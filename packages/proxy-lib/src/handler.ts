import {
  ModelSession,
  type ModelSessionOptions,
  createLogger,
  trunc,
  getToneForModel,
  requestUsesAgent,
  isPremiumOnlyModel,
  noteAgentRouteDead,
  noteAgentRouteAlive,
  isAgentRouteAlive,
  PREMIUM_ONLY_AGENT_TONES,
  defaultFramingForModel,
  currentFramingVariant,
  transcriptStyleForVariant,
  priorityAccessExhaustionOf,
  notePriorityAccessExhausted,
  activePriorityAccessExhaustion,
  meteredAllowance,
  METERED_BUDGETS,
  type MeteredBudget,
  meteredBudgetOf,
  priorityAccessFallbackModel,
  PRIORITY_ACCESS_FALLBACK_ENV,
  couldBePriorityAccessPrefix,
  secondsUntilReset,
  type PriorityAccessExhaustion,
  formatMessages as formatCoreMessages,
  imageUrls,
  parseToolCalls,
  buildSpecMap,
  looksLikeConfabulation,
  looksLikeHallucinatedCompletion,
  looksLikeRemoteArtifactCompletion,
  truncateAtFabricatedToolResponse,
  fabricatedToolResponseAt,
  textAfterFirstToolCall,
  longHeredocAsWrite,
  formatToolResponse,
  isProseDocument,
  getMessageContent,
  noteRequestOutcome,
  awaitDegradationBackoff,
  awaitTurnBudget,
  TurnBudgetHold,
  getImageArtifactToken,
  fetchImageBytes,
  type CapturedImage,
  type ParseResult,
} from "@m365-copilot/core";
import { ChatCompletionRequest } from "./schemas.js";
import type { z } from "zod/v4";

const log = createLogger("handler");

// Local conversation journal, enabled explicitly by the launcher.
async function localChatEvent(cid: string, direction: string, model: string, payload: unknown) {
  if (!process.env.M365_CHAT_DIR) return;
  try {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    await fs.mkdir(process.env.M365_CHAT_DIR, { recursive: true, mode: 0o700 });
    const filename = path.join(process.env.M365_CHAT_DIR,
      cid.replace(/[^a-zA-Z0-9_-]/g, "_") + ".jsonl");
    await fs.appendFile(filename,
      JSON.stringify({ time: new Date().toISOString(), cid, direction, model, payload }) + "\n",
      { mode: 0o600 });
  } catch (error: any) {
    log.info(`Local chat journal unavailable: ${error.message}`);
  }
}



// Reserve a short filename atomically, without overwriting existing files.
async function reserveImageFile(directory: string, extension: string) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  for (let number = 1; number <= 1000000; number++) {
    const filename = path.join(directory, `img${number}.${extension}`);
    try {
      const handle = await fs.open(filename, "wx", 0o600);
      return { filename, handle };
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  throw new Error("No available image filename could be found.");
}

// Save generated images on the proxy machine, never embed them in chat.
async function renderImagesMarkdown(images: CapturedImage[]): Promise<string> {
  if (images.length === 0) return "";
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const os = await import("node:os");
  const directory = path.join(os.homedir(), "Imágenes");
  const results: string[] = [];
  let artifactToken: string | null = null;
  try {
    await fs.mkdir(directory, { recursive: true });
    artifactToken = await getImageArtifactToken();
    if (!artifactToken) throw new Error("Could not obtain the image download token.");
  } catch (error: any) {
    log.info(`Image storage preparation failed: ${error.message}`);
    return "No image was saved: could not prepare the "
      + "~/Pictures folder or authenticate the download. Do not claim that a file exists.";
  }
  for (const image of images) {
    const url = image.referenceUrls[0];
    if (!url) {
      results.push("An image could not be saved: its download reference is missing.");
      continue;
    }
    try {
      const { data } = await fetchImageBytes(url, artifactToken!);
      const bytes = Buffer.from(data);
      let extension: string;
      if (bytes.length >= 24 &&
          bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        extension = "png";
      } else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 &&
                 bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217) {
        extension = "jpg";
      } else if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" &&
                 bytes.toString("ascii", 8, 12) === "WEBP") {
        extension = "webp";
      } else {
        throw new Error("The download does not have a recognized image signature.");
      }
      const { filename, handle } = await reserveImageFile(directory, extension);
      let complete = false;
      try {
        await handle.writeFile(bytes);
        await handle.sync();
        complete = true;
      } finally {
        await handle.close();
        if (!complete) await fs.unlink(filename).catch(() => {});
      }
      results.push(`Image saved on the proxy machine: ${filename}`);
      log.info(`Image saved locally (${bytes.length} bytes)`);
    } catch (error: any) {
      log.info(`Image save failed: ${error.message}`);
      results.push("An image could not be saved. Its contents and any remote link are not returned.");
    }
  }
  return results.join("\n");
}


// Filter image payloads before exposing any response content to the client.
async function sanitizeImagePayloads(text: string): Promise<string> {
  if (!/data:image\/|iVBORw0KGgo|\/9j\/|UklGR/i.test(text)) return text;
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const os = await import("node:os");

  const save = async (encoded: string): Promise<string> => {
    try {
      const compact = encoded.replace(/\s/g, "");
      if (!compact || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact) ||
          compact.length % 4 === 1) throw new Error("Invalid base64");
      const bytes = Buffer.from(compact, "base64");
      if (bytes.toString("base64").replace(/=+$/, "") !== compact.replace(/=+$/, "")) {
        throw new Error("Invalid encoding");
      }
      let extension = "";
      const pngEnd = Buffer.from([0,0,0,0,73,69,78,68,174,66,96,130]);
      if (bytes.length >= 45 &&
          bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) &&
          bytes.subarray(-12).equals(pngEnd)) {
        extension = "png";
      } else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 &&
                 bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217) {
        extension = "jpg";
      } else if (bytes.length >= 12 &&
                 bytes.toString("ascii", 0, 4) === "RIFF" &&
                 bytes.toString("ascii", 8, 12) === "WEBP" &&
                 bytes.readUInt32LE(4) + 8 === bytes.length) {
        extension = "webp";
      } else {
        throw new Error("Unrecognized or incomplete image");
      }
      const directory = path.join(os.homedir(), "Imágenes");
      await fs.mkdir(directory, { recursive: true });
      const { filename, handle } = await reserveImageFile(directory, extension);
      let complete = false;
      try {
        await handle.writeFile(bytes);
        await handle.sync();
        complete = true;
      } finally {
        await handle.close();
        if (!complete) await fs.unlink(filename).catch(() => {});
      }
      return `Image saved on the proxy machine: ${filename}`;
    } catch {
      return "[Image omitted: could not be saved; no file has been confirmed.]";
    }
  };

  const patterns = [
    /!\[[^\]\r\n]*\]\(\s*data:image\/[^;,\s)]+;base64,([A-Za-z0-9+/=\r\n\t ]+)\s*\)/gi,
    /data:image\/[^;,\s"'<>)]*;base64,([A-Za-z0-9+/=\r\n]+)/gi,
    /((?:iVBORw0KGgo|\/9j\/|UklGR)[A-Za-z0-9+/=]{512,})/g,
  ];
  for (const pattern of patterns) {
    let output = "";
    let position = 0;
    for (const match of text.matchAll(pattern)) {
      output += text.slice(position, match.index) + await save(match[1]);
      position = match.index! + match[0].length;
    }
    text = output + text.slice(position);
  }
  return text.replace(
    /data:image\/[^\s"'<>)]*/gi,
    "[Contenido de imagen omitido: formato no recuperable]"
  );
}

// Forcing follow-up sent (in the same conversation) when M365 confabulates an
// inability to act instead of calling a tool. See the confab-retry loop below.
const CONFAB_FORCE_PROMPT =
  "The working directory and the files named in the task ARE present on a real filesystem right now. Do NOT ask me to paste anything, and do NOT say commands return no output — you have not run any command yet. Emit ONE ```bash block this turn: run `ls -la` and `cat` the relevant files. Output only the ```bash block, nothing else.";

// The same give-up AFTER the model has already run tools. CONFAB_FORCE_PROMPT
// says "you have not run any command yet" — false at that point, and the model
// treats a prompt that contradicts its own transcript as untrustworthy: live
// (Windows / pi / gpt-5.6-think-deeper) it answered "so I can't run `ls -la` or
// `cat`", refusing the prompt's own instruction. The give-ups that reach here
// follow an obstacle — no PDF tool or Word library installed — so say what is
// true: the tools work, and a missing program is something to install.
const MIDTASK_FORCE_PROMPT =
  "Your tools are working: your previous command really ran on this machine, and its real output is in the last <tool_response>. Continue the task from there with ONE tool block for the next step. A missing program or library is not a missing tool — install it with the package manager (pip, npm, …) or do the job with what is already installed. Output only the tool block, nothing else.";

// Forcing follow-up when the model CLAIMS it did a file change but ran no tool.
const HALLUCINATION_FORCE_PROMPT =
  "You have NOT actually done that — no tool ran this turn, so nothing changed on disk. Do not claim a file was created, replaced, or updated until a <tool_response> confirms it. Emit ONE ```bash block now that performs the change for real (write the file with a `cat > path <<'EOF' … EOF` heredoc), and nothing else.";

// A Teams artifact belongs to M365's remote runtime and cannot be applied by a
// local agent using only its basename. Force the intended mutation through the
// harness tools instead of letting the remote patch leak into the conversation.
const REMOTE_ARTIFACT_FORCE_PROMPT =
  "The patch or download link you produced exists only in M365's remote environment and is NOT a file in the caller's working directory. Do NOT create, download, or apply a patch, and do NOT use a Teams artifact link. Use the provided local edit/write tool directly; if needed, emit ONE ```bash block that modifies the named local file in place. Output only that single local tool call, nothing else.";

// M365 soft-caps output around ~3k tokens (~12k chars) and — critically —
// CONCLUDES EARLY rather than truncating mid-stream, so a too-long answer comes
// back clean-looking but incomplete with no error to detect (docs/hypotheses.md
// F9). We can't see token counts, so we heuristically flag responses at/over the
// observed ceiling with finish_reason:"length" — the standard signal a harness
// uses to ask for a continuation. Tune/disable via env (0 disables).
const OUTPUT_CHAR_CEILING = process.env.M365_OUTPUT_CHAR_CEILING !== undefined
  ? Number(process.env.M365_OUTPUT_CHAR_CEILING)
  : 12_000;

/** "length" when the answer is at/over the empirical output ceiling, else "stop". */
function outputFinishReason(text: string): "stop" | "length" {
  if (OUTPUT_CHAR_CEILING > 0 && text.length >= OUTPUT_CHAR_CEILING) {
    log.info(`Output at ceiling (${text.length} ≥ ${OUTPUT_CHAR_CEILING} chars) — finish_reason=length (likely truncated; harness should continue)`);
    return "length";
  }
  return "stop";
}

/** How many chars of a model-written <tool_response> tail a tool turn may run
 *  before the proxy stops it (runBuffered). 0 stops at the tag itself. With the
 *  default, pi takes as many turns as when the turn runs to its end (+2%,
 *  p = 0.74), and no runaway gets far; stopping at the tag cost 10% more turns
 *  (hypotheses §35 F89). */
const DEFAULT_EARLY_STOP_AFTER = 2_000;
function earlyStopAfter(): number {
  const v = Number(process.env.M365_EARLY_STOP_AFTER);
  return process.env.M365_EARLY_STOP_AFTER !== undefined && Number.isFinite(v) && v >= 0 ? v : DEFAULT_EARLY_STOP_AFTER;
}

/** The longest M365_AVOID_THROTTLING holds a request that isn't streamed: it
 *  sends nothing until the answer, and its clients give up on headers after
 *  5 min (pi's SDK, the bench), of which a turn itself can take ~3. A streamed
 *  request has its keepalive chunks and waits up to M365_BUDGET_MAX_WAIT_MIN. */
const UNSTREAMED_BUDGET_WAIT_LIMIT_MS = 2 * 60_000;

type ChatBody = z.infer<typeof ChatCompletionRequest>;
type ParsedMessage = ChatBody["messages"][number];

/** Standalone recovery commands: only the CURRENT user turn can trigger them. */
const CONTEXT_RESTORE_COMMANDS = new Set(["RESTORECONTEXT", "RESTORESESSION"]);
const TOOLS_RESTORE_COMMANDS = new Set(["RESENDTOOLS", "RESTORETOOLS", "SENDTOOLS"]);

function restoreCommandOf(message: ParsedMessage): "context" | "tools" | null {
  if (message.role !== "user") return null;
  const command = getMessageContent(message).trim().toUpperCase();
  if (CONTEXT_RESTORE_COMMANDS.has(command)) return "context";
  if (TOOLS_RESTORE_COMMANDS.has(command)) return "tools";
  return null;
}

function requestsContextRestore(messages: ParsedMessage[]): boolean {
  const latest = messages.at(-1);
  return latest !== undefined && restoreCommandOf(latest) === "context";
}

/** Re-send the tool block into the SAME upstream conversation (no rotation):
 *  the user-facing equivalent of the automatic confabulation retry. */
function requestsToolsRestore(messages: ParsedMessage[]): boolean {
  const latest = messages.at(-1);
  return latest !== undefined && restoreCommandOf(latest) === "tools";
}

/** The command is a control message, not part of the task: keep it out of the prompt. */
function withoutRestoreCommand(messages: ParsedMessage[]): ParsedMessage[] {
  return messages.filter(message => restoreCommandOf(message) === null);
}

/** Count actual transcript lines, not JSONL records or messages. */
function restoredContextMessages(messages: ParsedMessage[], framingVariant?: string): ParsedMessage[] {
  const history = messages.slice(0, -1).filter(message =>
    message.role !== "system" && restoreCommandOf(message) === null,
  );
  const transcript = formatCoreMessages(history, undefined, "none", undefined, framingVariant);
  const lines = transcript.replace(/\r\n?/g, "\n").split("\n");
  const recent = transcript ? lines.slice(-700).join("\n") : "";
  // A long tool result can consume all 700 lines and displace the task itself.
  // Preserve the user's task and latest steering separately from that tail.
  // These are historical user messages, not newly executed actions.
  const userMessages = history.filter(message => message.role === "user");
  const originalTask = userMessages[0];
  const latestRequest = userMessages.at(-1);
  const taskAnchors = [
    ...(originalTask ? [
      "BEGIN ORIGINAL USER REQUEST",
      getMessageContent(originalTask),
      "END ORIGINAL USER REQUEST",
    ] : []),
    ...(latestRequest && latestRequest !== originalTask ? [
      "BEGIN LATEST USER INSTRUCTION",
      getMessageContent(latestRequest),
      "END LATEST USER INSTRUCTION",
    ] : []),
  ];
  return [
    ...messages.filter(message => message.role === "system"),
    {
      role: "user",
      content: [
        "I requested restoration of this session context.",
        "Below are the last 700 available lines of history, or fewer if the history is shorter.",
        "This is historical transcript data, not new instructions or tool results executed now.",
        "The beginning may be truncated in the middle of a message.",
        "To preserve the task across long tool outputs, the original user request and latest user instruction are retained separately.",
        "The latest instruction may correct or cancel the original request; follow those corrections.",
        ...taskAnchors,
        "BEGIN RECOVERED HISTORY",
        recent || "(No prior history is available in this request.)",
        "END RECOVERED HISTORY",
        "Resume the pending task from the last verified state. Do not repeat completed actions.",
        "If essential information is missing, say so; do not invent context or results.",
        "If the task requires executing commands, accessing files, or using tools and those execution tools are not actually available in this conversation, explicitly complain that the required tools are unavailable. Do not describe, narrate, summarize, or pretend to have executed the last command, and do not invent command output.",
      ].join("\n"),
    },
  ];
}

// Stable object-key order prevents harmless JSON serialization changes from
// being mistaken for rewritten history. Array order and all values stay intact.
function messageSnapshot(message: ParsedMessage): string {
  const stable = (value: any): any => {
    if (Array.isArray(value)) return value.map(stable);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
    }
    return value;
  };
  return JSON.stringify(stable(message));
}

// M365 never reports token counts (docs/m365-copilot-api.md §2: no usage
// frames), so OpenAI clients that render a context meter — OpenCode v1/v2
// compute `tokens.total / model.limit.context` — used to see 0% and show
// nothing. These are estimates (Latin text runs ~4 chars/token): wrong by a
// constant factor, but they move with the conversation, which is what the meter
// needs. `M365_TOKEN_ESTIMATE=0` restores the historical zeros.
function tokenEstimateEnabled(): boolean {
  return process.env.M365_TOKEN_ESTIMATE !== "0";
}

function estimateTokens(text: string | null | undefined): number {
  if (!tokenEstimateEnabled() || !text) return 0;
  return Math.ceil(text.length / 4);
}

/** Prompt size of the request as the CLIENT holds it (full history + schemas),
 *  not the delta we may send upstream: the meter is about the client's context. */
function estimatePromptTokens(messages: ParsedMessage[], tools?: unknown): number {
  if (!tokenEstimateEnabled()) return 0;
  let chars = 0;
  for (const message of messages) {
    chars += getMessageContent(message).length;
    for (const call of message.tool_calls ?? []) {
      chars += call.function.name.length + call.function.arguments.length;
    }
  }
  if (tools) chars += JSON.stringify(tools).length;
  return Math.max(1, Math.ceil(chars / 4));
}

// --- Per-conversation state ---

interface ConversationState {
  session: ModelSession;
  sentMessageCount: number;
  /** Exact serialized request prefix; counts alone cannot detect rewritten history. */
  sentMessageSnapshot?: string[];
  lastAccessedAt: number;
  /** Sent ahead of the next tool result when the proxy executed less than the
   *  model wrote last turn (see executedOnlyFirstNote). */
  pendingNote: string | null;
  /** The model that last answered in this conversation. A different one (the
   *  Opus fallback, #18) can't continue the M365 conversation — it may need
   *  another scenario — so it starts a fresh one with the full history. */
  servedModel?: string;
}

/**
 * The note that corrects the model's view of what actually ran.
 *
 * When the proxy executes only part of a reply — the head before a self-written
 * `<tool_response>` (the stop sequence), the first of several batched calls, or
 * the call at the head of a reply that kept going (#33) — M365's
 * server-side history still holds the WHOLE reply. The model then believes its
 * invented results happened, often including an invented "done", and reads the
 * real result as stale: "It looks like this tool response came in out of
 * context" (Sonnet 4.6: 9 of 56 bench runs ended that way without this note,
 * 0 of 70 with it; #31).
 */
const TRAILING_NOTE_CHARS = 120;
export function executedOnlyFirstNote(fabricated: boolean, droppedCalls: number, trailingChars = 0): string | null {
  if (fabricated) {
    return "(Note: only the first tool call in your previous reply was actually run. Everything you wrote after it, including the <tool_response> you wrote yourself, did not happen. Here is the real output of that first call:)";
  }
  const speculated = trailingChars >= TRAILING_NOTE_CHARS;
  if (droppedCalls > 0) {
    const rest = droppedCalls === 1 ? "the other one was not" : `the other ${droppedCalls} were not`;
    const tail = speculated ? " Anything you wrote after it was written before its result existed." : "";
    return `(Note: only the first of the ${droppedCalls + 1} tool calls in your previous reply was run; ${rest}.${tail} Here is the real output of the first one:)`;
  }
  if (speculated) {
    return "(Note: only the tool call in your previous reply was acted on; anything you wrote after it was written before its result existed. Here is the real output of that call:)";
  }
  return null;
}

// --- Session pool: maps conversation fingerprint → M365 session ---

const MAX_IDLE_MS = 30 * 60 * 1000; // evict after 30 min idle

export class SessionPool {
  private conversations = new Map<string, ConversationState>();
  private sessionOptions: ModelSessionOptions;

  constructor(sessionOptions: ModelSessionOptions = {}) {
    this.sessionOptions = sessionOptions;
  }

  /**
   * Resolve the conversation state for an incoming request.
   * Fingerprint is the hash of the first user message and the request's tool
   * names — same opener and same tool set = same conversation.
   */
  resolve(messages: ParsedMessage[], tools?: ChatBody["tools"]): ConversationState {
    this.evictStale();

    const fingerprint = this.fingerprint(messages, tools);
    const existing = this.conversations.get(fingerprint);

    if (existing) {
      // A request that carries no more messages than this conversation already
      // sent is not its continuation (a harness re-sends the whole history and
      // only ever appends). It's a new session that shares the first user message
      // — two pi sessions opened with the same prompt, even in different
      // directories — or a re-sent request. Either way it needs a FRESH M365
      // conversation: reset() kept the conversationId, so the full prompt went
      // into the old thread, and at equal length nothing reset at all and
      // "Please continue." went there. Measured (Windows / pi, 30 runs of 2
      // prompts): later sessions answered from earlier ones — "notlar.docx was
      // already created and verified" in an empty directory — and the pass rate
      // fell 7/10 → 4/10 → 3/10 over the sweep. The full prompt re-sends the
      // whole history, so nothing the harness holds is lost.
      const historyChanged = existing.sentMessageSnapshot !== undefined &&
        existing.sentMessageSnapshot.some(
          (previous, index) => messageSnapshot(messages[index]) !== previous,
        );
      if (messages.length <= existing.sentMessageCount || historyChanged) {
        log.info(`Conversation ${fingerprint}: history changed or request is not an append-only continuation; starting a fresh M365 conversation with full history`);
        existing.session.newConversation();
        existing.sentMessageCount = 0;
        existing.sentMessageSnapshot = undefined;
        existing.pendingNote = null;
      }
      existing.lastAccessedAt = Date.now();
      return existing;
    }

    // New conversation
    log.info(`New conversation ${fingerprint}, ${this.conversations.size} active`);
    const state: ConversationState = {
      session: new ModelSession(this.sessionOptions),
      sentMessageCount: 0,
      pendingNote: null,
      lastAccessedAt: Date.now(),
    };
    this.conversations.set(fingerprint, state);
    return state;
  }

  // The tool names are in the key because a harness's side requests can share
  // the session's first user message. opencode sends a title request ("You are
  // a title generator…", no tools) 4 ms before the task (12 tools): keyed on the
  // opener alone both went into one M365 conversation, as turns 0 and 1 run at
  // the same time (#83). pi's and opencode's tool sets don't change within a
  // session; one that does starts a fresh conversation with the full history,
  // which costs a thread, not the answer. Names, not definitions: descriptions
  // can carry per-turn text. The system prompt would separate the title request
  // too, but it is the likelier place for a date, a time or a git status.
  private fingerprint(messages: ParsedMessage[], tools?: ChatBody["tools"]): string {
    const firstUser = messages.find(m => m.role === "user");
    const text = firstUser ? getMessageContent(firstUser) : "";
    const toolNames = [...new Set((tools ?? []).map(t => t.function.name))].sort().join(",");
    return simpleHash(`${toolNames}\n${text}`);
  }

  private evictStale() {
    const now = Date.now();
    for (const [key, state] of this.conversations) {
      if (now - state.lastAccessedAt > MAX_IDLE_MS) {
        log.info(`Evicting idle conversation ${key}`);
        this.conversations.delete(key);
      }
    }
  }

  get size(): number {
    return this.conversations.size;
  }
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return String(hash);
}

/** Parse a tool-mode reply, with the document guard applied.
 *
 *  The shell-routing parser turns every ```bash block into a tool call, so a
 *  model that ANSWERS with a markdown document full of code fences ("here's a
 *  simplified README") would get its own answer executed as shell. That shape
 *  (multiple fences + prose) comes back as plain text instead — unless the reply
 *  OPENS with a tool call, which makes it an action with a speculative tail (#33).
 *
 *  This runs BEFORE the give-up checks, because a document runs nothing. It used
 *  to run after them, so a refusal that came with "run these yourself" fences —
 *  measured: "Dosya oluşturma özelliği bu oturumda devre dışı olduğu için
 *  notlar.pdf dosyasını oluşturamıyorum" + two ```bash blocks — counted as tool
 *  calls for the confabulation check (skipped), then as text for the user.
 *
 *  `judged` is the text the give-up checks read. For a document it's only the
 *  opening paragraph: a give-up announces itself there, and everything after
 *  is document content ("if you can't access the API…") that must not trip a
 *  forcing retry. */
function parseReply(text: string, tools: Parameters<typeof parseToolCalls>[1]): { parsed: ParseResult; judged: string | null } {
  const parsed = parseToolCalls(text, tools);
  if (isProseDocument(parsed, text, tools)) {
    log.info(`Response is a prose document (${parsed.toolCalls.length} embedded fences), returning as text instead of executing`);
    const opening = text.split("```")[0].trim().split(/\n\s*\n/)[0];
    return { parsed: { hasToolCalls: false, toolCalls: [], textContent: text }, judged: opening };
  }
  return { parsed, judged: parsed.textContent };
}

// --- Delta message formatting ---

/** Format the messages new since the last turn. `history` is the whole request:
 *  a tool message names its call only by `tool_call_id` (pi sends no `name`),
 *  so formatToolResponse takes the tool's name and command from the assistant
 *  `tool_calls` that issued it — every result used to be labelled
 *  `name="unknown"` (#50). */
export function formatDeltaMessages(messages: ParsedMessage[], history: ParsedMessage[] = messages): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      // Skip assistant messages — M365 already has them server-side.
      // Echoing them back as a user message confuses M365.
      continue;
    } else if (m.role === "tool") {
      // Same rendering as the first turn: named for the call that produced it.
      parts.push(formatToolResponse(m, history));
    } else if (m.role === "system") {
      // Skip system messages on follow-up turns
    } else {
      parts.push(`<${m.role}>\n${getMessageContent(m)}\n</${m.role}>`);
    }
  }
  return parts.join("\n\n");
}

// --- Main handler ---

/**
 * Handle a chat completion request, returning an OpenAI-compatible Response.
 * The SessionPool routes each conversation to its own ModelSession.
 */
export async function handleChatCompletion(
  body: ChatBody,
  pool: SessionPool,
  opts: { signal?: AbortSignal } = {},
): Promise<Response> {
  const conv = pool.resolve(body.messages, body.tools);
  const { session } = conv;
  const restoreContext = requestsContextRestore(body.messages);
  const restoreTools = !restoreContext && requestsToolsRestore(body.messages);
  if (restoreContext) {
    // Explicit recovery must not depend on the possibly degraded upstream
    // thread. Keep the caller's local history, but replay into a fresh one.
    session.newConversation();
    conv.sentMessageCount = 0;
    conv.sentMessageSnapshot = undefined;
    conv.pendingNote = null;
    conv.servedModel = undefined;
    log.info("RESTORECONTEXT: starting a fresh upstream conversation and replaying available context");
  } else if (restoreTools) {
    // Same conversation, same context: only the tool block/framing is re-sent,
    // exactly like the automatic confabulation retry does after a give-up.
    log.info("RESENDTOOLS: re-sending the tool framing into the current upstream conversation");
  }
  const hasTools = body.tools && body.tools.length > 0 && body.tool_choice !== "none";
  const requestedModel = body.model;

  // Priority access (§15, §24 F55, §26, issue #18). Once a budget is used up
  // every turn on it is refused until the reset, so don't start one: serve the
  // opt-in fallback model (M365_OPUS_FALLBACK_MODEL, e.g. the unmetered
  // claude-opus-4.8; M365_SONNET_FALLBACK_MODEL for Sonnet 5.5), or answer the
  // 429 here. A refused turn costs no allowance, but it does cost an M365 turn
  // and often a fresh conversation — what the account's thread-rate throttle
  // counts.
  const requestedBudget = meteredBudgetOf(requestedModel);
  const knownExhaustion = activePriorityAccessExhaustion(requestedBudget ?? requestedModel);
  const fallbackModel = knownExhaustion && requestedBudget ? priorityAccessFallbackModel(requestedBudget) : null;
  if (knownExhaustion && !fallbackModel) {
    log.info(`Priority access exhausted (${knownExhaustion.window}) until ${knownExhaustion.resetsAt.toISOString()} — 429 without contacting M365`);
    return priorityAccessResponse(knownExhaustion, requestedModel);
  }
  let model = fallbackModel ?? requestedModel;
  if (fallbackModel) log.info(`Priority access exhausted until ${knownExhaustion!.resetsAt.toISOString()} — serving ${requestedModel} with ${fallbackModel} (${PRIORITY_ACCESS_FALLBACK_ENV[requestedBudget!]})`);
  if (conv.servedModel && conv.servedModel !== model) {
    // The conversation was being served by another model (e.g. Opus 5.5 before
    // the fallback): continue in a fresh M365 conversation with the full history.
    log.info(`Conversation switches model ${conv.servedModel} → ${model}: fresh conversation, full history`);
    session.newConversation();
    conv.sentMessageCount = 0;
  }

  // Which requests carry the declarative tool agent. GPT-the-chat-model won't
  // tool-call agent-less (0/4), so it needs the agent. Claude tool-calls reliably
  // AGENT-LESS via shell-routing (F23), and on a non-premium account the agent
  // path doesn't serve Claude at all (§22 F44) — except Claude Opus, which takes
  // it: agent-less, Opus 4.8 works in its own code interpreter unless the
  // framing steers it out (§36). `Gpt_6_Reasoning` doesn't serve
  // with the agent on any account (§22 F45, #41), and `Gpt_6_Sol_Reasoning` /
  // `Gpt_61_Sol_Reasoning` only on a premium one (learned at runtime, see the
  // dead-route fallback in runBuffered). The rule lives in core (`requestUsesAgent`);
  // M365_FORCE_AGENT=1 / =0 forces the agent on / off for tool requests.
  // Derive it from the RESOLVED tone, not the raw model string: getToneForModel
  // routes any unmapped `claude-*` (e.g. the `claude-opus-5[1m]` a Claude Code
  // client sends) to a Claude tone, so this keeps that request on the working
  // agent-less path. The old `/claude/i.test(model)` + `magic` fallback split a
  // claude-* string into GPT-tone + agent-suppressed — the confab quadrant we
  // observed. One resolved tone drives both.
  let tone = getToneForModel(model);
  // Apply these workflow preferences to GPT-6 and Sol only, including
  // full-history retries and the context refreshed on continued tool turns.
  function formatMessages(...args: Parameters<typeof formatCoreMessages>): string {
    // Keep the original request untouched for session fingerprints/snapshots.
    // Apply the same replay on fresh-conversation and fallback retries too.
    if (restoreContext && args[0] === body.messages) {
      args[0] = restoredContextMessages(body.messages, args[4]);
    }
    const formatted = formatCoreMessages(...args);
    if (!hasTools || ![
      "Gpt_6_Reasoning",
      "Gpt_6_Sol_Reasoning",
      "Gpt_61_Sol_Reasoning",
    ].includes(tone)) return formatted;
    return formatted + "\n\n" + [
      "My workflow preferences for this task:",
      "Format clickable web links in user-facing responses as standard Markdown: [descriptive label](https://example.com/path). Do not write label (URL), wrap links in backticks, or emit HTML or terminal escape sequences. Keep sentence punctuation outside the Markdown link, preserve the exact destination URL, and do not invent URLs. These formatting rules apply to prose, not file contents, code examples, or tool arguments.",
      "Use the available dedicated patch or editing tool for file changes instead of Python, sed, or shell rewrites whenever it can express the change. Use only tools actually listed in this request, and follow their declared input format. Shell scripts remain appropriate for commands, tests, and transformations that genuinely need them.",
      "Do not create .bak, .backup, or timestamped backup copies by default, unless I ask for them or you are working on important changes where a backup provides meaningful recovery protection. Explain any backup you create in your final response. Preserve existing user changes and existing backups.",
      "Keep shell output operational: commands, test results, diagnostics, and actionable errors. Do not use print, echo, or printf to deliver explanations, progress narration, completion claims, caveats, or next steps intended for me.",
      "After the real tool results confirm completion, put the important information in your final plain-text response outside any tool block: what changed, verification results, limitations, pending work, and commit/push status when relevant. Do not hide this information in shell output or comments. The final response may use several concise sentences when needed; completeness matters more than the earlier one-sentence suggestion.",
    ].join("\n");
  }
  // Framing default follows the MODEL (defaultFramingForModel): the Claude,
  // GPT-6 and GPT-6 Sol tones get a user-voice relay (Sonnet reads the
  // `<system>`-tagged baseline as an injected prompt; on Opus it trips the
  // jailbreak classifier). Opus, Sonnet 4.6, GPT-6, GPT-6 Sol and GPT-6.1 Sol get the
  // turn-saving `relay_batch` (§24 F60, §25, §27, §28); Sonnet 5 and Sonnet 5.5 plain `relay`. The
  // rest keep the bench-tuned `baseline`.
  // Keyed on the model, not the tone, because one tone can serve two models.
  // M365_FRAMING_* still wins.
  let framingVariant = currentFramingVariant(defaultFramingForModel(model));
  let useToolAgent = requestUsesAgent(model, !!hasTools);

  // Format message: full prompt on first turn, delta on follow-ups.
  // M365 is stateful — it remembers everything from prior turns,
  // so we only need to send new messages after the first turn.
  const isFirstTurn = session.turnCount === 0;
  const convId = session.conversationId;
  await localChatEvent(convId, "ENTRA", model,
    body.messages.slice(conv.sentMessageCount || 0).filter(m => m.role !== "system"));
  let text: string;
  // Images ride on the message that carries their text (core image-input.ts).
  let inputImages: string[];
  if (restoreTools) {
    // Full history minus the command, with the tool definitions and framing the
    // harness sent on this request. No newConversation(): this is a nudge.
    text = formatMessages(withoutRestoreCommand(body.messages), body.tools, body.tool_choice, convId, framingVariant);
    inputImages = imageUrls(body.messages);
    log.info(`Chat completion: model=${model}, stream=${body.stream}, messages=${body.messages.length}, turn=${session.turnCount}, mode=restore-tools, cid=${convId}`);
  } else if (restoreContext || isFirstTurn || conv.sentMessageCount === 0) {
    text = formatMessages(body.messages, body.tools, body.tool_choice, convId, framingVariant);
    inputImages = restoreContext ? [] : imageUrls(body.messages);
    log.info(`Chat completion: model=${model}, stream=${body.stream}, messages=${body.messages.length}, turn=${session.turnCount}, mode=full, cid=${convId}`);
  } else {
    const newMessages = body.messages.slice(conv.sentMessageCount);
    inputImages = imageUrls(newMessages);
    const delta = newMessages.length > 0 ? formatDeltaMessages(newMessages, body.messages) : "";
    if (delta.length > 0) {
      // The upstream conversation retains its initial framing, tool schemas
      // and workflow preferences. Send only new messages on continuations.
      text = delta;
      // Only a tool result is the thing the note corrects the model about.
      if (conv.pendingNote && newMessages.some((m) => m.role === "tool")) {
        text = `${conv.pendingNote}\n\n${text}`;
        log.info("Prepended the only-the-first-call-ran note (last reply was partly executed)");
      }
      log.info(`Chat completion: model=${model}, stream=${body.stream}, messages=${body.messages.length}, new=${newMessages.length}, turn=${session.turnCount}, mode=delta, cid=${convId}`);
    } else {
      // No meaningful new content to send — nudge M365 to continue.
      text = "Please continue.";
      log.info(`Chat completion: model=${model}, stream=${body.stream}, messages=${body.messages.length}, turn=${session.turnCount}, mode=retry, cid=${convId}`);
    }
  }
  conv.pendingNote = null; // one turn only: consumed above, or stale

  log.debug("Formatted prompt:", trunc(text, 1000));

  const promptTokens = estimatePromptTokens(body.messages, body.tools);
  const completionId = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  // Buffer the full response, with a couple of quick retries on an empty reply.
  const MAX_RETRIES = 2;
  const SHORT_RETRY_DELAY_MS = 2_000;

  // Captured from the final attempt — surfaced through the OpenAI `usage` block
  // so clients can see M365's conversation-quota % (the closest proxy we have
  // to "context window remaining"). Token counts aren't exposed by M365.
  let lastThrottle: { current: number; max: number } | null = null;
  let lastContentOrigin: string | null | undefined;
  let lastMessageType: string | null | undefined;
  let lastScores: Record<string, number> | null | undefined;
  let lastTurnCount: number | null | undefined;
  let lastMetering: Record<string, number> | null | undefined;
  let lastCompletionTokens = 0;

  // `onDelta` (when provided) forwards each text delta to the caller AS IT ARRIVES,
  // for live incremental streaming. It's safe to forward without ever retracting:
  // runBuffered only retries on an EMPTY attempt (Disengaged, dead-agent, throttle),
  // and an empty attempt emits no deltas — so a forwarded delta always belongs to the
  // one attempt that produced content and is never re-sent by a subsequent retry.
  async function runBuffered(
    onDelta?: (delta: string) => void,
  ): Promise<{ fullText: string } | { error: Response }> {
    let agentRefreshed = false;
    let disengageRetried = false;
    let agentFallbackDone = false;
    let priorityFallbackDone = false;
    let internalErrorFreshRetried = false;
    let originalText = text;
    // Self-imposed pacing while the account is degraded (thread-rate throttle). A
    // no-op when healthy; during backoff it sleeps a jittered delay so we stop
    // starting fresh turns into the throttle and let it self-heal (H-R1). This
    // replaced the old auto-reauth, which didn't clear the throttle and raised our
    // detection profile. A single long pi thread never trips the trigger.
    await awaitDegradationBackoff();
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // A <tool_response> the model writes after a real call is a stop sequence
      // (truncateAtFabricatedToolResponse), but the cut in produce() only runs
      // once M365 has finished the turn, and Sonnet 4.6 sometimes writes the rest
      // of the session after its call: minutes of invented output (45-69k chars),
      // long enough for pi's request timeout to fail the run (hypotheses §34). So
      // stop the turn once the invented tail runs past M365_EARLY_STOP_AFTER
      // chars (2,000 by default), the way a client's Stop does; the cut then keeps the head as
      // before. Not at the tag itself: M365 keeps the whole message in the
      // conversation, the model seems to follow a short tail as its plan, and
      // stopping at the tag cost Sonnet 4.6 (`claude-sonnet`, agent-less) 10%
      // more turns (§35 F89).
      // M365_NO_EARLY_STOP=1 waits for the turn to end instead.
      const earlyStop = hasTools && !process.env.M365_NO_EARLY_STOP ? new AbortController() : null;
      const stopAfter = earlyStopAfter();
      const signal = !earlyStop ? opts.signal
        : opts.signal ? AbortSignal.any([opts.signal, earlyStop.signal]) : earlyStop.signal;
      let copilotStream;
      try {
        // M365_AVOID_THROTTLING=1: wait until the account's turn bucket can
        // afford this turn (turn-budget.ts, hypotheses §37). A pi session is one
        // long thread, but every turn in it draws on the same bucket as a bench
        // sweep (F58), so a busy enough session runs it dry and then sits out a
        // throttle of about an hour. Every upstream turn passes here, the
        // forcing retries included; run() calls the same wait before its reconnect.
        const waitForBudget = () => awaitTurnBudget({ signal: opts.signal, maxWaitMs: body.stream ? undefined : UNSTREAMED_BUDGET_WAIT_LIMIT_MS });
        await waitForBudget();
        // Only attach the tool-calling agent when the request actually has tools.
        // The agent overrides `tone` (forces GPT-5), so tool-less requests must
        // skip it to reach the model the tone selects (e.g. Claude). See
        // ModelSession.run / docs H8.6.
        copilotStream = await session.run(text, model, signal, useToolAgent, inputImages, waitForBudget);
      } catch (err: any) {
        if (err instanceof TurnBudgetHold) return { error: turnBudgetHoldResponse(err) };
        return { error: jsonResponse(502, { error: { message: err.message, type: "upstream_error" } }) };
      }

      let fullText = "";
      let tagAt = -1; // where the invented <tool_response> starts, once seen
      try {
        for await (const delta of copilotStream) {
          fullText += delta;
          onDelta?.(delta);
          if (!earlyStop || earlyStop.signal.aborted) continue;
          // Measured on the stream's composed text, which has the heads that
          // arrive only as snapshots (#29) — a fence's opening line among them.
          const sofar = (copilotStream.fullText?.length ?? 0) > fullText.length ? copilotStream.fullText! : fullText;
          // Look for the tag only when this delta (or its seam with the last one) can hold it.
          if (tagAt < 0 && /<tool_/i.test(fullText.slice(Math.max(0, fullText.length - delta.length - 16)))) {
            tagAt = fabricatedToolResponseAt(sofar, body.tools);
          }
          if (tagAt >= 0 && sofar.length - tagAt >= stopAfter) {
            log.info(`Model is writing its own <tool_response> after its call — stopping the turn ${sofar.length} chars in (tag at ${tagAt})`);
            earlyStop.abort();
          }
        }
        if (copilotStream.fullText && copilotStream.fullText.length > fullText.length) {
          fullText = copilotStream.fullText;
        }
      } catch (err: any) {
        return { error: jsonResponse(502, { error: { message: err.message, type: "upstream_error" } }) };
      }

      // Image gen (§14): the picture arrives on a GraphicArt frame, usually with NO
      // chat text — so an image turn looks empty to the checks below and would burn
      // a retry. Render the image(s) into the response instead, and (for streaming)
      // emit the markdown as a trailing delta so the client isn't left with nothing.
      fullText = await sanitizeImagePayloads(fullText);
      const images = copilotStream.images ?? [];
      if (images.length > 0) {
        const imageMd = await renderImagesMarkdown(images);
        if (imageMd) {
          const addition = fullText.length > 0 ? `\n\n${imageMd}` : imageMd;
          fullText += addition;
          // Image paths are included only in the final filtered response.
        }
      }

      lastThrottle = copilotStream.throttle;
      lastContentOrigin = copilotStream.contentOrigin;
      lastMessageType = copilotStream.messageType;
      lastScores = copilotStream.scores;
      lastTurnCount = copilotStream.turnCount;
      lastMetering = copilotStream.metering;

      // M365 SAYS when it throttles: the final item's result is `Throttled` /
      // `PerUserThrottled` (#35). Checked BEFORE the content check so
      // an apology that ever arrives as content can't pass for an answer. This
      // used to fall through to the empty-reply path below — two "quick retries"
      // straight back into the throttle, then a 502 blaming a content filter.
      // Fail fast with a 429 instead, and count it toward the degradation backoff.
      if (copilotStream.result?.value === "Throttled") {
        noteRequestOutcome(true, convId);
        log.info(`Upstream Throttled (${copilotStream.result.errorCode ?? "no errorCode"}) — 429, no retry`);
        return { error: throttledResponse(copilotStream.result) };
      }

      // A tone whose agent route serves only on a premium account came back as
      // the dead route (`InternalError`, no content): this account isn't
      // premium. Remember that for the process, and re-send the WHOLE request
      // agent-less in a fresh conversation — the dead turn processed nothing, and
      // a delta would have no context. Free retry, at most once per request; the
      // next request on this tone goes agent-less from the start. Never under
      // M365_FORCE_AGENT=1, which asked for the agent regardless.
      // A premium account produces the identical wire state as a one-off
      // transient (§23), so once the agent has answered for this tone the
      // InternalError falls through to the ordinary empty-reply handling below
      // instead (isAgentRouteAlive).
      if (
        useToolAgent && !agentFallbackDone &&
        PREMIUM_ONLY_AGENT_TONES.has(tone) &&
        !isAgentRouteAlive(tone) &&
        process.env.M365_FORCE_AGENT !== "1" &&
        copilotStream.result?.value === "InternalError" &&
        !copilotStream.hasContent && fullText.length === 0
      ) {
        agentFallbackDone = true;
        noteAgentRouteDead(tone);
        useToolAgent = false;
        session.newConversation();
        text = formatMessages(body.messages, body.tools, body.tool_choice, session.conversationId, framingVariant);
        inputImages = imageUrls(body.messages);
        originalText = text;
        log.info(`Agent route dead for ${tone} (InternalError) — this account isn't premium; re-sending agent-less with '${framingVariant}' framing in a fresh conversation`);
        attempt--;
        continue;
      }

      // A priority-access cap (Opus 5.5, Sonnet 5.5) arrives as a turn whose
      // text is a refusal ("You've used your available priority access…") and
      // whose final result is `OutOfCredits` (§24 F55). Left alone, the client
      // would receive a refusal dressed as an answer — the same hazard class as
      // the image-quota text (§14 H14.4). Surface it as a 429 with the reset
      // time instead, or, when the budget's fallback model is set
      // (M365_OPUS_FALLBACK_MODEL / M365_SONNET_FALLBACK_MODEL), re-send the
      // whole request to that model in a fresh conversation (issue #18). Either
      // way remember it, so the next requests don't spend M365 turns on
      // refusals until the reset.
      const exhausted = priorityAccessExhaustionOf(copilotStream.result, fullText);
      if (exhausted) {
        const budget = meteredBudgetOf(model);
        if (budget || copilotStream.result?.value === "OutOfCredits") notePriorityAccessExhausted(budget ?? model, exhausted);
        const fallback = budget && !priorityFallbackDone ? priorityAccessFallbackModel(budget) : null;
        if (fallback) {
          priorityFallbackDone = true;
          log.info(`Priority access exhausted (${exhausted.window}) — re-sending to ${fallback} (${PRIORITY_ACCESS_FALLBACK_ENV[budget!]}) in a fresh conversation`);
          model = fallback;
          tone = getToneForModel(model);
          framingVariant = currentFramingVariant(defaultFramingForModel(model));
          useToolAgent = requestUsesAgent(model, !!hasTools);
          session.newConversation();
          text = formatMessages(body.messages, body.tools, body.tool_choice, session.conversationId, framingVariant);
          inputImages = imageUrls(body.messages);
          originalText = text;
          attempt--;
          continue;
        }
        noteRequestOutcome(false, convId); // an answer, not a throttle
        log.info(`Priority access exhausted (${exhausted.window}) — resets ${exhausted.resetsAt.toISOString()}`);
        return { error: priorityAccessResponse(exhausted, model) };
      }

      if (copilotStream.hasContent || fullText.length > 0) {
        noteRequestOutcome(false, convId); // clean response → degradation has lifted
        if (useToolAgent) noteAgentRouteAlive(tone); // the agent route answered on this account
        conv.servedModel = model;
        inputImages = []; // on the server now: a forcing retry in this conversation needn't resend them
        return { fullText };
      }

      // Disengaged is a deliberate safety refusal, NOT a transient empty. Retrying
      // it with "Please continue." just disengages again and burns the 600-msg
      // quota (observed: 5 wasted messages in one turn). Fail fast with a clear
      // signal instead. Commonly fires when a heavy tool prompt is paired with a
      // non-default model/agent (e.g. a Claude tone + the declarative agent).
      if (copilotStream.messageType === "Disengaged") {
        // F22: the default framing's override-shape language occasionally trips Azure
        // Prompt Shields (jailbreak classifier) on benign requests (e.g. "replace X
        // with Y, leave everything else unchanged"). Retry ONCE with the low-override
        // `softened` framing in a FRESH conversation (a Disengaged conversation stays
        // Disengaged). Drops the worst-case disengage ~100%→~4%. Off via
        // M365_NO_DISENGAGE_RETRY.
        if (hasTools && !disengageRetried && !process.env.M365_NO_DISENGAGE_RETRY) {
          disengageRetried = true;
          session.newConversation();
          // `softened` is the low-override twin of the `<system>`-tagged framings.
          // A variant that deliberately avoids `<system>` tags (Claude Sonnet's
          // `relay`) keeps itself: swapping to `softened` would reintroduce
          // exactly the tag that model reads as a forged system prompt.
          const retryVariant = transcriptStyleForVariant(framingVariant).framingTag === "system" ? "softened" : framingVariant;
          text = formatMessages(body.messages, body.tools, body.tool_choice, session.conversationId, retryVariant);
          inputImages = imageUrls(body.messages);
          log.info(`Upstream Disengaged — retrying once with '${retryVariant}' framing in a fresh conversation (F22)`);
          attempt--; // free retry; bounded — disengageRetried flips once
          continue;
        }
        log.info("Upstream Disengaged — failing fast (no retry) to preserve quota");
        return {
          error: jsonResponse(502, {
            error: {
              message: "M365 Copilot disengaged from this request (its safety filter declined to answer). Common causes: too many tools, jailbreak-shaped instructions, or pairing a non-default model with the tool agent. Reduce the toolset or use the default model.",
              type: "disengaged",
            },
          }),
        };
      }

      // A content-less `InternalError` is a turn M365 dropped, and the
      // conversation it happened in tends to stay dropped: "Please continue."
      // into it came back `InternalError` again in 9 of 18 retries, against
      // 28 of 89 turns overall (Gpt_6_Sol_Reasoning on a non-premium account,
      // T3 Code driving Claude Code, 2026-10-14). The turn processed nothing,
      // so a "continue" has nothing to continue from either: re-send the
      // WHOLE request once in a fresh conversation instead. Not a free retry: it
      // spends an attempt, so a tone that fails every time still ends at the
      // premium-only / empty-response handling below. A premium-only model's
      // InternalError is deterministic (§24), so it skips straight there.
      if (
        !internalErrorFreshRetried &&
        copilotStream.result?.value === "InternalError" &&
        !copilotStream.hasContent && fullText.length === 0 &&
        !isPremiumOnlyModel(model) &&
        attempt < MAX_RETRIES
      ) {
        internalErrorFreshRetried = true;
        session.newConversation();
        text = formatMessages(body.messages, body.tools, body.tool_choice, session.conversationId, framingVariant);
        inputImages = imageUrls(body.messages);
        originalText = text;
        log.info(`Upstream InternalError — re-sending the whole request in a fresh conversation (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, SHORT_RETRY_DELAY_MS));
        continue;
      }

      // Empty response. Only an at-limit throttle warrants treating this as rate
      // limiting; otherwise it's a different failure (content filter, an invalid
      // agent/session, a transient upstream error) where a long escalating
      // backoff is futile and reads as a silent hang. Fail fast after a couple of
      // quick retries instead.
      const t = copilotStream.throttle;
      if (t && t.current >= t.max) {
        return { error: rateLimitResponse(t) };
      }
      if (attempt < MAX_RETRIES) {
        // A dead/deleted agent returns an instant empty reply (throttle: null).
        // Re-resolve the agent once before retrying so a long-lived host
        // self-heals from the deleted-agent trap instead of looping on empties.
        if (!agentRefreshed) {
          agentRefreshed = true;
          const agentChanged = await session.refreshAgent();
          if (agentChanged) {
            // The cached agent was stale/deleted and has been re-resolved.
            // Resend the original prompt to the fresh agent — a bare "continue"
            // would have no context since the dead agent processed nothing.
            log.info("Agent re-resolved after empty reply, resending original prompt");
            text = originalText;
            await new Promise(r => setTimeout(r, SHORT_RETRY_DELAY_MS));
            continue;
          }
        }
        log.info(`Empty upstream response, quick retry in ${SHORT_RETRY_DELAY_MS / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, SHORT_RETRY_DELAY_MS));
        // An empty turn may not have consumed the request. Retry its actual
        // prompt, including the task reference and command output, not a bare
        // continuation that assumes the missing context exists upstream.
        text = originalText;
      } else {
        // A model served only on a premium account, on a non-premium one (Opus
        // 4.8: BotConnection, `InternalError`, every time, with the agent and
        // without — §24, §36). Not a throttle, so it doesn't feed the degradation
        // backoff; say what it is instead of "empty response".
        if (isPremiumOnlyModel(model) && copilotStream.result?.value === "InternalError") {
          log.info(`${model}: InternalError on every attempt — premium-only model on a non-premium account?`);
          return { error: premiumOnlyModelResponse(model) };
        }
        // Final empty after retries, and not an at-limit (per-conversation) cap:
        // this is the thread-rate throttle signature (F13). Feed the degradation-
        // backoff policy — once empties span enough distinct conversations it paces
        // subsequent turns so the account can self-heal (H-R1). Never blocks this request.
        noteRequestOutcome(true, convId);
        return { error: emptyResponseResponse(t) };
      }
    }
    noteRequestOutcome(true, convId);
    return { error: emptyResponseResponse(null) };
  }

  // Produce the final turn result as DATA (not a Response), so the same logic
  // renders as either JSON (non-stream) or an early-flushed SSE stream (stream).
  // For streaming we return the SSE stream FIRST and run produce() INSIDE it, so the
  // client gets HTTP 200 + a role chunk + heartbeats immediately instead of waiting
  // out the whole (up to ~160s) M365 turn and risking a read-timeout.
  type Produced =
    | { kind: "error"; resp: Response }
    | { kind: "text"; text: string }
    | { kind: "tools"; toolCalls: ReturnType<typeof parseToolCalls>["toolCalls"] };

  // `onDelta` streams text to the client live (non-tool path only — see produce's
  // caller). Tool mode ignores it: the raw text is parsed for tool-call fences and
  // can't be shown verbatim, so it stays fully buffered.
  async function produceRaw(onDelta?: (delta: string) => void): Promise<Produced> {
  // When tools are present, buffer full response to detect tool calls
  if (hasTools) {
    // A <tool_response> the model wrote itself is a stop sequence: everything
    // after it is an invented result (see truncateAtFabricatedToolResponse).
    // `cutFabricated` reflects the attempt whose text is finally used.
    let cutFabricated = false;
    let droppedCalls = 0;
    const stopAtFabricatedResult = (raw: string): string => {
      const cut = truncateAtFabricatedToolResponse(raw, body.tools);
      cutFabricated = cut !== raw;
      if (cutFabricated) log.info(`Model wrote its own <tool_response> — cut ${raw.length - cut.length} fabricated chars (stop sequence)`);
      return cut;
    };
    const result = await runBuffered(onDelta);
    if ("error" in result) return { kind: "error", resp: result.error };
    conv.sentMessageCount = body.messages.length;
    conv.sentMessageSnapshot = body.messages.map(messageSnapshot);
    let fullText = stopAtFabricatedResult(result.fullText);

    log.debug("Raw response (tool mode):", trunc(fullText, 1000));
    let { parsed, judged } = parseReply(fullText, body.tools);
    log.info(`Parse result: hasToolCalls=${parsed.hasToolCalls}, count=${parsed.toolCalls.length}`);

    // Salvage stochastic turn-1 confabulation: M365's chat model sometimes claims it
    // "can't access the files / commands return no output" and asks the user to paste
    // them, WITHOUT calling a tool — even though the environment is real (the bench +
    // pi both reproduce this). Re-prompt forcefully in the SAME conversation (one
    // thread, cheap). Disable with M365_NO_CONFAB_RETRY; tune count with M365_CONFAB_RETRIES.
    const maxConfabRetries = process.env.M365_NO_CONFAB_RETRY
      ? 0
      : Number(process.env.M365_CONFAB_RETRIES ?? 1);
    // The model never actually acted if no assistant turn in the history carried a
    // tool call. Used to gate the hallucinated-completion retry (a model that did
    // real work called at least one tool), keeping false positives near zero.
    const everActed = (body.messages ?? []).some(
      (m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
    );
    for (let attempt = 0; attempt < maxConfabRetries && !parsed.hasToolCalls; attempt++) {
      const confab = looksLikeConfabulation(judged);
      const remoteArtifact = looksLikeRemoteArtifactCompletion(parsed.textContent);
      const halluc = !everActed && looksLikeHallucinatedCompletion(judged);
      if (!confab && !remoteArtifact && !halluc) break;
      const retryKind = remoteArtifact ? "Remote artifact completion" : confab ? "Confabulation" : "Hallucinated completion";
      log.info(`${retryKind} detected (no tool call) — forcing retry ${attempt + 1}/${maxConfabRetries}`);
      text = remoteArtifact ? REMOTE_ARTIFACT_FORCE_PROMPT
        : confab ? (everActed ? MIDTASK_FORCE_PROMPT : CONFAB_FORCE_PROMPT)
        : HALLUCINATION_FORCE_PROMPT;
      const retry = await runBuffered();
      if ("error" in retry) return { kind: "error", resp: retry.error };
      conv.sentMessageCount = body.messages.length;
      conv.sentMessageSnapshot = body.messages.map(messageSnapshot);
      fullText = stopAtFabricatedResult(retry.fullText);
      ({ parsed, judged } = parseReply(fullText, body.tools));
      if (confab && parsed.hasToolCalls) {
        parsed.textContent = parsed.textContent
          ? `TOOLS RESTORED\n\n${parsed.textContent}`
          : "TOOLS RESTORED";
      }
      log.info(`After forcing retry: hasToolCalls=${parsed.hasToolCalls}, count=${parsed.toolCalls.length}`);
    }

    // Never pass a remote M365 artifact off as a successful local edit. A retry
    // may merely transform a Teams URL into `sandbox:/mnt/data/...`; once the
    // configured attempts are exhausted, fail explicitly so the harness/user can
    // switch models instead of applying a nonexistent local file.
    //
    // Judge the FINAL text, not a sticky flag from the first attempt: a retry that
    // replaces the bogus mutation claim with a genuine answer ("I need the file
    // path first") has fixed the problem, and 502-ing it would be a regression.
    if (!parsed.hasToolCalls && looksLikeRemoteArtifactCompletion(parsed.textContent)) {
      log.info("Remote-artifact mutation claim persisted without a local tool call after forcing retries — failing closed");
      return {
        kind: "error",
        resp: jsonResponse(502, {
          error: {
            message: "M365 returned a remote Teams or /mnt/data artifact instead of calling the local editing tools. No local file was changed. Retry with gpt-5.5-think-deeper, the recommended model for tool calling.",
            type: "file_mutation_without_local_tool",
          },
        }),
      };
    }

    // Fail-closed: if model mixed text with tool calls, strip text and re-prompt once.
    // This enforces the "output ONLY a tool call" contract.
    if (parsed.hasToolCalls && parsed.textContent) {
      const extraText = parsed.textContent.trim();
      if (extraText.length > 0) {
        log.info(`Mixed output detected (${extraText.length} chars of text alongside ${parsed.toolCalls.length} tool calls), stripping text`);
        // Strip the text — the tool calls are what the client needs.
        // Log the stripped text for debugging but don't send it downstream.
        log.debug("Stripped text:", trunc(extraText, 500));
        parsed = { ...parsed, textContent: null };
      }
    }

    // Handle "reply" tool calls — convert to plain text
    if (parsed.hasToolCalls) {
      const replyCall = parsed.toolCalls.find(tc => tc.function.name === "reply");
      const realToolCalls = parsed.toolCalls.filter(tc => tc.function.name !== "reply");

      if (replyCall && realToolCalls.length === 0) {
        let replyText: string;
        try {
          const args = JSON.parse(replyCall.function.arguments);
          replyText = args.text || args.message || args.content || fullText;
        } catch {
          replyText = fullText;
        }
        log.info("Reply tool detected, converting to text response");
        return { kind: "text", text: replyText };
      }

      if (realToolCalls.length > 0) {
        parsed.toolCalls = realToolCalls;
      }

      // Enforce one tool call per turn unless explicitly opted out. M365 — the
      // reasoning tones especially — batches its whole plan into a single
      // response. Executing a batch runs later steps on guessed state and lets a
      // premature success claim ride along at the end. Keeping only the first
      // call forces a real step-by-step loop where each call reacts to the
      // previous tool_response. Set M365_ALLOW_MULTI_TOOL to restore batching.
      if (!process.env.M365_ALLOW_MULTI_TOOL && parsed.toolCalls.length > 1) {
        log.info(`One-call-per-turn: keeping ${parsed.toolCalls[0].function.name}, dropping ${parsed.toolCalls.length - 1} batched call(s)`);
        droppedCalls = parsed.toolCalls.length - 1;
        parsed.toolCalls = [parsed.toolCalls[0]];
      }
    }

    if (parsed.hasToolCalls && parsed.toolCalls.length > 0) {
      // A heredoc file write past the Windows command-line cap would reach the
      // shell cut short; run the same write through the harness's write tool.
      const asWrite = longHeredocAsWrite(parsed.toolCalls[0], body.tools);
      let rewriteNote: string | null = null;
      if (asWrite) {
        log.info(`Heredoc write to ${asWrite.path} is over the Windows command-line cap — sent as ${asWrite.call.function.name} instead`);
        parsed.toolCalls = [asWrite.call];
        rewriteNote = `(Note: your heredoc to \`${asWrite.path}\` was longer than the ~8,000-character Windows command-line limit and would have been cut off, so it was written with the \`${asWrite.call.function.name}\` tool instead.${asWrite.skipped ? ` The commands after the heredoc did NOT run: \`${asWrite.skipped.slice(0, 200)}\`.` : ""})`;
      }
      // The model's server-side history holds more than what runs; say so on
      // the turn that carries the real result (executedOnlyFirstNote).
      const notes = [rewriteNote, executedOnlyFirstNote(cutFabricated, droppedCalls, textAfterFirstToolCall(fullText, body.tools).length)].filter(Boolean);
      conv.pendingNote = notes.length ? notes.join("\n") : null;
      return { kind: "tools", toolCalls: parsed.toolCalls };
    }
    return { kind: "text", text: fullText };
  } else {
    // No tools — stream deltas live (onDelta) while buffering for the retry logic.
    const result = await runBuffered(onDelta);
    if ("error" in result) return { kind: "error", resp: result.error };
    conv.sentMessageCount = body.messages.length;
    conv.sentMessageSnapshot = body.messages.map(messageSnapshot);
    return { kind: "text", text: result.fullText };
  }

  } // end produceRaw()

  async function produce(onDelta?: (delta: string) => void): Promise<Produced> {
    const result = await produceRaw(onDelta);
    if (result.kind === "text") {
      result.text = await sanitizeImagePayloads(result.text);
    } else if (result.kind === "tools") {
      const cleanValue = async (value: unknown): Promise<unknown> => {
        if (typeof value === "string") return sanitizeImagePayloads(value);
        if (Array.isArray(value)) return Promise.all(value.map(cleanValue));
        if (value !== null && typeof value === "object") {
          const entries = await Promise.all(Object.entries(value).map(
            async ([key, item]) => [key, await cleanValue(item)] as const
          ));
          return Object.fromEntries(entries);
        }
        return value;
      };
      for (const call of result.toolCalls) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(call.function.arguments);
        } catch {
          call.function.arguments = await sanitizeImagePayloads(call.function.arguments);
          continue;
        }
        call.function.arguments = JSON.stringify(await cleanValue(parsed));
      }
    } else {
      const content = await sanitizeImagePayloads(await result.resp.text());
      const headers = new Headers(result.resp.headers);
      headers.delete("content-length");
      result.resp = new Response(content, {
        status: result.resp.status,
        statusText: result.resp.statusText,
        headers,
      });
    }
    lastCompletionTokens = result.kind === "text"
      ? estimateTokens(result.text)
      : result.kind === "tools"
        ? result.toolCalls.reduce(
            (sum, call) => sum + estimateTokens(call.function.name + call.function.arguments),
            0,
          )
        : 0;
    await localChatEvent(convId, "SALE", model,
      result.kind === "error"
        ? { status: result.resp.status, error: await result.resp.clone().text() }
        : result);
    return result;
  }


  // --- Render: JSON (non-stream) or an early-flushed SSE stream (stream) ---
  const includeUsage = !!body.stream_options?.include_usage;
  const usage = () => buildUsage(lastThrottle, lastContentOrigin, lastMessageType, lastScores, lastTurnCount, lastMetering, { prompt: promptTokens, completion: lastCompletionTokens });

  if (!body.stream) {
    const p = await produce();
    if (p.kind === "error") return p.resp;
    if (p.kind === "tools") {
      return jsonResponse(200, {
        id: completionId, object: "chat.completion", created, model,
        choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: p.toolCalls }, finish_reason: "tool_calls" }],
        usage: usage(),
      });
    }
    return jsonResponse(200, {
      id: completionId, object: "chat.completion", created, model,
      choices: [{ index: 0, message: { role: "assistant", content: p.text }, finish_reason: outputFinishReason(p.text) }],
      usage: usage(),
    });
  }

  // Streaming: send HTTP 200 + a role chunk + keepalive comments from t=0, then run
  // produce() INSIDE the stream so the client never waits out the whole M365 turn
  // (up to ~160s) before the first byte — avoids client read-timeouts.
  //
  // On the non-tool path we forward each text delta AS IT ARRIVES (`liveDelta`), so
  // `stream:true` is genuinely incremental. Tool mode still buffers: the raw text is
  // parsed for tool-call fences and can't be shown verbatim, so its tool_calls (or a
  // prose fallback) are emitted once at the end.
  return sseResponse(new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (obj: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
      const base = { id: completionId, object: "chat.completion.chunk", created, model };
      send({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
      // Keepalive: a REAL empty-delta chunk, not an SSE comment. Agents that track
      // stream liveness by data chunks (e.g. Hermes: comments don't reset its
      // `last_chunk_time`, so a silent turn shows "N s without stream output" and can
      // trip its stale watchdog) see this as activity. No content is added — an empty
      // delta contributes nothing to the assembled message.
      const hb = setInterval(() => {
        try { send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: null }] }); } catch {}
      }, 15000);

      // Synthetic proxy status, NOT model reasoning. Keep it out of content
      // and tool arguments. Clients without reasoning_content support ignore it.
      // Preserve the waiting indicator on tool-capable turns too. Its
      // reasoning segment ends at the first upstream output, before a
      // recognised tool header starts native tool input.
      //
      // Shown for every model whose id doesn't say "think": the `*-think-deeper`
      // reasoning models may stream thinking of their own, and stacking a
      // fabricated "The model is thinking internally." on top of it muddles the
      // two. `M365_WAIT_INDICATOR=0` turns it off everywhere.
      const thinkingModel = /think/i.test(model) ||
        (typeof requestedModel === "string" && /think/i.test(requestedModel));
      const waitingEnabled = process.env.M365_WAIT_INDICATOR !== "0" && !thinkingModel;
      let waitingTicks = 0;
      let waitingElapsedTicks = 0;
      let upstreamOutputStarted = false;
      const waitingTimer = waitingEnabled ? setInterval(() => {
        if (opts.signal?.aborted || upstreamOutputStarted || startedTool || sent.length > 0 || waitingTicks >= 120) return;
        // Show Thinking only after two seconds of uninterrupted waiting.
        // Fast responses go straight to prose/tool input without a flash.
        // Once visible, keep adding one dot per second.
        if (++waitingElapsedTicks < 2) return;
        const status = waitingTicks++ === 0
          ? "The model is thinking internally."
          : ".";
        try {
          send({ ...base, choices: [{
            index: 0, delta: { reasoning_content: status }, finish_reason: null,
          }] });
        } catch {}
      }, 1000) : undefined;

      // Stream only an irrevocably safe prose prefix. Keep potential image
      // payloads, tool fences and fabricated results buffered for final parsing.
      // A suffix holdback catches markers split across arbitrary deltas.
      let sent = "";
      let pending = "";
      let blocked = false;
      let startedTool: { id: string; name: string } | undefined;
      const markers = ["data:" + "image/", "iVBORw0KGgo", "/9j/", "UklGR", "!["];
      if (hasTools) markers.push("<tool_", "<invoke", "<function");
      const toolFenceNames = hasTools ? [...buildSpecMap(body.tools ?? []).keys()] : [];
      const streamEverActed = body.messages.some(
        message => message.role === "assistant" &&
          Array.isArray(message.tool_calls) && message.tool_calls.length > 0,
      );
      const liveDelta = (delta: string) => {
        if (delta && !upstreamOutputStarted) {
          upstreamOutputStarted = true;
          if (waitingTimer !== undefined) clearInterval(waitingTimer);
          // OpenAI-compatible clients end an open reasoning segment when
          // tool_calls is present, including an empty array. Close the
          // synthetic waiting segment as soon as upstream output starts,
          // even while a split tool header is still being classified.
          // This announces no tool and commits no executable arguments.
          if (waitingTicks > 0) {
            send({ ...base, choices: [{
              index: 0, delta: { tool_calls: [] }, finish_reason: null,
            }] });
          }
        }
        if (!delta || blocked) return;
        pending += delta;
        if (couldBePriorityAccessPrefix(pending)) return;
        // Tool-mode retries may replace a refusal or a fabricated completion.
        // Do not expose such a draft before the existing checks have judged it.
        if (hasTools && (
          looksLikeConfabulation(pending) ||
          (!streamEverActed && looksLikeHallucinatedCompletion(pending)) ||
          looksLikeRemoteArtifactCompletion(pending)
        )) {
          blocked = true;
          return;
        }
        const lower = pending.toLowerCase();
        let end = pending.length;
        for (const marker of markers) {
          const index = lower.indexOf(marker.toLowerCase());
          if (index >= 0) end = Math.min(end, index);
        }
        // A normal code example is prose, not a tool call. Hold only an
        // incomplete fence header or a header recognised by the tool parser.
        // Re-evaluate incomplete headers on every delta instead of permanently
        // blocking the stream at the first backticks.
        if (hasTools) {
          const fences = /```([A-Za-z0-9_.-]*)([ \t]*)(\r?\n|$)/g;
          for (const match of pending.matchAll(fences)) {
            const name = match[1];
            const incomplete = match[3] === "";
            if (!incomplete && name && toolFenceNames.includes(name)) {
              end = Math.min(end, match.index!);
              blocked = true;
              // Start a real tool-input stream, not a synthetic status message.
              // Announce opening command/editing fences through native tool
              // input events. Arguments remain buffered and validated.
              const spec = buildSpecMap(body.tools ?? []).get(name);
              if (!startedTool && spec &&
                  ["bash", "shell", "sh", "zsh", "run", "exec", "execute", "command", "cmd", "terminal", "run_command", "run_terminal_cmd", "execute_command", "execute_bash", "shell_exec", "system", "patch", "apply_patch", "edit", "write", "edit_file", "write_file"].includes(spec.name) &&
                  pending.slice(0, match.index).trim() === "") {
                startedTool = {
                  id: `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
                  name: spec.name,
                };
                send({ ...base, choices: [{
                  index: 0,
                  delta: { tool_calls: [{
                    index: 0, id: startedTool.id, type: "function",
                    function: { name: startedTool.name, arguments: "" },
                  }] },
                  finish_reason: null,
                }] });
              }
              break;
            }
            if (incomplete && toolFenceNames.some(tool => tool.startsWith(name))) {
              end = Math.min(end, match.index!);
            }
          }
          // The opening backticks themselves may span several deltas.
          // Only hold when they look like a fence opener at start of line (not inline code).
          const partialTicks = /(?:^|\r?\n)[ \t]*`{1,3}$/.exec(pending);
          if (partialTicks) end = Math.min(end, partialTicks.index);
        }
        if (markers.some(marker => lower.includes(marker.toLowerCase()))) blocked = true;
        // Delay tool-mode prose classification; never show a raw tool block.
        if (hasTools && pending.length < 48 && !blocked) return;
        if (!blocked) {
          for (const marker of markers) {
            for (let size = 1; size < marker.length; size++) {
              if (lower.endsWith(marker.slice(0, size).toLowerCase())) {
                end = Math.min(end, pending.length - size);
              }
            }
          }
          // Marker-prefix holdback above is sufficient; do not delay every
          // ordinary token by a fixed 24-character tail.
        }
        if (end <= sent.length) return;
        const content = pending.slice(sent.length, end);
        sent += content;
        try {
          send({ ...base, choices: [{ index: 0, delta: { content }, finish_reason: null }] });
        } catch {}
      };

      let p: Produced;
      try { p = await produce(liveDelta); }
      catch (err: any) { p = { kind: "error", resp: jsonResponse(502, { error: { message: err?.message ?? "stream error", type: "upstream_error" } }) }; }
      // Never change a tool's identity after announcing it. A rewritten call
      // or divergent final snapshot must fail rather than execute the wrong tool.
      if (startedTool && p.kind !== "error" &&
          (p.kind !== "tools" || p.toolCalls[0]?.function.name !== startedTool.name)) {
        p = { kind: "error", resp: jsonResponse(502, { error: {
          message: "The final response changed an announced tool call. No tool arguments were committed; retry the request.",
          type: "tool_stream_mismatch",
        } }) };
      }
      clearInterval(hb);
      if (waitingTimer !== undefined) clearInterval(waitingTimer);
      try {
        if (p.kind === "error") {
          let message = "upstream error";
          let type = "upstream_error";
          let code: string | undefined;
          // Carry the structured fields through, not just the prose: a streaming
          // client still has to tell a priority-access wall (back off until the
          // reset) from a transient upstream failure (retry now), and the status
          // code it would have read is gone once HTTP 200 is committed.
          try {
            const parsed = JSON.parse(await p.resp.text())?.error;
            if (parsed?.message) message = parsed.message;
            if (parsed?.type) type = parsed.type;
            if (parsed?.code) code = parsed.code;
          } catch {}
          const retryAfter = p.resp.headers.get("Retry-After");
          // HTTP 200 is already committed, so surface the failure as an in-stream error chunk.
          send({ ...base, error: { message, type, ...(code ? { code } : {}), ...(retryAfter ? { retry_after: Number(retryAfter) } : {}) } });
        } else if (p.kind === "tools") {
          p.toolCalls.forEach((tc, i) => {
            log.debug(`Tool call: ${tc.function.name} ${trunc(tc.function.arguments, 200)}`);
            if (i === 0 && startedTool) {
              send({ ...base, choices: [{
                index: 0,
                delta: { tool_calls: [{
                  index: 0, function: { arguments: tc.function.arguments },
                }] },
                finish_reason: null,
              }] });
            } else {
              send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: tc.function.arguments } }] }, finish_reason: null }] });
            }
          });
          send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], ...(includeUsage ? { usage: usage() } : {}) });
        } else {
          // Emit only what wasn't already streamed live: the whole text if nothing was
          // (tool-mode prose fallback, or a fully-buffered turn), or just the tail when
          // live deltas already covered a prefix. If `sent` somehow isn't a prefix of
          // the final text (a divergent snapshot upstream chose not to stream), fall
          // back to sending nothing more rather than duplicating already-sent bytes.
          const remainder = p.text.startsWith(sent) ? p.text.slice(sent.length) : "";
          if (!p.text.startsWith(sent)) log.info(`Streamed prefix diverged from final text (sent ${sent.length}, final ${p.text.length} chars) — not re-sending to avoid duplication`);
          if (remainder) send({ ...base, choices: [{ index: 0, delta: { content: remainder }, finish_reason: null }] });
          send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: outputFinishReason(p.text) }], ...(includeUsage ? { usage: usage() } : {}) });
        }
      } catch {
        // client likely disconnected mid-emit — nothing more to do
      } finally {
        try { controller.enqueue(enc.encode("data: [DONE]\n\n")); controller.close(); } catch {}
      }
    },
  }));
}

/**
 * Build the OpenAI-style `usage` block from whatever diagnostic info M365 gave
 * us. Token counts are NOT exposed by M365's WebSocket API (we'd need to count
 * locally with a tokenizer that matches the underlying model — see the doc on
 * token-usage hypotheses). What M365 does send is a **conversation quota**:
 * how many user messages out of the 600-per-conversation cap have been spent.
 *
 * That's a different axis from token-window utilisation, but it's the closest
 * thing we have to "remaining budget", so we surface it as extension fields
 * (`x_m365_*`) alongside the zeroed standard counters. Real OpenAI clients
 * ignore unknown extension fields; curious users can read them.
 */
function buildUsage(
  throttle: { current: number; max: number } | null,
  contentOrigin?: string | null,
  messageType?: string | null,
  scores?: Record<string, number> | null,
  turnCount?: number | null,
  metering?: Record<string, number> | null,
  tokens?: { prompt: number; completion: number },
): Record<string, unknown> {
  // Estimated (see estimateTokens): M365 exposes no token counts, but OpenAI
  // clients size their context meter from these fields. Zeroes made the meter
  // useless; a local estimate tracks the conversation and is the best available.
  const promptTokens = tokens?.prompt ?? 0;
  const completionTokens = tokens?.completion ?? 0;
  const base: Record<string, unknown> = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
  if (promptTokens > 0 || completionTokens > 0) base.x_m365_tokens_source = "estimated";
  if (throttle) {
    base.x_m365_conversation_messages = throttle.current;
    base.x_m365_conversation_max = throttle.max;
    base.x_m365_conversation_pct = Math.min(100, Math.round((throttle.current / throttle.max) * 100));
    base.x_m365_conversation_remaining = Math.max(0, throttle.max - throttle.current);
  }
  if (contentOrigin) base.x_m365_content_origin = contentOrigin;
  if (messageType) base.x_m365_message_type = messageType;
  if (typeof turnCount === "number") base.x_m365_turn_count = turnCount;
  // Disengaged-classifier scores. Empirically: clean tool calls sit at
  // ~1e-13 / ~1e-8, jailbreak-shaped prompts climb to ~1e-3 / ~1e-3. The
  // `dea_violation` component is the one that actually correlates with the
  // Disengaged filter firing — surface that explicitly so clients can monitor
  // their proximity to the threshold.
  if (scores) {
    base.x_m365_classifier_scores = scores;
    if (typeof scores.dea_violation === "number") base.x_m365_dea_score = scores.dea_violation;
    if (typeof scores.BotOffense === "number") base.x_m365_offense_score = scores.BotOffense;
  }
  // Priority access left after this turn (paid-scenario turns only, §24 F55,
  // §26): one unit per turn, so a client can see the wall coming (issue #18).
  // `x_m365_opus_*` for Opus 5.5, `x_m365_sonnet55_*` for Sonnet 5.5.
  for (const [budget, { usageKey }] of Object.entries(METERED_BUDGETS)) {
    const left = meteredAllowance(metering, budget as MeteredBudget);
    if (left?.daily !== undefined) base[`x_m365_${usageKey}_daily_remaining`] = left.daily;
    if (left?.weekly !== undefined) base[`x_m365_${usageKey}_weekly_remaining`] = left.weekly;
  }
  return base;
}

// --- Helpers ---

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** A priority-access budget (Opus 5.5, Sonnet 5.5) ran out. A real 429 (with `Retry-After` and
 *  the UTC reset instant) so a client backs off to the refill instead of
 *  retrying into a wall — and so an agent loop doesn't treat the refusal text as
 *  the model's answer. Resets at midnight UTC; the weekly budget on Monday. */
function priorityAccessResponse(exhaustion: PriorityAccessExhaustion, model: string): Response {
  const retryAfter = secondsUntilReset(exhaustion);
  const label = exhaustion.model ?? model;
  const when = exhaustion.window === "week" ? "this week" : "today";
  return jsonResponse(
    429,
    {
      error: {
        message:
          `M365 Copilot's priority access to ${label} is used up for ${when} ` +
          `(resets ${exhaustion.resetsAt.toISOString()}, i.e. midnight UTC` +
          `${exhaustion.window === "week" ? " on Monday" : ""}). ` +
          `Switch to another model (e.g. claude-sonnet or gpt-5.5-think-deeper) or wait. ` +
          `Upstream said: ${exhaustion.message}`,
        type: "rate_limit_error",
        code: "priority_access_exhausted",
        param: exhaustion.window,
      },
    },
    { "Retry-After": String(retryAfter) },
  );
}

function sseResponse(stream: ReadableStream): Response {
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

function rateLimitMessage(throttle: { current: number; max: number } | null): string {
  return throttle
    ? `M365 Copilot rate limited (${throttle.current}/${throttle.max} messages used). Please wait and try again.`
    : "M365 Copilot returned an empty response. You may be rate limited. Please wait and try again.";
}

function rateLimitResponse(throttle: { current: number; max: number } | null): Response {
  return jsonResponse(429, { error: { message: rateLimitMessage(throttle), type: "rate_limit_error" } });
}

/** M365 explicitly throttled the turn (`result.value: "Throttled"`). It names
 *  the scope (`PerUserThrottled`) but not the duration, so no Retry-After is
 *  invented. */
function throttledResponse(result: { errorCode?: string; message?: string }): Response {
  const scope = result.errorCode ? ` (${result.errorCode})` : "";
  return jsonResponse(429, {
    error: {
      message: `M365 Copilot throttled this account${scope}: ${result.message ?? "too many requests"} ` +
        `Retrying immediately does not help; it is triggered by starting many new conversations in a short time.`,
      type: "rate_limit_error",
      code: "m365_throttled",
      ...(result.errorCode ? { param: result.errorCode } : {}),
    },
  });
}

/** M365_AVOID_THROTTLING would have had to wait longer than this request may
 *  (a throttle hold, usually), so the turn was never sent: sending it would only
 *  keep the throttle alive. Whatever retries the client makes are answered here
 *  the same way, without reaching M365. */
function turnBudgetHoldResponse(hold: TurnBudgetHold): Response {
  const retryAfter = Math.max(1, Math.ceil(hold.waitMs / 1000));
  return jsonResponse(
    429,
    {
      error: {
        message: `Not sent to M365 Copilot (M365_AVOID_THROTTLING): ${hold.message}.`,
        type: "rate_limit_error",
        code: hold.reason === "throttle hold" ? "m365_throttle_hold" : "m365_turn_budget",
      },
    },
    { "Retry-After": String(retryAfter) },
  );
}

/** Empty upstream reply that is NOT an at-limit throttle — a distinct failure
 *  (content filter, invalid agent/session, transient error) we surface clearly
 *  instead of hanging on a long retry loop. */
function emptyResponseResponse(throttle: { current: number; max: number } | null): Response {
  const detail = throttle ? ` (throttle ${throttle.current}/${throttle.max})` : "";
  return jsonResponse(502, {
    error: {
      message: `M365 Copilot returned an empty response${detail} — likely a content filter, an invalid agent/session, or a transient upstream error.`,
      type: "upstream_empty_response",
    },
  });
}

function premiumOnlyModelResponse(model: string): Response {
  return jsonResponse(502, {
    error: {
      message: `M365 Copilot didn't serve ${model}: it returned InternalError on every attempt. ${model} is served only on a premium (paid Microsoft 365 Copilot) account; on any other account use claude-sonnet.`,
      type: "upstream_error",
      code: "model_route_unavailable",
    },
  });
}

// (streaming is emitted inline by the early-flushed SSE renderer in
// handleChatCompletion; the old streamText/streamToolCalls helpers were removed.)

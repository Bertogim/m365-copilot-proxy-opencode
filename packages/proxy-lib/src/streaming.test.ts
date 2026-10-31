import { describe, it, expect, vi, afterEach } from "vitest";

// Replace core's ModelSession with a scripted fake so we can exercise the handler's
// streaming path with no auth/WebSocket. Everything else in core stays real.
const scripted: {
  deltas: string[];
  fullText?: string;
  /** Script an upstream `result` (e.g. Throttled) on a turn with no content. */
  result?: { value: string; errorCode?: string; message?: string } | null;
  runs: number;
  /** Text of every run() call, in order. */
  texts: string[];
  /** Per-call overrides, consumed front-first (e.g. a Disengaged turn, then an answer). */
  queue: Array<{ fullText: string; messageType?: string | null; result?: { value: string; errorCode?: string; message?: string }; metering?: Record<string, number> }>;
  /** The model argument of every run() call, in order. */
  models: string[];
  /** The `useAgent` argument of every run() call, in order. */
  agentFlags: Array<boolean | undefined>;
  /** The image data URLs of every run() call, in order. */
  images: string[][];
  /** How many times the handler rotated to a fresh conversation. */
  newConversations: number;
  /** Held open to keep a turn silent while a test advances the clock (heartbeat tests). */
  gate: Promise<void> | null;
  /** The abort signal of every run() call, in order. */
  signals: Array<AbortSignal | undefined>;
  /** Deltas yielded by the last run() before its signal aborted it (the Stop), or null if it ran out. */
  stoppedAfter: number | null;
  /** Make `fullText` grow with the deltas yielded so far, like the real stream's composed answer. */
  liveFullText?: boolean;
  /** What awaitTurnBudget (M365_AVOID_THROTTLING) throws before every turn, or null to let it through. */
  budgetHold: Error | null;
  /** The options of every awaitTurnBudget call, in order. */
  awaitTurnBudgetCalls: Array<{ maxWaitMs?: number; signal?: AbortSignal }>;
  /** The `waitForBudget` argument of every run() call, in order (one function per call). */
  budgetWaits: Array<(() => Promise<unknown>) | undefined>;
} = { deltas: [], runs: 0, texts: [], queue: [], agentFlags: [], newConversations: 0, models: [], images: [], gate: null, signals: [], stoppedAfter: null, budgetHold: null, awaitTurnBudgetCalls: [], budgetWaits: [] };

vi.mock("@m365-copilot/core", async (importActual) => {
  const actual = await importActual<typeof import("@m365-copilot/core")>();
  let sessionsMade = 0;
  class FakeModelSession {
    readonly uid = ++sessionsMade;
    turnCount = 0;
    conversationId = "conv-test";
    reset() {}
    newConversation() { this.conversationId = "conv-test-2"; this.turnCount = 0; scripted.newConversations++; }
    async refreshAgent() { return false; }
    async run(text: string, model?: string, signal?: AbortSignal, useAgent?: boolean, images: string[] = [], waitForBudget?: () => Promise<unknown>) {
      if (scripted.gate) await scripted.gate;
      scripted.budgetWaits.push(waitForBudget);
      scripted.models.push(model ?? "");
      scripted.images.push(images);
      scripted.signals.push(signal);
      scripted.stoppedAfter = null;
      this.turnCount++; // like the real session: later requests go down the delta path
      scripted.runs++;
      scripted.texts.push(text);
      scripted.agentFlags.push(useAgent);
      servedBy.push(this.uid);
      const next = scripted.queue.shift();
      const deltas = next ? (next.fullText ? [next.fullText] : []) : scripted.deltas;
      const full = next ? next.fullText : (scripted.fullText ?? deltas.join(""));
      const yielded: string[] = [];
      const stream = {
        get fullText() { return scripted.liveFullText ? yielded.join("") : full; },
        hasContent: full.length > 0,
        result: next?.result ?? scripted.result ?? { value: "Success" },
        metering: next?.metering ?? null,
        images: [],
        throttle: { current: 1, max: 600 },
        contentOrigin: "Claude",
        messageType: (next?.messageType ?? null) as string | null,
        messageId: "m1",
        scores: null,
        turnCount: 1,
        turnState: "Completed",
        async *[Symbol.asyncIterator]() {
          for (const d of deltas) {
            await Promise.resolve(); // yield to the event loop between deltas
            // Like the real session: an aborted signal sends Stop and the turn ends.
            if (signal?.aborted) { scripted.stoppedAfter = yielded.length; return; }
            yielded.push(d);
            yield d;
          }
        },
      };
      return stream;
    }
  }
  // awaitTurnBudget reads the account's real logs; script its verdict instead.
  async function awaitTurnBudget(opts: { maxWaitMs?: number; signal?: AbortSignal } = {}) {
    scripted.awaitTurnBudgetCalls.push(opts);
    if (scripted.budgetHold) throw scripted.budgetHold;
    return { waitedMs: 0 };
  }
  return { ...actual, ModelSession: FakeModelSession, awaitTurnBudget };
});

/** Which fake ModelSession (by creation order) served every run() call, in order. */
const servedBy: number[] = [];

const { handleChatCompletion, SessionPool, ChatCompletionRequest } = await import("./index.js");
const { resetAgentRoutes, resetPriorityAccessState, TurnBudgetHold } = await import("@m365-copilot/core");

// The proxy remembers a priority-access wall for the process (until the reset);
// don't let one test's refusal 429 the next test's Opus request.
afterEach(() => resetPriorityAccessState());

/** One request on a fresh pool with a fake clock: an empty upstream turn makes
 *  the handler wait 2 s before each quick retry, and that wait is the handler's
 *  own pacing, not what these tests check. */
async function respond(body: ReturnType<typeof ChatCompletionRequest.parse>): Promise<Response> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const pending = handleChatCompletion(body, new SessionPool());
    await vi.runAllTimersAsync();
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

/** Drive one streaming request and collect the ordered content-delta strings. */
async function streamContents(deltas: string[], fullText?: string): Promise<string[]> {
  scripted.deltas = deltas;
  scripted.fullText = fullText;
  const body = ChatCompletionRequest.parse({
    model: "m365-copilot",
    stream: true,
    messages: [{ role: "user", content: "hello" }],
  });
  const res = await handleChatCompletion(body, new SessionPool());
  expect(res.status).toBe(200);
  const text = await res.text();

  const contents: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6);
    if (payload === "[DONE]") continue;
    const chunk = JSON.parse(payload);
    const c = chunk.choices?.[0]?.delta?.content;
    if (typeof c === "string" && c.length > 0) contents.push(c);
  }
  return contents;
}

describe("filtered streaming (non-tool path)", () => {
  it("streams ordinary prose incrementally while preserving the complete answer", async () => {
    const contents = await streamContents(["Hello", ", ", "world", "! This is a longer answer.", " More text arrives now."]);
    // Safe prose arrives in multiple chunks; image payloads remain filtered.
    expect(contents.length).toBeGreaterThan(1);
    // Lossless and in-order: reconstructs the full answer exactly once.
    expect(contents.join("")).toBe("Hello, world! This is a longer answer. More text arrives now.");
  });

  it("filters an image data URL even when its prefix spans multiple upstream deltas", async () => {
    // Invalid image bytes: no file should be saved, and no data URL may leak.
    const contents = await streamContents(["Antes ", "data:im", "age/png;base64,", "AAAA", " despues"]);
    const text = contents.join("");
    expect(text).toContain("Antes ");
    expect(text).toContain("despues");
    expect(text).not.toContain("data:image");
    expect(text).not.toContain("AAAA");
    expect(text).toContain("Image omitted");
  });

  it("emits the trailing remainder once when the final text outruns the delta stream", async () => {
    // Deltas cover a prefix ("Hello wor"); the authoritative full text is longer —
    // the renderer must send the "ld" tail exactly once, never re-send the prefix.
    const contents = await streamContents(["Hello ", "wor"], "Hello world");
    expect(contents.join("")).toBe("Hello world");
    // No duplicated prefix.
    expect(contents.join("").match(/Hello/g)?.length).toBe(1);
  });
});

describe("usage token estimates (OpenCode v1/v2 context meter)", () => {
  const body = (content: string, stream: boolean) => ChatCompletionRequest.parse({
    model: "gpt-6.1-sol",
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content },
    ],
  });

  afterEach(() => {
    delete process.env.M365_TOKEN_ESTIMATE;
    scripted.deltas = [];
    scripted.fullText = undefined;
  });

  it("reports non-zero prompt/completion tokens in the non-stream usage block", async () => {
    scripted.deltas = ["Hello there, this is a complete answer."];
    scripted.fullText = "Hello there, this is a complete answer.";
    const res = await respond(body("x".repeat(4000), false));
    const usage = (await res.json()).usage;
    expect(usage.prompt_tokens).toBeGreaterThan(0);
    expect(usage.completion_tokens).toBeGreaterThan(0);
    expect(usage.total_tokens).toBe(usage.prompt_tokens + usage.completion_tokens);
    expect(usage.x_m365_tokens_source).toBe("estimated");
    // ~4 chars/token, so a 4k-char user turn lands near 1k prompt tokens.
    expect(usage.prompt_tokens).toBeGreaterThan(900);
  });

  it("sends the same estimate in the final streaming chunk when include_usage is set", async () => {
    scripted.deltas = ["streamed answer"];
    scripted.fullText = "streamed answer";
    const res = await handleChatCompletion(body("y".repeat(800), true), new SessionPool());
    const text = await res.text();
    let usage: any;
    for (const line of text.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6);
      if (payload === "[DONE]") continue;
      const chunk = JSON.parse(payload);
      if (chunk.usage) usage = chunk.usage;
    }
    expect(usage).toBeDefined();
    expect(usage.prompt_tokens).toBeGreaterThan(0);
    expect(usage.completion_tokens).toBeGreaterThan(0);
    expect(usage.total_tokens).toBe(usage.prompt_tokens + usage.completion_tokens);
  });

  it("can be turned off with M365_TOKEN_ESTIMATE=0", async () => {
    process.env.M365_TOKEN_ESTIMATE = "0";
    scripted.deltas = ["answer"];
    scripted.fullText = "answer";
    const usage = (await (await respond(body("hello", false))).json()).usage;
    expect(usage.prompt_tokens).toBe(0);
    expect(usage.completion_tokens).toBe(0);
    expect(usage.total_tokens).toBe(0);
    expect(usage.x_m365_tokens_source).toBeUndefined();
  });
});

describe("keepalive on a silent turn (tool turns are buffered, so the stream can be quiet for minutes)", () => {
  it("sends a data chunk, not an SSE comment, so a client's last-chunk clock keeps ticking", async () => {
    // A stream carrying only comments looks alive at the socket but dead to a client that
    // measures liveness by data chunks: it warns "no stream output" and can trip its stale
    // watchdog, reconnecting (and re-sending the turn) mid-flight.
    scripted.deltas = ["listo"];
    scripted.fullText = "listo";
    let release!: () => void;
    scripted.gate = new Promise<void>((r) => { release = r; });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      const body = ChatCompletionRequest.parse({
        model: "m365-copilot",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      });
      const pending = handleChatCompletion(body, new SessionPool()).then((res) => res.text());
      await vi.advanceTimersByTimeAsync(16_000); // the turn has said nothing yet
      release();
      const text = await pending;

      // At least one heartbeat, and it is a no-op data chunk (empty delta, no finish
      // marker). A client that resets its liveness clock on data chunks sees the turn
      // as live; the comment this replaced (`: keepalive`) it does not see at all.
      const beats = text
        .split("\n")
        .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
        .map((l) => JSON.parse(l.slice(6)))
        .filter((c) => c.choices?.[0]?.finish_reason === null && Object.keys(c.choices[0].delta ?? {}).length === 0);
      expect(beats.length).toBeGreaterThan(0);

      // The heartbeat is a no-op: the turn's own text is still emitted exactly once.
      const contents = text
        .split("\n")
        .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
        .map((l) => JSON.parse(l.slice(6)).choices?.[0]?.delta?.content)
        .filter((c) => typeof c === "string" && c.length > 0);
      expect(contents.join("")).toBe("listo");
    } finally {
      scripted.gate = null;
      vi.useRealTimers();
    }
  });
});

/** Drive one streaming request and collect content deltas AND error chunks. */
async function streamRaw(
  deltas: string[],
  fullText?: string,
): Promise<{ contents: string[]; errors: any[] }> {
  scripted.deltas = deltas;
  scripted.fullText = fullText;
  const body = ChatCompletionRequest.parse({
    model: "claude-opus",
    stream: true,
    messages: [{ role: "user", content: "hello" }],
  });
  const res = await handleChatCompletion(body, new SessionPool());
  const text = await res.text();

  const contents: string[] = [];
  const errors: any[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6);
    if (payload === "[DONE]") continue;
    const chunk = JSON.parse(payload);
    const c = chunk.choices?.[0]?.delta?.content;
    if (typeof c === "string" && c.length > 0) contents.push(c);
    if (chunk.error) errors.push(chunk.error);
  }
  return { contents, errors };
}

describe("priority-access exhaustion on the streaming path", () => {
  const REFUSAL =
    "You've used your available priority access to the Opus model for today. " +
    "You can choose another available model or wait until tomorrow to use the Opus model again.";

  it("never leaks the refusal to the client as content", async () => {
    // Chunked the way M365 actually streams it — the gate must hold the head.
    const deltas = REFUSAL.match(/.{1,12}/g)!;
    const { contents } = await streamRaw(deltas);
    expect(contents.join("")).not.toContain("priority access");
    expect(contents.join("")).toBe("");
  });

  it("emits a machine-readable error chunk, not just prose", async () => {
    const { errors } = await streamRaw(REFUSAL.match(/.{1,12}/g)!);
    expect(errors).toHaveLength(1);
    // A streaming client must be able to tell a quota wall from a transient
    // upstream blip without string-matching the message.
    expect(errors[0].code).toBe("priority_access_exhausted");
    expect(errors[0].type).toBe("rate_limit_error");
    expect(errors[0].retry_after).toBeGreaterThan(0);
  });

  it("still streams an ordinary answer that merely starts with \"You\"", async () => {
    const { contents, errors } = await streamRaw(["You", "r code ", "has a bug."]);
    expect(errors).toHaveLength(0);
    expect(contents.join("")).toBe("Your code has a bug.");
  });
});

describe("the only-the-first-call-ran note", () => {
  const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } }];
  const NOTE = "(Note: only the first tool call in your previous reply was actually run.";

  /** One conversation, several requests through the same pool. */
  async function converse(replies: string[]): Promise<string[]> {
    scripted.result = null;
    scripted.texts = [];
    scripted.queue = replies.map((fullText) => ({ fullText }));
    const pool = new SessionPool();
    const messages: any[] = [{ role: "system", content: "sys" }, { role: "user", content: `fix it ${Math.random()}` }];
    for (let i = 0; i < replies.length; i++) {
      const res = await handleChatCompletion(ChatCompletionRequest.parse({ model: "claude-sonnet", stream: false, tools, messages }), pool);
      const msg = (await res.json()).choices[0].message;
      if (!msg.tool_calls) break;
      messages.push({ role: "assistant", content: null, tool_calls: msg.tool_calls });
      messages.push({ role: "tool", tool_call_id: msg.tool_calls[0].id, content: `real output ${i}` });
    }
    scripted.queue = [];
    return scripted.texts;
  }

  it("tells the model, with the real result, that its invented tail never ran", async () => {
    const sent = await converse([
      "```bash\ncat config.json\n```\n\n<tool_response>\n{\"port\": 3000}\n</tool_response>\n\nThe bug is fixed.",
      "```bash\nsed -i s/3000/8080/ config.json\n```",
      "Done.",
    ]);
    expect(sent).toHaveLength(3);
    expect(sent[1].startsWith(NOTE)).toBe(true);
    expect(sent[1]).toContain("real output 0");
    expect(sent[2]).not.toContain("(Note:"); // once only: turn 2 was executed in full
  });

  it("says how many batched calls were dropped by one-call-per-turn", async () => {
    const sent = await converse(["```bash\nls\n```\n\n```bash\ncat a.txt\n```", "Done."]);
    expect(sent[1]).toContain("only the first of the 2 tool calls in your previous reply was run; the other one was not");
  });

  it("adds nothing when the whole reply ran", async () => {
    const sent = await converse(["```bash\nls\n```", "Done."]);
    expect(sent[1]).not.toContain("(Note:");
  });

  it("names the tool on a follow-up turn, though the tool message carries no name (#50)", async () => {
    // Like pi: the result names its call only by tool_call_id.
    const sent = await converse(["```bash\nls\n```", "Done."]);
    // The same rendering as the first turn (tool and command), so the model reads one format.
    expect(sent[1]).toMatch(/<tool_response tool="bash" command="ls">\nreal output 0\n<\/tool_response>/);
    expect(sent[1]).not.toContain('name="unknown"');
  });
});

describe("a reply that opens with a tool call and then writes an essay", () => {
  it("runs the opening call and tells the model its essay was written before the result", async () => {
    const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } }];
    scripted.result = null;
    scripted.texts = [];
    scripted.queue = [
      { fullText: "```bash\ncat config.json\n```\n\nThe file `config.json` doesn't exist in my environment, so here is how you could fix it yourself:\n\n## Steps\n\n```bash\nsed -i s/3000/8080/ config.json\n```\n\nThat's all." },
      { fullText: "Done." },
    ];
    const pool = new SessionPool();
    const messages: any[] = [{ role: "user", content: `essay ${Math.random()}` }];
    const r1 = await (await handleChatCompletion(ChatCompletionRequest.parse({ model: "claude-sonnet", stream: false, tools, messages }), pool)).json();
    const call = r1.choices[0].message.tool_calls?.[0];
    expect(call).toBeDefined(); // the old guard returned the essay as text
    expect(JSON.parse(call.function.arguments).command).toBe("cat config.json");
    messages.push({ role: "assistant", content: null, tool_calls: r1.choices[0].message.tool_calls });
    messages.push({ role: "tool", tool_call_id: call.id, content: '{"port": 3000}' });
    await handleChatCompletion(ChatCompletionRequest.parse({ model: "claude-sonnet", stream: false, tools, messages }), pool);
    expect(scripted.texts[1]).toContain("was written before its result existed");
    expect(scripted.texts[1]).toContain('{"port": 3000}');
    scripted.queue = [];
  });
});

describe("a reply that restates its call as a correction (Sonnet 5.5)", () => {
  it("runs the corrected copy and doesn't tell the model its correction was dropped", async () => {
    const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } }];
    const plan = "The logs are plain text, so the viewer can read them once they are renamed. Two of the files are empty "
      + "and can go. Next I'll rename the rest to `.log`, delete the two empty ones, and point the index page at the "
      + "local copies, keeping a backup of the page first so the change is easy to undo if anything looks wrong.";
    const cmd = (grep: string) => `cd /tmp/proj && rm logs/a.txt && for f in logs/*.txt; do mv "$f" "\${f%.txt}.log"; done && ls logs; grep -n '${grep}' index.html`;
    scripted.result = null;
    scripted.texts = [];
    scripted.queue = [
      { fullText: `${plan}\n\n\`\`\`bash\n${cmd("href\\|src")}</bash>\n\`\`\`\n\nOops, that closing fence is wrong. Here is the same command, correctly formatted:\n\n\`\`\`bash\n${cmd("href")}\n\`\`\`` },
      { fullText: "Done." },
    ];
    const pool = new SessionPool();
    const messages: any[] = [{ role: "user", content: `rename the logs ${Math.random()}` }];
    const r1 = await (await handleChatCompletion(ChatCompletionRequest.parse({ model: "claude-sonnet-5.5", stream: false, tools, messages }), pool)).json();
    const calls = r1.choices[0].message.tool_calls;
    expect(calls).toHaveLength(1); // the document guard used to return the whole reply as text
    expect(JSON.parse(calls[0].function.arguments).command).toBe(cmd("href"));
    messages.push({ role: "assistant", content: null, tool_calls: calls });
    messages.push({ role: "tool", tool_call_id: calls[0].id, content: "c.log" });
    await handleChatCompletion(ChatCompletionRequest.parse({ model: "claude-sonnet-5.5", stream: false, tools, messages }), pool);
    expect(scripted.texts[1]).not.toContain("(Note:");
    scripted.queue = [];
  });
});

describe("an explicitly Throttled turn (result.value = Throttled)", () => {
  // Verbatim from the Sep 28 dumps: no content frames, only this final result.
  const THROTTLED = {
    value: "Throttled",
    errorCode: "PerUserThrottled",
    message: "We're temporarily unable to respond to this volume of requests. Please try again later.",
  };

  it("fails fast with a 429 — no quick retries back into the throttle", async () => {
    scripted.deltas = [];
    scripted.fullText = "";
    scripted.result = THROTTLED;
    scripted.runs = 0;
    const body = ChatCompletionRequest.parse({
      model: "claude-sonnet",
      stream: false,
      messages: [{ role: "user", content: "hello throttled" }],
    });
    const res = await handleChatCompletion(body, new SessionPool());
    expect(res.status).toBe(429);
    const err = (await res.json()).error;
    expect(err.type).toBe("rate_limit_error");
    expect(err.code).toBe("m365_throttled");
    expect(err.param).toBe("PerUserThrottled");
    expect(scripted.runs).toBe(1); // the old path spent 3 attempts here
    scripted.result = null;
  });

  it("carries the code through the streaming path as an error chunk", async () => {
    scripted.result = THROTTLED;
    const { contents, errors } = await streamRaw([], "");
    expect(contents).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("m365_throttled");
    scripted.result = null;
  });
});

describe("M365_AVOID_THROTTLING holds a turn it would have to wait too long for", () => {
  const hold = () => new TurnBudgetHold("throttle hold", 65 * 60_000, Date.parse("2026-10-12T08:00:00.000Z"));

  it("answers 429 with Retry-After and never sends the turn", async () => {
    scripted.result = null;
    scripted.runs = 0;
    scripted.budgetHold = hold();
    const body = ChatCompletionRequest.parse({ model: "claude-sonnet", stream: false, messages: [{ role: "user", content: "held" }] });
    const res = await handleChatCompletion(body, new SessionPool());
    scripted.budgetHold = null;
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe(String(65 * 60));
    const err = (await res.json()).error;
    expect(err.type).toBe("rate_limit_error");
    expect(err.code).toBe("m365_throttle_hold");
    expect(err.message).toMatch(/throttled this account at 2026-10-12T08:00:00\.000Z/);
    expect(scripted.runs).toBe(0);
  });

  it("carries the code and retry_after through the streaming path", async () => {
    scripted.runs = 0;
    scripted.budgetHold = new TurnBudgetHold("refill", 20 * 60_000, null);
    const { contents, errors } = await streamRaw([], "");
    scripted.budgetHold = null;
    expect(contents).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("m365_turn_budget");
    expect(errors[0].retry_after).toBe(20 * 60);
    expect(scripted.runs).toBe(0);
  });

  it("lets a streamed request wait as long as configured, an unstreamed one 2 min, and passes the client's signal", async () => {
    scripted.result = null;
    scripted.queue = [];
    scripted.awaitTurnBudgetCalls = [];
    await streamContents(["hi"]);
    const ac = new AbortController();
    const body = ChatCompletionRequest.parse({ model: "m365-copilot", stream: false, messages: [{ role: "user", content: "hi" }] });
    await handleChatCompletion(body, new SessionPool(), { signal: ac.signal });
    expect(scripted.awaitTurnBudgetCalls.map((c) => c.maxWaitMs)).toEqual([undefined, 2 * 60_000]);
    expect(scripted.awaitTurnBudgetCalls[1]!.signal).toBe(ac.signal);
  });

  it("makes the forcing retry wait for the budget too: every upstream turn goes through awaitTurnBudget", async () => {
    scripted.awaitTurnBudgetCalls = [];
    scripted.runs = 0;
    scripted.queue = [
      { fullText: "I can't access your files from here. Please paste the contents of calc.py." },
      { fullText: "```bash\ncat calc.py\n```" },
    ];
    const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } }];
    const body = ChatCompletionRequest.parse({ model: "claude-sonnet", stream: false, tools, messages: [{ role: "user", content: "fix calc.py" }] });
    const res = await handleChatCompletion(body, new SessionPool());
    expect(res.status).toBe(200);
    expect(scripted.runs).toBe(2);
    expect(scripted.awaitTurnBudgetCalls).toHaveLength(2);
    scripted.queue = [];
  });

  it("hands run() the same wait for its reconnect's turn (#77)", async () => {
    scripted.result = null;
    scripted.queue = [];
    scripted.awaitTurnBudgetCalls = [];
    scripted.budgetWaits = [];
    const ac = new AbortController();
    const body = ChatCompletionRequest.parse({ model: "claude-sonnet", stream: false, messages: [{ role: "user", content: "hi" }] });
    await handleChatCompletion(body, new SessionPool(), { signal: ac.signal });
    expect(scripted.budgetWaits).toHaveLength(1);
    await scripted.budgetWaits[0]!(); // what run() does before it reconnects
    expect(scripted.awaitTurnBudgetCalls).toHaveLength(2);
    expect(scripted.awaitTurnBudgetCalls[1]).toEqual(scripted.awaitTurnBudgetCalls[0]);
    expect(scripted.awaitTurnBudgetCalls[1]!.maxWaitMs).toBe(2 * 60_000);
    expect(scripted.awaitTurnBudgetCalls[1]!.signal).toBe(ac.signal);
  });
});

describe("Disengage retry keeps a model's <system>-free framing", () => {
  const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } }];
  async function disengageThenAnswer(model: string): Promise<string> {
    scripted.result = null;
    scripted.texts = [];
    scripted.queue = [{ fullText: "", messageType: "Disengaged" }, { fullText: "```bash\nls\n```" }];
    const body = ChatCompletionRequest.parse({
      model, stream: false, tools,
      messages: [{ role: "system", content: "sys" }, { role: "user", content: `do it ${model}` }],
    });
    const res = await handleChatCompletion(body, new SessionPool());
    expect(res.status).toBe(200);
    expect(scripted.texts).toHaveLength(2);
    scripted.queue = [];
    return scripted.texts[1];
  }

  it("retries Sonnet 5 with relay again, never a <system>-tagged framing", async () => {
    const retry = await disengageThenAnswer("claude-sonnet-5");
    expect(retry).not.toContain("<system>");
    expect(retry).toContain("guide me through this from my terminal, one command at a time");
    expect(retry).not.toContain("put as much as you can into one block");
  });

  it("sends Opus, Sonnet 4.6 and GPT-6 relay_batch on the first try and keeps it on the retry (§24, §25)", async () => {
    for (const model of ["claude-opus-4.8", "claude-opus", "claude-sonnet", "gpt-6-think-deeper"]) {
      const retry = await disengageThenAnswer(model);
      expect(scripted.texts[0]).toContain("put as much as you can into one block");
      expect(scripted.texts[0]).not.toContain("<system>");
      expect(retry).toContain("put as much as you can into one block");
    }
  });


  it("still retries the <system>-tagged defaults with softened (F22)", async () => {
    const retry = await disengageThenAnswer("gpt-5.5-think-deeper");
    expect(retry).toContain("<system>");
    expect(retry).toContain("You are an automated coding agent working in a real working directory");
  });
});

describe("which requests carry the tool agent (#41)", () => {
  const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } }];

  /** The `useAgent` flag the handler passed for one request on `model`. */
  async function agentFlagFor(model: string, withTools = true): Promise<boolean | undefined> {
    scripted.result = null;
    scripted.agentFlags = [];
    scripted.queue = [{ fullText: "```bash\nls\n```" }];
    const body = ChatCompletionRequest.parse({
      model, stream: false,
      ...(withTools ? { tools } : {}),
      messages: [{ role: "user", content: `list files ${model} ${Math.random()}` }],
    });
    const res = await handleChatCompletion(body, new SessionPool());
    expect(res.status).toBe(200);
    scripted.queue = [];
    expect(scripted.agentFlags).toHaveLength(1);
    return scripted.agentFlags[0];
  }

  afterEach(() => { delete process.env.M365_FORCE_AGENT; });

  it("sends gpt-6-think-deeper tool requests without the agent", async () => {
    expect(await agentFlagFor("gpt-6-think-deeper")).toBe(false);
  });

  it("still sends GPT-5.x tool requests with the agent", async () => {
    expect(await agentFlagFor("gpt-5.5-think-deeper")).toBe(true);
    expect(await agentFlagFor("m365-copilot")).toBe(true);
  });

  it("still sends Claude Sonnet tool requests without it", async () => {
    expect(await agentFlagFor("claude-sonnet")).toBe(false);
    expect(await agentFlagFor("claude-sonnet-5")).toBe(false);
  });

  it("sends both Opus models' tool requests with it (§24, §36)", async () => {
    expect(await agentFlagFor("claude-opus")).toBe(true);
    expect(await agentFlagFor("claude-opus-5[1m]")).toBe(true);
    expect(await agentFlagFor("claude-opus-4.8")).toBe(true);
    expect(await agentFlagFor("claude-opus-4.5")).toBe(true);
  });

  it("never attaches it to a request without tools — Opus 4.8 included, which serves agent-less (§36)", async () => {
    expect(await agentFlagFor("gpt-5.5-think-deeper", false)).toBe(false);
    expect(await agentFlagFor("claude-opus", false)).toBe(false);
    expect(await agentFlagFor("claude-opus-4.8", false)).toBe(false);
    expect(await agentFlagFor("claude-opus-4.5", false)).toBe(false);
  });

  it("lets M365_FORCE_AGENT=1 put it back", async () => {
    process.env.M365_FORCE_AGENT = "1";
    expect(await agentFlagFor("gpt-6-think-deeper")).toBe(true);
  });

  it("lets M365_FORCE_AGENT=0 take it away", async () => {
    process.env.M365_FORCE_AGENT = "0";
    expect(await agentFlagFor("gpt-5.5-think-deeper")).toBe(false);
  });
});

describe("GPT-6 Sol: agent on premium, learned fallback on non-premium (#23)", () => {
  const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } }];
  const DEAD = { fullText: "", result: { value: "InternalError" } };
  const CALL = { fullText: "```bash\nls\n```" };

  async function send(model = "gpt-6-sol") {
    scripted.result = null;
    scripted.texts = [];
    scripted.agentFlags = [];
    scripted.newConversations = 0;
    const body = ChatCompletionRequest.parse({
      model, stream: false, tools,
      messages: [{ role: "system", content: "sys" }, { role: "user", content: `list files ${Math.random()}` }],
    });
    return respond(body);
  }

  afterEach(() => {
    resetAgentRoutes();
    scripted.queue = [];
    delete process.env.M365_FORCE_AGENT;
  });

  it("sends the agent first and keeps it when it serves (premium)", async () => {
    scripted.queue = [CALL];
    const res = await send();
    expect(res.status).toBe(200);
    expect(scripted.agentFlags).toEqual([true]);
    expect(scripted.newConversations).toBe(0);
  });

  it("on the dead route, re-sends the full prompt agent-less in a fresh conversation", async () => {
    scripted.queue = [DEAD, CALL];
    const res = await send();
    expect(res.status).toBe(200);
    expect((await res.json()).choices[0].message.tool_calls).toHaveLength(1);
    expect(scripted.agentFlags).toEqual([true, false]);
    expect(scripted.newConversations).toBe(1);
    // The retry is the whole request, not a "Please continue." into nothing.
    expect(scripted.texts[1]).toContain("list files");
    expect(scripted.texts[1]).toContain("```bash");
  });

  it("remembers it: the next request goes agent-less from the start", async () => {
    scripted.queue = [DEAD, CALL];
    await send();
    scripted.queue = [CALL];
    await send();
    expect(scripted.agentFlags).toEqual([false]);
    expect(scripted.newConversations).toBe(0);
  });

  it("treats InternalError as a transient once the agent has answered (premium, §23)", async () => {
    scripted.queue = [CALL];
    await send(); // the agent answered: this account is premium
    scripted.queue = [DEAD, CALL];
    const res = await send();
    expect(res.status).toBe(200);
    // No agent-less switch: the ordinary InternalError retry, which re-sends the
    // whole request in a fresh conversation — the dropped turn processed nothing,
    // so "Please continue." would lose the request.
    expect(scripted.newConversations).toBe(1);
    expect(scripted.agentFlags).toEqual([true, true]);
    expect(scripted.texts[1]).not.toBe("Please continue.");
    expect(scripted.texts[1]).toBe(scripted.texts[0].replace("conv-test<", "conv-test-2<"));
    scripted.queue = [CALL];
    await send();
    expect(scripted.agentFlags).toEqual([true]);
  });

  it("doesn't touch tones outside PREMIUM_ONLY_AGENT_TONES", async () => {
    scripted.queue = [DEAD, CALL];
    const res = await send("gpt-5.5-think-deeper");
    expect(res.status).toBe(200);
    // The fresh-conversation InternalError retry, still with the agent.
    expect(scripted.newConversations).toBe(1);
    expect(scripted.agentFlags[1]).toBe(true);
  });

  it("doesn't fall back under M365_FORCE_AGENT=1", async () => {
    process.env.M365_FORCE_AGENT = "1";
    scripted.queue = [DEAD, CALL];
    await send();
    // The fresh-conversation InternalError retry, still with the agent.
    expect(scripted.newConversations).toBe(1);
    expect(scripted.agentFlags).toEqual([true, true]);
  });
});

describe("follow-up turns and give-ups (Windows / pi, measured)", () => {
  const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } }];

  async function ask(messages: any[], pool: InstanceType<typeof SessionPool>) {
    const res = await handleChatCompletion(ChatCompletionRequest.parse({ model: "gpt-5.6-think-deeper", stream: false, tools, messages }), pool);
    return (await res.json()).choices[0].message;
  }

  // A pi session is delta turns from turn 2 on. The delta path labelled every
  // tool result name="unknown" with no command — the misread formatMessages was
  // fixed for, and the turn on which live runs said "bash is not enabled".
  it("names a follow-up tool result after the call that produced it", async () => {
    scripted.result = null;
    scripted.texts = [];
    scripted.queue = [{ fullText: "```bash\nls -la\n```" }, { fullText: "Done." }];
    const pool = new SessionPool();
    const messages: any[] = [{ role: "user", content: `look ${Math.random()}` }];
    const m1 = await ask(messages, pool);
    messages.push({ role: "assistant", content: null, tool_calls: m1.tool_calls });
    messages.push({ role: "tool", tool_call_id: m1.tool_calls[0].id, content: "README.md" });
    await ask(messages, pool);
    expect(scripted.texts[1]).toContain('<tool_response tool="bash" command="ls -la">');
    expect(scripted.texts[1]).not.toContain('name="unknown"');
    scripted.queue = [];
  });

  // Live: a refusal that came with "run these yourself" fences was parsed as two
  // tool calls (confab check skipped), then returned to the user as a document.
  it("forces a retry when a give-up comes dressed as a document", async () => {
    scripted.result = null;
    scripted.texts = [];
    scripted.queue = [
      // Verbatim from the live run (pdf task, Windows / pi / gpt-5.6-think-deeper).
      { fullText: "Dosya oluşturma özelliği bu oturumda devre dışı olduğu için `notlar.pdf` dosyasını doğrudan oluşturamıyorum.\n\nYerel bilgisayarınızda Türkçe karakter desteğiyle dönüştürmek için şu komutu çalıştırabilirsiniz:\n\n```bash\nwinget install --id JohnMacFarlane.Pandoc\npandoc notlar.md -o notlar.pdf --pdf-engine=weasyprint\n```\n\n`weasyprint` eksikse:\n\n```bash\npy -m pip install weasyprint\npandoc notlar.md -o notlar.pdf --pdf-engine=weasyprint\n```\n\nHer iki komutu da `notlar.md` dosyasının bulunduğu klasörde çalıştırın. Dosyanın UTF-8 olarak kaydedilmiş olması `ç, ğ, ı, İ, ö, ş, ü` karakterlerinin doğru görünmesini sağlar." },
      { fullText: "```bash\nls -la\n```" },
    ];
    const m = await ask([{ role: "user", content: `pdf ${Math.random()}` }], new SessionPool());
    expect(scripted.texts).toHaveLength(2); // the forcing retry ran
    expect(m.tool_calls?.[0] && JSON.parse(m.tool_calls[0].function.arguments).command).toBe("ls -la");
    scripted.queue = [];
  });

  // Live: after a real tool result showed no PDF tool installed, the model said
  // "bash is not enabled"; the forcing prompt then claimed "you have not run any
  // command yet", and the model refused that too.
  it("doesn't tell a model that already ran tools that it ran nothing", async () => {
    scripted.result = null;
    scripted.texts = [];
    scripted.queue = [
      { fullText: "```bash\ncommand -v pandoc || echo none\n```" },
      { fullText: "Dosya oluşturma araçları şu anda etkin olmadığı için notlar.pdf dosyasını oluşturamıyorum." },
      { fullText: "```bash\npy -m pip install fpdf2\n```" },
    ];
    const pool = new SessionPool();
    const messages: any[] = [{ role: "user", content: `pdf ${Math.random()}` }];
    const m1 = await ask(messages, pool);
    messages.push({ role: "assistant", content: null, tool_calls: m1.tool_calls });
    messages.push({ role: "tool", tool_call_id: m1.tool_calls[0].id, content: "none" });
    const m2 = await ask(messages, pool);
    expect(scripted.texts).toHaveLength(3);
    expect(scripted.texts[2]).toContain("Your tools are working");
    expect(scripted.texts[2]).not.toContain("you have not run any command yet");
    expect(JSON.parse(m2.tool_calls[0].function.arguments).command).toBe("py -m pip install fpdf2");
    scripted.queue = [];
  });

  it("leaves a real document alone even if its body sounds like a give-up", async () => {
    scripted.result = null;
    scripted.texts = [];
    const doc = "Here is the README you asked for:\n\n# Setup\n\nIf you can't access the API, check the token.\n\n```bash\nnpm install\n```\n\n```bash\nnpm test\n```";
    scripted.queue = [{ fullText: doc }];
    const m = await ask([{ role: "user", content: `readme ${Math.random()}` }], new SessionPool());
    expect(scripted.texts).toHaveLength(1); // no forcing retry
    expect(m.tool_calls).toBeUndefined();
    expect(m.content).toContain("If you can't access the API");
    scripted.queue = [];
  });
});

describe("a new harness session that shares the first user message", () => {
  const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } }];
  const ask = async (messages: any[], pool: InstanceType<typeof SessionPool>) =>
    (await (await handleChatCompletion(ChatCompletionRequest.parse({ model: "gpt-5.6-think-deeper", stream: false, tools, messages }), pool)).json()).choices[0].message;

  // Measured: pi sessions opened with the same prompt (even in different
  // directories) were joined to the first session's M365 conversation and
  // answered from it — "notlar.docx was already created" in an empty directory.
  it("gets a fresh M365 conversation after a longer earlier session", async () => {
    scripted.result = null;
    scripted.texts = [];
    scripted.newConversations = 0;
    scripted.queue = [{ fullText: "```bash\nls\n```" }, { fullText: "Done." }, { fullText: "```bash\nls\n```" }];
    const pool = new SessionPool();
    const prompt = `make a pdf ${Math.random()}`;
    const first: any[] = [{ role: "user", content: prompt }];
    const m1 = await ask(first, pool);
    first.push({ role: "assistant", content: null, tool_calls: m1.tool_calls });
    first.push({ role: "tool", tool_call_id: m1.tool_calls[0].id, content: "notlar.md" });
    await ask(first, pool);
    await ask([{ role: "user", content: prompt }], pool); // a new session, same opener
    expect(scripted.newConversations).toBe(1);
    expect(scripted.texts[2]).toContain(prompt); // the full prompt, not a delta
    scripted.queue = [];
  });

  it("gets one after a single-turn session too (equal length used to send 'Please continue.')", async () => {
    scripted.result = null;
    scripted.texts = [];
    scripted.newConversations = 0;
    scripted.queue = [{ fullText: "I can't do that." }, { fullText: "```bash\nls\n```" }];
    const pool = new SessionPool();
    const prompt = `make a docx ${Math.random()}`;
    await ask([{ role: "user", content: prompt }], pool);
    await ask([{ role: "user", content: prompt }], pool);
    expect(scripted.newConversations).toBe(1);
    expect(scripted.texts[scripted.texts.length - 1]).not.toBe("Please continue.");
    expect(scripted.texts[scripted.texts.length - 1]).toContain(prompt);
    scripted.queue = [];
  });

  it("still continues a real continuation in the same conversation", async () => {
    scripted.result = null;
    scripted.texts = [];
    scripted.newConversations = 0;
    scripted.queue = [{ fullText: "```bash\nls\n```" }, { fullText: "Done." }];
    const pool = new SessionPool();
    const msgs: any[] = [{ role: "user", content: `go ${Math.random()}` }];
    const m1 = await ask(msgs, pool);
    msgs.push({ role: "assistant", content: null, tool_calls: m1.tool_calls });
    msgs.push({ role: "tool", tool_call_id: m1.tool_calls[0].id, content: "a.txt" });
    await ask(msgs, pool);
    expect(scripted.newConversations).toBe(0);
    expect(scripted.texts[1]).toContain('<tool_response tool="bash"'); // a delta
    scripted.queue = [];
  });
});

describe("a side request that shares the session's first user message (#83)", () => {
  const tools = [
    { type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } },
    { type: "function", function: { name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } } },
  ];
  const post = (pool: InstanceType<typeof SessionPool>, messages: any[], withTools?: unknown[]) =>
    handleChatCompletion(ChatCompletionRequest.parse({ model: "claude-sonnet-5", stream: false, ...(withTools ? { tools: withTools } : {}), messages }), pool);

  it("puts opencode's title request in a conversation of its own, though it arrives with the task", async () => {
    scripted.result = null;
    scripted.texts = [];
    servedBy.length = 0;
    scripted.newConversations = 0;
    scripted.queue = [{ fullText: "Fix calc bug" }, { fullText: "```bash\nls\n```" }, { fullText: "Done." }];
    const pool = new SessionPool();
    const opener = { role: "user", content: `calc.py prints the wrong result ${Math.random()}` };
    // Like opencode: the title request (no tools) and the task (tools), at the same time.
    const [, task] = await Promise.all([
      post(pool, [{ role: "system", content: "You are a title generator. You output ONLY a thread title." }, opener]),
      post(pool, [{ role: "system", content: "You are an AI agent running in OpenCode." }, opener], tools),
    ]);
    expect(pool.size).toBe(2);
    expect(servedBy[0]).not.toBe(servedBy[1]);
    const call = (await task.json()).choices[0].message.tool_calls[0];
    // The task's next turn continues the task's conversation, as a delta.
    await post(pool, [
      { role: "system", content: "You are an AI agent running in OpenCode." }, opener,
      { role: "assistant", content: null, tool_calls: [call] },
      { role: "tool", tool_call_id: call.id, content: "calc.py" },
    ], tools);
    expect(servedBy[2]).toBe(servedBy[1]);
    expect(scripted.texts[2]).toContain('<tool_response tool="bash"');
    expect(scripted.newConversations).toBe(0);
    scripted.queue = [];
  });

  it("keys on the tool names, not their order or descriptions", async () => {
    scripted.result = null;
    servedBy.length = 0;
    scripted.queue = [{ fullText: "```bash\nls\n```" }, { fullText: "Done." }];
    const pool = new SessionPool();
    const opener = { role: "user", content: `list it ${Math.random()}` };
    const call = (await (await post(pool, [opener], tools)).json()).choices[0].message.tool_calls[0];
    const reordered = [{ ...tools[1], function: { ...tools[1].function, description: "Read a file (cwd: /tmp/x)" } }, tools[0]];
    await post(pool, [opener, { role: "assistant", content: null, tool_calls: [call] }, { role: "tool", tool_call_id: call.id, content: "a.txt" }], reordered);
    expect(pool.size).toBe(1);
    expect(servedBy[1]).toBe(servedBy[0]);
    scripted.queue = [];
  });

  it("sends the whole history when a session changes its tool set", async () => {
    scripted.result = null;
    scripted.texts = [];
    scripted.queue = [{ fullText: "```bash\nls\n```" }, { fullText: "Done." }];
    const pool = new SessionPool();
    const opener = { role: "user", content: `look ${Math.random()}` };
    const call = (await (await post(pool, [opener], [tools[0]])).json()).choices[0].message.tool_calls[0];
    await post(pool, [opener, { role: "assistant", content: null, tool_calls: [call] }, { role: "tool", tool_call_id: call.id, content: "a.txt" }], tools);
    expect(pool.size).toBe(2);
    expect(scripted.texts[1]).toContain(opener.content); // the full prompt, not a delta into a fresh conversation
    scripted.queue = [];
  });
});

describe("Opus 4.8 on an account that can't serve it (§24, §36)", () => {
  const DEAD = { fullText: "", result: { value: "InternalError" } };
  const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } }];

  afterEach(() => {
    resetAgentRoutes();
    scripted.queue = [];
  });

  async function deadRoute(withTools: boolean) {
    scripted.result = null;
    scripted.agentFlags = [];
    scripted.newConversations = 0;
    scripted.queue = [DEAD, DEAD, DEAD];
    const body = ChatCompletionRequest.parse({
      model: "claude-opus-4.8", stream: false, ...(withTools ? { tools } : {}),
      messages: [{ role: "user", content: `hello ${Math.random()}` }],
    });
    const res = await respond(body);
    expect(res.status).toBe(502);
    const err = (await res.json()).error;
    expect(err.code).toBe("model_route_unavailable");
    expect(err.message).toContain("premium");
    expect(scripted.newConversations).toBe(0);
  }

  it("says the model is premium-only instead of 'empty response' on a tool-less (agent-less) request", async () => {
    await deadRoute(false);
    expect(scripted.agentFlags).toEqual([false, false, false]);
  });

  it("…and on a tool request, which keeps the agent: agent-less is dead too, so there's no fallback", async () => {
    await deadRoute(true);
    expect(scripted.agentFlags).toEqual([true, true, true]);
  });

  it("keeps the generic message for other models' empty InternalErrors", async () => {
    scripted.result = null;
    scripted.queue = [DEAD, DEAD, DEAD];
    const body = ChatCompletionRequest.parse({
      model: "claude-opus", stream: false,
      messages: [{ role: "user", content: `hello ${Math.random()}` }],
    });
    const res = await respond(body);
    expect(res.status).toBe(502);
    expect((await res.json()).error.type).toBe("upstream_empty_response");
  });
});

describe("Priority access (Opus 5.5, Sonnet 5.5): OutOfCredits, remembering it, metering, the opt-in fallback (#18)", () => {
  const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } }];
  const WEEKLY = "You\u2019ve used your available priority access to the Opus model for the week. You can choose another available model or wait until Monday to use the Opus model again.";
  const REFUSAL = { fullText: WEEKLY, result: { value: "OutOfCredits", message: WEEKLY } };
  const CALL = { fullText: "```bash\nls\n```", metering: { ClaudeOpusQueryDaily: 12, ClaudeOpusQuery75: 30 } };

  async function send(model = "claude-opus", content = `list files ${Math.random()}`, stream = false) {
    scripted.result = null;
    scripted.texts = [];
    scripted.models = [];
    scripted.agentFlags = [];
    scripted.newConversations = 0;
    const body = ChatCompletionRequest.parse({
      model, stream, tools,
      messages: [{ role: "system", content: "sys" }, { role: "user", content }],
    });
    return handleChatCompletion(body, pool);
  }
  let pool = new SessionPool();

  afterEach(() => {
    resetPriorityAccessState();
    scripted.queue = [];
    delete process.env.M365_OPUS_FALLBACK_MODEL;
    delete process.env.M365_SONNET_FALLBACK_MODEL;
    pool = new SessionPool();
  });

  it("surfaces the Opus allowances left in usage", async () => {
    scripted.queue = [CALL];
    const res = await send();
    const usage = (await res.json()).usage;
    expect(usage.x_m365_opus_daily_remaining).toBe(12);
    expect(usage.x_m365_opus_weekly_remaining).toBe(30);
  });

  it("429s an OutOfCredits turn with the weekly reset", async () => {
    scripted.queue = [REFUSAL];
    const res = await send();
    expect(res.status).toBe(429);
    const err = (await res.json()).error;
    expect(err.code).toBe("priority_access_exhausted");
    expect(err.param).toBe("week");
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("then answers later metered Opus requests itself, without an M365 turn", async () => {
    scripted.queue = [REFUSAL];
    await send();
    const res = await send("claude-opus", "another task");
    expect(res.status).toBe(429);
    expect(scripted.models).toEqual([]); // nothing sent upstream
    // Opus 4.8 isn't metered, so it is unaffected.
    scripted.queue = [CALL];
    expect((await send("claude-opus-4.8", "third task")).status).toBe(200);
    expect(scripted.models).toEqual(["claude-opus-4.8"]);
  });

  it("with M365_OPUS_FALLBACK_MODEL, re-sends the whole request to it in a fresh conversation", async () => {
    process.env.M365_OPUS_FALLBACK_MODEL = "claude-opus-4.8";
    scripted.queue = [REFUSAL, { fullText: "```bash\nls\n```" }];
    const res = await send();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.choices[0].message.tool_calls).toHaveLength(1);
    expect(json.model).toBe("claude-opus-4.8"); // says who answered
    expect(scripted.models).toEqual(["claude-opus", "claude-opus-4.8"]);
    expect(scripted.newConversations).toBe(1);
    expect(scripted.agentFlags).toEqual([true, true]);
    expect(scripted.texts[1]).toContain("list files"); // the whole request, not a delta
  });

  it("…and routes the next requests straight to the fallback until the reset", async () => {
    process.env.M365_OPUS_FALLBACK_MODEL = "claude-opus-4.8";
    scripted.queue = [REFUSAL, { fullText: "```bash\nls\n```" }];
    await send();
    scripted.queue = [{ fullText: "```bash\npwd\n```" }];
    const res = await send("claude-opus", "another task");
    expect(res.status).toBe(200);
    expect(scripted.models).toEqual(["claude-opus-4.8"]);
  });

  it("starts a fresh conversation when an ongoing Opus 5.5 conversation moves to the fallback", async () => {
    scripted.queue = [CALL];
    await send("claude-opus", "long task");          // turn 1 served by Opus 5.5
    process.env.M365_OPUS_FALLBACK_MODEL = "claude-opus-4.8";
    scripted.queue = [REFUSAL, { fullText: "Done." }];
    // the client continues the same conversation with a tool result
    scripted.texts = []; scripted.models = []; scripted.newConversations = 0;
    const body = ChatCompletionRequest.parse({
      model: "claude-opus", stream: false, tools,
      messages: [
        { role: "system", content: "sys" }, { role: "user", content: "long task" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{\"command\":\"ls\"}" } }] },
        { role: "tool", tool_call_id: "c1", content: "a.txt" },
      ],
    });
    const res = await handleChatCompletion(body, pool);
    expect(res.status).toBe(200);
    expect(scripted.models).toEqual(["claude-opus", "claude-opus-4.8"]);
    expect(scripted.texts[1]).toContain("long task");   // full history for the new model
    expect(scripted.texts[1]).toContain("a.txt");
  });

  it("never falls back for an unmetered model's refusal text", async () => {
    process.env.M365_OPUS_FALLBACK_MODEL = "claude-opus-4.8";
    scripted.queue = [{ fullText: WEEKLY }];
    const res = await send("gpt-5.5-think-deeper");
    expect(res.status).toBe(429);
    expect(scripted.models).toEqual(["gpt-5.5-think-deeper"]);
  });

  it("falls back on the streaming path too, without leaking the refusal", async () => {
    process.env.M365_OPUS_FALLBACK_MODEL = "claude-opus-4.8";
    scripted.queue = [REFUSAL, { fullText: "Hello from 4.8" }];
    scripted.result = null; scripted.models = [];
    const body = ChatCompletionRequest.parse({ model: "claude-opus", stream: true, messages: [{ role: "user", content: `hi ${Math.random()}` }] });
    const res = await handleChatCompletion(body, pool);
    const text = await res.text();
    expect(text).toContain("Hello from 4.8");
    expect(text).not.toContain("priority access");
    expect(scripted.models).toEqual(["claude-opus", "claude-opus-4.8"]);
  });

  // Sonnet 5.5 has a budget of its own (§26): ClaudeSonnet55QueryDaily/Weekly.
  const SONNET_DAILY = "You\u2019ve used your available priority access to the Sonnet model for today. You can choose another available model or wait until tomorrow to use the Sonnet model again.";
  const SONNET_REFUSAL = { fullText: SONNET_DAILY, result: { value: "OutOfCredits", message: SONNET_DAILY } };

  it("surfaces Sonnet 5.5's allowances in usage, next to Opus's", async () => {
    scripted.queue = [{ fullText: "```bash\nls\n```", metering: { ClaudeOpusQueryDaily: 12, ClaudeOpusQuery75: 30, ClaudeSonnet55QueryDaily: 79, ClaudeSonnet55QueryWeekly: 149 } }];
    const usage = (await (await send("claude-sonnet-5.5")).json()).usage;
    expect(usage.x_m365_sonnet55_daily_remaining).toBe(79);
    expect(usage.x_m365_sonnet55_weekly_remaining).toBe(149);
    expect(usage.x_m365_opus_daily_remaining).toBe(12);
  });

  it("keeps the Sonnet 5.5 and Opus walls apart", async () => {
    scripted.queue = [SONNET_REFUSAL];
    const res = await send("claude-sonnet-5.5");
    expect(res.status).toBe(429);
    expect((await res.json()).error.param).toBe("day");
    // Sonnet 5.5 is answered locally until the reset…
    expect((await send("claude-sonnet-5.5", "another task")).status).toBe(429);
    expect(scripted.models).toEqual([]);
    // …while Opus 5.5, Sonnet 5 and Sonnet 4.6 still go upstream.
    for (const model of ["claude-opus", "claude-sonnet-5", "claude-sonnet"]) {
      scripted.queue = [CALL];
      expect((await send(model, `task for ${model}`)).status).toBe(200);
      expect(scripted.models).toEqual([model]);
    }
  });

  it("with M365_SONNET_FALLBACK_MODEL, re-sends a Sonnet 5.5 request to it", async () => {
    process.env.M365_SONNET_FALLBACK_MODEL = "claude-sonnet-5";
    process.env.M365_OPUS_FALLBACK_MODEL = "claude-opus-4.8"; // the other budget's, unused here
    scripted.queue = [SONNET_REFUSAL, { fullText: "```bash\nls\n```" }];
    const res = await send("claude-sonnet-5.5");
    expect(res.status).toBe(200);
    expect((await res.json()).model).toBe("claude-sonnet-5");
    expect(scripted.models).toEqual(["claude-sonnet-5.5", "claude-sonnet-5"]);
    expect(scripted.agentFlags).toEqual([false, false]);
  });

  it("remembers an unexpected OutOfCredits under that model alone", async () => {
    scripted.queue = [{ fullText: "Out of credits.", result: { value: "OutOfCredits", message: "Out of credits." } }];
    expect((await send("gpt-6-sol")).status).toBe(429);
    expect((await send("gpt-6-sol", "again")).status).toBe(429);
    expect(scripted.models).toEqual([]);
    scripted.queue = [CALL];
    expect((await send("claude-opus", "opus task")).status).toBe(200);
  });
});

describe("image input (#39)", () => {
  const PNG = "data:image/png;base64,iVBORw0KGgo=";
  const tools = [{ type: "function", function: { name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } } }];

  it("sends a read image with the turn that carries its tool result, and only that turn", async () => {
    scripted.result = null;
    scripted.texts = [];
    scripted.images = [];
    scripted.queue = [{ fullText: "```read\npath: chart.png\n```" }, { fullText: "The title is Lot 7." }];
    const pool = new SessionPool();
    const messages: any[] = [{ role: "user", content: `what does chart.png say? ${Math.random()}` }];
    const ask = async () => (await (await handleChatCompletion(ChatCompletionRequest.parse({ model: "gpt-5.6-think-deeper", stream: false, tools, messages }), pool)).json()).choices[0].message;
    const call = (await ask()).tool_calls[0];
    // pi's shape for a model with image input: the tool result, then the image in a user message.
    messages.push({ role: "assistant", content: null, tool_calls: [call] });
    messages.push({ role: "tool", tool_call_id: call.id, content: "Read image file [image/png]" });
    messages.push({ role: "user", content: [{ type: "text", text: "Attached image(s) from tool result:" }, { type: "image_url", image_url: { url: PNG } }] });
    expect((await ask()).content).toBe("The title is Lot 7.");
    expect(scripted.images).toEqual([[], [PNG]]);
    expect(scripted.texts[1]).toContain("Attached image(s) from tool result:");
    scripted.queue = [];
  });

  it("sends the images of the whole history with a full prompt", async () => {
    scripted.result = null;
    scripted.images = [];
    scripted.queue = [{ fullText: "A red square." }];
    const body = ChatCompletionRequest.parse({
      model: "gpt-5.6-think-deeper", stream: false,
      messages: [{ role: "user", content: [{ type: "text", text: `what is this? ${Math.random()}` }, { type: "image_url", image_url: { url: PNG, detail: "auto" } }] }],
    });
    await handleChatCompletion(body, new SessionPool());
    expect(scripted.images).toEqual([[PNG]]);
    scripted.queue = [];
  });
});

describe("stopping a turn that writes its own <tool_response> (early stop)", () => {
  const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } }];
  // A call, then the model's own result and the rest of an invented session:
  // a short tail (~500 chars, the usual kind) and a runaway (~3,700).
  const head = ["```bash\nls\n```\n\n", "<tool_res", "ponse>\nconfig.json\n</tool_response>\n\n"];
  const steps = (n: number) => Array.from({ length: n }, (_, i) => `invented step ${i}\n`);
  const short = [...head, ...steps(30)];
  const runaway = [...head, ...steps(200)];
  const tagAt = head[0].length;

  /** How many deltas have streamed once the tail is `after` chars past the tag. */
  function deltasUntil(deltas: string[], after: number): number {
    let n = 0, len = 0;
    while (len - tagAt < after) len += deltas[n++].length;
    return n;
  }

  async function toolTurn(deltas: string[], withTools = true, env: Record<string, string> = {}): Promise<any> {
    scripted.result = null;
    scripted.queue = [];
    scripted.deltas = deltas;
    scripted.fullText = undefined;
    scripted.liveFullText = true;
    Object.assign(process.env, env);
    try {
      const res = await respond(ChatCompletionRequest.parse({
        model: "claude-sonnet", stream: false, messages: [{ role: "user", content: `stop ${Math.random()}` }],
        ...(withTools ? { tools } : {}),
      }));
      return (await res.json()).choices[0].message;
    } finally {
      for (const k of Object.keys(env)) delete process.env[k];
      scripted.liveFullText = false;
      scripted.deltas = [];
    }
  }

  it("lets a short invented tail run to its end, then cuts it and runs the call", async () => {
    const msg = await toolTurn(short);
    expect(scripted.signals.at(-1)?.aborted).toBe(false);
    expect(scripted.stoppedAfter).toBeNull();
    expect(msg.tool_calls).toHaveLength(1);
    expect(JSON.parse(msg.tool_calls[0].function.arguments).command).toBe("ls");
    expect(msg.content ?? "").not.toContain("invented step");
  });

  it("stops a runaway once its tail is 2,000 chars past the tag, and runs the call", async () => {
    const msg = await toolTurn(runaway);
    const n = deltasUntil(runaway, 2000);
    expect(n).toBeLessThan(runaway.length);
    expect(scripted.signals.at(-1)?.aborted).toBe(true);
    expect(scripted.stoppedAfter).toBe(n);
    expect(JSON.parse(msg.tool_calls[0].function.arguments).command).toBe("ls");
  });

  it("stops at the tag itself under M365_EARLY_STOP_AFTER=0, even split across deltas", async () => {
    const msg = await toolTurn(short, true, { M365_EARLY_STOP_AFTER: "0" });
    expect(scripted.signals.at(-1)?.aborted).toBe(true);
    expect(scripted.stoppedAfter).toBe(3); // the tag completes in the third delta
    expect(JSON.parse(msg.tool_calls[0].function.arguments).command).toBe("ls");
  });

  it("honours another M365_EARLY_STOP_AFTER", async () => {
    await toolTurn(short, true, { M365_EARLY_STOP_AFTER: "100" });
    expect(scripted.stoppedAfter).toBe(deltasUntil(short, 100));
  });

  it("doesn't stop for a tag that follows prose rather than a call", async () => {
    const msg = await toolTurn(["I can't run tools here. A result would look like ", "<tool_response>…</tool_response>", " and so on."], true, { M365_EARLY_STOP_AFTER: "0" });
    expect(scripted.signals.at(-1)?.aborted ?? false).toBe(false);
    expect(scripted.stoppedAfter).toBeNull();
    expect(msg.tool_calls ?? []).toHaveLength(0);
  });

  it("leaves a request without tools alone", async () => {
    await toolTurn(runaway, false);
    expect(scripted.signals.at(-1)).toBeUndefined();
    expect(scripted.stoppedAfter).toBeNull();
  });

  it("waits for the turn to end under M365_NO_EARLY_STOP=1, and still cuts the invented tail", async () => {
    const msg = await toolTurn(runaway, true, { M365_NO_EARLY_STOP: "1" });
    expect(scripted.signals.at(-1)?.aborted ?? false).toBe(false);
    expect(scripted.stoppedAfter).toBeNull();
    expect(JSON.parse(msg.tool_calls[0].function.arguments).command).toBe("ls");
  });
});


describe("local history continuity regressions", () => {
  const tools = [{
    type: "function",
    function: {
      name: "bash",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
      },
    },
  }];

  async function ask(pool: InstanceType<typeof SessionPool>, messages: any[]) {
    const response = await handleChatCompletion(ChatCompletionRequest.parse({
      model: "gpt-6.1-sol",
      stream: false,
      tools,
      messages,
    }), pool);
    expect(response.status).toBe(200);
    return (await response.json()).choices[0].message;
  }

  afterEach(() => {
    scripted.queue = [];
    scripted.result = null;
    resetAgentRoutes();
  });

  it("does not replay earlier history on an append-only tool continuation", async () => {
    scripted.result = null;
    scripted.texts = [];
    scripted.queue = [
      { fullText: "```bash\npwd\n```" },
      { fullText: "```bash\nls\n```" },
      { fullText: "Received." },
    ];
    const pool = new SessionPool();
    const messages: any[] = [
      { role: "user", content: "ORIGINAL_TASK_CONTEXT: repair the parser without changing ordering." },
    ];
    const first = await ask(pool, messages);
    messages.push(
      { role: "assistant", content: null, tool_calls: first.tool_calls },
      { role: "tool", tool_call_id: first.tool_calls[0].id, content: "EARLIER_RESULT_CONTEXT: /project/parser" },
      { role: "user", content: "LATEST_DECISION_CONTEXT: preserve comments as well." },
    );
    const second = await ask(pool, messages);
    messages.push(
      { role: "assistant", content: null, tool_calls: second.tool_calls },
      { role: "tool", tool_call_id: second.tool_calls[0].id, content: "CURRENT_COMMAND_OUTPUT: parser.ts" },
    );
    await ask(pool, messages);
    const sent = scripted.texts.at(-1)!;
    expect(sent).not.toContain("ORIGINAL_TASK_CONTEXT");
    expect(sent).not.toContain("LATEST_DECISION_CONTEXT");
    expect(sent).not.toContain("EARLIER_RESULT_CONTEXT");
    expect(sent).toContain("CURRENT_COMMAND_OUTPUT");
    expect(sent).not.toContain("REFERENCE TRANSCRIPT");
  });

  it("replays the task when an inserted system message shifts the history", async () => {
    scripted.result = null;
    scripted.texts = [];
    scripted.queue = [
      { fullText: "```bash\npwd\n```" },
      { fullText: "Received." },
    ];
    const pool = new SessionPool();
    const opener = { role: "user", content: "TASK_CONTEXT_INSERTION: inspect the project, then fix its parser." };
    const call = await ask(pool, [opener]);
    await ask(pool, [
      { role: "system", content: "WORKSPACE_CONTEXT_INSERTION: /project/parser" },
      opener,
      { role: "assistant", content: null, tool_calls: call.tool_calls },
      { role: "tool", tool_call_id: call.tool_calls[0].id, content: "/project/parser" },
    ]);
    const sent = scripted.texts[scripted.texts.length - 1];
    expect(sent).toContain("WORKSPACE_CONTEXT_INSERTION");
    expect(sent).toContain("TASK_CONTEXT_INSERTION");
  });

  it("replays corrected earlier output instead of silently skipping it", async () => {
    scripted.result = null;
    scripted.texts = [];
    scripted.queue = [
      { fullText: "```bash\npwd\n```" },
      { fullText: "Received." },
      { fullText: "Received correction." },
    ];
    const pool = new SessionPool();
    const opener = { role: "user", content: "TASK_CONTEXT_CORRECTION: inspect the project and keep working." };
    const call = await ask(pool, [opener]);
    const history: any[] = [
      opener,
      { role: "assistant", content: null, tool_calls: call.tool_calls },
      { role: "tool", tool_call_id: call.tool_calls[0].id, content: "OLD_OUTPUT_CONTEXT" },
    ];
    await ask(pool, history);
    await ask(pool, [
      ...history.slice(0, 2),
      { ...history[2], content: "CORRECTED_OUTPUT_CONTEXT: actual workspace is /project/real" },
      { role: "assistant", content: "Received." },
      { role: "user", content: "Continue the original task using the corrected output." },
    ]);
    const sent = scripted.texts[scripted.texts.length - 1];
    expect(sent).toContain("CORRECTED_OUTPUT_CONTEXT");
    expect(sent).toContain("TASK_CONTEXT_CORRECTION");
  });
});


describe("incremental streaming with workspace tools", () => {
  const tools = [{
    type: "function",
    function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } },
  }];

  async function collect(deltas: string[], continued = false, requestTools: unknown[] = tools) {
    scripted.result = null;
    scripted.queue = [];
    scripted.deltas = deltas;
    scripted.fullText = undefined;
    const response = await handleChatCompletion(ChatCompletionRequest.parse({
      model: "gpt-6.1-sol", stream: true, tools: requestTools,
      messages: [
        { role: "user", content: "Inspect the project." },
        ...(continued ? [
          {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_previous",
              type: "function",
              function: { name: "bash", arguments: "{\"command\":\"pwd\"}" },
            }],
          },
          { role: "tool", tool_call_id: "call_previous", content: "/project" },
        ] : []),
      ],
    }), new SessionPool());
    const chunks = (await response.text()).split("\n")
      .filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
      .map(line => JSON.parse(line.slice(6)));
    return chunks;
  }

  afterEach(() => {
    scripted.queue = [];
    scripted.deltas = [];
    scripted.fullText = undefined;
    resetAgentRoutes();
  });

  it("streams prose in multiple chunks even when tools are available", async () => {
    const deltas = [
      "The parser reads the configuration and validates each entry before passing it to the next stage. ".repeat(3),
      "The next stage keeps the original ordering and reports invalid entries explicitly. ",
      "This preserves the intended behavior and makes the result easier to inspect.",
    ];
    const chunks = await collect(deltas);
    const content = chunks.map(chunk => chunk.choices?.[0]?.delta?.content).filter(Boolean);
    expect(content.length).toBeGreaterThan(1);
    expect(content.join("")).toBe(deltas.join(""));
  });

  it("keeps streaming a deployment summary after actual tool use and an inline filename", async () => {
    const deltas = [
      "Previously deployed 27-event catalog, shop server UI improvements, and OP Roles pre-round weighting/restoration fixes.\n",
      "Implemented and deployed event IDs 1–27, persisted in `eventos",
      ".json`.\n",
      "The identifiers remain stable across restarts. ",
      "The configuration preserves all 27 events.",
    ];
    const chunks = await collect(deltas, true);
    const content = chunks.map(chunk => chunk.choices?.[0]?.delta?.content).filter(Boolean);
    expect(content.join("")).toBe(deltas.join(""));
    expect(content).toContain(".json`.\n");
    expect(content).toContain("The identifiers remain stable across restarts. ");
    expect(content).toContain("The configuration preserves all 27 events.");
    expect(chunks.flatMap(chunk => chunk.choices?.[0]?.delta?.tool_calls ?? [])).toHaveLength(0);
  });

  it("never streams a raw tool fence split across upstream deltas", async () => {
    const chunks = await collect(["`", "``ba", "sh\n", "pwd", "\n```"]);
    const content = chunks.map(chunk => chunk.choices?.[0]?.delta?.content ?? "").join("");
    expect(content).toBe("");
    const calls = chunks.flatMap(chunk => chunk.choices?.[0]?.delta?.tool_calls ?? []);
    expect(calls).toHaveLength(2);
    expect(calls[0].function.name).toBe("bash");
    expect(calls[0].function.arguments).toBe("");
    expect(calls[0].id).toMatch(/^call_/);
    expect(calls[1].index).toBe(0);
    expect(calls[1].id).toBeUndefined();
    expect(calls[1].function.name).toBeUndefined();
    expect(JSON.parse(calls.map(call => call.function.arguments).join("")).command).toBe("pwd");
    expect(chunks.some(chunk => chunk.choices?.[0]?.delta?.reasoning_content)).toBe(false);
  });

  it("waits for the complete shell header before starting native tool input", async () => {
    const chunks = await collect(["```bash", "\n", "pwd", "\n```"]);
    const calls = chunks.flatMap(chunk => chunk.choices?.[0]?.delta?.tool_calls ?? []);
    expect(calls).toHaveLength(2);
    expect(calls[0].function).toEqual({ name: "bash", arguments: "" });
    expect(JSON.parse(calls[1].function.arguments)).toEqual({ command: "pwd" });
    expect(chunks.at(-1).choices[0].finish_reason).toBe("tool_calls");
  });

  it("does not start native tool input for a longer ordinary fence name", async () => {
    const deltas = ["```bash", "-example\n", "pwd\n", "```"];
    const chunks = await collect(deltas);
    expect(chunks.flatMap(chunk => chunk.choices?.[0]?.delta?.tool_calls ?? [])).toHaveLength(0);
    expect(chunks.map(chunk => chunk.choices?.[0]?.delta?.content ?? "").join("")).toBe(deltas.join(""));
  });

  for (const fence of ["shell", "bash", "sh"]) {
    it(`starts native shell input for a ${fence} fence when the harness tool is shell`, async () => {
      const requestTools = [{
        type: "function",
        function: {
          name: "shell",
          parameters: {
            type: "object",
            properties: { command: { type: "string" } },
          },
        },
      }];
      const chunks = await collect(["``", "`" + fence, "\n", "pwd", "\n```"], false, requestTools);
      const calls = chunks.flatMap(chunk => chunk.choices?.[0]?.delta?.tool_calls ?? []);
      expect(calls).toHaveLength(2);
      expect(calls[0].function).toEqual({ name: "shell", arguments: "" });
      expect(calls[0].id).toMatch(/^call_/);
      expect(calls[1].index).toBe(0);
      expect(calls[1].id).toBeUndefined();
      expect(calls[1].function.name).toBeUndefined();
      expect(JSON.parse(calls[1].function.arguments)).toEqual({ command: "pwd" });
      expect(chunks.map(chunk => chunk.choices?.[0]?.delta?.content ?? "").join("")).toBe("");
      expect(chunks.some(chunk => chunk.choices?.[0]?.delta?.reasoning_content)).toBe(false);
      expect(chunks.at(-1).choices[0].finish_reason).toBe("tool_calls");
    });
  }

  for (const name of ["patch", "apply_patch", "edit", "write", "edit_file", "write_file"]) {
    it(`starts native ${name} input before delivering validated arguments`, async () => {
      const patchTool = name === "patch" || name === "apply_patch";
      const properties = patchTool
        ? { patchText: { type: "string" } }
        : { filePath: { type: "string" }, content: { type: "string" } };
      const requestTools = [{
        type: "function",
        function: { name, parameters: { type: "object", properties } },
      }];
      const body = patchTool
        ? "*** Begin Patch\n*** Add File: example.txt\n+hello\n*** End Patch"
        : "filePath: example.txt\n\nhello";
      const chunks = await collect(["``", "`" + name, "\n", body, "\n```"], false, requestTools);
      const calls = chunks.flatMap(chunk => chunk.choices?.[0]?.delta?.tool_calls ?? []);
      expect(calls).toHaveLength(2);
      expect(calls[0].function).toEqual({ name, arguments: "" });
      expect(calls[0].id).toMatch(/^call_/);
      expect(calls[1].index).toBe(0);
      expect(calls[1].id).toBeUndefined();
      expect(calls[1].function.name).toBeUndefined();
      const args = JSON.parse(calls[1].function.arguments);
      if (patchTool) expect(args.patchText).toBe(body);
      else {
        expect(args.filePath).toBe("example.txt");
        expect(args.content).toBe("hello");
      }
      expect(chunks.map(chunk => chunk.choices?.[0]?.delta?.content ?? "").join("")).toBe("");
      expect(chunks.some(chunk => chunk.choices?.[0]?.delta?.reasoning_content)).toBe(false);
      expect(chunks.at(-1).choices[0].finish_reason).toBe("tool_calls");
    });
  }

  it("continues streaming after an ordinary code example with a split header", async () => {
    const deltas = [
      "This example describes the configuration without executing any workspace tool. ",
      "``",
      "`j",
      "son\n",
      '{"enabled": true}\n',
      "``",
      "`\n",
      "The explanation continues immediately after the example. ",
      "Additional details must arrive before the final response is complete.",
    ];
    const chunks = await collect(deltas);
    const content = chunks.map(chunk => chunk.choices?.[0]?.delta?.content).filter(Boolean);
    expect(content.join("")).toBe(deltas.join(""));
    expect(content.some(text => text.includes("explanation continues"))).toBe(true);
    expect(content[content.length - 1]).not.toContain("explanation continues");
    expect(chunks.flatMap(chunk => chunk.choices?.[0]?.delta?.tool_calls ?? [])).toHaveLength(0);
  });

  it("does not hold a short prose answer until the upstream turn finishes", async () => {
    const deltas = [
      "The configuration is valid and the parser preserves its original ordering. ",
      "No additional changes are needed.",
    ];
    const chunks = await collect(deltas);
    const content = chunks.map(chunk => chunk.choices?.[0]?.delta?.content).filter(Boolean);
    expect(content.length).toBeGreaterThan(1);
    expect(content.join("")).toBe(deltas.join(""));
  });

  it("streams inline code spans with backticks progressively even when split across deltas", async () => {
    const deltas = [
      "- Added ",
      "`party",
      "Presence` ",
      "to handle the new case. ",
      "The fix ensures consistent behavior.",
    ];
    const chunks = await collect(deltas);
    const content = chunks.map(chunk => chunk.choices?.[0]?.delta?.content).filter(Boolean);
    expect(content.length).toBeGreaterThan(1);
    expect(content.join("")).toBe(deltas.join(""));
    expect(chunks.flatMap(chunk => chunk.choices?.[0]?.delta?.tool_calls ?? [])).toHaveLength(0);
  });

  it("does not rotate a conversation merely because object keys change order", async () => {
    scripted.newConversations = 0;
    scripted.queue = [{ fullText: "Received." }, { fullText: "Continued." }];
    const pool = new SessionPool();
    const post = (messages: any[]) => handleChatCompletion(ChatCompletionRequest.parse({
      model: "gpt-6.1-sol", stream: false, tools, messages,
    }), pool);
    await post([{ role: "user", content: "Keep this task context." }]);
    await post([
      { content: "Keep this task context.", role: "user" },
      { role: "assistant", content: "Received." },
      { role: "user", content: "Continue." },
    ]);
    expect(scripted.newConversations).toBe(0);
  });
});

describe("workspace framing on continued tool turns", () => {
  it("keeps initial workspace framing without repeating it or rotating the thread", async () => {
    scripted.result = null;
    scripted.texts = [];
    scripted.newConversations = 0;
    scripted.queue = [{ fullText: "```bash\npwd\n```" }, { fullText: "Done." }];
    const pool = new SessionPool();
    const tools = [{
      type: "function",
      function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } },
    }];
    const messages: any[] = [
      { role: "system", content: "WORKSPACE_REFRESH: /project/real; use the local harness tools." },
      { role: "user", content: "Inspect the current project." },
    ];
    const post = async () => {
      const response = await handleChatCompletion(ChatCompletionRequest.parse({
        model: "gpt-6.1-sol", stream: false, tools, messages,
      }), pool);
      expect(response.status).toBe(200);
      return (await response.json()).choices[0].message;
    };
    try {
      const first = await post();
      messages.push(
        { role: "assistant", content: null, tool_calls: first.tool_calls },
        { role: "tool", tool_call_id: first.tool_calls[0].id, content: "/project/real" },
      );
      await post();
      expect(scripted.newConversations).toBe(0);
      expect(scripted.texts[0]).toContain("WORKSPACE_REFRESH");
      expect(scripted.texts[0]).toContain("My workflow preferences for this task:");
      expect(scripted.texts[1]).not.toContain("WORKSPACE_REFRESH");
      expect(scripted.texts[1]).not.toContain("My workflow preferences for this task:");
      expect(scripted.texts[1]).not.toContain("Before the task, a note on how we'll work:");
      expect(scripted.texts[1]).toContain('<tool_response tool="bash"');
    } finally {
      scripted.queue = [];
      resetAgentRoutes();
    }
  });
});


describe("RESTORECONTEXT", () => {
  afterEach(() => {
    scripted.queue = [];
    scripted.result = null;
    resetAgentRoutes();
  });

  async function post(pool: InstanceType<typeof SessionPool>, messages: any[], stream = false) {
    scripted.result = null;
    scripted.queue = [{ fullText: "Context received." }];
    const response = await handleChatCompletion(ChatCompletionRequest.parse({
      model: "gpt-6.1-sol", stream, messages,
    }), pool);
    expect(response.status).toBe(200);
    await response.text();
    return scripted.texts.at(-1)!;
  }

  it("replays exactly the last 700 transcript lines and preserves current instructions", async () => {
    const messages: any[] = [
      { role: "system", content: "CURRENT_WORKSPACE_RULES" },
      { role: "user", content: Array.from({ length: 900 }, (_, i) => `HISTORY_LINE_${i}`).join("\n") },
      { role: "assistant", content: "LAST_VERIFIED_STATE" },
      { role: "user", content: "  RESTORECONTEXT\n" },
    ];
    const original = JSON.stringify(messages);
    const prompt = await post(new SessionPool(), messages);
    const recovered = prompt.split("BEGIN RECOVERED HISTORY\n")[1]
      .split("\nEND RECOVERED HISTORY")[0];
    expect(recovered.split("\n")).toHaveLength(700);
    expect(recovered).not.toContain("HISTORY_LINE_0\n");
    expect(recovered).toContain("HISTORY_LINE_899");
    expect(recovered).toContain("LAST_VERIFIED_STATE");
    expect(prompt).toContain("CURRENT_WORKSPACE_RULES");
    expect(JSON.stringify(messages)).toBe(original);
  });

  it("restores into a fresh upstream conversation and then continues that conversation normally", async () => {
    const pool = new SessionPool();
    const messages: any[] = [{ role: "user", content: "ORIGINAL_TASK_MARKER" }];
    await post(pool, messages);
    const rotations = scripted.newConversations;
    messages.push(
      { role: "assistant", content: null, tool_calls: [{
        id: "call-restore", type: "function",
        function: { name: "bash", arguments: '{"command":"pwd"}' },
      }] },
      { role: "tool", tool_call_id: "call-restore", content: "REAL_WORKSPACE_RESULT" },
      { role: "user", content: "RESTORECONTEXT" },
    );
    const prompt = await post(pool, messages, true);
    expect(prompt).toContain("ORIGINAL_TASK_MARKER");
    expect(prompt).toContain("pwd");
    expect(prompt).toContain("REAL_WORKSPACE_RESULT");
    expect(prompt).toContain("BEGIN RECOVERED HISTORY");
    expect(scripted.newConversations).toBe(rotations + 1);
    messages.push(
      { role: "assistant", content: "Context received." },
      { role: "user", content: "Continue normally." },
    );
    const next = await post(pool, messages);
    expect(next).not.toContain("BEGIN RECOVERED HISTORY");
    expect(scripted.newConversations).toBe(rotations + 1);
  });

  it("preserves the task and latest steering when a long tool result fills the replay window", async () => {
    const messages: any[] = [
      { role: "system", content: "CURRENT_WORKSPACE_RULES" },
      { role: "user", content: "ORIGINAL_TASK: repair context restoration, not the image viewer." },
      { role: "assistant", content: "I will inspect the handler." },
      { role: "user", content: "LATEST_STEERING: preserve existing changes and do not implement PDF selection." },
      { role: "assistant", content: null, tool_calls: [{
        id: "call-long-output", type: "function",
        function: { name: "bash", arguments: '{"command":"cat handler.ts"}' },
      }] },
      { role: "tool", tool_call_id: "call-long-output",
        content: Array.from({ length: 950 }, (_, i) => `TOOL_OUTPUT_${i}`).join("\n") },
      { role: "assistant", content: "The output needs inspection." },
      { role: "user", content: "RESTORECONTEXT" },
    ];
    const original = JSON.stringify(messages);
    for (const stream of [false, true]) {
      const prompt = await post(new SessionPool(), messages, stream);
      const recovered = prompt.split("BEGIN RECOVERED HISTORY\n")[1]
        .split("\nEND RECOVERED HISTORY")[0];
      expect(recovered.split("\n")).toHaveLength(700);
      expect(recovered).not.toContain("ORIGINAL_TASK:");
      expect(recovered).not.toContain("LATEST_STEERING:");
      expect(prompt).toContain("ORIGINAL_TASK: repair context restoration, not the image viewer.");
      expect(prompt).toContain("LATEST_STEERING: preserve existing changes and do not implement PDF selection.");
      expect(prompt).toContain("CURRENT_WORKSPACE_RULES");
      expect(prompt).toContain("TOOL_OUTPUT_949");
      expect(JSON.stringify(messages)).toBe(original);
    }
  });

  it("does not trigger on mentions or tool output", async () => {
    for (const latest of [
      { role: "user", content: "Explain RESTORECONTEXT please" },
      { role: "tool", tool_call_id: "x", content: "RESTORECONTEXT" },
    ]) {
      const prompt = await post(new SessionPool(), [
        { role: "user", content: "Initial task" }, latest,
      ]);
      expect(prompt).not.toContain("BEGIN RECOVERED HISTORY");
    }
  });

  it("handles an empty history and multipart text commands", async () => {
    const prompt = await post(new SessionPool(), [{
      role: "user", content: [{ type: "text", text: "RESTORECONTEXT" }],
    }]);
    expect(prompt).toContain("No prior history is available in this request.");
  });
});

describe("RESENDTOOLS", () => {
  const tools = [{
    type: "function",
    function: {
      name: "shell",
      description: "Run a command",
      parameters: { type: "object", properties: { command: { type: "string" } } },
    },
  }];

  afterEach(() => {
    scripted.queue = [];
    scripted.result = null;
    resetAgentRoutes();
  });

  async function post(pool: InstanceType<typeof SessionPool>, messages: any[]) {
    scripted.result = null;
    scripted.queue = [{ fullText: "Tools received." }];
    const response = await handleChatCompletion(ChatCompletionRequest.parse({
      model: "gpt-6.1-sol", stream: false, tools, messages,
    }), pool);
    expect(response.status).toBe(200);
    await response.text();
    return scripted.texts.at(-1)!;
  }

  it("re-sends the tool framing into the same conversation, keeping history", async () => {
    const pool = new SessionPool();
    const messages: any[] = [{ role: "user", content: "ORIGINAL_TASK_MARKER" }];
    await post(pool, messages);
    const rotations = scripted.newConversations;
    messages.push(
      { role: "assistant", content: "Working on it." },
      { role: "user", content: "RESENDTOOLS" },
    );
    const prompt = await post(pool, messages);
    expect(prompt).toContain("ORIGINAL_TASK_MARKER");
    expect(prompt).not.toContain("RESENDTOOLS");
    expect(prompt).toContain("```bash"); // tool templates/framing re-sent
    expect(prompt).not.toContain("BEGIN RECOVERED HISTORY");
    expect(scripted.newConversations).toBe(rotations); // same conversation
  });

  it("accepts RESTORETOOLS, SENDTOOLS and surrounding whitespace", async () => {
    for (const command of ["RESTORETOOLS", "SENDTOOLS", "  resendtools  "]) {
      const pool = new SessionPool();
      const messages: any[] = [{ role: "user", content: "TASK_MARKER" }];
      await post(pool, messages);
      const rotations = scripted.newConversations;
      messages.push({ role: "user", content: command });
      const prompt = await post(pool, messages);
      expect(prompt).toContain("TASK_MARKER");
      expect(prompt).toContain("```bash");
      expect(scripted.newConversations).toBe(rotations);
    }
  });

  it("still lets a mention inside a sentence go down the normal delta path", async () => {
    const pool = new SessionPool();
    const messages: any[] = [{ role: "user", content: "TASK_MARKER" }];
    await post(pool, messages);
    messages.push({ role: "user", content: "Explain RESENDTOOLS please" });
    const prompt = await post(pool, messages);
    // A normal continuation sends only the new message, not a full replay.
    expect(prompt).not.toContain("TASK_MARKER");
    expect(prompt).toContain("Explain RESENDTOOLS please");
  });
});

describe("synthetic proxy waiting indicator", () => {
  it("adds GPT-6 workflow preferences initially without repeating them on continued tool turns", async () => {
    const tools = [{
      type: "function",
      function: {
        name: "bash",
        parameters: { type: "object", properties: { command: { type: "string" } } },
      },
    }];
    try {
      for (const model of ["gpt-6-think-deeper", "gpt-6-sol", "gpt-6.1-sol", "claude-sonnet"]) {
        scripted.result = null;
        scripted.texts = [];
        scripted.queue = [
          { fullText: "```bash\npwd\n```" },
          { fullText: "Done." },
        ];
        const pool = new SessionPool();
        const messages: any[] = [{ role: "user", content: "Inspect this project." }];
        const post = async () => {
          const response = await handleChatCompletion(ChatCompletionRequest.parse({
            model, stream: false, tools, messages,
          }), pool);
          expect(response.status).toBe(200);
          return (await response.json()).choices[0].message;
        };
        const first = await post();
        expect(first.tool_calls).toHaveLength(1);
        messages.push(
          { role: "assistant", content: null, tool_calls: first.tool_calls },
          { role: "tool", tool_call_id: first.tool_calls[0].id, content: "/project" },
        );
        await post();
        expect(scripted.texts).toHaveLength(2);
        for (const [index, prompt] of scripted.texts.entries()) {
          if (model === "claude-sonnet" || index > 0) {
            expect(prompt).not.toContain("My workflow preferences for this task:");
            expect(prompt).not.toContain("dedicated patch or editing tool");
            if (index > 0) {
              expect(prompt).not.toContain("Before the task, a note on how we'll work:");
            }
          } else {
            expect(prompt).toContain("dedicated patch or editing tool");
            expect(prompt).toContain("[descriptive label](https://example.com/path)");
            expect(prompt).toContain("Keep sentence punctuation outside the Markdown link");
            expect(prompt).toContain("not file contents, code examples, or tool arguments");
            expect(prompt).toContain("Do not create .bak");
            expect(prompt).toContain("Keep shell output operational");
            expect(prompt).toContain("final plain-text response outside any tool block");
          }
        }
      }
    } finally {
      scripted.queue = [];
      scripted.result = null;
      resetAgentRoutes();
    }
  });

  async function silentTurn(model: string, disabled = false, toolTurn = false, waitMs = 10_000) {
    scripted.queue = [];
    scripted.result = null;
    scripted.deltas = toolTurn
      ? ["`", "``sh", "ell", "\n", "pwd", "\n```"]
      : ["Real response."];
    scripted.fullText = scripted.deltas.join("");
    let release!: () => void;
    scripted.gate = new Promise<void>(resolve => { release = resolve; });
    const previous = process.env.M365_WAIT_INDICATOR;
    if (disabled) process.env.M365_WAIT_INDICATOR = "0";
    else delete process.env.M365_WAIT_INDICATOR;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      const pending = handleChatCompletion(ChatCompletionRequest.parse({
        model, stream: true,
        ...(toolTurn ? { tools: [{
          type: "function",
          function: {
            name: "shell",
            parameters: { type: "object", properties: { command: { type: "string" } } },
          },
        }] } : {}),
        messages: [{ role: "user", content: "Describe the project." }],
      }), new SessionPool()).then(response => response.text());
      await vi.advanceTimersByTimeAsync(waitMs);
      release();
      const text = await pending;
      const chunks = text.split("\n")
        .filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
        .map(line => JSON.parse(line.slice(6)));
      expect(vi.getTimerCount()).toBe(0);
      return chunks;
    } finally {
      release();
      scripted.gate = null;
      scripted.deltas = [];
      scripted.fullText = undefined;
      if (previous === undefined) delete process.env.M365_WAIT_INDICATOR;
      else process.env.M365_WAIT_INDICATOR = previous;
      vi.useRealTimers();
    }
  }

  for (const model of ["gpt-6-sol", "gpt-6.1-sol"]) {
    it(`emits separate waiting dots for ${model}, without changing the answer`, async () => {
      const chunks = await silentTurn(model);
      const reasoning = chunks.map(c => c.choices?.[0]?.delta?.reasoning_content ?? "").join("");
      const content = chunks.map(c => c.choices?.[0]?.delta?.content ?? "").join("");
      const statuses = chunks
        .map(c => c.choices?.[0]?.delta?.reasoning_content)
        .filter(status => status !== undefined);
      expect(statuses).toHaveLength(9);
      expect(statuses[0]).toBe("The model is thinking internally.");
      expect(statuses.slice(1)).toEqual(Array(8).fill("."));
      expect(reasoning).toBe("The model is thinking internally" + ".".repeat(9));
      expect(content).toBe("Real response.");
      expect(chunks.at(-1).choices[0].finish_reason).toBe("stop");
    });
  }

  it("can be disabled explicitly", async () => {
    const chunks = await silentTurn("gpt-6.1-sol", true);
    expect(chunks.some(c => c.choices?.[0]?.delta?.reasoning_content)).toBe(false);
  });

  it("ends waiting reasoning before starting native input for a split shell header", async () => {
    const chunks = await silentTurn("gpt-6.1-sol", false, true);
    const boundary = chunks.findIndex(c =>
      Array.isArray(c.choices?.[0]?.delta?.tool_calls) &&
      c.choices[0].delta.tool_calls.length === 0);
    const start = chunks.findIndex(c =>
      c.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name === "shell");
    expect(boundary).toBeGreaterThan(0);
    expect(start).toBeGreaterThan(boundary);
    expect(chunks.slice(0, boundary).filter(c =>
      c.choices?.[0]?.delta?.reasoning_content !== undefined)).toHaveLength(9);
    expect(chunks.slice(boundary).some(c =>
      c.choices?.[0]?.delta?.reasoning_content !== undefined)).toBe(false);
    const calls = chunks.flatMap(c => c.choices?.[0]?.delta?.tool_calls ?? []);
    expect(calls).toHaveLength(2);
    expect(calls[0].function).toEqual({ name: "shell", arguments: "" });
    expect(JSON.parse(calls[1].function.arguments)).toEqual({ command: "pwd" });
    expect(chunks.map(c => c.choices?.[0]?.delta?.content ?? "").join("")).toBe("");
    expect(chunks.at(-1).choices[0].finish_reason).toBe("tool_calls");
  });

  for (const waitMs of [100, 1900]) {
    it(`skips Thinking when native tool output starts after ${waitMs}ms`, async () => {
      const chunks = await silentTurn("gpt-6.1-sol", false, true, waitMs);
      expect(chunks.some(c =>
        c.choices?.[0]?.delta?.reasoning_content !== undefined)).toBe(false);
      expect(chunks.some(c =>
        c.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name === "shell")).toBe(true);
      expect(chunks.at(-1).choices[0].finish_reason).toBe("tool_calls");
    });
  }

  it("shows Thinking at the two-second threshold", async () => {
    const chunks = await silentTurn("gpt-6.1-sol", false, true, 2000);
    const statuses = chunks
      .map(c => c.choices?.[0]?.delta?.reasoning_content)
      .filter(status => status !== undefined);
    expect(statuses).toEqual(["The model is thinking internally."]);
    expect(chunks.at(-1).choices[0].finish_reason).toBe("tool_calls");
  });

  it("shows Thinking for any model whose id doesn't say `think`", async () => {
    const chunks = await silentTurn("m365-copilot");
    expect(chunks.some(c => c.choices?.[0]?.delta?.reasoning_content)).toBe(true);
  });

  for (const model of ["gpt-6-think-deeper", "claude-opus-think-deeper"]) {
    it(`adds no synthetic reasoning to the reasoning model ${model}`, async () => {
      const chunks = await silentTurn(model);
      expect(chunks.some(c => c.choices?.[0]?.delta?.reasoning_content)).toBe(false);
    });
  }
});

import { type ModelSessionOptions, getAvailableModels } from "@m365-copilot/core";
import { ChatCompletionRequest } from "./schemas.js";
import { SessionPool, handleChatCompletion } from "./handler.js";

export { SessionPool, handleChatCompletion } from "./handler.js";
export { applySystemPrompt, stripHarnessPrompt, systemPromptOverride } from "./system-filter.js";
export { ChatCompletionRequest, ChatMessage, ToolCall, ToolDefinition } from "./schemas.js";

// Re-export tool utilities from core
export {
  formatMessages,
  formatToolDefinitions,
  parseToolCalls,
  getMessageContent,
  type Message,
  type ToolDef,
  type ToolChoice,
  type ParsedToolCall,
  type ParseResult,
} from "@m365-copilot/core";

// --- Shared response payloads (reused by the Nitro routes in @m365-copilot/proxy) ---

/** Static body for `GET /health`. */
export const HEALTH_PAYLOAD = { status: "ok" } as const;

// Window/output hints surfaced to harnesses on /v1/models so they can size
// context packing and output expectations. These are ADVERTISED hints only — M365
// enforces its own limits server-side. Advertise each model's published window and
// max output so harnesses neither pre-truncate our prompts/output nor compact early;
// unknown tones fall back to the env defaults. Empirically (docs/hypotheses.md F9)
// M365 accepts ≥500k tokens of input (retrieval-backed).
const DEFAULT_CONTEXT_WINDOW_TOKENS = Number(process.env.M365_CONTEXT_WINDOW) || 1_000_000;
const DEFAULT_MAX_OUTPUT_TOKENS = Number(process.env.M365_MAX_OUTPUT_TOKENS) || 128_000;

/** Published context window / max output of the model behind each tone. */
const MODEL_LIMITS: ReadonlyArray<readonly [RegExp, number, number]> = [
  [/^gpt-5\.2/, 400_000, 128_000],
  [/^gpt-5\.3/, 128_000, 16_384],
  [/^gpt-5\.[4-6]/, 1_050_000, 128_000],
  [/^gpt-6/, 1_050_000, 128_000],
  [/^claude/, 1_000_000, 128_000],
];

export function modelLimits(id: string): { context: number; output: number } {
  for (const [pattern, context, output] of MODEL_LIMITS) {
    if (pattern.test(id)) return { context, output };
  }
  return { context: DEFAULT_CONTEXT_WINDOW_TOKENS, output: DEFAULT_MAX_OUTPUT_TOKENS };
}

/** Build the OpenAI-compatible `GET /v1/models` payload. */
export function buildModelsPayload() {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: "list",
    data: getAvailableModels().map((id) => {
      const { context, output } = modelLimits(id);
      return {
        id,
        object: "model",
        created,
        owned_by: "microsoft",
        context_window: context,
        max_context_length: context,
        max_input_tokens: context,
        max_output_tokens: output,
      };
    }),
  };
}

// --- CORS (permissive, matches the previous Hono `cors()` default) ---

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function withCors(res: Response): Response {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  return res;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A minimal Web fetch handler — the same shape Hono exposed via `app.fetch`. */
export interface FetchApp {
  fetch(req: Request): Promise<Response>;
}

/**
 * Create a framework-free fetch handler that serves an OpenAI-compatible API
 * backed by M365 Copilot. Each distinct conversation automatically gets its own
 * M365 session via the SessionPool.
 *
 * This is the embeddable entry point used by the tests, `proxy-verify`, and the
 * openclaw-plugin. The standalone server is the Nitro app in `@m365-copilot/proxy`,
 * whose routes reuse the same `handleChatCompletion` / `buildModelsPayload` helpers.
 */
export function createApp(sessionOptions: ModelSessionOptions = {}): FetchApp {
  const pool = new SessionPool(sessionOptions);

  async function fetch(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    const method = req.method.toUpperCase();

    if (method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    if (method === "GET" && pathname === "/health") {
      return withCors(json(200, HEALTH_PAYLOAD));
    }

    if (method === "GET" && pathname === "/v1/models") {
      return withCors(json(200, buildModelsPayload()));
    }

    if (method === "POST" && pathname === "/v1/chat/completions") {
      let body: ReturnType<typeof ChatCompletionRequest.parse>;
      try {
        body = ChatCompletionRequest.parse(await req.json());
      } catch (err: any) {
        return withCors(
          json(400, { error: { message: err.message, type: "invalid_request_error" } }),
        );
      }
      // req.signal aborts when the client disconnects → cancels the M365 turn.
      return withCors(await handleChatCompletion(body, pool, { signal: req.signal }));
    }

    return withCors(
      json(404, { error: { message: "Not found", type: "invalid_request_error" } }),
    );
  }

  return { fetch };
}

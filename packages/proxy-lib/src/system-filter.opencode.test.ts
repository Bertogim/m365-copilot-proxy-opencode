import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readPromptFile } from "@m365-copilot/core";
import { applySystemPrompt, stripHarnessPrompt } from "./system-filter.js";

const PROMPT = readPromptFile("opencode-system.md");

/** The OpenCode release `packages/prompts/opencode-system.md` was seeded from.
 *  A different version is not a failure — it is a warning to re-capture the
 *  prompt before trusting it. Bump this when the capture is refreshed. */
const KNOWN_OPENCODE_VERSION = "2.2.5";

/** Anchors the harness prompt has carried in every version we captured. If they
 *  disappear, the prompt changed shape and `opencode-system.md` is stale. */
const HARNESS_ANCHORS = ["OpenCode", "system-reminder", "# Harness"];

/** The plain text the test asks OpenCode to send. */
const USER_TEXT = "hello from the fake proxy test";

/** How many extra chars of harness tags (system-reminder, env, ...) the user
 *  turn may carry before the test calls it a leak. */
const USER_TAG_BUDGET = 150;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text?: unknown }).text ?? "") : ""))
      .join("");
  }
  return content == null ? "" : JSON.stringify(content);
}

const WARN = "[opencode prompt check]";

function warn(message: string): void {
  console.warn(`${WARN} ${message}`);
}

// --- Unit: the filter itself ------------------------------------------------

describe("system prompt filter", () => {
  it("drops every harness control message and keeps the conversation", () => {
    const messages = [
      { role: "system", content: "You are OpenCode <tools>x</tools>" },
      { role: "developer", content: "dev note" },
      { role: "user", content: "do the thing" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "again" },
    ];
    expect(stripHarnessPrompt(messages).map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    const filtered = applySystemPrompt(messages, PROMPT);
    expect(filtered.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(filtered[0]!.content).toBe(PROMPT);
    expect(JSON.stringify(filtered)).not.toContain("<tools>");
  });

  it("is a no-op when disabled", () => {
    const messages = [{ role: "system", content: "harness" }, { role: "user", content: "hi" }];
    expect(applySystemPrompt(messages, null)).toEqual(messages);
  });
});

// --- E2E: real OpenCode -> fake proxy -> filtered request -------------------

function findOpencode(): string | null {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN;
  try {
    const found = execFileSync("which", ["opencode"], { encoding: "utf8" }).trim();
    if (found) return found;
  } catch {
    // fall through to the default install location
  }
  const local = join(homedir(), ".opencode", "bin", "opencode");
  return existsSync(local) ? local : null;
}

const OPENCODE = findOpencode();
if (!OPENCODE) {
  warn(
    "opencode binary not found — the real-opencode filter check is SKIPPED. " +
      "Install opencode or set OPENCODE_BIN so OpenCode upgrades are caught here.",
  );
}

function opencodeVersion(bin: string): string | null {
  try {
    const out = execFileSync(bin, ["--version"], { encoding: "utf8" }).trim();
    return out.match(/\d+\.\d+\.\d+/)?.[0] ?? out;
  } catch {
    return null;
  }
}

interface Captured {
  raw: Record<string, unknown> & { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function?: { name?: string } }> };
  filtered: Array<{ role: string; content: unknown }>;
}

/** Fake OpenAI-compatible proxy: applies the real filter and records the result. */
function startFakeProxy(outDir: string): Promise<{ server: Server; port: number; captured: Map<string, Captured> }> {
  const captured = new Map<string, Captured>();
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (!req.url?.includes("/chat/completions")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [] }));
        return;
      }
      const raw = JSON.parse(body) as Captured["raw"];
      const kind = Array.isArray(raw.tools) && raw.tools.length > 0 ? "main" : "title";
      const filtered = applySystemPrompt(raw.messages, PROMPT);
      captured.set(kind, { raw, filtered });
      writeFileSync(join(outDir, `${kind}.json`), JSON.stringify({ raw, filtered }, null, 2));

      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: object, finish: string | null) =>
        `data: ${JSON.stringify({
          id: "1",
          object: "chat.completion.chunk",
          created: 0,
          model: raw.model,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      res.write(chunk({ role: "assistant", content: "ok" }, null));
      res.write(chunk({}, "stop"));
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      resolve({ server, port: address.port, captured });
    });
  });
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!OPENCODE)("real opencode -> fake proxy (filter out)", () => {
  it(
    "sends only packages/prompts/opencode-system.md as the system message",
    async () => {
      const version = opencodeVersion(OPENCODE!) ?? "unknown";
      if (version !== KNOWN_OPENCODE_VERSION) {
        warn(
          `opencode ${version} differs from the version the prompt was captured from ` +
            `(${KNOWN_OPENCODE_VERSION}). Re-run this check; if the harness prompt changed, ` +
            `re-capture it and update packages/prompts/opencode-system.md.`,
        );
      }

      const dir = mkdtempSync(join(tmpdir(), "m365-filter-"));
      dirs.push(dir);
      const { server, port, captured } = await startFakeProxy(dir);
      try {
        const config = {
          $schema: "https://opencode.ai/config.json",
          model: "m365/gpt-6.1-sol",
          provider: {
            m365: {
              npm: "@ai-sdk/openai-compatible",
              name: "Fake M365",
              options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "test" },
              models: { "gpt-6.1-sol": { name: "Fake" } },
            },
          },
        };
        const env = {
          ...process.env,
          HOME: dir,
          XDG_DATA_HOME: join(dir, "data"),
          XDG_CONFIG_HOME: join(dir, "config"),
          XDG_CACHE_HOME: join(dir, "cache"),
          XDG_STATE_HOME: join(dir, "state"),
          OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
          OPENCODE_DB: join(dir, "db.sqlite"),
          OPENCODE_DISABLE_MODELS_FETCH: "1",
          OPENCODE_DISABLE_AUTOUPDATE: "1",
          OPENCODE_DISABLE_SHARE: "1",
          CI: "1",
        };
        const child = spawn(OPENCODE!, ["run", "--standalone", "hello from the fake proxy test"], {
          cwd: dir,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => (stderr += chunk));
        const code = await new Promise<number | null>((resolve) => {
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            resolve(null);
          }, 120_000);
          child.on("exit", (exitCode) => {
            clearTimeout(timer);
            resolve(exitCode);
          });
        });

        const main = captured.get("main");
        if (!main) {
          throw new Error(
            `${WARN} opencode ${version} made no tool-bearing request (exit ${code}). ` +
              `The CLI flags or the config shape may have changed; check "opencode run --standalone" ` +
              `and OPENCODE_CONFIG_CONTENT.\n${stderr.slice(-2000)}`,
          );
        }

        const problems: string[] = [];

        // 1. OpenCode really did send its own prompt...
        const rawSystem = main.raw.messages
          .filter((m) => m.role === "system")
          .map((m) => String(m.content))
          .join("\n");
        if (rawSystem.length < 2000) {
          problems.push(`the harness system prompt shrank to ${rawSystem.length} chars (expected >2000)`);
        }
        const missingAnchors = HARNESS_ANCHORS.filter((anchor) => !rawSystem.includes(anchor));
        if (missingAnchors.length > 0) {
          problems.push(`the harness prompt no longer contains ${missingAnchors.map((a) => JSON.stringify(a)).join(", ")}`);
        }

        // 2. ...and the proxy replaced all of it with exactly our file.
        const systems = main.filtered.filter((m) => m.role === "system");
        if (systems.length !== 1) problems.push(`the filtered request carries ${systems.length} system messages (expected 1)`);
        if (main.filtered[0]?.role !== "system") problems.push("the filtered request does not start with the system message");
        if (systems[0]?.content !== PROMPT) {
          problems.push(
            "the filtered system message is NOT packages/prompts/opencode-system.md verbatim " +
              `(got ${textOf(systems[0]?.content).length} chars, expected ${PROMPT.length})`,
          );
        }
        if (main.filtered.some((m) => m.role === "developer")) problems.push("a developer message survived the filter");

        // 3. No harness text leaks, and the user turn survives.
        const wire = JSON.stringify(main.filtered);
        for (const leak of ["Code Mode", "tools.opencode", "available_skills", "<env>", "Today's date", "<tools>"]) {
          if (wire.includes(leak)) problems.push(`the filtered request still contains ${JSON.stringify(leak)}`);
        }
        const userWire = main.filtered.filter((m) => m.role === "user").map((m) => textOf(m.content)).join("\n");
        if (!userWire.includes(USER_TEXT)) problems.push("the user message did not survive the filter");
        const extra = userWire.length - USER_TEXT.length;
        if (extra > USER_TAG_BUDGET) {
          problems.push(
            `the user turn carries ${extra} extra chars of harness tags (budget ${USER_TAG_BUDGET}): ` +
              JSON.stringify(userWire.slice(0, 400)),
          );
        }
        if (main.filtered.length !== main.raw.messages.filter((m) => m.role !== "system" && m.role !== "developer").length + 1) {
          problems.push("the filter dropped or duplicated conversation messages");
        }

        // 4. The fence mapping depends on the tool names OpenCode sends.
        const toolNames = (main.raw.tools ?? []).map((tool) => tool.function?.name).filter(Boolean);
        if (toolNames.length === 0) {
          problems.push("the request carries no tools, so fence->tool_calls mapping cannot work");
        } else if (!toolNames.some((name) => name === "shell" || name === "bash")) {
          warn(`no shell/bash tool in ${JSON.stringify(toolNames)} — the fence vocabulary may have changed`);
        }

        if (problems.length > 0) {
          throw new Error(
            `${WARN} opencode ${version}: the prompt replacement is not working as expected:\n` +
              problems.map((problem) => `  - ${problem}`).join("\n") +
              `\nFix: re-capture the harness prompt (fake proxy + "opencode run --standalone"), update ` +
              `packages/prompts/opencode-system.md, and keep system-filter.ts in sync.`,
          );
        }

        expect(systems[0]!.content).toBe(PROMPT);
      } finally {
        server.close();
      }
    },
    180_000,
  );
});

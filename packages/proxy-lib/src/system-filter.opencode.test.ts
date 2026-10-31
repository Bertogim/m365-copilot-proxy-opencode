import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readPromptFile } from "@m365-copilot/core";
import { applySystemPrompt, stripHarnessPrompt } from "./system-filter.js";

const PROMPT = readPromptFile("opencode-system.md");

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

interface Captured {
  raw: Record<string, unknown> & { messages: Array<{ role: string; content: unknown }>; tools?: unknown[] };
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
        if (!main) throw new Error(`opencode made no main request (exit ${code})\n${stderr.slice(-2000)}`);

        // OpenCode really did send its own (large) prompt...
        const rawSystem = main.raw.messages
          .filter((m) => m.role === "system")
          .map((m) => String(m.content))
          .join("\n");
        expect(rawSystem.length).toBeGreaterThan(2000);
        expect(rawSystem).toContain("OpenCode");

        // ...and the proxy replaced all of it with exactly our file.
        const systems = main.filtered.filter((m) => m.role === "system");
        expect(systems).toHaveLength(1);
        expect(main.filtered[0]!.role).toBe("system");
        expect(systems[0]!.content).toBe(PROMPT);
        expect(main.filtered.some((m) => m.role === "developer")).toBe(false);

        // No harness prompt leaks through, and the user turn survives.
        const wire = JSON.stringify(main.filtered);
        for (const leak of ["Code Mode", "tools.opencode", "available_skills", "<env>", "Today's date", "<tools>"]) {
          expect(wire).not.toContain(leak);
        }
        expect(wire).toContain("hello from the fake proxy test");
        expect(main.filtered.length).toBe(
          main.raw.messages.filter((m) => m.role !== "system" && m.role !== "developer").length + 1,
        );
      } finally {
        server.close();
      }
    },
    180_000,
  );
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPromptFile } from "./prompt-file.js";

// Regression for the probe that killed the built proxy at import time:
// `packages/proxy/.output` panicked with "prompt not found: nudges/confab.md"
// because Nitro's chunk sets `_importMeta_.url` to `file:///_entry.js` before
// the entry module replaces it, so the walk-up started at `/`. The search now
// also starts from the launched script and the cwd.
describe("readPromptFile", () => {
  const originalArgv = process.argv;
  const originalCwd = process.cwd();
  const originalPromptsDir = process.env.M365_PROMPTS_DIR;
  let work: string;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "m365-prompts-"));
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.chdir(originalCwd);
    if (originalPromptsDir === undefined) delete process.env.M365_PROMPTS_DIR;
    else process.env.M365_PROMPTS_DIR = originalPromptsDir;
    rmSync(work, { recursive: true, force: true });
  });

  it("reads a repo prompt", () => {
    expect(readPromptFile("periodic-tool-reminder.md").length).toBeGreaterThan(0);
    expect(readPromptFile("nudges/confab.md").length).toBeGreaterThan(0);
  });

  it("finds prompts when started from an unrelated cwd", () => {
    process.chdir(work);
    expect(readPromptFile("nudges/confab.md").length).toBeGreaterThan(0);
  });

  it("finds prompts from the script it was launched with", () => {
    // A fake checkout, reachable only by walking up from argv[1].
    const repo = join(work, "checkout");
    mkdirSync(join(repo, "packages", "prompts", "nudges"), { recursive: true });
    mkdirSync(join(repo, "packages", "proxy", "bin"), { recursive: true });
    writeFileSync(join(repo, "packages", "prompts", "nudges", "probe.md"), "from checkout\n");
    const bin = join(repo, "packages", "proxy", "bin", "m365-proxy.mjs");
    writeFileSync(bin, "");
    process.argv = ["node", bin];
    process.chdir(work);

    expect(readPromptFile("nudges/probe.md")).toBe("from checkout");
  });

  it("honours M365_PROMPTS_DIR", () => {
    mkdirSync(join(work, "prompts"), { recursive: true });
    writeFileSync(join(work, "prompts", "custom.md"), "custom\n");
    process.env.M365_PROMPTS_DIR = join(work, "prompts");

    expect(readPromptFile("custom.md")).toBe("custom");
  });

  it("names the searched directories when the prompt is missing", () => {
    expect(() => readPromptFile("nudges/does-not-exist.md")).toThrowError(
      /prompt not found: nudges\/does-not-exist\.md \(set M365_PROMPTS_DIR; looked in .+packages\/prompts/,
    );
  });
});

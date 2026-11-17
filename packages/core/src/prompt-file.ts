import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Read a prompt shipped in the repo's `packages/prompts/` directory. Kept on
 *  disk so the texts are editable without touching or rebuilding the code.
 *
 *  The directory is found by walking up from this module, from the script the
 *  process was launched from, and from the cwd: none of them is reliable on its
 *  own. A fixed `../../prompts` lands in `packages/proxy/prompts`, and the
 *  bundled proxy can't trust its module URL at all — Nitro's chunk sets
 *  `_importMeta_.url` to `file:///_entry.js` before the entry module (which
 *  sets the real one) is evaluated, so a prompt read at import time would look
 *  in `/packages/prompts`. `M365_PROMPTS_DIR` overrides the search. */
export function readPromptFile(name: string): string {
  const dirs = promptDirs();
  for (const dir of dirs) {
    const file = join(dir, name);
    if (existsSync(file)) return readFileSync(file, "utf8").trim();
  }
  throw new Error(`prompt not found: ${name} (set M365_PROMPTS_DIR; looked in ${dirs.join(", ")})`);
}

function promptDirs(): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();
  const push = (dir: string) => {
    const key = dir.replace(/[/\\]+$/, "");
    if (!key || seen.has(key)) return;
    seen.add(key);
    dirs.push(key);
  };

  const override = process.env.M365_PROMPTS_DIR?.trim();
  if (override) push(override);

  for (const start of startDirs()) {
    let dir = start;
    for (let depth = 0; depth < 8; depth += 1) {
      push(join(dir, "packages", "prompts"));
      push(join(dir, "prompts"));
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return dirs;
}

/** Where to start walking up from. */
function startDirs(): string[] {
  const starts: string[] = [];
  const add = (dir: string | undefined) => {
    if (!dir) return;
    const full = resolve(dir);
    if (!starts.includes(full)) starts.push(full);
  };

  // Dev runs: this file's real location under packages/core/src.
  try {
    add(dirname(fileURLToPath(import.meta.url)));
  } catch {
    /* bundled: the URL can be a placeholder, covered by the entries below */
  }
  // Bundled runs: bin/m365-proxy.mjs, or `node .output/server/index.mjs`.
  const entry = process.argv[1];
  if (entry) add(dirname(entry));
  add(process.cwd());
  return starts;
}

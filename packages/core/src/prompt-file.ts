import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Read a prompt shipped in the repo's `packages/prompts/` directory. Kept on
 *  disk so the texts are editable without touching or rebuilding the code.
 *
 *  The directory is found by walking up from this module (and then the cwd),
 *  because the bundled proxy reports `import.meta.url` as
 *  `packages/proxy/.output/server/index.mjs` — a fixed `../../prompts` lands in
 *  `packages/proxy/prompts` there. `M365_PROMPTS_DIR` overrides the search. */
export function readPromptFile(name: string): string {
  for (const dir of promptDirs()) {
    const file = join(dir, name);
    if (existsSync(file)) return readFileSync(file, "utf8").trim();
  }
  throw new Error(`prompt not found: ${name} (set M365_PROMPTS_DIR)`);
}

function promptDirs(): string[] {
  const dirs: string[] = [];
  const override = process.env.M365_PROMPTS_DIR?.trim();
  if (override) dirs.push(override);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    dirs.push(join(dir, "packages", "prompts"), join(dir, "prompts"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  dirs.push(join(process.cwd(), "packages", "prompts"), join(process.cwd(), "prompts"));
  return dirs;
}

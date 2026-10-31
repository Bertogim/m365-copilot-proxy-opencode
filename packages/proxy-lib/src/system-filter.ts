import { readFileSync } from "node:fs";
import { readPromptFile } from "@m365-copilot/core";

/**
 * Prompt filtering: the proxy owns the system prompt completely.
 *
 * OpenCode sends a large control prompt (its base instructions, Code Mode and
 * tool catalogue, skills, AGENTS.md, date, `<env>`). None of it reaches M365:
 * every `system`/`developer` message is dropped and exactly one `system`
 * message is prepended with `packages/prompts/opencode-system.md`.
 *
 * `M365_SYSTEM_PROMPT=0|off` disables the filter (the harness prompt passes
 * through). Any other value is a path to a different prompt file.
 */

export interface PromptMessage {
  role: string;
  content?: unknown;
}

const DISABLED = /^(0|off|false|no)$/i;
const DEFAULT = /^(1|on|true|auto)$/i;

/** The replacement prompt text, or null when the filter is disabled. */
export function systemPromptOverride(): string | null {
  const setting = process.env.M365_SYSTEM_PROMPT?.trim();
  if (setting && DISABLED.test(setting)) return null;
  const fallback = () => {
    try {
      return readPromptFile("opencode-system.md");
    } catch {
      return null;
    }
  };
  if (!setting || DEFAULT.test(setting)) return fallback();
  try {
    const text = readFileSync(setting, "utf8").trim();
    return text.length > 0 ? text : fallback();
  } catch {
    return fallback();
  }
}

/** Drop every harness-owned control message (`system` and `developer`). */
export function stripHarnessPrompt<T extends PromptMessage>(messages: readonly T[]): T[] {
  return messages.filter((message) => message.role !== "system" && message.role !== "developer");
}

/** Replace the harness prompt with the single proxy-owned `system` message. */
export function applySystemPrompt<T extends PromptMessage>(
  messages: readonly T[],
  prompt: string | null = systemPromptOverride(),
): T[] {
  if (!prompt) return [...messages];
  return [{ role: "system", content: prompt } as unknown as T, ...stripHarnessPrompt(messages)];
}

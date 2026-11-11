import { readFileSync } from "node:fs";
import { readPromptFile } from "@m365-copilot/core";

/**
 * Prompt filtering: the proxy owns the system prompt completely.
 *
 * OpenCode sends a large control prompt (its base instructions, Code Mode and
 * tool catalogue, skills, AGENTS.md, date, `<env>`). Only the working directory,
 * platform and Git-repository status are retained from it: every
 * `system`/`developer` message is otherwise dropped and one proxy-owned
 * `system` message is prepended with `packages/prompts/opencode-system.md`.
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
const ENVIRONMENT_FIELDS = [
  "Working directory",
  "Platform",
  "Is directory a git repo",
] as const;

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(part => {
      if (!part || typeof part !== "object" || !("text" in part)) return "";
      return String((part as { text?: unknown }).text ?? "");
    })
    .join("");
}

/**
 * OpenCode injects Code Mode catalogue refreshes as `user` messages rather
 * than system/developer messages. Match the complete wrapper plus several
 * stable Code Mode anchors so ordinary user text mentioning Code Mode, tools
 * or `<system-update>` is preserved.
 */
export function isOpenCodeCodeModeUpdate(message: PromptMessage): boolean {
  if (message.role !== "user") return false;
  const text = messageText(message.content).trim();
  return (
    text.startsWith("<system-update>") &&
    text.endsWith("</system-update>") &&
    /(?:^|\n)# Code Mode(?:\r?\n|$)/.test(text) &&
    text.includes("The tools listed below cannot be called directly") &&
    text.includes("The catalog is complete. Do not guess tool names.") &&
    /(?:^|\n)## Code Mode tools \(call only inside `execute`\)(?:\r?\n|$)/.test(text)
  );
}

/** Remove only OpenCode's user-role Code Mode catalogue refreshes. */
export function stripOpenCodeCodeModeUpdates<T extends PromptMessage>(
  messages: readonly T[],
): T[] {
  return messages.filter(message => !isOpenCodeCodeModeUpdate(message));
}

/** Keep only the three OpenCode environment facts needed by the agent. */
export function retainedEnvironment(messages: readonly PromptMessage[]): string {
  const values = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "system" && message.role !== "developer") continue;
    const text = messageText(message.content);
    for (const field of ENVIRONMENT_FIELDS) {
      if (values.has(field)) continue;
      const match = new RegExp(`^[ \\t]*${field}:[ \\t]*(.+?)[ \\t]*$`, "im").exec(text);
      if (match?.[1]) values.set(field, match[1]);
    }
  }
  const lines = ENVIRONMENT_FIELDS
    .filter(field => values.has(field))
    .map(field => `${field}: ${values.get(field)}`);
  return lines.length > 0 ? `# Environment\n\n${lines.join("\n")}` : "";
}

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

/**
 * Drop harness-owned control messages: system/developer prompts and OpenCode's
 * user-role Code Mode catalogue updates.
 */
export function stripHarnessPrompt<T extends PromptMessage>(messages: readonly T[]): T[] {
  return stripOpenCodeCodeModeUpdates(messages).filter(
    message => message.role !== "system" && message.role !== "developer",
  );
}

/** Replace the harness prompt with the single proxy-owned `system` message. */
export function applySystemPrompt<T extends PromptMessage>(
  messages: readonly T[],
  prompt: string | null = systemPromptOverride(),
): T[] {
  if (!prompt) return [...messages];
  const environment = retainedEnvironment(messages);
  const content = environment ? `${prompt}\n\n${environment}` : prompt;
  return [{ role: "system", content } as unknown as T, ...stripHarnessPrompt(messages)];
}

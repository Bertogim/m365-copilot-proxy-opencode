# Prompts

Every prompt the proxy sends (or installs server-side) lives here as plain
Markdown, so it can be edited without touching TypeScript. `readPromptFile()`
(`packages/core/src/prompt-file.ts`) resolves `packages/prompts/<name>` from both
`src/` and `dist/`.

**Hot-reload:** `opencode-system.md` and `framing/*.md` are read on every request, so edits
apply to the next turn. `agent-instructions.md` is hashed per request: a change
gives the agent a new name, so the next request provisions a fresh Copilot
Studio bot with the new text (old versions are left in place). `nudges/*.md` are loaded once at proxy start — restart the proxy after editing
them.

## Files

| File | Role | When it is used |
|---|---|---|
| `opencode-system.md` | The **only** system message sent to M365. Leaner fork: execution contract, one fence per turn, first-move anti-confab rule, and the ` ```question ` block as the way to ask for a decision. | Every full turn (first message, context restore, nudges). The harness's own `system`/`developer` messages are dropped (`stripHarnessPrompt`) and this file is sent verbatim (`applySystemPrompt`). Disable with `M365_SYSTEM_PROMPT=0`; a path uses that file instead. |
| `opencode-system-old.md` | Previous system prompt (the fuller OpenCode-derived text plus the pasted confab imperative). Kept for reference/rollback. | Opt-in: `M365_SYSTEM_PROMPT=<repo>/packages/prompts/opencode-system-old.md`. |
| `framing/<variant>.md` | Behavioural wrapper injected into the user turn, around the fenced tool instructions. | Every tool request, **one** variant only. Chosen by `M365_FRAMING_FILE` (first line of a control file) > `M365_FRAMING_VARIANT` > per-model default. See the table below. |
| `agent-instructions.md` | Format contract of the Copilot Studio tool agent. | Server-side: baked into the bot when it is provisioned (`m365-tool-agent-<sha256[:8]>`), on tool requests whose tone uses the agent. Not part of the message text. |
| `nudges/confab.md` | "The files are there; you have run nothing — emit one ```bash block." | Retry after a turn-1 confabulation (model asks to paste files / claims no output) with no tool call. |
| `nudges/midtask.md` | Same, but mid-task (a tool already ran): "tools work, continue with the next step." | Retry when the model confabulates **after** it has already acted. |
| `nudges/hallucination.md` | "You did not actually do that; nothing changed on disk." | Retry when the model claims a completion it never performed (no tool call ever made). |
| `nudges/remote-artifact.md` | "That patch/link only exists in M365's remote sandbox; edit the local file." | Retry when the model returns a `sandbox:/mnt/data/...` artifact or Teams link instead of a local edit. |
| `nudges/tools-resend.md` | Re-sends the framing + tool block with a "continue" nudge. | The `RESENDTOOLS` / `RESTORETOOLS` / `SENDTOOLS` recovery command. |
| `nudges/turn-reminder.md` | One-line "act, don't chat" reminder: one block, `question` for decisions, `patch` for file changes. | Prepended to **every delta turn** (continuations, where only the new messages are sent and the framing is only server-side). `M365_NO_TURN_REMINDER=1` disables it. |
| `nudges/continue.md` | Literally "Please continue." | A turn with no new content (retry mode); with tools it is wrapped by `toolNudge` so the framing goes with it. |

All nudges are one-shot retries (`M365_NO_CONFAB_RETRY` disables them,
`M365_CONFAB_RETRIES` sets the count). A normal first message uses none of them.

## Framing variants

| Variant | Strategy | Default for |
|---|---|---|
| `baseline` | "You are the execution core": shell-first, strict rules, anti-confabulation. The control. | GPT-5.x, `m365-copilot` (magic) |
| `minimal` | Same contract, minimal text. | — |
| `terse` | All-caps telegram: "DO NOT TALK. EMIT ONE ```bash BLOCK." | — |
| `recency` | Baseline plus the order repeated at the very end. | — |
| `fewshot` | Shows a full example turn instead of rules. | — |
| `demo_only` | A single annotated example session. | — |
| `negative` | List of forbidden replies ("don't narrate", "don't claim empty"). | — |
| `proof_demand` | Evidence rule: no claim without a `<tool_response>` above it. | — |
| `persona` | "SHGEN", a shell-command generator that cannot chat. | — |
| `react` | Thought → Action loop format. | — |
| `session_facts` | Anti-confabulation as plain facts, no `NEVER`/caps (dodges the jailbreak classifier). | — |
| `softened` | Baseline with the override shape removed. | Retry after `Disengaged` |
| `retag` | `baseline` text byte-for-byte, different wrapper tag (isolates the `<system>` tag). | — |
| `honest` | The user explains in their own voice that the model's sandbox is another machine. | — |
| `terse_user` | The same two facts in one parenthetical. | — |
| `relay` | Role = pair-programmer: "tell me the command, I'll run it". | `claude-sonnet-5`, `claude-sonnet-5.5` |
| `relay_batch` | `relay` + "put as much as you can in one block" (saves turns). Falls back to `relay` with no shell tool. | `claude-opus*`, `claude-sonnet` (4.6), `gpt-6*` |

`retag` is the only alias: it reuses `baseline`'s text. `reply_tool` is not a
framing (it is a tool-injection strategy) and also runs `baseline`.

## First message of a conversation

With `m365/gpt-6.1-sol` and a plain "hola":

```
system:  opencode-system.md  (includes the output-discipline rules)
user:    framing/relay_batch.md + "hola"
agent:   agent-instructions.md   (server-side, not in the text)
```

The separate title request OpenCode sends is answered locally and uses no file.

## Environment

| Variable | Effect |
|---|---|
| `M365_SYSTEM_PROMPT` | `1`/unset = `opencode-system.md`; a path = that file; `0`/`off` = keep the harness prompt. |
| `M365_FRAMING_VARIANT` | Force one framing for every request. |
| `M365_FRAMING_FILE` | File whose first line names the framing; read per request, for A/B sweeps without a restart. |
| `M365_NO_CONFAB_RETRY`, `M365_CONFAB_RETRIES` | Disable / count the nudge retries. |
| `M365_NO_TURN_REMINDER` | Drop the per-turn reminder on delta turns. |

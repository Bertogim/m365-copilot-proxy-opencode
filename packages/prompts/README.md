# Prompts

Every prompt the proxy sends (or installs server-side) lives here as plain
Markdown, so it can be edited without touching TypeScript. `readPromptFile()`
(`packages/core/src/prompt-file.ts`) resolves `packages/prompts/<name>` from both
`src/` and `dist/`.

**Hot-reload:** `opencode-system.md` is read on every request, so edits apply to the
next turn. It is also the Copilot Studio **agent instructions** text, hashed per
request: a change gives the agent a new name, so the next request provisions a fresh
bot with the new text (old versions are left in place). `old/framing/*.md` is still
resolved from `old/` by the framing builder, which no request path calls. Reminders and
`nudges/*.md` are loaded once at proxy start, so restart the proxy after editing them.

**OpenCode upgrades.** `system-filter.opencode.test.ts` runs the real `opencode` binary
against a fake proxy. It warns when the binary version differs from the one the prompt was
captured from (`KNOWN_OPENCODE_VERSION`, currently 2.2.5) and fails with a list of
mismatches if the harness prompt changed shape, the filter no longer replaces it verbatim, or
the user turn carries more than 150 chars of extra harness tags (e.g. a `<system-reminder>`). When
that fires: re-capture the prompt (fake proxy + `opencode run --standalone`), update
`opencode-system.md`, and bump the version constant.

## Files

| File | Role | When it is used |
|---|---|---|
| `opencode-system.md` | The **only** system message sent to M365, and the **only** prompt installed server-side. Execution contract: the user runs the blocks, one fence per turn, `question` for decisions, `patch` for file changes, summary in plain text when done. | Two places: (1) every full turn (first message, context restore, nudges) — the harness's own `system`/`developer` messages are dropped (`stripHarnessPrompt`) and this file is sent verbatim (`applySystemPrompt`); `M365_SYSTEM_PROMPT=0` disables it, a path replaces it. (2) baked into the Copilot Studio tool agent when it is provisioned (`m365-tool-agent-<sha256[:8]>`), on tool requests whose tone uses the agent. |
| `old/opencode-system-old.md` | Previous, currently unused system prompt. Kept for reference/rollback. | Opt-in: `M365_SYSTEM_PROMPT=<repo>/packages/prompts/old/opencode-system-old.md`. |
| `old/framing/<variant>.md` | Behavioural wrapper injected into the user turn, around the fenced tool instructions. | Every tool request, **one** variant only. Chosen by `M365_FRAMING_FILE` (first line of a control file) > `M365_FRAMING_VARIANT` > per-model default. See the table below. |
| `question-note.md` | The `question` tool schema, with free-form and multiple-choice examples. | Appended right after a `question` tool result that reports `Invalid arguments for tool`, so the retry sees the array contract next to the failure (`formatToolResponse`). |
| `patch-note.md` | The required `patch` block format and retry guidance. | On every failed patch, the proxy checks the previous failed patch. It appends the reminder only if at least 10 proxy calls have elapsed since that failure. The initial request counts as call 1. |
| `nudges/confab.md` | "The files are there and I can run what you send; you have run nothing yet" — asks for the first commands. | Retry after a turn-1 confabulation (model asks to paste files / claims no output) with no tool call. |
| `nudges/midtask.md` | Same, but mid-task (a tool already ran): "tools work, continue with the next step." | Retry when the model confabulates **after** it has already acted. |
| `nudges/hallucination.md` | "You have not done that yet: nothing ran, so nothing on disk changed." | Retry when the model claims a completion it never performed (no tool call ever made). |
| `nudges/remote-artifact.md` | "That patch/link only exists in your remote environment; I can't apply it there." | Retry when the model returns a `sandbox:/mnt/data/...` artifact or Teams link instead of a local edit. |
| `periodic-tool-reminder.md` | Reminds the model that the user personally executes one `bash`, `question`, or `patch` block, while completed tasks end in plain text. | Prepended every 15th proxy call. The initial request counts as call 1. |
| `nudges/continue.md` | "Continue with the task": one block for the next step, or the final summary if it is done. | A turn with no new content (retry mode); with tools it is wrapped by `toolNudge` so the tool instructions travel with it. |
| `nudges/noop-shell.md` | Tells the model not to finish through an `echo`, `true`, or `false` shell call. | One same-conversation retry when the response contains only such a shell command. Completed work must be summarized as plain text; unfinished work must continue with a substantive tool call. |

All nudges are one-shot retries (`M365_NO_CONFAB_RETRY` disables them,
`M365_CONFAB_RETRIES` sets the count). A normal first message uses none of them.

They are written in the **user's first-person voice** — they arrive as a user message, so
they say what I (the person at the terminal) can run or apply, not what "the user" is. The
`SENDTOOLS` / `RESENDTOOLS` / `RESTORETOOLS` recovery path reuses
`periodic-tool-reminder.md` instead of keeping a second copy of the contract.

`old/` holds what the active flow no longer sends: the 16 framing variants (retired
from `formatMessages`; only the framing builder and the tests read them) and
`opencode-system-old.md`, kept for rollback. Everything else lives at the top level or
under `nudges/`, and every nudge is written in the voice of `opencode-system.md` — the
user runs the blocks, one fence per turn, plain-text summary when done.

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
user:    old/framing/relay_batch.md + "hola"
agent:   opencode-system.md   (server-side, same text, not in the message)
```

The separate title request OpenCode sends is answered locally and uses no file.

## Environment

| Variable | Effect |
|---|---|
| `M365_SYSTEM_PROMPT` | `1`/unset = `opencode-system.md`; a path = that file; `0`/`off` = keep the harness prompt. |
| `M365_FRAMING_VARIANT` | Force one framing for every request. |
| `M365_FRAMING_FILE` | File whose first line names the framing; read per request, for A/B sweeps without a restart. |
| `M365_NO_CONFAB_RETRY`, `M365_CONFAB_RETRIES` | Disable / count the nudge retries. |
| `M365_DISABLE_TOOL_ACCESS_CONFAB` | Set to `1` to disable only the default detection and automatic tool-instruction resend for false "I can't access the files/tools" responses. Other nudge retries remain enabled. |

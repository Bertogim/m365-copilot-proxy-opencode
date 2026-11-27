# Project Abandoned (27/11/2026)

This project has been abandoned since Microsoft's recent changes to AI usage limits.<br>
In my experience, the usage limit that previously lasted me a full day is now reached in just 15 minutes.

This means it is no longer maintained.

It should still work for some time.

The repository remains available for anyone interested in exploring, forking, or adapting the code.

Unless Microsoft changes its limits to make the service viable to use again, this project will remain abandoned.

Thanks to everyone who used or supported this project.

# m365-copilot-proxy-opencode

Fork of `m365-copilot-proxy` adapted for OpenCode and other OpenAI-compatible coding agents. It exposes Microsoft 365 Copilot through an OpenAI-compatible API while preserving the upstream reverse-engineering, tool-calling and benchmarking work.

> This repository is a fork. Upstream development originated in `cramt/m365-copilot-proxy`; this fork focuses on OpenCode-oriented workflows and experimentation.

> **Want the gory protocol details?** See the upstream [M365 Copilot API protocol write-up](https://github.com/cramt/m365-copilot-proxy/blob/main/docs/m365-copilot-api.md) — a full write-up of M365 Copilot's undocumented WebSocket API: auth, SignalR frames, tones/models, throttling, the "Disengaged" filter, and the Copilot Studio agent trick that makes tool calling work.

## Quick start (OpenCode)

Point OpenCode at the local proxy. `examples/opencode.jsonc` is a complete,
ready-to-copy provider block for `~/.config/opencode/opencode.jsonc`:

```json
{
  "provider": {
    "m365": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "M365 Copilot (own account)",
      "options": {
        "baseURL": "http://127.0.0.1:4141/v1",
        "apiKey": "not-needed"
      },
      "models": {
        "gpt-6.1-sol": {
          "name": "M365: GPT-6.1 Sol",
          "tool_call": true,
          "attachment": false,
          "limit": { "context": 1050000, "output": 128000 }
        },
        "gpt-5.4": {
          "name": "M365: GPT-5.4",
          "tool_call": true,
          "attachment": false,
          "limit": { "context": 1050000, "output": 128000 }
        }
      }
    }
  },
  "model": "m365/gpt-6.1-sol",
  "small_model": "m365/gpt-5.4"
}
```

Full example with every model `/v1/models` serves (GPT-6.2 Sol/Astra, Claude
Fable 5.1, Claude Sonnet 5.5, Opus, Copilot, ...), using GPT-6.1 Sol as `model`
and GPT-5.4 as `small_model`: [`examples/opencode.jsonc`](examples/opencode.jsonc).

> `apiKey` is a placeholder unless you set `M365_PROXY_KEY` on the proxy, in which case it
> must match. The proxy binds to `127.0.0.1` and refuses browser origins by default.

`limit` mirrors each model's published window, and `/v1/models` advertises the
same numbers (a test keeps `examples/opencode.jsonc` in sync): GPT-5.2 400k/128k,
GPT-5.3 128k/16k, GPT-5.4 through GPT-6.2 1.05M/128k, Claude 1M/128k. They drive
OpenCode's `% used` meter and its auto-compaction, so compaction fires when the
real model window is nearly full. Unknown tones fall back to `M365_CONTEXT_WINDOW`
/ `M365_MAX_OUTPUT_TOKENS`. M365 does not expose token counts, so the proxy
reports an estimate (~4 chars/token) and the meter moves with the conversation.

### Authenticate in a visible browser

To sign in interactively, start the proxy from a graphical desktop with
interactive approval enabled:

~~~sh
M365_ENABLE_INTERACTIVE_APPROVAL=1 pnpm run proxy 4141
~~~

Then start the first conversation or request in OpenCode. When the proxy needs
to authenticate, it opens a visible browser window. Complete Microsoft SSO and
MFA manually in that window. This works with the authentication method enforced
by your tenant and does not require storing a Microsoft password or TOTP seed
in `secrets.json`.

The proxy caches the resulting tokens. It also uses a persistent browser profile
for Microsoft session and device cookies, so later authentication normally
reuses the existing session. Set an explicit profile location to keep it stable
regardless of the directory from which the proxy is started:

~~~sh
export M365_BROWSER_PROFILE="$HOME/.local/share/m365-copilot/browser-profile"
export M365_ENABLE_INTERACTIVE_APPROVAL=1
pnpm run proxy 4141
~~~

Interactive authentication requires an installed Chromium-compatible browser
and a graphical display available through `DISPLAY` or `WAYLAND_DISPLAY`. It is
not suitable for a truly headless host.

If the proxy cannot find Chrome or Chromium, install Playwright's Chromium from
the repository root:

~~~sh
pnpm --filter @m365-copilot/core exec playwright install chromium
~~~

By default, Playwright stores the downloaded browser in its user cache. To keep
it in a specific directory, use the same variable when installing and when
starting the proxy:

~~~sh
export PLAYWRIGHT_BROWSERS_PATH="$HOME/.local/share/m365-copilot/ms-playwright"
pnpm --filter @m365-copilot/core exec playwright install chromium
M365_ENABLE_INTERACTIVE_APPROVAL=1 pnpm run proxy 4141
~~~

Alternatively, install `google-chrome`, `chromium` or `chromium-browser` with
your operating system's package manager. If the browser is installed outside
`PATH`, set `CHROMIUM_PATH` to its executable before starting the proxy.

The proxy waits up to 600000 milliseconds (10 minutes) by default for manual
sign-in. Override that limit with `M365_INTERACTIVE_TIMEOUT_MS`.
`M365_NO_INTERACTIVE=1` always disables browser login, even when
`M365_ENABLE_INTERACTIVE_APPROVAL=1` is set.

### Recovery commands

Send one of these as the **whole message** (a mention inside a sentence does
nothing). They are control messages: the proxy strips them from the prompt.

| Command | What it does | When to use it |
|---|---|---|
| `RESTORECONTEXT` (alias `RESTORESESSION`) | Keeps the **same upstream M365 conversation** and replays all previous context available in the local request, plus the original task and latest instruction as explicit anchors. | The model has lost or confused the context. No new M365 thread is created. |
| `RESENDTOOLS` (aliases `RESTORETOOLS`, `SENDTOOLS`) | Keeps the **same conversation** and re-sends the tool definitions and framing with the current history — the manual version of the automatic give-up retry. No replay, no new thread. | The model "forgot" it has tools, answered in prose, or asked you to run commands yourself, while the rest of the context is still fine. |

The proxy also detects give-up confabulations automatically (`looksLikeConfabulation`)
and forces one retry in the same conversation; when that retry recovers a real tool
call, the reply is prefixed with `TOOLS RESTORED`.

## How it works

M365 Copilot uses a SignalR WebSocket protocol, not the OpenAI API. This project translates between the two:

1. **Standalone proxy** — HTTP server with `/v1/chat/completions` and `/v1/models` endpoints. Works with OpenCode and other OpenAI-compatible clients.
2. **OpenClaw plugin** — Config generator + setup CLI for OpenClaw's provider system.

## About this fork

This repository tracks the upstream project while focusing on OpenCode compatibility and integration.

If upstream documentation and this repository differ, prefer the documentation and behaviour present in this fork.

### Fork-specific changes

- Repository URL: `https://github.com/Bertogim/m365-copilot-proxy-opencode`
- Primary target: OpenCode-compatible coding agents and harnesses
- OpenCode-oriented compatibility improvements and defaults
- Upstream ideas may be merged selectively, but behaviour described in this repository should be treated as authoritative for this fork

### Why this fork exists

The upstream project provides an OpenAI-compatible wrapper around Microsoft 365 Copilot. This fork focuses on making M365 models work reliably inside OpenCode.

A major challenge is that Microsoft 365 Copilot does not natively support the tool-calling patterns expected by OpenAI-compatible agents. Different model families also behave differently: some naturally emit shell-style actions, some prefer their own sandbox, and others require specific framing to reliably follow tool instructions.

This fork contains the translation, routing and framing layers needed to bridge that gap. Rather than exposing raw M365 behaviour, it adapts requests to the formats that each model family follows most reliably, normalizes tool calls back into OpenAI-compatible responses, and applies model-specific defaults so OpenCode can interact with GPT, Claude and other M365-backed models through a consistent interface.

The result is more reliable tool execution, fewer compatibility issues between model families, and a smoother OpenCode experience than a generic OpenAI-compatibility wrapper. The goal of this fork is compatibility, not research: make M365-backed models behave as predictably as possible inside OpenCode.

### Tool calling

M365 Copilot doesn't support OpenAI-style `tool_calls` natively. Instead, tools are
emulated via a **Markdown-fence format** (the JSON `{"tool":...}` format was removed —
it scored 0/5 on real agentic tasks; see
[upstream hypotheses §9](https://github.com/cramt/m365-copilot-proxy/blob/main/docs/hypotheses.md#9)):

- Tool definitions are no longer injected as a `<tools>` block: the prompt tells the model to act with a fenced block, and our system prompt documents the `bash`/`patch`/`question` forms
- The model emits a fenced tool call — a code block whose info-string is the tool name
  (scalar args as `key: value` header lines, one free-form body arg as the fence body,
  `old`/`new` edits as aider-style `SEARCH/REPLACE` diffs)
- The proxy/handler parses that and converts it to OpenAI `tool_calls` format
- **Shell-routing (the key lever):** M365's chat-tuned model won't "act as an agent" on
  demand but *will* reflexively write a ```` ```bash ```` block. When the toolset includes a
  shell tool (`bash`/`shell`/`run`/`run_command`/… — any name), the proxy injects "do the
  whole step by writing one ```` ```bash ```` block" framing and routes that block to the
  shell tool. This exploits the one agentic behavior Microsoft's system prompt permits, and
  is what turns 0/5 into real multi-turn loops (verified 9-tool-call bug fix).
- **Reliability comes from the Copilot Studio agent (below) + the fenced/shell framing** —
  without the agent, M365 ignores tool instructions and answers in prose

### System prompt

OpenCode's own system prompt describes a native tool API (Code Mode, an `execute`
tool, parallel calls), which contradicts the fenced emulation above and is what makes
the model answer "there is no tool block in this turn". By default the proxy
**drops every `system` and `developer` message the harness sends** and sends exactly
one replacement `system` message. Only the working directory, platform and Git
repository status are retained from OpenCode's environment and appended to that
replacement prompt:

```sh
export M365_SYSTEM_PROMPT=1                 # packages/prompts/opencode-system.md from the repo
export M365_SYSTEM_PROMPT=/path/to/file.md  # any file you want to edit
export M365_SYSTEM_PROMPT=0                 # off: pass the harness prompt through
```

To restore the default behaviour after disabling it:

```sh
unset M365_SYSTEM_PROMPT
```

When `M365_SYSTEM_PROMPT` is unset, the proxy automatically uses
`packages/prompts/opencode-system.md` and keeps the system-prompt filter enabled.

The prompt lives in [`packages/prompts/opencode-system.md`](packages/prompts/opencode-system.md) as
plain Markdown. It is read on every request, so edits apply on the next turn without
rebuilding or restarting the proxy.

#### How the OpenCode prompt is replaced

Before each upstream request, the proxy:

1. retains the working directory, platform and Git-repository status from
   OpenCode's `system` and `developer` messages;
2. removes those harness-owned messages;
3. removes OpenCode's user-role Code Mode catalogue refreshes (keeping the
   `Today's date` line they carry);
4. loads `packages/prompts/opencode-system.md`, or the custom path selected by
   `M365_SYSTEM_PROMPT`;
5. appends the retained environment facts and sends the result as the only
   `system` message received by M365.

The filter itself is
`packages/proxy-lib/src/system-filter.ts` (`stripHarnessPrompt` / `applySystemPrompt`);
`system-filter.opencode.test.ts` runs the real `opencode` binary against a fake proxy and
asserts that only the replacement prompt and retained environment arrive. The
filter remains enabled when `M365_SYSTEM_PROMPT` is unset. Other prompt files
and their reload behaviour are documented in
[`packages/prompts/README.md`](packages/prompts/README.md).

## OpenCode-specific environment variables

| Variable | Effect |
|---|---|
| `M365_ENABLE_INTERACTIVE_APPROVAL` | Set to `1` to allow manual Microsoft sign-in in a visible browser when no cached token is available. |
| `M365_BROWSER_PROFILE` | Select the persistent browser-profile directory used to retain Microsoft session and device cookies. |
| `M365_INTERACTIVE_TIMEOUT_MS` | Set the manual browser-login timeout in milliseconds; the default is 600000 (10 minutes). |
| `M365_NO_INTERACTIVE` | Set to `1` to disable interactive browser login, overriding `M365_ENABLE_INTERACTIVE_APPROVAL`. |
| `M365_SYSTEM_PROMPT` | Select, replace or disable the OpenCode system-prompt replacement. |
| `M365_LOCAL_TITLES` | Answer OpenCode title requests locally. Enabled by default; set to `0` to send them upstream. |
| `M365_PROMPT_LOG_DIR` | Write original and converted prompts and responses using conversation, question and turn identifiers. |
| `M365_OPENCODE_TOOLS` | Override the OpenCode tool allowlist used by the adaptation layer. |
| `M365_NO_CONFAB_RETRY` | Disable automatic retries for tool-access confabulations and invented completions. |
| `M365_CONFAB_RETRIES` | Set the number of automatic recovery retries. |
| `M365_DISABLE_TOOL_ACCESS_CONFAB` | Disable only the retry for false claims that files or tools are inaccessible. |
| `M365_ALLOW_MULTI_TOOL` | Preserve multiple tool calls from one model response instead of keeping only the first. |
| `M365_NO_EARLY_STOP` | Do not stop a tool turn when the model begins inventing its own tool response. |
| `M365_EARLY_STOP_AFTER` | Set how much of an invented tool-response tail may be generated before stopping it. |

See all environment variables in the
[upstream README](https://github.com/cramt/m365-copilot-proxy#environment-variables).

## Access and security

Anyone who can reach the port spends the signed-in M365 account, so the defaults are
closed: `m365-proxy` binds to `127.0.0.1`, sends no CORS headers, and refuses any request
carrying an `Origin` it wasn't told to trust (a 403, not just a missing header — CORS
alone can't stop a request from being sent, and a DNS-rebound page is same-origin to the
browser). CLI clients such as OpenCode send no `Origin` and are unaffected.

| Variable | Effect |
|---|---|
| `HOST` / `NITRO_HOST` | Address the standalone `m365-proxy` binds. Default `127.0.0.1`; `0.0.0.0` listens on every interface. Anyone who reaches the port spends your M365 account, so pair that with `M365_PROXY_KEY`. |
| `M365_PROXY_KEY` / `M365_PROXY_KEY_FILE` | When set, every request except `GET /health` must send the key as `Authorization: Bearer <key>` or `x-api-key: <key>` (401 otherwise). OpenCode sends its configured `apiKey` that way, so set the same value in `examples/opencode.jsonc`. The NixOS module's `apiKeyFile` sets the file variant. |
| `M365_CORS_ORIGIN` | Comma-separated browser origins allowed to call the proxy, or `*` for any. Unset: no CORS headers are sent and any request with an `Origin` header gets a 403, which stops web pages (including DNS-rebinding ones) from driving your account. |

The policy lives in `@m365-copilot/proxy-lib` (`access.ts`), so the Nitro server and the
framework-free `createApp()` enforce the same rules.

## Relevant files

| Path | Purpose |
|---|---|
| `examples/opencode.jsonc` | Complete OpenCode provider and model configuration. |
| `packages/prompts/opencode-system.md` | Active replacement system prompt. |
| `packages/prompts/README.md` | Prompt inventory and loading behaviour. |
| `packages/prompts/nudges/` | Automatic recovery prompts. |
| `packages/proxy-lib/src/system-filter.ts` | Harness-prompt filtering and replacement. |
| `packages/core/src/fenced.ts` | Fenced tool-call parsing and routing. |
| `packages/core/src/tools.ts` | Tool formatting and OpenCode tool adaptation. |

## Upstream

Use [`cramt/m365-copilot-proxy`](https://github.com/cramt/m365-copilot-proxy)
for documentation about:

- Microsoft 365 authentication and account requirements;
- the SignalR WebSocket protocol;
- available models, tones, entitlements and quotas;
- throttling and conversation limits;
- image generation;
- standalone proxy, OpenClaw, NixOS and other non-OpenCode clients;
- generic environment variables and configuration files;
- upstream development, benchmarks and known limitations.

## License

[MIT](LICENSE), matching the upstream project.

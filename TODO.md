# TODO — upstream changes selected for this fork (opencode-only)

Status: **the refusal handling is implemented** (`b9699c1`); everything else is
planned and unimplemented. Fork: `Bertogim/m365-copilot-proxy-opencode`.
Upstream: `cramt/m365-copilot-proxy`.

> The fork already has its own prompt and is tuned for opencode. Do not touch
> `opencode-system.md` or the framing. Everything below is proxy, parser or
> session behaviour.

Difficulty criteria:

- **Easy**: localized change, with the commit's own tests, without touching
  `handler.ts` + `session.ts` + `fenced.ts` at once; **half a day or less**.
- **Hard**: touches several of those files, rewrites a piece, or needs a live
  test; **a day or more**.

The estimates include porting the behaviour, adapting the tests and resolving
conflicts with the fork's own implementation (these are not clean cherry-picks).

## Summary

### Easy

| Commits | What | Effort | Status |
|---|---|---:|---|
| `500a193` + `bc13a55` + `056acb9` + `ff057c7` | Refusals: token limit, Bing, apology | 3-4 h | **Done** (`b9699c1`) |
| `e903b53` + `5bfdcf3` | Request body limits and deadline | 2-3 h | Pending |
| `693dc2c` | New models (`gpt-6.2*`, `claude-fable`) | 1-2 h | Pending |
| `96dfcf6` + `af12b33` | Composer: doubled head and repeated `<` | 1-2 h | Pending |

### Hard

| Commits | What | Effort | Status |
|---|---|---:|---|
| `bca4ea4` + `29e1e4d` | 24 h conversations and lost-history resend | 1-2 days | Pending |
| `7c63ed5` + `af794dc` | Sessions that share the first message | 1 day | Pending |
| `fc998f4` | Restore what M365 strips (`[word]:`) and don't run a damaged PowerShell command | 1 day | Pending |
| `f5e428a` | `reasoning_content` | 4-8 h | Pending |
| `f2e723d` + `1b29ea4` | Long turns in parts | 2-4 days | Pending |
| `ba10843` + `1365441` | Daily turn limit as an account-wide limit | 4-6 h | Pending |

## Detail

### Session and history

- [ ] **`bca4ea4` + `29e1e4d`** — 24 h conversations (`M365_CONVERSATION_TTL_HOURS`, 24 by default) and a full resend when M365 loses the history.
  - **Difficulty:** hard · **Effort:** 1-2 days.
  - The fork evicts after 30 min (`MAX_IDLE_MS` in `handler.ts`); a long opencode session resends everything and can lose context.
  - Includes: configurable TTL, a 1,000-conversation cap, detection of `numUserMessagesInConversation === 1`, a single replay per request, and learning which long openers are not kept.

- [ ] **`7c63ed5` + `af794dc`** — several conversations that share the first message.
  - **Difficulty:** hard · **Effort:** ~1 day.
  - The fork already includes the tool names in the fingerprint, but two opencode sessions with the same “hello” and the same tools still collide.
  - Includes: per-fingerprint bucket, `replyKey` (tool-call ids or text), a busy flag so a conversation with a turn in flight cannot be joined, and a fallback to the most recent one.

- [ ] **`fc998f4` + `96dfcf6` + `af12b33`** — fidelity of the text the client receives.
  - **Difficulty:** hard as a group; `96dfcf6` + `af12b33` are easy on their own (1-2 h). · **Effort:** ~1 day.
  - `fc998f4`: restore what M365 strips (`[word]:`) and do not run a damaged PowerShell command.
  - `96dfcf6`: do not double a head that the first delta restates (`<<document>`).
  - `af12b33`: drop the repeated leading `<` after a cursor.
  - Check the conflict with the fork's own `TurnTextComposer`.

### Refusals and M365 errors

- [x] **`500a193` + `bc13a55` + `056acb9` + `ff057c7`** — refusal handling. **Done in `b9699c1`.**
  - **Difficulty:** easy · **Effort:** 3-4 h.
  - `500a193`: `InvalidRequest` / `InputTokenLimitExceeded` → 400 `context_length_exceeded` without retrying.
  - `bc13a55`: if the refusal came from the Bing plugin, retry once without it and remember it per tone.
  - `056acb9` + `ff057c7`: treat M365's “apology” (`contentOrigin: "Apology"`) like a `Disengage`; remember the turn so the handler can see it.
  - Before this, the fork could spend 3 attempts and return a misleading 502.

### Long context and reasoning

- [ ] **`f2e723d` + `1b29ea4`** — long turns in parts.
  - **Difficulty:** hard · **Effort:** 2-4 days.
  - `M365_TURN_CHUNK_BYTES` (400,000 bytes by default), `M365_MAX_TURN_PARTS` (12 by default), long-history replay and follow-up parts.
  - What matters here is the chunking and the handling of failed parts, not the usage.
  - `1b29ea4` fixes the edge cases: unrecognized part, lost history, throttling, dead agent, Bing, `OutOfCredits`, `InternalError`.
  - Depends on `bca4ea4` + `29e1e4d`; do it afterwards.

- [ ] **`f5e428a`** — `reasoning_content` from `ChainOfThoughtSummary`.
  - **Difficulty:** hard · **Effort:** 4-8 h.
  - opencode shows it as “thinking” with no configuration.
  - Note: the fork's current tests expect `reasoning_content` to be **absent**; they must be updated.
  - `M365_NO_REASONING=1` disables it.

### Proxy robustness

- [ ] **`e903b53` + `5bfdcf3`** — limits on the `/v1/chat/completions` request body.
  - **Difficulty:** easy · **Effort:** 2-3 h.
  - `M365_MAX_REQUEST_BYTES` (32 MiB by default), `M365_REQUEST_BODY_TIMEOUT_MS` (30 s by default), 413/408/400, and a deadline for streams that have already started.
  - Today the fork uses `readBody(event)` with no cap.

### Daily turn limit

- [ ] **`ba10843` + `1365441`** — daily limit as an account-wide limit.
  - **Difficulty:** hard · **Effort:** 4-6 h.
  - `TotalTurnUsageDaily` is remembered under one account key, 429 `daily_turn_quota_exhausted` with `Retry-After` to midnight UTC, no fallback.
  - `usage.x_m365_total_turns_daily_remaining` carries the turns left.
  - `1365441`: do not confuse a reply that quotes the refusal with the real refusal.

### Models

- [ ] **`693dc2c`** — add `gpt-6.2-sol`, `gpt-6.2-astra`, `gpt-6-astra` and `claude-fable`.
  - **Difficulty:** easy · **Effort:** 1-2 h.
  - IDs, tones and defaults only; the fork's prompt stays as it is.
  - Check whether `relay_batch` makes sense for these tones under the fork's own contract.

## Implementation note

Cherry-picks will conflict in `handler.ts`, `fenced.ts` and `session.ts`: the fork
diverged a lot and has its own implementations. Port behaviour and tests, not the
whole commit. Recommended order:

1. ~~Refusals (`500a193`, `bc13a55`, `056acb9`, `ff057c7`) — easy, no dependencies.~~ **Done in `b9699c1`.**
2. Request body limits (`e903b53`, `5bfdcf3`) — easy, independent.
3. Models (`693dc2c`) — easy, independent.
4. Session and history (`bca4ea4`, `29e1e4d`, `7c63ed5`, `af794dc`).
5. Stream and text (`96dfcf6`, `af12b33`, `fc998f4`).
6. Context and reasoning (`f2e723d`, `1b29ea4`, `f5e428a`) — after session and history.
7. Daily limit (`ba10843`, `1365441`).

Total estimate: **5-9 days** of work, mostly in `f2e723d` + `1b29ea4` and
`bca4ea4` + `29e1e4d`.

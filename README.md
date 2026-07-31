# my-pi

A collection of [pi](https://pi.dev) extensions for an enhanced coding experience.

![Screenshot](https://github.com/user-attachments/assets/e8766ffd-3ff5-474b-a876-3b8f78bfd069)

## Quick Start

Copy the prompt below and paste it into your pi editor, then press Enter:

```text
Clone https://github.com/Loongphy/my-pi.git and copy all files to ~/.pi/agent/extensions/, then run /reload. If any filenames conflict, rename the incoming files before copying — I don't want to overwrite my existing extensions.
```


### Option 2: Manual setup

Clone the repo and copy the files:

```bash
git clone https://github.com/Loongphy/my-pi.git /tmp/pi-extensions
cp -r /tmp/pi-extensions/*.ts ~/.pi/agent/extensions/
cp -r /tmp/pi-extensions/status/ ~/.pi/agent/extensions/status/
```

> [!WARNING]
> Check for filename conflicts. If you already have an extension with the same name in the `~/.pi/agent/extensions`, **rename the incoming files** (e.g., `collapse-tools.new.ts`) rather than overwriting your existing ones.

Then reload pi:

```
/reload
```

## Extensions

### ✏️ editor

![editor](https://github.com/user-attachments/assets/890dc61a-e42e-42ea-860d-ea0809f2ab12)

Patches the `DynamicBorder` component to suppress redundant border lines in bash mode, keeping the editor area clean and clutter-free.

**File:** `editor.ts`

---

### 📝 request-logger

Logs every provider request to a file (`~/.pi/agent/requests/<session>.request.log`). Captures HTTP status, headers, token counts, model info, and sanitizes sensitive query parameters.

**File:** `request-logger.ts`

---

### ⌨️ shortcuts

Adds `Ctrl+Shift+C` to copy the current editor content to the system clipboard.

**File:** `shortcuts.ts`

---

### 📊 status

A comprehensive status bar suite with multiple modules:

| Module | Description |
|--------|-------------|
| **index.ts** | Main extension entry point, orchestrates all status modules |
| **header.ts** | Rich status header above the editor showing model, working directory + git branch, token statistics, context usage, generation speed, and TTFT |
| **git.ts** | Git status detection — branch name, ahead/behind counts, staged/modified/deleted/conflicted/untracked file counts |
| **tps.ts** | Token speed engine — real-time TPS estimation during streaming, accurate TPS after completion, TTFT measurement |
| **title.ts** | Animated terminal title with a braille spinner during agent activity |
| **theme.ts** | Cross-platform system dark/light mode detection and automatic pi theme switching |
| **statusline.ts** | `/statusline` command for interactive configuration of which items appear in the header |

**Files:** `status/index.ts`, `status/header.ts`, `status/git.ts`, `status/tps.ts`, `status/title.ts`, `status/theme.ts`, `status/statusline.ts`

**TPS** (time window: first token → `message_end`, excluding TTFT):
- **During streaming** — estimated, via `max(1, round(chars/4))`, the same chars/4 heuristic pi's compaction module uses internally.
- **After `message_end`** — accurate, `TPS = usage.output / (message_end - first_token_time)`.

**TTFT** (time to first token): `TTFT = first_token_time - http_request_sent_time`

---

## 429 Rate-Limit Workaround (OpenCode)

![429 limit](https://github.com/user-attachments/assets/907d920d-5d20-4193-b298-416179fc0c69)

> **Temporary workaround** for SDK 429 retry hang, integrated into `request-logger.ts`.
>
> **Related issues:**
> - [pi#3671](https://github.com/earendil-works/pi/issues/3671) — Copilot provider hangs on long Retry-Afters
> - [pi#4666](https://github.com/earendil-works/pi/issues/4666) — 429 Retry-After waits ignore `maxRetryDelayMs`; Esc and /new do not recover
>
> **The problem (historical):** When a provider returns HTTP 429 with a large
> `retry-after` header, the underlying SDK (OpenAI, Anthropic) used to sleep for
> that exact duration with no upper bound and no abort support — Esc could not
> cancel it, `/new` broke the session, and the only recovery was restarting pi.
> **This has since been fixed upstream** (pi now calls the SDKs with
> `maxRetries: 0` plus capped, abort-aware delays), so a raw 429 no longer hangs.
>
> **Why it is still kept:** formatting. The reset time lives in the
> `retry-after` header, which a raw 429 error message drops. Rewriting to a 400
> (non-retryable, so the SDK throws immediately) with a human-readable body
> (`Usage limit reached (FreeUsageLimitError): Resets in 2h 5m`) makes the agent
> stop with a clear error that includes the reset time.
>
> **What it does:** Intercepts `fetch()` on 429 responses from `opencode.ai`
> providers only. Parses the `retry-after` header, returns a 400 with a
> human-readable message (`Usage limit reached (FreeUsageLimitError): Resets in 2h 5m`),
> and avoids pi's retry-trigger keywords so the error displays once without
> entering a retry loop. The provider's error-type marker (e.g.
> `FreeUsageLimitError` / `GoUsageLimitError`) is preserved in the body so the
> SDK classifies it as a **non-retryable** limit and stops the agent with the
> reset time, rather than retrying.
>
> **Companion `429-retry.ts`:** auto-retries *transient* 429s (short
> `retry-after`), but **fails fast** on hard usage limits — detected via the
> error-type marker or a reset window beyond 10 minutes — so a multi-hour
> free-tier limit surfaces an error immediately instead of burning ~100 min on
> pointless retries.
>
> **Remove this workaround once the upstream issue is fixed.**

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

### 📦 compact-tool

<p align="center">
  <img src="https://github.com/user-attachments/assets/0c8fbd7d-36f0-418a-923a-5a68e409ab6a" height="400">
</p>

Inspired by Codex style.

**File:** `compact-tool.ts`

---

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

---

## 429 Rate-Limit Workaround (OpenCode)

![429 limit](https://github.com/user-attachments/assets/907d920d-5d20-4193-b298-416179fc0c69)

> **Temporary workaround** for SDK 429 retry hang, integrated into `request-logger.ts`.
>
> **Related issues:**
> - [pi#3671](https://github.com/earendil-works/pi/issues/3671) — Copilot provider hangs on long Retry-Afters
> - [pi#4666](https://github.com/earendil-works/pi/issues/4666) — 429 Retry-After waits ignore `maxRetryDelayMs`; Esc and /new do not recover
>
> **The problem:** When a provider returns HTTP 429 with a large `retry-after`
> header, the underlying SDK (OpenAI, Anthropic) sleeps for that exact duration
> with no upper bound. The sleep is not abort-aware — **Esc cannot cancel it**,
> `/new` breaks the session, and the only recovery is restarting pi.
>
> **What it does:** Intercepts `fetch()` on 429 responses from `opencode.ai`
> providers only. Parses the `retry-after` header, returns a 400 with a
> human-readable message (`Usage limit reached: Resets in 2h 5m`), and avoids
> pi's retry-trigger keywords so the error displays once without entering a
> retry loop.
>
> **Remove this workaround once the upstream issue is fixed.**

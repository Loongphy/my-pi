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

### 📦 collapse-tools

Collapses verbose tool outputs (bash, read, write, edit) into compact one-liners showing only the tool name and key parameters. Press `Ctrl+O` to expand/collapse and view full output. Fully adapts to the system theme.

**File:** `collapse-tools.ts`

**Credits:** [xRyul/pi-collapse-tools](https://github.com/xRyul/pi-collapse-tools)

---

### ✏️ editor

Patches the `DynamicBorder` component to suppress redundant border lines in bash mode, keeping the editor area clean and clutter-free.

**File:** `editor.ts`

---

### 📝 request-logger

Logs every provider request to a file (`~/.pi/agent/requests/<session>.request.log`). Captures HTTP status, headers, token counts, model info, and sanitizes sensitive query parameters.

**File:** `request-logger.ts`

---

### 📊 status

A comprehensive status bar suite with multiple modules:

| Module | Description |
|--------|-------------|
| **header.ts** | Rich status header above the editor showing model, working directory + git branch, token statistics, context usage, generation speed, and TTFT |
| **title.ts** | Animated terminal title with a braille spinner during agent activity |
| **theme.ts** | Cross-platform system dark/light mode detection and automatic pi theme switching |
| **statusline.ts** | `/statusline` command for interactive configuration of which items appear in the header |

**Files:** `status/index.ts`, `status/header.ts`, `status/title.ts`, `status/theme.ts`, `status/statusline.ts`

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

---

## Pi Internals

You do **not** need any extension to replace `find`/`grep` with `fd`/`rg` — pi already handles this internally. The tool names exposed to the LLM are `find` and `grep` for semantic clarity, but the actual work is done by `fd` and `rg`.

example:

```
LLM calls "find" tool
  → pi receives the "find" tool call
    → find.ts execute()
      → ensureTool("fd", true)   ← auto-downloads fd if missing
        → spawn(fd binary, fd args)
          → returns fd search results
```

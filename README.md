# my-pi

A collection of [pi](https://pi.dev) extensions for an enhanced coding experience.

![Screenshot](https://github.com/user-attachments/assets/e8766ffd-3ff5-474b-a876-3b8f78bfd069)

## Quick Start

### Install with pi

```bash
pi install https://github.com/Loongphy/my-pi
```

Then reload pi:

```
/reload
```

How it shows up in pi:

- `pi list` → the source string you installed (`https://github.com/Loongphy/my-pi`) with install path `~/.pi/agent/git/github.com/Loongphy/my-pi`
- loaded-resources panel (compact labels) → `Loongphy/my-pi:editor.ts`, `Loongphy/my-pi:status`

> [!NOTE]
> The git clone is managed by pi — updating runs `git clean -fdx` + `git pull`, so **don't edit files inside `~/.pi/agent/git/`**. Keep personal customizations in `~/.pi/agent/extensions/` (loaded alongside packages).

### Update with pi

`pi update` on its own only updates pi — it skips extensions outright (`Extensions are skipped. Run pi update --extensions …`). Use `--extensions` for packages alone, or `--all` for both.

All packages:

```bash
pi update --all
```

Only this package:

```bash
pi update https://github.com/Loongphy/my-pi
```

## Extensions

### status

A comprehensive status bar suite with multiple modules:

| Module | Description |
|--------|-------------|
| **index.ts** | Main extension entry point, orchestrates all status modules |
| **header.ts** | Rich status header above the editor showing model, working directory + git branch, token statistics, context usage, generation speed, and TTFT |
| **git.ts** | Git status detection — branch name, ahead/behind counts, staged/modified/deleted/conflicted/untracked file counts |
| **tps.ts** | Token speed engine — real-time TPS estimation during streaming, accurate TPS after completion, TTFT measurement |
| **title.ts** | Animated terminal title with a braille spinner during agent activity |
| **statusline.ts** | `/statusline` command for interactive configuration of which items appear in the header |

**Files:** `status/index.ts`, `status/header.ts`, `status/git.ts`, `status/tps.ts`, `status/title.ts`, `status/statusline.ts`

---

### auto-update

Checks extension packages on TUI startup and, when updates exist, runs the same command you would type in shell mode — `pi update --extensions` — in a **separate process**. The child's stdout/stderr are piped, so npm never writes to the terminal, the composer stays untouched, and the result is appended to the transcript as a custom entry (not sent to the LLM). With no updates or a failed check, it stays completely silent.

Manual command: `/ext-update [package]` (equivalent to `pi update --extensions` / `pi update --extension <package>`).

- `PI_AUTO_UPDATE_EXTENSIONS=update|check|off` — default `update`; `check` only notifies, `off` disables the startup check.
- `PI_OFFLINE=1` skips the startup check.

**File:** `auto-update.ts`

---

### tool-tui

Devin-CLI style compact rendering for the built-in `read`, `write`, `edit`, `bash` and `powershell` tools: every call collapses to a single row — status icon, tool name, path or command, plus the numbers that matter (`+12 -3` for writes/edits, `120 lines` or `lines 40-80` for reads, `(timeout 60s)` / `(exit 1)` for shells). `Ctrl+O` still expands the original pi output; tool behavior is untouched.

**File:** `tool-tui.ts`

---

### bash-default-timeout

Gives the `bash` / `powershell` tools a default 60s timeout when the model does not pass one (an explicit `timeout` is kept as-is). The wrapped `renderCall` also shows `(timeout 60s)` in the TUI, which pi cannot do on its own — the call is drawn during `tool_execution_start`, before the timeout is injected.

**File:** `bash-default-timeout.ts`

---

### editor

![editor](https://github.com/user-attachments/assets/37fdd8a3-f924-4829-a4eb-ad9b2f42c187)

- **Composer** — codex-style input area with a bold `❯` prompt (highlighted in `!bash` mode, `！` alias included)
- **Skill mentions** — `$skill` mentions render bold in the theme accent; typing `$` opens the mention picker with all indexed skills (agents, codex, claude, pi); unknown `$tokens` are left untouched. Chinese IMEs work too: Shift+4 gives `￥`, which opens the same picker and is rewritten to `$` **in the composer** the moment the token names a skill (`￥coss` → `$coss` under the caret), so highlighting and the submitted prompt keep the plain `$` rules — and a non-resolving `￥100` stays a price
- **Bash alias** — Chinese IMEs: Shift+1 gives `！` (U+FF01), rewritten to `!` **in the composer** when leading (`！ls` → `!ls`, `！！`/`！!`/`!！` → `!!`); a `！` elsewhere stays punctuation (`你好！` never runs)
- **Fullscreen quote** — in fullscreen mode, a mouse drag over the transcript only copies (pi's copy-on-select); press `Enter` while that selection is active to quote it into the composer as a Markdown blockquote (`> line`) followed by a blank line, with the caret ready for your question. Any other key dismisses the transcript selection, so a copy-only selection never hijacks a later Enter submitted with a draft. Only transcript selections are quoted (drags over the composer are ignored), and the gesture follows grok-build's block-viewer quote (`Enter` on a selected block) so the quoted material is visually distinct from the prompt

**File:** `editor.ts`

---

### request-logger

Logs every provider request to `~/.pi/agent/requests/<session>.request.log` — HTTP status, headers, token counts, model info, and the complete decoded request body (including gzip-compressed provider payloads) — with sensitive query parameters and auth headers sanitized.

**File:** `request-logger.ts`

---

### shortcuts

`Alt+C` copies the current editor content to the system clipboard. (Formerly `Ctrl+Shift+C`, which Windows Terminal intercepts for its own Copy action whenever any text is selected in the terminal — the key never reached pi in that state.)

`Alt+K` / `Alt+J` jump to the previous / next **final assistant answer** in fullscreen mode. Each stop is the last qualifying assistant body of one user turn: user prompts, intermediate assistant messages that end in tool calls, and earlier retry/aborted partial replies are skipped. So with several queued prompts one press moves one prompt back or forward. At the first answer, `Alt+K` moves to its first line; past the last answer, `Alt+J` returns to the live end of the transcript.

Pi's built-in `Ctrl+Shift+Up` / `Ctrl+Shift+Down` (`Ctrl+Up` / `Ctrl+Down` on Windows/WSL) already jumps between OSC 133 marked messages, but that includes the user message at the start of every turn — hence two stops per queued prompt. The `Alt+J/K` shortcuts use the same fullscreen renderer but only stop at final assistant replies.

**File:** `shortcuts.ts`

#### Built-in keybindings (`~/.pi/agent/keybindings.json`)

Beyond what this extension registers, the local config remaps two **pi built-in** actions to match codex-cli's input habits:

```json
{
  "app.message.followUp": "ctrl+enter",
  "app.message.dequeue": "alt+up"
}
```

| Action | Key here | pi default | codex-cli | Why |
|---|---|---|---|---|
| `app.message.followUp` — queue the draft as a follow-up (delivered after the current turn ends; plain `Enter` while streaming *steers* instead) | `Ctrl+Enter` | `Alt+Enter` (`Ctrl+Q` on Windows/WSL) | `composer.queue` = `Tab` | `Ctrl+Enter` is the usual "send/queue without interrupting" habit, and it frees `Alt+Enter` — codex binds that to a newline, and Windows Terminal grabs it for fullscreen (pi's own newline is `shift+enter`/`ctrl+j`, so nothing is lost) |
| `app.message.dequeue` — pull the queued messages back into the editor | `Alt+↑` | `Alt+↑` (`Alt+Q` on Windows/WSL) | `chat.edit_queued_message` = `Alt+↑` (+ `Shift+←`) | Same chord as codex; written out explicitly so Windows/WSL also gets `Alt+↑` instead of pi's platform-specific `Alt+Q` default |

Two caveats, both from pi's own `docs/terminal-setup.md`:

- `Ctrl+Enter` needs a terminal that reports modified Enter distinctly (Kitty keyboard protocol: Kitty, Ghostty, WezTerm, iTerm2, Windows Terminal, VS Code ≥1.109.5). xfce4-terminal and terminator cannot tell it apart from plain `Enter` — there the chord arrives as `Enter`, i.e. it steers instead of queueing.
- After editing `keybindings.json`, run `/reload` in pi to apply it.

**File:** `~/.pi/agent/keybindings.json` (not an extension)

---

### session-workbench

- **Live activity line** — the status bar shows the executing tool or command (`⏳ bash: npm run build`) and clears itself when the tool finishes.
- **`Alt+H` / `/workbench`** — overlay list of every user message, newest first. Rows stay collapsed; the selected one expands in place to show the user message plus the assistant's final text reply only — thinking and tool calls stay hidden.
- **`Enter`** — opens the selected turn's full process in `/tree` list style (one row per step, ✓/✗ per tool call). `Enter` again opens that step's content, the cursor lands on the first assistant reply, `g`/`G` jump to top/bottom.
- **`V`** — reads the final reply verbatim (original line breaks, scrollable) for copying the answer without digging through the process.

Keys: `↑↓` select · `PgUp`/`PgDn` scroll · `V` read reply · `Enter` detail · `C` copy · `Esc`/`Q` close

**File:** `session-workbench.ts`

---

### 429-retry

![429 limit](https://github.com/user-attachments/assets/907d920d-5d20-4193-b298-416179fc0c69)

Retries transient HTTP 429 responses automatically (any provider). The wait follows an incremental sequence — 5s, 10s, 20s, 30s, 60s, 90s, ... (+30s per retry after 30s), up to 15 attempts, or the server's `Retry-After` / body reset time when provided — with a live status-bar countdown. Hard limits fail fast: a wait longer than 10 min, or a provider's permanent-limit signature (e.g. workbuddy quota exhausted, opencode usage-limit errors), surfaces the response immediately with the reset time instead of retrying.

OpenCode-specific: before an opencode.ai usage-limit 429 is handed back to the SDK, the response body is annotated with the server-provided reset time — `resets_at` in the codex TUI's format (`14:30` / `14:30 5 Mar`) plus the remaining duration `resets_in`, both top-level and inside `error`, with a `(Free usage limit resets at 14:30)` suffix appended to `error.message` — so the final error message the TUI displays carries the reset time (e.g. `{"type":"FreeUsageLimitError","message":"Rate limit exceeded. Please try again later. (Free usage limit resets at 14:30)","resets_at":"14:30","resets_in":"8h 7m 17s"}`). Other providers keep the historical top-level `resets_in` only.

Devin-specific: every `server.codeium.com` 429 is handed straight back to the provider instead of being retried by the fetch-layer backoff. Devin owns its own rolling 5-requests/60s limiter and waits for a slot transparently — retrying here would eat the five grace slots and push the reset further out.

**Command:** `/429-retry` toggles on/off · `/429-retry <seconds>` sets a fixed wait time for every retry

**File:** `429-retry.ts`

---

### thinking-level

![thinking-level /model picker](https://github.com/user-attachments/assets/f29e4266-933a-42c9-a712-e2ee0b75a475)

Remembers the reasoning level **per model** and defaults each model to its highest supported level.

- Switching back restores its remembered level; a model without one is raised to its maximum — never inheriting a lower level (a `high`-only model followed by a `max`-capable one lands on `max`). Fallback: scoped `--models model:level`.
- `/model` lists the levels each model supports, current one highlighted. No commands, no switches.

**Storage:** `~/.pi/agent/thinking-level-memory.json` · **File:** `thinking-level.ts`

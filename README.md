# my-pi

A collection of [pi](https://pi.dev) extensions for an enhanced coding experience.

![Screenshot](https://github.com/user-attachments/assets/e8766ffd-3ff5-474b-a876-3b8f78bfd069)

## Quick Start

### Install with pi (recommended)

```bash
pi install https://github.com/Loongphy/my-pi
```

(`git:github.com/Loongphy/my-pi` is equivalent.) pi clones the repo into `~/.pi/agent/git/github.com/Loongphy/my-pi` and records the source in your `settings.json` (`packages`). The extensions listed in the package manifest (`package.json` → `pi.extensions`) are loaded on the next startup — no manual copying, and **no filename conflicts**: the package lives in its own directory, fully separate from `~/.pi/agent/extensions/`.

Then reload pi:

```
/reload
```

Update later with `pi update` (all packages) or `pi update https://github.com/Loongphy/my-pi`.

How it shows up in pi:

- `pi list` → the source string you installed (`https://github.com/Loongphy/my-pi` or `git:github.com/Loongphy/my-pi`) with install path `~/.pi/agent/git/github.com/Loongphy/my-pi`
- loaded-resources panel (compact labels) → `Loongphy/my-pi:editor.ts`, `Loongphy/my-pi:status`

> [!NOTE]
> The git clone is managed by pi — updating runs `git clean -fdx` + `git pull`, so **don't edit files inside `~/.pi/agent/git/`**. Keep personal customizations in `~/.pi/agent/extensions/` (loaded alongside packages).

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
| **theme.ts** | Cross-platform system dark/light mode detection and automatic pi theme switching |
| **statusline.ts** | `/statusline` command for interactive configuration of which items appear in the header |

**Files:** `status/index.ts`, `status/header.ts`, `status/git.ts`, `status/tps.ts`, `status/title.ts`, `status/theme.ts`, `status/statusline.ts`

---

### editor

![editor](https://github.com/user-attachments/assets/37fdd8a3-f924-4829-a4eb-ad9b2f42c187)

- **Composer** — codex-style input area with a bold `❯` prompt (highlighted in `!bash` mode, `！` alias included)
- **Skill mentions** — `$skill` mentions render bold in the theme accent; typing `$` opens the mention picker with all indexed skills (agents, codex, claude, pi); unknown `$tokens` are left untouched. Chinese IMEs work too: Shift+4 gives `￥`, which opens the same picker and is rewritten to `$` **in the composer** the moment the token names a skill (`￥coss` → `$coss` under the caret), so highlighting and the submitted prompt keep the plain `$` rules — and a non-resolving `￥100` stays a price
- **Bash alias** — Chinese IMEs: Shift+1 gives `！` (U+FF01), rewritten to `!` **in the composer** when leading (`！ls` → `!ls`, `！！`/`！!`/`!！` → `!!`); a `！` elsewhere stays punctuation (`你好！` never runs)

**File:** `editor.ts`

---

### request-logger

Logs every provider request to `~/.pi/agent/requests/<session>.request.log` — HTTP status, headers, token counts, model info, and the complete decoded request body (including gzip-compressed provider payloads) — with sensitive query parameters and auth headers sanitized.

**File:** `request-logger.ts`

---

### shortcuts

`Alt+C` copies the current editor content to the system clipboard. (Formerly `Ctrl+Shift+C`, which Windows Terminal intercepts for its own Copy action whenever any text is selected in the terminal — the key never reached pi in that state.)

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

### 429-retry

![429 limit](https://github.com/user-attachments/assets/907d920d-5d20-4193-b298-416179fc0c69)

Retries transient HTTP 429 responses automatically (any provider). The wait follows an incremental sequence — 5s, 10s, 20s, 30s, 60s, 90s, ... (+30s per retry after 30s), up to 15 attempts, or the server's `Retry-After` / body reset time when provided — with a live status-bar countdown. Hard limits fail fast: a wait longer than 10 min, or a provider's permanent-limit signature (e.g. workbuddy quota exhausted, opencode usage-limit errors), surfaces the response immediately with the reset time instead of retrying.

OpenCode-specific: before an opencode.ai usage-limit 429 is handed back to the SDK, the response body is annotated with the server-provided reset time — `resets_at` in the codex TUI's format (`14:30` / `14:30 5 Mar`) plus the remaining duration `resets_in`, both top-level and inside `error`, with a `(Free usage limit resets at 14:30)` suffix appended to `error.message` — so the final error message the TUI displays carries the reset time (e.g. `{"type":"FreeUsageLimitError","message":"Rate limit exceeded. Please try again later. (Free usage limit resets at 14:30)","resets_at":"14:30","resets_in":"8h 7m 17s"}`). Other providers keep the historical top-level `resets_in` only.

**Command:** `/429-retry` toggles on/off · `/429-retry <seconds>` sets a fixed wait time for every retry

**File:** `429-retry.ts`

---

### thinking-level

![thinking-level /model picker](https://github.com/user-attachments/assets/f29e4266-933a-42c9-a712-e2ee0b75a475)

Remembers the reasoning level **per model** and defaults each model to its highest supported level.

- Switching back restores its remembered level; a model without one is raised to its maximum — never inheriting a lower level (a `high`-only model followed by a `max`-capable one lands on `max`). Fallback: scoped `--models model:level`.
- `/model` lists the levels each model supports, current one highlighted. No commands, no switches.

**Storage:** `~/.pi/agent/thinking-level-memory.json` · **File:** `thinking-level.ts`

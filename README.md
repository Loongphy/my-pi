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

## status/index.ts

A status bar suite: a header above the editor showing model, working directory and git branch, token stats, context usage, generation speed and TTFT; an animated terminal title during agent activity; and `/statusline` to choose which items appear.

| Module | What it does |
|--------|--------------|
| index | Entry point, orchestrates the footer slots and status modules |
| header | Rich status header above the editor |
| git | Branch, ahead/behind, staged/modified/deleted/untracked counts |
| tps | Live TPS estimate while streaming, accurate TPS after completion, TTFT |
| title | Braille spinner in the terminal title |
| statusline | `/statusline` config command |

---

## editor.ts

![editor](https://github.com/user-attachments/assets/37fdd8a3-f924-4829-a4eb-ad9b2f42c187)

A Codex-style composer: a filled panel with a bold `❯` prompt (green in `!bash` mode). `$skill` mentions highlight in the theme accent, and typing `$` opens a picker over every indexed skill (agents, codex, claude, pi); unknown tokens stay untouched. Chinese IME aliases `￥` → `$` and leading `！` → `!` are rewritten in place.

In fullscreen mode, `Enter` on a transcript selection quotes it into the composer as a Markdown blockquote with a blank line, ready for your question. Any other key dismisses the selection.

---

## auto-update.ts

![auto-update](https://github.com/user-attachments/assets/16b9a2b2-3475-4861-8f93-b7703e875d73)

Checks pi itself and the extension packages on TUI startup. When updates exist it runs the matching `pi update` command in a separate process, pipes stdout/stderr so nothing touches the terminal or the composer, and appends the result to the transcript as a custom entry (not sent to the LLM). With no updates or a failed check it stays silent.

The pi check uses the same endpoint, User-Agent, timeout and gates as pi's own `Update Available` banner. A new pi version needs a restart (the running process keeps its loaded modules); updated packages are picked up by `/reload`. `/ext-update` runs it for everything, `/ext-update <package>` for one package. Installation is `pi update`'s decision, so non-npm setups need [`selfUpdateCommand`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md) in `settings.json`.

| Env var | Default | Description |
|---------|---------|-------------|
| `PI_AUTO_UPDATE_EXTENSIONS` | `update` | `update` runs it, `check` only notifies, `off` skips the package check |
| `PI_AUTO_UPDATE_PI` | `update` | Same three values for pi itself |
| `PI_OFFLINE` / `PI_SKIP_VERSION_CHECK` | unset | Skip the startup check |

---

## tool-tui.ts

![tool-tui](https://github.com/user-attachments/assets/95f4eb91-b7e7-4afb-a483-9296e928b3ee)

Devin-CLI style compact rows for `read`, `write`, `edit`, `bash` and `powershell`: one line per call with a status icon, the path or command, and the numbers that matter (`+12 -3`, `120 lines`, `(exit 1)`). Tool behavior is untouched and `Ctrl+O` still expands pi's original output.

---

## bash-default-timeout.ts

pi ships no default shell timeout, so a model that omits it can hang a tool call. This injects 60s (600s for installs, builds and test runs), fixes millisecond mixups (`180000` means 3 minutes, not 50 hours), and caps everything at 7200s. The `timeout` schema text and the rendered call are updated to match the deadline that actually applies.

The `tool_call` hook covers nested calls from codemode and subagents; `!command` runs are left alone. `powershell` is Windows-only.

| Env var | Default | Description |
|---------|---------|-------------|
| `PI_BASH_TIMEOUT_SECONDS` | `60` | Deadline injected when the model omits `timeout` |
| `PI_BASH_LONG_TIMEOUT_SECONDS` | `600` | Deadline for installs, builds and test runs |
| `PI_BASH_MAX_TIMEOUT_SECONDS` | `7200` | Hard ceiling applied to every value |
| `PI_BASH_NO_MS_HEURISTIC` | unset | Keep millisecond-looking numbers as seconds |

---

## request-logger.ts

Logs every provider request to `~/.pi/agent/requests/<session>.request.log` — HTTP status, headers, token counts, model info and the complete decoded body (including gzip payloads), with sensitive query parameters and auth headers sanitized.

---

## session-workbench.ts

`Alt+H` / `/workbench` lists every user turn newest first; selecting one expands the user message plus the final reply, `Enter` opens the turn's step-by-step process, and `V` shows the final reply verbatim. A live activity line in the status bar shows the running tool or command.

Keys: `↑↓` select · `PgUp`/`PgDn` scroll · `V` read reply · `Enter` detail · `C` copy · `Esc`/`Q` close

---

## theme-follow.ts

On Windows Terminal (including WSL/ConPTY) and other terminals without `DECSET 2031`, pi's `system` theme does not follow live light/dark switches: user messages and the composer keep the startup palette while the rest of the UI changes. This extension fixes that.

pi re-queries OSC 10/11/4 only on startup, `/reload`, or a `CSI ?997;1n|2n` report. Windows Terminal answers OSC 11 but never sends that report ([microsoft/terminal#18375](https://github.com/microsoft/terminal/issues/18375); [PR #20335](https://github.com/microsoft/terminal/pull/20335) rejected: apps should query `11;?` themselves).

It polls the same color query every 3 seconds; when the answer changes it updates pi's live `terminalColors` in place and calls `setTheme("system")` to rebuild every token. Only active with `theme: "system"`.

| Env var | Default | Description |
|---------|---------|-------------|
| `PI_THEME_FOLLOW` | unset | Set to `off` to disable |
| `PI_THEME_FOLLOW_POLL_MS` | `3000` | Interval between queries (`0` disables) |
| `PI_THEME_FOLLOW_DELAY_MS` | `2000` | Delay before the first query, so pi's startup query finishes first |
| `PI_THEME_FOLLOW_TIMEOUT_MS` | `150` | Per-query timeout |
| `PI_THEME_FOLLOW_DEBUG` | unset | `1` logs every poll instead of just switches |

Start, stop and switch events go to `~/.pi/agent/tmp/theme-follow.log`.

---

## 429-retry.ts

![429 limit](https://github.com/user-attachments/assets/907d920d-5d20-4193-b298-416179fc0c69)

Retries transient HTTP 429s from any provider: 5s → 10s → 20s → 30s → 60s → 90s … (up to 15 attempts), or the server's `Retry-After` / body reset time, with a live status-bar countdown. Permanent limits fail fast with the reset time; opencode usage-limit bodies are annotated with `resets_at` / `resets_in` so the TUI shows them. Devin 429s are handed back to the provider's own limiter instead of being retried.

`/429-retry` toggles it, `/429-retry <seconds>` sets a fixed wait.

---

## thinking-level.ts

![thinking-level /model picker](https://github.com/user-attachments/assets/f29e4266-933a-42c9-a712-e2ee0b75a475)

Remembers the reasoning level per model and defaults each model to its highest supported level. Switching back restores it; a model without one is raised to its maximum rather than inheriting a lower level. `/model` lists supported levels with the current one highlighted.

**Storage:** `~/.pi/agent/thinking-level-memory.json`

---

## shortcuts.ts

`Alt+C` copies the editor content (Windows Terminal intercepts `Ctrl+Shift+C` whenever text is selected). `Alt+K` / `Alt+J` jump between final assistant answers in fullscreen mode, skipping user prompts and intermediate tool-call turns — unlike pi's built-in OSC 133 jumps, which stop twice per queued prompt.

### Built-in keybindings

`~/.pi/agent/keybindings.json` remaps two pi built-ins to match codex-cli:

```json
{
  "app.message.followUp": "ctrl+enter",
  "app.message.dequeue": "alt+up"
}
```

| Action | Key here | pi default | Why |
|---|---|---|---|
| `app.message.followUp` — queue the draft (`Enter` while streaming steers instead) | `Ctrl+Enter` | `Alt+Enter` / `Ctrl+Q` | Usual "send without interrupting" chord; frees `Alt+Enter` |
| `app.message.dequeue` — pull queued messages back | `Alt+↑` | `Alt+↑` / `Alt+Q` | Matches codex; explicit so WSL gets `Alt+↑` too |

`Ctrl+Enter` needs a terminal that reports modified Enter distinctly (Kitty keyboard protocol); xfce4-terminal and terminator cannot. Run `/reload` after editing the file.

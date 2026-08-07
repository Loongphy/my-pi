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

### Legacy — migrating from manual setup

Previously this collection was installed by copying files into `~/.pi/agent/extensions/`. To migrate to the recommended install:

```bash
pi install https://github.com/Loongphy/my-pi
```

Then remove the manual copies from `~/.pi/agent/extensions/` (the ones that exist in the package), and run `/reload`.

> [!WARNING]
> If you keep both, the same extensions load twice — duplicate patches, first-wins tool registration.

<details>
<summary>Archived: old manual setup (deprecated — for reference only)</summary>

```bash
git clone https://github.com/Loongphy/my-pi.git /tmp/pi-extensions
cp -r /tmp/pi-extensions/*.ts ~/.pi/agent/extensions/
cp -r /tmp/pi-extensions/status/ ~/.pi/agent/extensions/status/
```

> [!WARNING]
> Check for filename conflicts. If you already have an extension with the same name in `~/.pi/agent/extensions`, **rename the incoming files** (e.g., `collapse-tools.new.ts`) rather than overwriting your existing ones.

</details>

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

- **Composer** — codex-style input area with a bold `❯` prompt (highlighted in `!bash` mode)
- **Skill mentions** — `$skill` mentions render bold in the theme accent; typing `$` opens the mention picker with all indexed skills (agents, codex, claude, pi); unknown `$tokens` are left untouched

**File:** `editor.ts`

---

### request-logger

Logs every provider request to `~/.pi/agent/requests/<session>.request.log` — HTTP status, headers, token counts, model info — with sensitive query parameters sanitized.

**File:** `request-logger.ts`

---

### shortcuts

`Ctrl+Shift+C` copies the current editor content to the system clipboard.

**File:** `shortcuts.ts`

---

### 429-retry

![429 limit](https://github.com/user-attachments/assets/907d920d-5d20-4193-b298-416179fc0c69)

Retries transient HTTP 429 responses automatically (any provider): waits clamped to 1s–10min, up to 10 attempts, with a live status-bar countdown. Hard usage limits fail fast — the agent stops with the reset time instead.

**Command:** `/429-retry` toggles on/off · `/429-retry <seconds>` sets the default wait when the response carries no `retry-after` (default 30s)

**File:** `429-retry.ts`

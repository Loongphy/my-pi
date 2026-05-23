# my-pi

A collection of [pi](https://pi.dev) extensions for an enhanced coding experience.

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

Logs every provider request to a file (`~/.pi/agent/requests/<session>.request.log`). Captures HTTP status, headers, token counts, model info, and sanitizes sensitive query parameters. Supports configurable max log size via the `PI_REQUEST_LOG_MAX_KB` environment variable.

**File:** `request-logger.ts`

---

### 📊 status

A comprehensive status bar suite with multiple modules:

| Module | Description |
|--------|-------------|
| **header.ts** | Rich status header above the editor showing model, working directory + git branch, token statistics, context usage, and generation speed |
| **title.ts** | Animated terminal title with a braille spinner during agent activity |
| **theme.ts** | Cross-platform system dark/light mode detection and automatic pi theme switching |
| **statusline.ts** | `/statusline` command for interactive configuration of which items appear in the header |

**Files:** `status/index.ts`, `status/header.ts`, `status/title.ts`, `status/theme.ts`, `status/statusline.ts`

---

### 🔧 tool

Replaces the default bash tool description from _"Execute bash commands (ls, grep, find, etc.)"_ to _"Execute bash commands (ls, rg for text search, fd for file search, etc.)"_, biasing the LLM toward modern search tools.

**File:** `tool.ts`

- `~/.pi/agent/AGENTS.md`

This extension works best when paired with `~/.pi/agent/AGENTS.md`, which enforces the same search policy at the instruction level. Place it at:

- `~/.pi/agent/AGENTS.md` — global (all projects)
- `<project>/.pi/agent/AGENTS.md` — project-local

```markdown
# Bash Search Command Policy

These rules override any generic examples that mention `find`, `grep`, or recursive shell search.

Use bash for shell commands. For project search:
- use `rg` for text search
- use `fd` for file/path search
- use `sg` for AST/code-structure search

## Forbidden by default

Do NOT use these commands for project search:
- `find .`
- `find <path>`
- `grep -R`
- `egrep -R`
- `ls -R`

Do not use `find` or `grep` unless other tools are unavailable.
```

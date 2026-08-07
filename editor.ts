/**
 * Codex Composer + `$skill` Mention Highlighting
 *
 * Two features layered on the pi input editor:
 *
 * ── 1. Codex Composer restyle ──────────────────────────────────────────────
 * The default pi editor draws its chrome as top/bottom `─` border lines. Codex
 * instead draws the composer as a single filled panel: a solid background
 * rectangle with the text inset by one row (top/bottom) and two columns (left),
 * and a bold prompt sitting in the left gutter of the first text line. (Codex
 * uses `›`; this extension uses its heavy variant `❯`, which reads larger.)
 *
 * Codex fills the composer with the same background it uses for user messages
 * (`user_message_style()` in codex-rs/tui/src/style.rs). This extension does the
 * same via pi's `userMessageBg` theme token, so the panel is a subtle neutral
 * surface that adapts to dark themes (slightly lighter than the background) and
 * light themes (slightly darker) automatically, exactly like Codex.
 *
 * ── 2. `$skill` mention highlighting + completion (codex-style) ───────────
 * While typing, any `$name` token that resolves to a skill is rendered bold in
 * the theme's accent color, mirroring how Codex's composer surfaces skill
 * mentions (`$codex-reapply`, `$codex-review`, ...). Unknown `$tokens` are left
 * untouched, so shell variables in `!bash` mode never light up.
 *
 * Typing `$` at a token boundary opens the same dropdown as `@` file
 * attachments, listing every indexed skill (fuzzy-filtered as you type, Enter
 * or Tab to insert `$skill-name`). The picker is layered on top of pi's
 * built-in autocomplete provider, so `@`/`/`/path completion keeps working:
 * unknown `$tokens` simply fall through and produce no dropdown. Each row
 * shows `$name` in a narrow primary column, then the skill's directory
 * location and its description, sourced with Codex's own priority (`openai.yaml`
 * `interface.short-description` → SKILL.md `metadata.short-description` →
 * frontmatter `description`), truncated to 60 chars.
 *
 * Four skill formats are indexed (global + project-local). A skill is any
 * directory containing a SKILL.md (or the skills dir itself holding SKILL.md);
 * its name comes from the frontmatter `name:` field, falling back to the
 * directory name. Matching is case-insensitive over `[A-Za-z0-9_-]`.
 *
 *   source   | global roots                                        | project roots (cwd and every ancestor up to $HOME)
 *   ---------|-----------------------------------------------------|----------------------------------------------------------
 *   agents   | ~/.agents/skills                                   | .agents/skills
 *   standard | $XDG_CONFIG_HOME/agents/skills                     |
 *            |   (default ~/.config/agents/skills)                |
 *   ---------|-----------------------------------------------------|----------------------------------------------------------
 *   codex    | $CODEX_HOME/skills                                 | —
 *            |   (default ~/.codex/skills)                        |   (no official project-level root; the
 *            |                                                    |   .codex/skills convention is third-party
 *            |                                                    |   only, so it is not scanned)
 *   ---------|-----------------------------------------------------|----------------------------------------------------------
 *   claude   | $CLAUDE_CONFIG_DIR/skills                          | .claude/skills
 *            |   (default ~/.claude/skills)                       |
 *   ---------|-----------------------------------------------------|----------------------------------------------------------
 *   pi       | ~/.pi/agent/skills                                 | .pi/skills
 *            |   (pi global agent skills, mirroring pi's loader)  |
 *
 * All four share the same highlight style (theme `accent`, bold). If you want
 * to tell sources apart visually, override SKILL_SOURCE_COLORS below — e.g.
 * give `pi` its own color — instead of editing the renderer.
 *
 * The index is built once per session (session_start) from ctx.cwd; install
 * new skills and `/reload` (or start a new session) to refresh it. Rendering is
 * ANSI-aware: tokens keep their highlight even when the editor's inverted
 * cursor sits on a character inside the token.
 *
 * Usage: pi --extension ./examples/extensions/codex-composer.ts
 */

import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import {
	CustomEditor,
	type ExtensionAPI,
	type KeybindingsManager,
	type Theme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	Editor,
	type EditorTheme,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";

// Codex insets the textarea by two columns on the left (LIVE_PREFIX_COLS) and
// draws the prompt in that gutter. We reserve the same space via paddingX. `❯`
// (U+276F) is the heavy variant of Codex's `›` — the same shape but visually
// larger, and still a single column wide.
const PROMPT_CHAR = "❯";
const PROMPT_GUTTER_COLS = 2;

const RESET_BG = "\x1b[49m";

/**
 * Layout for the `$skill` picker list. pi's default SelectList column is 32
 * wide, which leaves a huge gap after short skill names; Codex's own picker
 * uses a narrow primary column. 20 fits every current skill name (longest is
 * `$domain-modeling` at 16) while keeping the gap tight.
 */
const SKILL_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 20,
	maxPrimaryColumnWidth: 20,
};

// ============================================================================
// Skill index — the four supported skill formats
// ============================================================================

type SkillSource = "agents" | "codex" | "claude" | "pi";

/**
 * Per-source highlight color. All four default to the theme `accent` token —
 * the codex-style highlight. Override any entry with another ThemeColor (e.g.
 * "cyan", "magenta") to visually tell sources apart.
 */
const SKILL_SOURCE_COLORS: Record<SkillSource, ThemeColor> = {
	agents: "accent",
	codex: "accent",
	claude: "accent",
	pi: "accent",
};

interface SkillEntry {
	/** Name as declared (frontmatter `name` or directory name). */
	displayName: string;
	/** Skill directory (parent of SKILL.md). */
	path: string;
	source: SkillSource;
	/** One-line description from SKILL.md frontmatter, if present. */
	description?: string;
}

/**
 * Read the `name:` frontmatter field from a SKILL.md, if present.
 * (Codex, Claude Code, and Agent-Skills-standard skills all declare it.)
 */
function frontmatterName(skillMdPath: string): string | undefined {
	try {
		const content = readFileSync(skillMdPath, "utf8").slice(0, 4096);
		const match = /^\s*---\r?\n([\s\S]*?)\r?\n\s*---/.exec(content);
		if (!match) return undefined;
		const nameMatch = /^name:\s*(.+?)\s*$/m.exec(match[1]);
		if (!nameMatch) return undefined;
		let name = nameMatch[1].trim();
		if (name.length >= 2) {
			const first = name[0]!;
			const last = name[name.length - 1]!;
			if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
				name = name.slice(1, -1).trim();
			}
		}
		return name || undefined;
	} catch {
		return undefined;
	}
}

/** Strip quotes and collapse whitespace from a single-line YAML scalar. */
function cleanYamlScalar(raw: string): string | undefined {
	let rest = raw.trim();
	if (rest.length >= 2) {
		const first = rest[0]!;
		const last = rest[rest.length - 1]!;
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			rest = rest.slice(1, -1).trim();
		}
	}
	rest = rest.replace(/\s+/g, " ").trim();
	return rest || undefined;
}

/**
 * Description priority for the dropdown, mirroring Codex's `skill_description()`
 * (codex-rs/tui/src/skills_helpers.rs):
 *
 *   1. `agents/openai.yaml` next to SKILL.md — `interface.short-description`
 *      (Codex plugin metadata; core-skills reads it via SKILLS_METADATA_DIR +
 *      SKILLS_METADATA_FILENAME)
 *   2. SKILL.md frontmatter `metadata.short-description`
 *   3. SKILL.md frontmatter `description` (standard Agent Skills field)
 */
export function skillDescription(skillDir: string): string | undefined {
	return (
		openaiShortDescription(skillDir) ??
		frontmatterShortDescription(join(skillDir, "SKILL.md")) ??
		frontmatterDescription(join(skillDir, "SKILL.md"))
	);
}

/** Codex plugin metadata: `agents/openai.yaml` `interface.short-description`. */
function openaiShortDescription(skillDir: string): string | undefined {
	try {
		// Codex stores plugin metadata at <skill_dir>/agents/openai.yaml
		// (SKILLS_METADATA_DIR "agents" + SKILLS_METADATA_FILENAME "openai.yaml"
		// in core-skills/src/loader.rs).
		const content = readFileSync(join(skillDir, "agents", "openai.yaml"), "utf8").slice(0, 8192);
		const lines = content.split(/\r?\n/);
		let inInterface = false;
		for (const line of lines) {
			if (/^interface:\s*$/.test(line)) {
				inInterface = true;
				continue;
			}
			if (inInterface) {
				if (/^\S/.test(line)) break; // next top-level key
				// Codex writes `short_description` (Serde snake_case); also accept
				// the kebab-case variant used by some plugins.
				const m = /^[ \t]+short[-_]description:\s*(.*)$/.exec(line);
				if (m) {
					const desc = cleanYamlScalar(m[1]!);
					// Same ruling as Codex's resolve_str: a short_description longer
					// than MAX_SHORT_DESCRIPTION_LEN (1024 chars, code points like
					// Rust's chars().count()) is dropped, so the picker falls back
					// to the next description source.
					if (desc && [...desc].length > 1024) return undefined;
					return desc;
				}
			}
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/** SKILL.md frontmatter `metadata.short-description` (Codex extension field). */
function frontmatterShortDescription(skillMdPath: string): string | undefined {
	try {
		const content = readFileSync(skillMdPath, "utf8").slice(0, 8192);
		const match = /^\s*---\r?\n([\s\S]*?)\r?\n\s*---/.exec(content);
		if (!match) return undefined;
		const lines = match[1]!.split(/\r?\n/);
		const metaIndex = lines.findIndex((line) => /^metadata:\s*$/.test(line));
		if (metaIndex === -1) return undefined;
		for (let i = metaIndex + 1; i < lines.length; i++) {
			const line = lines[i]!;
			if (/^\S/.test(line)) break;
			const m = /^[ \t]+short[-_]description:\s*(.*)$/.exec(line);
			if (m) return cleanYamlScalar(m[1]!);
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/**
 * Read the `description:` frontmatter field from a SKILL.md — the standard
 * Agent Skills field, and Codex's fallback description source. Collapsed to a
 * single line, handling quoted values and YAML `|` block scalars.
 */
function frontmatterDescription(skillMdPath: string): string | undefined {
	try {
		const content = readFileSync(skillMdPath, "utf8").slice(0, 8192);
		const match = /^\s*---\r?\n([\s\S]*?)\r?\n\s*---/.exec(content);
		if (!match) return undefined;
		const lines = match[1]!.split(/\r?\n/);
		const descIndex = lines.findIndex((line) => /^description:\s*/.test(line));
		if (descIndex === -1) return undefined;

		let rest = lines[descIndex]!.replace(/^description:\s*/, "").trim();
		if (rest.startsWith("|")) {
			// YAML block scalar: join the following indented lines.
			const block: string[] = [];
			for (let i = descIndex + 1; i < lines.length; i++) {
				const line = lines[i]!;
				if (/^\s+\S/.test(line)) block.push(line.trim());
				else break;
			}
			rest = block.join(" ");
		}
		return cleanYamlScalar(rest);
	} catch {
		return undefined;
	}
}

/** Index every skill under a single skills root (one level deep). */
function scanSkillsDir(index: Map<string, SkillEntry>, dir: string, source: SkillSource): void {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}

	const add = (name: string, skillDir: string): void => {
		index.set(name.toLowerCase(), {
			displayName: name,
			path: skillDir,
			source,
			description: skillDescription(skillDir),
		});
	};

	// A bare SKILL.md directly inside the skills dir is a single-skill root.
	const selfSkillMd = join(dir, "SKILL.md");
	if (existsSync(selfSkillMd)) {
		add(frontmatterName(selfSkillMd) ?? basename(dir), dir);
	}

	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		let isDir = entry.isDirectory();
		if (entry.isSymbolicLink()) {
			try {
				isDir = statSync(join(dir, entry.name)).isDirectory();
			} catch {
				continue;
			}
		}
		if (!isDir) continue;

		const skillDir = join(dir, entry.name);
		const skillMd = join(skillDir, "SKILL.md");
		if (!existsSync(skillMd)) continue;

		// The directory name is always a valid `$mention`; a differing
		// frontmatter `name` is indexed as an alias.
		add(entry.name, skillDir);
		const fmName = frontmatterName(skillMd);
		if (fmName && fmName.toLowerCase() !== entry.name.toLowerCase()) {
			add(fmName, skillDir);
		}
	}
}

/**
 * Build the skill index for a session working directory.
 *
 * Probes, in order: global roots (agents standard / codex / claude / pi), then
 * `.agents/skills`, `.claude/skills` and `.pi/skills` under the cwd and every
 * ancestor up to (and including) $HOME. Project-level skills shadow
 * same-name globals (later entries win). Missing dirs are skipped.
 * `.codex/skills` is intentionally absent — Codex has no official
 * project-level skills root; it only appears in third-party tooling (e.g.
 * skilltap's symlink layout).
 */
export function buildSkillIndex(cwd: string): Map<string, SkillEntry> {
	const index = new Map<string, SkillEntry>();
	const scanned = new Set<string>();

	const addDir = (dir: string, source: SkillSource): void => {
		const resolved = resolve(dir);
		if (scanned.has(resolved)) return;
		scanned.add(resolved);
		scanSkillsDir(index, resolved, source);
	};

	const home = homedir();
	const xdgConfig = process.env.XDG_CONFIG_HOME ? resolve(process.env.XDG_CONFIG_HOME) : join(home, ".config");
	const codexHome = process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(home, ".codex");
	const claudeConfig = process.env.CLAUDE_CONFIG_DIR ? resolve(process.env.CLAUDE_CONFIG_DIR) : join(home, ".claude");

	// Global roots
	addDir(join(home, ".agents", "skills"), "agents");
	addDir(join(xdgConfig, "agents", "skills"), "agents");
	addDir(join(codexHome, "skills"), "codex");
	addDir(join(claudeConfig, "skills"), "claude");
	addDir(join(home, ".pi", "agent", "skills"), "pi");

	// Project-local roots: cwd and every ancestor up to home (inclusive).
	// No `.codex/skills`: Codex's only official project root is `.agents/skills`.
	let dir = resolve(cwd);
	while (true) {
		addDir(join(dir, ".agents", "skills"), "agents");
		addDir(join(dir, ".claude", "skills"), "claude");
		addDir(join(dir, ".pi", "skills"), "pi");
		if (dir === home) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	return index;
}

// ============================================================================
// `$skill` completion dropdown (codex-style mention picker)
// ============================================================================

/**
 * Extract a standalone `$mention` token that reaches the cursor, if any. The
 * token starts at a token boundary (start of text, space, or tab) — matching
 * the highlight rule, so `foo$bar` never completes. A bare `$` at the cursor
 * is a valid token (shows the full skill list, like `@` shows all files).
 */
export function extractSkillToken(textBeforeCursor: string): string | undefined {
	const match = /(?:^|[ \t])(\$[A-Za-z0-9][A-Za-z0-9_-]*|\$)$/.exec(textBeforeCursor);
	return match?.[1];
}

/**
 * Render a skill directory for the dropdown's description column: paths under
 * the home directory are abbreviated with `~` (e.g. `~/.agents/skills/coss`)
 * so the picker shows where each skill actually lives — global roots like
 * `~/.agents/skills`, `~/.codex/skills`, `~/.claude/skills`, `~/.pi/agent/skills`,
 * or a project-local `.agents/skills` etc. under the cwd.
 */
export function displaySkillPath(path: string): string {
	const home = homedir();
	if (path === home) return "~";
	if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
	return path;
}

/**
 * List indexed skills as dropdown items, deduped by skill directory (a
 * frontmatter `name` alias points at the same dir as the directory name).
 * Ranks exact matches, then prefixes, then substrings; alphabetical within a
 * rank. Each item's `value` carries the `$` so applying it replaces the token;
 * the description column shows the skill's directory location plus its
 * description, sourced with Codex's own priority: `openai.yaml`
 * `interface.short-description`, then SKILL.md `metadata.short-description`,
 * then the frontmatter `description`. Descriptions are capped at 60 chars
 * (with `…`) so the picker stays compact next to the narrow name column.
 */
export function findSkillItems(index: Map<string, SkillEntry>, query: string): AutocompleteItem[] {
	const seen = new Set<string>();
	const entries: SkillEntry[] = [];
	for (const entry of index.values()) {
		if (seen.has(entry.path)) continue;
		seen.add(entry.path);
		entries.push(entry);
	}

	const lowerQuery = query.toLowerCase();
	const rank = (entry: SkillEntry): number => {
		const name = entry.displayName.toLowerCase();
		if (name === lowerQuery) return 0;
		if (name.startsWith(lowerQuery)) return 1;
		if (name.includes(lowerQuery)) return 2;
		return 3;
	};

	const filtered = lowerQuery
		? entries.filter((entry) => entry.displayName.toLowerCase().includes(lowerQuery))
		: entries;
	filtered.sort((a, b) => {
		const byRank = rank(a) - rank(b);
		if (byRank !== 0) return byRank;
		return a.displayName.localeCompare(b.displayName);
	});

	return filtered.slice(0, 50).map((entry) => {
		let detail = displaySkillPath(entry.path);
		if (entry.description) {
			const desc =
				entry.description.length > 60 ? `${entry.description.slice(0, 60)}…` : entry.description;
			detail = `${detail} — ${desc}`;
		}
		return {
			value: `$${entry.displayName}`,
			label: `$${entry.displayName}`,
			description: detail,
		};
	});
}

/**
 * Wrap the built-in autocomplete provider with `$skill` mention completion.
 * `$` is added as a trigger character, so typing `$` at a token boundary (or
 * continuing a `$token`) opens the picker; unknown `$tokens` (e.g. `$HOME` in
 * `!bash` mode) fall through to the wrapped provider, which yields nothing —
 * matching the highlight rule exactly.
 */
export function createSkillAutocompleteProvider(
	current: AutocompleteProvider,
	index: Map<string, SkillEntry>,
): AutocompleteProvider {
	return {
		triggerCharacters: ["$"],

		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const currentLine = lines[cursorLine] ?? "";
			const token = extractSkillToken(currentLine.slice(0, cursorCol));
			if (token === undefined) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const items = findSkillItems(index, token.slice(1));
			if (items.length === 0) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			return { items, prefix: token };
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			if (prefix.startsWith("$")) {
				// Replace the `$token` span with the selected mention (no trailing
				// space, so mid-sentence insertion stays clean).
				const currentLine = lines[cursorLine] ?? "";
				const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
				const afterCursor = currentLine.slice(cursorCol);
				const newLines = [...lines];
				newLines[cursorLine] = `${beforePrefix}${item.value}${afterCursor}`;
				return {
					lines: newLines,
					cursorLine,
					cursorCol: beforePrefix.length + item.value.length,
				};
			}
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

// ============================================================================
// `$skill` token highlighting
// ============================================================================

/** Same shape as Codex's `is_mention_name_char` (a-z, A-Z, 0-9, _, -). */
const SKILL_TOKEN_RE = /\$[A-Za-z0-9][A-Za-z0-9_-]*/g;

/**
 * Extract a terminal escape sequence at pos, mirroring pi-tui's
 * `extractAnsiCode`: CSI `ESC [ ... m/G/K/H/J`, OSC `ESC ] ... BEL/ST`
 * (hyperlinks), APC `ESC _ ... BEL/ST` (the editor's CURSOR_MARKER).
 */
function extractAnsiCode(line: string, pos: number): { code: string; length: number } | null {
	if (pos >= line.length || line[pos] !== "\x1b") return null;
	const next = line[pos + 1];

	if (next === "[") {
		let j = pos + 2;
		while (j < line.length && !/[mGKHJ]/.test(line[j]!)) j++;
		if (j < line.length) return { code: line.slice(pos, j + 1), length: j + 1 - pos };
		return null;
	}

	if (next === "]" || next === "_") {
		let j = pos + 2;
		while (j < line.length) {
			if (line[j] === "\x07") return { code: line.slice(pos, j + 1), length: j + 1 - pos };
			if (line[j] === "\x1b" && line[j + 1] === "\\") return { code: line.slice(pos, j + 2), length: j + 2 - pos };
			j++;
		}
		return null;
	}

	return null;
}

/** Strip ANSI from a line while recording each visible char's raw offset. */
function buildVisibleMap(line: string): { visible: string; toRaw: number[] } {
	let visible = "";
	const toRaw: number[] = [];
	let i = 0;
	while (i < line.length) {
		const ansi = extractAnsiCode(line, i);
		if (ansi) {
			i += ansi.length;
			continue;
		}
		toRaw.push(i);
		visible += line[i];
		i++;
	}
	return { visible, toRaw };
}

/**
 * Highlight every `$skill` token on a rendered editor row that resolves in the
 * index, wrapping it in the theme's per-source accent (codex-style: bold +
 * accent color). The row may already contain ANSI (cursor inversion, panel
 * fill); token boundaries are computed on the visible text and mapped back to
 * raw offsets, and the style is re-asserted after any full reset inside the
 * span so a cursor character in the middle of a token doesn't kill the rest.
 */
export function highlightSkillTokens(line: string, index: Map<string, SkillEntry>, theme: Theme): string {
	if (index.size === 0 || !line.includes("$")) return line;

	const { visible, toRaw } = buildVisibleMap(line);
	const spans: Array<{ start: number; end: number; source: SkillSource }> = [];
	SKILL_TOKEN_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = SKILL_TOKEN_RE.exec(visible)) !== null) {
		// Only standalone tokens: skip `$` that continues a word (`foo$bar`).
		if (match.index > 0 && /[A-Za-z0-9]/.test(visible[match.index - 1]!)) continue;
		const entry = index.get(match[0].slice(1).toLowerCase());
		if (!entry) continue;
		const start = toRaw[match.index]!;
		const end = toRaw[match.index + match[0].length - 1]! + 1;
		spans.push({ start, end, source: entry.source });
	}
	if (spans.length === 0) return line;

	let out = line;
	for (let s = spans.length - 1; s >= 0; s--) {
		const span = spans[s]!;
		const prefix = `\x1b[1m${theme.getFgAnsi(SKILL_SOURCE_COLORS[span.source])}`;
		const suffix = "\x1b[22m\x1b[39m";
		const token = out.slice(span.start, span.end).replace(/\x1b\[0m/g, `\x1b[0m${prefix}`);
		out = out.slice(0, span.start) + prefix + token + suffix + out.slice(span.end);
	}
	return out;
}

// ============================================================================
// Editor
// ============================================================================

export class CodexComposer extends CustomEditor {
	private piTheme: Theme;
	private skillIndex: Map<string, SkillEntry>;
	/** Last caret/token state probed by probeSkillAutocomplete (dedupe). */
	private lastAutocompleteProbe = "";

	constructor(
		tui: TUI,
		editorTheme: EditorTheme,
		keybindings: KeybindingsManager,
		theme: Theme,
		skillIndex: Map<string, SkillEntry>,
	) {
		super(tui, editorTheme, keybindings, { paddingX: PROMPT_GUTTER_COLS });
		this.piTheme = theme;
		this.skillIndex = skillIndex;

		// Narrow the primary column of the `$skill` picker. `createAutocompleteList`
		// is private on the base Editor (only `/` commands get a custom layout), so
		// shadow it with an instance property: `$` picks get our compact layout,
		// everything else (`/`, `@`, paths) keeps pi's built-in behavior.
		const baseCreateAutocompleteList = (Editor.prototype as unknown as {
			createAutocompleteList: (prefix: string, items: SelectItem[]) => SelectList;
		}).createAutocompleteList;
		(this as unknown as Record<string, unknown>).createAutocompleteList = (prefix: string, items: SelectItem[]) => {
			if (prefix.startsWith("$")) {
				const editor = this as unknown as { theme: EditorTheme; autocompleteMaxVisible: number };
				return new SelectList(items, editor.autocompleteMaxVisible, editor.theme.selectList, SKILL_SELECT_LIST_LAYOUT);
			}
			return baseCreateAutocompleteList.call(this, prefix, items);
		};

		// Re-open the `$skill` picker when the caret lands on a `$token`.
		// pi refreshes an *open* picker on cursor movement, but never re-triggers
		// one that was closed (Esc, a selection, or an edit elsewhere); moving
		// back onto a `$token` then shows nothing until the text changes. Shadow
		// moveCursor so arrowing back into a token re-runs the probe — the same
		// rule typing/backspace use (token at a boundary, `$` + name reaching the
		// caret). Movement paths that bypass moveCursor (Home/End, up/down on
		// first/last visual line, page scroll) are covered by the same probe in
		// render().
		const baseMoveCursor = (Editor.prototype as unknown as {
			moveCursor: (deltaLine: number, deltaCol: number) => void;
		}).moveCursor;
		(this as unknown as Record<string, unknown>).moveCursor = (deltaLine: number, deltaCol: number) => {
			baseMoveCursor.call(this, deltaLine, deltaCol);
			this.probeSkillAutocomplete();
		};
	}

	/**
	 * If the caret sits on a `$token` and no picker is open, re-trigger the
	 * skill autocomplete. Deduped on the caret position + token tail, so it is
	 * a no-op while the picker is open or after a no-match cancel — and it
	 * fires at most once per distinct caret position.
	 */
	probeSkillAutocomplete(): void {
		const editor = this as unknown as {
			autocompleteState: "regular" | "force" | null;
			autocompleteTriggerPattern: RegExp;
			state: { lines: string[]; cursorLine: number; cursorCol: number };
			tryTriggerAutocomplete: () => void;
		};
		if (editor.autocompleteState) return;
		const line = editor.state.lines[editor.state.cursorLine] ?? "";
		const before = line.slice(0, editor.state.cursorCol);
		if (!editor.autocompleteTriggerPattern.test(before)) return;
		const key = `${editor.state.cursorLine}:${editor.state.cursorCol}:${before.slice(-64)}`;
		if (key === this.lastAutocompleteProbe) return;
		this.lastAutocompleteProbe = key;
		editor.tryTriggerAutocomplete();
	}

	// The app syncs paddingX from user settings; keep enough left gutter for the
	// prompt no matter what it requests.
	override setPaddingX(padding: number): void {
		super.setPaddingX(Math.max(PROMPT_GUTTER_COLS, padding));
	}

	// Fill a single row with the panel background. Border `─` glyphs become
	// spaces so the former border rows read as solid top/bottom padding, while
	// any scroll-indicator text ("↑ 3 more") is preserved on the fill.
	private fillRow(line: string, width: number, bg: string): string {
		// A theme may define userMessageBg as the default terminal background
		// (""), which resolves to a bare bg reset. In that case leave the row
		// untouched instead of blanking the borders.
		if (bg === "" || bg === RESET_BG) {
			return line;
		}
		let row = line.replace(/─/g, " ");
		// A full reset (e.g. after the inverted cursor glyph) drops the
		// background, so re-assert it to keep the fill continuous.
		row = row.replace(/\x1b\[0m/g, `\x1b[0m${bg}`);
		const pad = visibleWidth(row) < width ? " ".repeat(width - visibleWidth(row)) : "";
		return `${bg}${row}${pad}${RESET_BG}`;
	}

	// Highlight `$skill` mentions on the text rows (between the top border and
	// the bottom border; autocomplete rows rendered below stay untouched).
	private highlightSkills(lines: string[], bottomBorder: number): void {
		if (this.skillIndex.size === 0 || bottomBorder < 2) return;
		for (let i = 1; i < bottomBorder; i++) {
			lines[i] = highlightSkillTokens(lines[i], this.skillIndex, this.piTheme);
		}
	}

	override render(width: number): string[] {
		// Cursor-movement fallback: probe once per frame so the picker re-opens
		// on every caret path (including Home/End and page scroll that bypass
		// moveCursor). No-op while a picker is open or the probe key is unchanged.
		this.probeSkillAutocomplete();

		const lines = super.render(width);
		if (lines.length < 2) {
			return lines;
		}

		// Same background pi uses for user messages, matching Codex's composer.
		// It is defined per theme, so dark and light themes each get a suitable
		// panel without any color math here.
		const bg = this.piTheme.getBgAnsi("userMessageBg");

		// The composer is everything up to and including the bottom border. The
		// bottom border is the last row that still contains a `─` glyph; any
		// autocomplete rows rendered after it are left untouched so the popup
		// keeps its own styling.
		let bottomBorder = lines.length - 1;
		while (bottomBorder > 0 && !lines[bottomBorder].includes("─")) {
			bottomBorder--;
		}

		// Drop the bold `❯` prompt into the left gutter of the first text row
		// (the row just below the top border), replacing one padding space so the
		// row width is unchanged. Codex renders the prompt as bold default-fg.
		// When the input starts with `!` (bash mode), pi highlights the editor
		// border with the `bashMode` theme color (green). Since we replaced the
		// border with a filled panel, we highlight the `❯` prompt instead.
		const isBashMode = this.getText().trimStart().startsWith("!");
		const prompt = isBashMode
			? this.piTheme.fg("bashMode", this.piTheme.bold(PROMPT_CHAR))
			: this.piTheme.bold(PROMPT_CHAR);
		lines[1] = `${prompt}${lines[1].slice(1)}`;

		// Fill the whole panel — top border, text rows, and bottom border. Filling
		// the top and bottom rows (not just the text) is what vertically centers
		// the text inside the panel and keeps the cursor off the top edge, matching
		// Codex's inset textarea.
		for (let i = 0; i <= bottomBorder; i++) {
			lines[i] = this.fillRow(lines[i], width, bg);
		}

		// Highlight `$skill` mentions last, after the panel fill: the fill already
		// re-asserts the background after every `\x1b[0m`, so the highlight only
		// needs to re-assert its own foreground/bold after resets.
		this.highlightSkills(lines, bottomBorder);

		// Prepend a single open row so the panel does not sit flush against the
		// widget above (e.g. the status header). Because the text is centered in
		// the filled panel below, this one row reads as a subtle gap rather than a
		// large empty band.
		lines.unshift("");

		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		// ctx.ui.theme is a live reference: it tracks runtime theme switches.
		const theme = ctx.ui.theme;
		// Index the four skill formats (agents standard / codex / claude / pi)
		// for this session's working directory, including project-local roots.
		const skillIndex = buildSkillIndex(ctx.cwd);
		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
			return new CodexComposer(tui, editorTheme, keybindings, theme, skillIndex);
		});
		// `$skill` mention picker: stack on top of pi's built-in autocomplete
		// provider, so `@` file attachments, `/` commands and path completion
		// keep working. `$` becomes a trigger character for skills only.
		ctx.ui.addAutocompleteProvider((current) => createSkillAutocompleteProvider(current, skillIndex));
	});
}

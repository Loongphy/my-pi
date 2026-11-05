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
 * Both surfaces use Codex's *neutral* surface colors, ported from
 * codex-rs/tui/src/style.rs (see CODEX_SURFACE_ALPHAS below): the composer is
 * `user_message_bg_rgb()` and submitted prompts are `history_prompt_style()`.
 * Each is a hue-free blend of the terminal's own background toward white (dark
 * terminals) or black (light terminals), with a slightly lighter fill for
 * submitted prompts. This replaces pi's built-in `userMessageBg`, which belongs
 * to the blue family (dark.json `blueBg`, and the system theme derives it from
 * ANSI slot 4) and used to paint both surfaces a blue slab.
 *
 * Only those two backgrounds change. The composer takes its color directly
 * here; pi's UserMessageComponent keeps reading `theme.bg("userMessageBg")`,
 * so we patch just that token's cached ANSI sequence on the live Theme. No
 * other theme token is rebuilt or touched, and the patch re-applies on every
 * frame so runtime theme switches keep working.
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
 * Chinese input is a first-class citizen, because Shift+4 on a Pinyin IME does
 * not produce `$`: `￥` (U+FFE5, the yuan sign the IME emits) opens the very
 * same picker, and the composer rewrites it to the canonical `$` *in place* the
 * instant the token names a skill — type `￥coss` and the `￥` flips to `$`
 * under the caret as the final `s` lands. Everything after that point
 * (highlighting, completion, undo, the submitted prompt) keeps its original
 * `$`-only logic; only the input side knows about the alias. A `￥` that does
 * not resolve is left exactly as typed, so `￥100` stays a price and `￥HOME`
 * stays a shell variable. Token boundaries are CJK-friendly too — any non-word
 * character starts a mention, since Chinese is written without spaces, so
 * `用￥coss` completes just like `用 $coss`.
 *
 * Bash mode gets the same treatment for its own Shift+1 problem: on a Pinyin
 * IME that key emits `！` (U+FF01, fullwidth exclamation) instead of `!`, so a
 * leading `！` is rewritten to the canonical `!` *in place* — `！ls` behaves
 * exactly like `!ls` (green `❯`, direct execution), and `！！`/`！!`/`!！` behave
 * like `!!` (excluded from context). Only the leading run is touched, so a
 * `！` anywhere else stays Chinese punctuation (`你好！` is never a command).
 * The command text itself is tinted with the theme's `bashMode` color, the same
 * green pi uses for the bash border (and our `❯` prompt), so a `!`/`！` command
 * reads as one mode instead of only its prompt changing color.
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
 * The index is built at session_start from ctx.cwd and is **refetchable**: it
 * rescans the skills directories when their contents change (mtime-signature,
 * throttled to once per second), so skills added mid-session appear in `$`
 * completion/highlighting without `/reload`. A `/reload` (or new session) also
 * rebuilds it. Rendering is ANSI-aware: tokens keep their highlight even when
 * the editor's inverted cursor sits on a character inside the token.
 *
 * ── 3. Fullscreen selection quoting ────────────────────────────────────────
 * In fullscreen mode pi owns mouse selection (the transcript is not the
 * terminal emulator's scrollback), and a plain drag release only copies — which
 * is all a user who just wants the clipboard needs. Pressing `Enter` while a
 * transcript selection is active turns it into a prompt quote: the selected
 * text is inserted into the composer as a Markdown blockquote (`> line`),
 * followed by a blank line, with the caret left there for the user's question.
 * The gesture mirrors grok-build's block-viewer quote (`Enter` on a selected
 * block): a blockquote clearly delimits quoted material without hiding it from
 * the model, and the trailing blank line separates the quote from the prompt.
 *
 * Any other key dismisses the selection, so a selection left over from a copy
 * action never hijacks a later Enter meant to submit the draft. Only
 * transcript selections are quoted (dragging over the composer itself is
 * ignored), and only when the composer already has focus, so a capturing
 * dialog or a detached editor is never hijacked. A non-capturing overlay (a
 * toast, extra status, etc.) does not block quoting: pi disables scroll-view
 * mapping for selections while any overlay is open, and those screen-row
 * selections are accepted when both endpoints sit above the composer. The
 * selection is read through `TuiAltScreen.getActiveSelectionText()`; pi 1.4
 * exposes only the boolean `hasActiveSelection()` / the clipboard action, so
 * the getter is called defensively and the feature simply disables itself if a
 * future pi renames it.
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
	backgroundAnsi,
	Editor,
	type EditorTheme,
	rgbColor,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	type TUI,
	matchesKey,
	visibleWidth,
} from "@earendil-works/pi-tui";

// Codex insets the textarea by two columns on the left (LIVE_PREFIX_COLS) and
// draws the prompt in that gutter. We reserve the same space via paddingX. `❯`
// (U+276F) is the heavy variant of Codex's `›` — the same shape but visually
// larger, and still a single column wide.
const PROMPT_CHAR = "❯";
const PROMPT_GUTTER_COLS = 2;

const RESET_BG = "\x1b[49m";

// ── Codex surface colors ────────────────────────────────────────────────────
// Ported from codex-rs/tui/src/style.rs. Codex gives neither the composer nor
// submitted prompts a hue of its own: both are neutral fills mixed from the
// terminal's *own* background, so they read as a subtle elevation of whatever
// theme the terminal uses instead of a colored card.
//
//   surface        dark terminal            light terminal
//   composer       blend(white, bg, .12)   blend(black, bg, .04)
//   user message   blend(white, bg, .16)   blend(black, bg, .02)
//
// The submitted prompt is a shade lighter than the editable composer in either
// appearance (Codex: "Submitted prompts use a lighter fill than the editable
// composer in either theme"). Codex quantizes with `best_color()`; pi's
// `backgroundAnsi()` does the same for truecolor / 256-color modes.
const CODEX_SURFACE_ALPHAS = {
	composer: { dark: 0.12, light: 0.04 },
	userMessage: { dark: 0.16, light: 0.02 },
} as const;

type Rgb = { r: number; g: number; b: number };

/** Codex `color.rs::is_light`: luma > 128. */
function isLightBackground(bg: Rgb): boolean {
	return 0.299 * bg.r + 0.587 * bg.g + 0.114 * bg.b > 128;
}

/** Codex `color.rs::blend`: straight sRGB interpolation, truncated like `as u8`. */
function blendToward(top: Rgb, bg: Rgb, alpha: number): Rgb {
	return {
		r: Math.trunc(top.r * alpha + bg.r * (1 - alpha)),
		g: Math.trunc(top.g * alpha + bg.g * (1 - alpha)),
		b: Math.trunc(top.b * alpha + bg.b * (1 - alpha)),
	};
}

/**
 * The terminal background pi already queried at startup (OSC 10/11). `theme`
 * is pi's live Proxy; reading `colors` makes its getter cache
 * `resolvedColors.terminal` on the underlying instance. The field is guarded
 * because a future pi may keep those colors elsewhere — in that case we fall
 * back to the same black/white guesses pi itself uses for an unreported
 * background (`GUESSED_DEFAULT_COLORS` in theme.ts).
 */
function terminalBackground(theme: Theme): Rgb {
	void theme.colors;
	const cached = (
		theme as unknown as { resolvedColors?: { terminal?: { background?: Rgb } } }
	).resolvedColors?.terminal?.background;
	if (cached && Number.isFinite(cached.r) && Number.isFinite(cached.g) && Number.isFinite(cached.b)) {
		return cached;
	}
	return theme.appearance === "light" ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
}

/** Background SGR sequence for one of Codex's two neutral surfaces. */
export function codexSurfaceAnsi(theme: Theme, surface: keyof typeof CODEX_SURFACE_ALPHAS): string {
	const bg = terminalBackground(theme);
	const light = isLightBackground(bg);
	const alpha = CODEX_SURFACE_ALPHAS[surface][light ? "light" : "dark"];
	const top = light ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
	const color = blendToward(top, bg, alpha);
	return backgroundAnsi(rgbColor(color.r, color.g, color.b), theme.getColorMode());
}

/**
 * Override only `userMessageBg`'s cached background escape sequence on the
 * live Theme, so pi's UserMessageComponent renders the second Codex surface.
 * Idempotent and self-healing: comparing against the cached value re-applies
 * the patch when pi swaps in a new Theme instance (theme switch, terminal color
 * report) without ever touching another token. HTML export colors come from
 * `theme.colors`, which is deliberately left alone.
 */
export function syncCodexUserMessageBg(theme: Theme): void {
	try {
		const bgAnsi = (theme as unknown as { bgAnsi?: Map<string, string> }).bgAnsi;
		if (!bgAnsi) return;
		const ansi = codexSurfaceAnsi(theme, "userMessage");
		if (bgAnsi.get("userMessageBg") !== ansi) bgAnsi.set("userMessageBg", ansi);
	} catch {
		// Theme not initialised yet (or a future pi changed its internals).
		// render() retries on the next frame; the composer still gets its fill.
	}
}

/**
 * Mention sigils. `$` is the canonical form; `￥` (U+FFE5, the yuan sign Pinyin
 * layouts emit for Shift+4 in Chinese mode — the IME never hands over a plain
 * `$` there) is its input alias. Both are a single UTF-16 code unit, so they
 * can be handled with the same slicing arithmetic (the editor's `cursorCol` is
 * a code-unit index, not a display width).
 *
 * `￥` is only ever an *input* alias: the moment one of them spells a skill
 * name, the composer rewrites it to `$name` in place (see
 * `CodexComposer.normalizeMentionSigils`), so everything downstream —
 * highlighting, completion, undo history, the prompt sent to the model — keeps
 * the original `$`-only rules with no foreign-sigil logic anywhere. A `￥` that
 * does not resolve (a price like `￥100`, a shell var like `￥HOME`) is left
 * exactly as typed.
 *
 * The generic fullwidth dollar `＄` (U+FF04) is deliberately not included: it
 * needs a whole-input-mode switch, and in that mode the skill name arrives
 * fullwidth too (`＄ｃｏｓｓ`), which no ASCII-only skill tokenizer can match — so
 * listing it would buy nothing.
 */
const MENTION_SIGILS = ["$", "￥"] as const;

/** Sigils that still have to be rewritten to the canonical `$`. */
const FOREIGN_SIGILS: readonly string[] = MENTION_SIGILS.slice(1);

/** Character class matching any mention sigil, for embedding in regexes. */
const SIGIL_CLASS = `[${MENTION_SIGILS.join("")}]`;

/**
 * The name part of a mention token — same shape as Codex's
 * `is_mention_name_char` (a-z, A-Z, 0-9, _, -).
 */
const MENTION_TAIL = "[A-Za-z0-9][A-Za-z0-9_-]*";

/** A full `￥name` token, for the in-place rewrite. */
const FOREIGN_SIGIL_TOKEN_RE = new RegExp(`[${FOREIGN_SIGILS.join("")}]${MENTION_TAIL}`, "g");

/** Whether `char` is a mention sigil (`$` or the `￥` input alias). */
function isMentionSigil(char: string | undefined): boolean {
	return char !== undefined && (MENTION_SIGILS as readonly string[]).includes(char);
}

/** Whether `text` starts with a mention sigil (i.e. is a `$`/`￥` token). */
function startsWithMentionSigil(text: string): boolean {
	return isMentionSigil(text[0]);
}

/** Whether `text` holds a sigil the composer still has to normalise. */
function hasForeignSigil(text: string): boolean {
	return FOREIGN_SIGILS.some((sigil) => text.includes(sigil));
}

/**
 * The token-boundary rule, shared by the highlighter and the normaliser: a
 * sigil only starts a mention when it does not continue a word, so `foo$bar`
 * (and `foo￥bar`) is never a mention. Kept deliberately narrow — letters and
 * digits only — so CJK glyphs and punctuation *do* start a token, which is what
 * Chinese text without spaces needs.
 */
function isStandaloneTokenStart(text: string, start: number): boolean {
	return start === 0 || !/[A-Za-z0-9]/.test(text[start - 1]!);
}

/**
 * Bash sigils. `!` is the canonical form; `！` (U+FF01, the fullwidth
 * exclamation a Pinyin IME emits for Shift+1 in Chinese mode — the IME never
 * hands over a plain `!` there) is its input alias. Same idea as `$`/`￥`:
 * the composer rewrites a leading `！` to `!` in place (see
 * `CodexComposer.normalizeBashSigil`), so everything downstream — bash-mode
 * detection, the green `❯` highlight, submit handling — keeps its original
 * `!`-only logic with no foreign-sigil logic anywhere.
 *
 * Only the leading run matters: pi treats input as a bash command when the
 * trimmed text starts with `!` (`!cmd` runs, `!!cmd` runs excluded from
 * context). A `！` anywhere else (e.g. `你好！`) is untouched Chinese
 * punctuation. Both sigils are a single UTF-16 code unit, so the swap keeps
 * the editor's `cursorCol` (a code-unit index, not a display width) unchanged.
 */
const BASH_SIGIL = "!";
const BASH_FOREIGN_SIGIL = "！"; // U+FF01

/** Whether trimmed text starts a bash command with either sigil. */
export function isBashModeText(text: string): boolean {
	const trimmed = text.trimStart();
	return trimmed.startsWith(BASH_SIGIL) || trimmed.startsWith(BASH_FOREIGN_SIGIL);
}

/**
 * Normalise a submit/raw string's leading run: `！ls` → `!ls`, and `！！ls` /
 * `！!ls` / `!！ls` → `!!ls`. Leading whitespace is preserved; anything past
 * the leading run (including a mid-text `！`) is left exactly as typed.
 */
export function normalizeBashSubmitText(text: string): string {
	const m = /^(\s*)([!！]+)/.exec(text);
	if (!m || !m[2]!.includes(BASH_FOREIGN_SIGIL)) return text;
	const prefix = m[1]!;
	const run = m[2]!;
	return prefix + run.replace(/！/g, BASH_SIGIL) + text.slice(prefix.length + run.length);
}

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
 * Refetchable skill index: the `Map` reference is stable for the session, but
 * its contents refresh when the skills directories change. This lets skills
 * added mid-session appear in `$` completion/highlighting without `/reload`.
 *
 * Freshness is tracked by the max mtime of each watched root dir plus a
 * short min-interval throttle, so the rescan is cheap and rare.
 */
interface RefetchableIndex {
	/** Stable index map shared by all consumers. */
	index: Map<string, SkillEntry>;
	/** Roots (global + project-local) to rescan. */
	roots: Array<{ dir: string; source: SkillSource }>;
	/** Last signature (mtimeMs) of the roots; undefined = never scanned. */
	lastSignature: string | undefined;
	/** Earliest next rescan (ms); bounds the throttle. */
	nextCheckAt: number;
}

/**
 * Per-session refetchable index registry. Each `session_start` registers a
 * fresh entry keyed by the stable `index` map; `refreshSkillIndexIfStale`
 * looks it up to rescan in place.
 */
const refetchableIndexes = new WeakMap<Map<string, SkillEntry>, RefetchableIndex>();

/** Min interval between staleness checks (ms). */
const REFRESH_MIN_INTERVAL_MS = 1000;

/**
 * Compute a cheap change-signature for the roots: the newest mtimeMs among
 * existing roots (dir + immediate child entries). Missing dirs contribute
 * nothing. Child-entry mtime covers adding a new skill dir without touching
 * the parent's mtime.
 */
function computeRootsSignature(roots: Array<{ dir: string; source: SkillSource }>): string {
	let newest = 0;
	for (const { dir } of roots) {
		try {
			const st = statSync(dir);
			if (st.mtimeMs > newest) newest = st.mtimeMs;
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (entry.name.startsWith(".")) continue;
				const full = join(dir, entry.name);
				try {
					const ms = statSync(full).mtimeMs;
					if (ms > newest) newest = ms;
				} catch {
					// ignore unreadable entries
				}
			}
		} catch {
			// root missing/unreadable — skip
		}
	}
	return String(newest);
}

/**
 * Register a refetchable index for the session. Called once at `session_start`;
 * the returned map is shared with the composer and `$` picker and refreshed
 * in place by `refreshSkillIndexIfStale`.
 */
export function createRefetchableSkillIndex(cwd: string): Map<string, SkillEntry> {
	const roots = collectSkillRoots(cwd);
	const index = new Map<string, SkillEntry>();
	rebuildSkillIndex(index, roots);
	refetchableIndexes.set(index, {
		index,
		roots,
		lastSignature: computeRootsSignature(roots),
		nextCheckAt: Date.now() + REFRESH_MIN_INTERVAL_MS,
	});
	return index;
}

/**
 * Rescan the roots into the index if anything changed (throttled).
 * No-op for indexes not created via `createRefetchableSkillIndex` (e.g. tests).
 */
export function refreshSkillIndexIfStale(index: Map<string, SkillEntry>): void {
	const ref = refetchableIndexes.get(index);
	if (!ref) return;
	const now = Date.now();
	if (now < ref.nextCheckAt) return;
	ref.nextCheckAt = now + REFRESH_MIN_INTERVAL_MS;
	const signature = computeRootsSignature(ref.roots);
	if (signature === ref.lastSignature) return;
	ref.lastSignature = signature;
	rebuildSkillIndex(index, ref.roots);
}

/** Whether `index` is a refetchable (session) index that may grow on refresh. */
function hasRefetchableRoots(index: Map<string, SkillEntry>): boolean {
	return refetchableIndexes.has(index);
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
export function collectSkillRoots(cwd: string): Array<{ dir: string; source: SkillSource }> {
	const roots: Array<{ dir: string; source: SkillSource }> = [];
	const seen = new Set<string>();

	const addDir = (dir: string, source: SkillSource): void => {
		const resolved = resolve(dir);
		if (seen.has(resolved)) return;
		seen.add(resolved);
		roots.push({ dir: resolved, source });
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

	return roots;
}

/**
 * (Re)build the skill index into `index` in place from the given roots.
 * The `index` reference is kept stable so every consumer (composer highlight,
 * `$` picker) sees refreshed contents without re-registration.
 */
export function rebuildSkillIndex(index: Map<string, SkillEntry>, roots: Array<{ dir: string; source: SkillSource }>): void {
	index.clear();
	for (const { dir, source } of roots) {
		scanSkillsDir(index, dir, source);
	}
}

export function buildSkillIndex(cwd: string): Map<string, SkillEntry> {
	const index = new Map<string, SkillEntry>();
	rebuildSkillIndex(index, collectSkillRoots(cwd));
	return index;
}

// ============================================================================
// `$skill` completion dropdown (codex-style mention picker)
// ============================================================================

/** A mention token anchored at the end of the text before the cursor. */
const SKILL_TOKEN_AT_CARET_RE = new RegExp(
	`(?:^|[^\\w])(${SIGIL_CLASS}${MENTION_TAIL}|${SIGIL_CLASS})$`,
);

/**
 * Extract a standalone mention token (`$name` or the `￥name` alias) that
 * reaches the cursor, if any. The token starts at a token boundary — start of
 * text or any non-word character, matching the highlight rule, so `foo$bar`
 * never completes while `用$bar` (CJK, no space) does. A bare sigil at the
 * cursor is a valid token (shows the full skill list, like `@` shows all
 * files).
 */
export function extractSkillToken(textBeforeCursor: string): string | undefined {
	const match = SKILL_TOKEN_AT_CARET_RE.exec(textBeforeCursor);
	return match?.[1];
}

/**
 * The clause pi's built-in trigger pattern is missing for CJK input: it only
 * starts a token after whitespace or at line start, so `用￥coss` never opens
 * the picker. This alternative mirrors {@link extractSkillToken}'s boundary
 * (any non-word character, including Chinese glyphs and punctuation) and is
 * limited to the mention sigils, leaving `@`/`#` behavior untouched.
 */
const MENTION_BOUNDARY_TRIGGER_SOURCE = `(?:[^\\s\\w])${SIGIL_CLASS}[^\\s]*$`;

/** Return `pattern` with the CJK mention boundary accepted as well. */
function withMentionBoundaryTrigger(pattern: RegExp): RegExp {
	if (pattern.source.includes(MENTION_BOUNDARY_TRIGGER_SOURCE)) return pattern;
	return new RegExp(`${pattern.source}|${MENTION_BOUNDARY_TRIGGER_SOURCE}`, pattern.flags);
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
	refreshSkillIndexIfStale(index);
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
		// `$` plus the `￥` input alias, so a Chinese IME's Shift+4 triggers exactly
		// like the ASCII sigil (pi accepts any single-code-unit character).
		triggerCharacters: [...MENTION_SIGILS],

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
			if (startsWithMentionSigil(prefix)) {
				// Replace the token span with the selected mention (no trailing
				// space, so mid-sentence insertion stays clean). `item.value` is
				// always the canonical `$name`, which also normalises a `￥` typed
				// through an IME back to `$` (before the composer's own rewrite has
				// had a chance to, i.e. while the token is still a partial match).
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

/**
 * `$mention` tokens, as the highlighter sees them. Only the canonical sigil:
 * `￥` is rewritten to `$` by the composer before a token can ever be
 * highlighted, so this stays exactly what it was before Chinese input support.
 */
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
	if (index.size === 0 && !hasRefetchableRoots(index)) return line;
	refreshSkillIndexIfStale(index);
	if (index.size === 0 || !line.includes("$")) return line;

	const { visible, toRaw } = buildVisibleMap(line);
	const spans: Array<{ start: number; end: number; source: SkillSource }> = [];
	SKILL_TOKEN_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = SKILL_TOKEN_RE.exec(visible)) !== null) {
		// Only standalone tokens: skip `$` that continues a word (`foo$bar`).
		if (!isStandaloneTokenStart(visible, match.index)) continue;
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

/**
 * Tint a whole editor row with the theme's `bashMode` color — the same green
 * pi paints the editor border with in bash mode, and the same token the `❯`
 * prompt uses. Bash mode is all-or-nothing (it starts at the first `!` and
 * applies to the entire input), so unlike a `$skill` mention this colors the
 * whole row, leading `!`/`!!` included.
 *
 * The panel fill runs before this, so the row may already end with a background
 * reset; a foreground reset does not clear the background, and the suffix
 * restores the default foreground without touching it. The row can also carry
 * its own foreground sequences (the prompt is styled separately), so both full
 * resets and foreground resets re-assert the tint — otherwise the prompt's
 * trailing `\x1b[39m` would leave the command itself in the default color.
 */
export function highlightBashText(line: string, theme: Theme): string {
	const fg = theme.getFgAnsi("bashMode");
	const body = line.replace(/\x1b\[(?:0|39)m/g, (reset) => `${reset}${fg}`);
	return `${fg}${body}\x1b[39m`;
}

// ============================================================================
// Fullscreen selection quoting
// ============================================================================

/**
 * Format a transcript selection as a Markdown blockquote, following
 * grok-build's `format_blockquote` (`> line`, with a bare `>` for a blank
 * line). Trailing newlines are dropped so a selection ending at a line break
 * does not produce an extra empty quote line.
 */
export function formatSelectionQuote(text: string): string {
	const normalized = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
	if (normalized.length === 0) return "";
	return normalized
		.split("\n")
		.map((line) => (line.length === 0 ? ">" : `> ${line}`))
		.join("\n");
}

/** One endpoint of `TuiAltScreen`'s private selection state. */
interface FullscreenSelectionPoint {
	row: number;
	col: number;
	boundary?: boolean;
	scrollView?: unknown;
}

/** Minimal shape of `TuiAltScreen`'s private layout boxes. */
interface LayoutBoxLike {
	component?: unknown;
	rect: { x: number; y: number; width: number; height: number };
	children?: LayoutBoxLike[];
}

/**
 * The part of `TuiAltScreen` this feature reads. `getActiveSelectionText`,
 * `resetTextSelection`, `selectionPressActive`, `selectionAnchor`,
 * `selectionFocus`, and `currentLayout` are private in pi 1.4 — the public
 * surface only has `hasActiveSelection()` and the clipboard action — so all of
 * them are optional and the feature degrades to a no-op if they disappear.
 */
interface FullscreenSelectionTui extends TUI {
	getActiveSelectionText?(): string | undefined;
	resetTextSelection?(): void;
	flash?(message: string, durationMs?: number): void;
	selectionPressActive?: boolean;
	selectionAnchor?: FullscreenSelectionPoint;
	selectionFocus?: FullscreenSelectionPoint;
	/** Private layout frame; used to locate the composer on screen. */
	currentLayout?: { root?: LayoutBoxLike };
}

/** Whether `root` is `target` or contains it in its component child tree. */
function componentContains(root: unknown, target: unknown): boolean {
	if (root === target) return true;
	const children = (root as { children?: unknown[] } | undefined)?.children;
	if (!Array.isArray(children)) return false;
	return children.some((child) => componentContains(child, target));
}

/**
 * Top row (0-based) of the editor slot containing `component` in the current
 * fullscreen layout. The composer itself is not a layout leaf (it lives inside
 * the editor `Container`), so find the deepest layout box whose component
 * subtree contains it. Taking the greatest `y` skips the dock/root ancestors
 * and lands on the editor slot.
 */
function findComponentTop(tui: TUI, component: unknown): number | undefined {
	const root = (tui as FullscreenSelectionTui).currentLayout?.root;
	if (!root) return undefined;
	let top: number | undefined;
	const stack: LayoutBoxLike[] = [root];
	while (stack.length > 0) {
		const box = stack.pop()!;
		if (box.component !== undefined && componentContains(box.component, component)) {
			if (top === undefined || box.rect.y > top) top = box.rect.y;
		}
		if (box.children) stack.push(...box.children);
	}
	return top;
}

interface TranscriptSelectionRefs {
	anchor: FullscreenSelectionPoint;
	focus: FullscreenSelectionPoint;
}

/** Whether the endpoints describe a non-empty range (not a plain click). */
function hasSelectionRange(refs: TranscriptSelectionRefs): boolean {
	return refs.anchor.row !== refs.focus.row || refs.anchor.col !== refs.focus.col;
}

/**
 * The endpoints of a released fullscreen transcript selection, if there is
 * one. In-progress drags, composer selections, and selections spanning
 * different scroll views have no quotable transcript range and return
 * undefined.
 *
 * When any overlay is open, `TuiAltScreen` deliberately disables scroll-view
 * mapping for selections (`scrollView` is undefined) and reconstructs text
 * from screen rows instead. Accept those selections only when both endpoints
 * sit above the composer, which keeps transcript quoting working with a
 * non-capturing overlay (toast, extra status, etc.) while still rejecting
 * selections made inside the composer itself.
 */
function readTranscriptSelectionRefs(tui: TUI, composer?: unknown): TranscriptSelectionRefs | undefined {
	if (tui.mode !== "fullscreen") return undefined;
	const fullscreen = tui as FullscreenSelectionTui;
	if (fullscreen.selectionPressActive !== false) return undefined;
	const anchor = fullscreen.selectionAnchor;
	const focus = fullscreen.selectionFocus;
	if (!anchor || !focus) return undefined;

	if (anchor.scrollView) {
		return anchor.scrollView === focus.scrollView ? { anchor, focus } : undefined;
	}

	const composerTop = composer === undefined ? undefined : findComponentTop(tui, composer);
	if (composerTop === undefined) return undefined;
	if (anchor.row >= composerTop || focus.row >= composerTop) return undefined;
	return { anchor, focus };
}

/** Read the text of a released fullscreen transcript selection, if any. */
function readTranscriptSelection(tui: TUI, composer?: unknown): string | undefined {
	if (!readTranscriptSelectionRefs(tui, composer)) return undefined;
	const fullscreen = tui as FullscreenSelectionTui;
	const read = fullscreen.getActiveSelectionText;
	if (typeof read !== "function") return undefined;

	const text = read.call(tui);
	return typeof text === "string" && text.trim().length > 0 ? text : undefined;
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
			if (startsWithMentionSigil(prefix)) {
				const editor = this as unknown as { theme: EditorTheme; autocompleteMaxVisible: number };
				return new SelectList(items, editor.autocompleteMaxVisible, editor.theme.selectList, SKILL_SELECT_LIST_LAYOUT);
			}
			return baseCreateAutocompleteList.call(this, prefix, items);
		};

		// Accept a mention token that starts after a non-word character, so CJK
		// text (`用￥coss`, `，$coss`) triggers the picker even though Chinese is
		// written without spaces. pi rebuilds this private field on every
		// `setAutocompleteProvider()` (which the app calls again whenever a
		// provider is added), so intercept the assignment instead of patching it
		// once: every pattern the base class installs gets the extra clause.
		let triggerPattern = withMentionBoundaryTrigger(
			(this as unknown as { autocompleteTriggerPattern: RegExp }).autocompleteTriggerPattern,
		);
		Object.defineProperty(this, "autocompleteTriggerPattern", {
			configurable: true,
			get: () => triggerPattern,
			set: (pattern: RegExp) => {
				triggerPattern = withMentionBoundaryTrigger(pattern);
			},
		});

		// Rewrite a resolvable `￥name` to `$name` (and a leading `！` to `!`)
		// while the keystroke is still being handled. pi calls `onChange` from
		// inside every text mutation and *before* the autocomplete trigger check,
		// so shadowing the field with an accessor lets the swap happen mid-edit:
		// the picker, the highlighter, the undo snapshots and the submitted prompt
		// only ever see the canonical `$token` / `!` form, and the app's own
		// handler is called with the corrected text.
		let appOnChange: ((text: string) => void) | undefined;
		const changeHook = (text: string): void => {
			// Normalise first, and never inside the optional call below: `?.` short
			// circuits the whole call *expression*, arguments included, so an app
			// that never assigns `onChange` would silently disable the rewrite.
			const changedMention = this.normalizeMentionSigils();
			const changedBash = this.normalizeBashSigil();
			const next = changedMention || changedBash ? this.getText() : text;
			// Keep the receiver pi had when calling `this.onChange(...)`, in case its
			// handler is a regular function that reads `this`.
			appOnChange?.call(this, next);
		};
		Object.defineProperty(this, "onChange", {
			configurable: true,
			enumerable: true,
			get: () => changeHook,
			set: (handler: ((text: string) => void) | undefined) => {
				appOnChange = handler;
			},
		});

		// Same alias idea for bash mode: a leading `！` (Shift+1 in Chinese
		// mode) must execute exactly like `!`. The `onChange` rewrite above
		// already flips `state.lines` in place, so by submit time there is
		// usually nothing left to do — but text that arrives without a change
		// notification (or a race between the last keystroke and Enter) would
		// still reach pi core as `！cmd` and miss its `startsWith("!")` check.
		// Shadowing `onSubmit` closes that gap: the app handler always sees
		// the canonical `!`/`!!` prefix, while history keeps the canonical form.
		let appOnSubmit: ((text: string) => unknown) | undefined;
		const submitHook = (text: string): unknown => {
			const next = normalizeBashSubmitText(text);
			return appOnSubmit?.call(this, next);
		};
		Object.defineProperty(this, "onSubmit", {
			configurable: true,
			enumerable: true,
			get: () => submitHook,
			set: (handler: ((text: string) => unknown) | undefined) => {
				appOnSubmit = handler;
			},
		});

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
	 * Swap a fullwidth mention sigil for the canonical `$` the instant the token
	 * under it names an indexed skill — `￥coss` becomes `$coss` as the last `s`
	 * is typed, with the caret untouched. The rewrite is one code unit for one,
	 * on the same line, at the same offsets, so cursor position, visual layout
	 * and every other rule (highlight, completion, submit) stay byte-for-byte
	 * what they were for `$`. Tokens that do not resolve are left alone, so
	 * `￥100` stays a price and `￥HOME` stays a shell variable; the boundary rule
	 * is the highlighter's own, so `foo￥coss` is not mangled either.
	 *
	 * Returns whether anything changed. Driven from `onChange` (every typed and
	 * pasted edit) and once per frame from `render()` as a safety net for text
	 * that arrives without a change notification (programmatic `setText`, draft
	 * restore, undo) — which also picks up skills added mid-session.
	 */
	normalizeMentionSigils(): boolean {
		if (this.skillIndex.size === 0 && !hasRefetchableRoots(this.skillIndex)) return false;
		refreshSkillIndexIfStale(this.skillIndex);
		const editor = this as unknown as { state: { lines: string[] } };
		const lines = editor.state.lines;
		let changed = false;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]!;
			if (!hasForeignSigil(line)) continue;
			const rewritten = line.replace(FOREIGN_SIGIL_TOKEN_RE, (token, offset: number, whole: string) => {
				if (!isStandaloneTokenStart(whole, offset)) return token;
				return this.skillIndex.has(token.slice(1).toLowerCase()) ? `$${token.slice(1)}` : token;
			});
			if (rewritten !== line) {
				lines[i] = rewritten;
				changed = true;
			}
		}
		return changed;
	}

	/**
	 * Swap a leading fullwidth bash sigil for the canonical `!` — `！ls`
	 * becomes `!ls` as soon as the `！` lands, with the caret untouched. The
	 * rewrite is one code unit for one, on the first content line, at the same
	 * offsets, so cursor position and every other rule (bash-mode highlight,
	 * submit, undo, history) stay exactly what they were for `!`. The leading
	 * run is converted wholesale, so `！！` / `！!` / `!！` all become `!!`
	 * (excluded from context), mirroring pi core's `!` vs `!!` split. Only the
	 * first non-blank line's leading run is touched, so a mid-text `！` (Chinese
	 * punctuation like `你好！`) is never mangled.
	 *
	 * Returns whether anything changed. Driven from `onChange` (every typed and
	 * pasted edit) and once per frame from `render()` as a safety net for text
	 * that arrives without a change notification (programmatic `setText`, draft
	 * restore, undo) — the same pattern as `normalizeMentionSigils`.
	 */
	normalizeBashSigil(): boolean {
		const editor = this as unknown as { state: { lines: string[] } };
		const lines = editor.state.lines;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]!;
			if (line.trim() === "") continue;
			// First content line: normalise its leading `!`/`！` run, if foreign.
			const m = /^(\s*)([!！]+)/.exec(line);
			if (!m || !m[2]!.includes(BASH_FOREIGN_SIGIL)) return false;
			const prefix = m[1]!;
			const run = m[2]!;
			lines[i] = prefix + run.replace(/！/g, BASH_SIGIL) + line.slice(prefix.length + run.length);
			return true;
		}
		return false;
	}

	/**
	 * Enter with a fullscreen transcript selection quotes it into the composer
	 * as a Markdown blockquote, instead of submitting the draft. A plain mouse
	 * drag still only copies (pi's copy-on-select), so selecting text for the
	 * clipboard is never turned into a prompt quote by accident.
	 */
	override handleInput(data: string): void {
		const tui = this.tui;
		// `\n` is Shift+Enter / Ctrl+J (newline) in the editor's own parser even
		// when the legacy key matcher also calls it Enter; never turn that into a
		// quote.
		if (
			tui.mode === "fullscreen" &&
			data !== "\n" &&
			matchesKey(data, "enter") &&
			!this.isShowingAutocomplete()
		) {
			const refs = readTranscriptSelectionRefs(tui, this);
			if (refs && hasSelectionRange(refs)) {
				if (this.quoteFullscreenSelection()) return;

				// There is a visible selection but no quotable text (blank line,
				// whitespace-only, or a transient layout read failure). Never fall
				// through to submit the draft: swallow the Enter and drop the
				// selection so the next Enter behaves normally.
				const fullscreen = tui as FullscreenSelectionTui;
				fullscreen.resetTextSelection?.();
				fullscreen.flash?.("Could not quote selection");
				tui.requestRender();
				return;
			}
		}

		super.handleInput(data);

		// Any other key dismisses the transcript selection. This is what keeps a
		// selection made for copying from hijacking a later Enter: typing a
		// question removes the selection, so Enter submits the draft. Clearing
		// after `super` leaves app actions such as Ctrl+X able to read the
		// selection synchronously first.
		if (tui.mode === "fullscreen" && readTranscriptSelectionRefs(tui, this)) {
			(tui as FullscreenSelectionTui).resetTextSelection?.();
		}
	}

	/**
	 * Quote the current fullscreen transcript selection into the composer and
	 * leave the caret on the blank line after it, ready for the user's question.
	 * Returns true when a quote was inserted (so the Enter is swallowed).
	 *
	 * The composer must already be focused: selection over the transcript does
	 * not move focus, so this is true in the normal prompt workflow, while an
	 * open dialog (which should keep the quote out of the editor) fails it.
	 */
	private quoteFullscreenSelection(): boolean {
		// Focus is the right gate: a capturing overlay/dialog has already taken
		// keyboard focus, while a non-capturing overlay (a toast, extra status,
		// etc.) does not block the composer and must not disable quoting.
		if (!this.focused) return false;
		const tui = this.tui;
		if (tui.mode !== "fullscreen") return false;

		const text = readTranscriptSelection(tui, this);
		if (!text) return false;
		const quote = formatSelectionQuote(text);
		if (!quote) return false;

		// Keep the quote on its own line when the caret sits mid-line, and add a
		// blank line after it (grok-build does the same) so the user can type the
		// actual question without deleting anything.
		const prefix = this.getCursor().col > 0 ? "\n" : "";
		this.insertTextAtCursor(`${prefix}${quote}\n\n`);

		// The quote is now in the composer; drop the transcript highlight so the
		// gesture reads as consumed and the next Enter submits normally.
		(tui as FullscreenSelectionTui).resetTextSelection?.();

		// Selection does not normally steal focus, but make the "focus back in
		// the editor" guarantee explicit and refresh the panel.
		tui.setFocus(this);
		tui.requestRender();
		return true;
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
		// Normalise before the rows are produced, so a `￥token` / leading `！`
		// that never went through `onChange` still renders (and behaves) as a
		// plain `$token` / `!` command.
		this.normalizeMentionSigils();
		this.normalizeBashSigil();

		// Cursor-movement fallback: probe once per frame so the picker re-opens
		// on every caret path (including Home/End and page scroll that bypass
		// moveCursor). No-op while a picker is open or the probe key is unchanged.
		this.probeSkillAutocomplete();

		const lines = super.render(width);
		if (lines.length < 2) {
			return lines;
		}

		// Codex's two neutral surfaces. The composer takes its own (darker)
		// fill here instead of pi's blue `userMessageBg`; submitted user
		// messages get the lighter one via the token patch below.
		syncCodexUserMessageBg(this.piTheme);
		const bg = codexSurfaceAnsi(this.piTheme, "composer");

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
		// border with a filled panel, the `❯` prompt and the command text below
		// carry that color instead. `isBashModeText` also accepts the `！` alias,
		// so both light up even on the very first frame before the in-place
		// rewrite lands.
		const isBashMode = isBashModeText(this.getText());
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

		// Highlight the text rows last, after the panel fill so nothing in a row
		// can drop the inline color. For `$skill` mentions, the fill has already
		// re-asserted the background after every `\x1b[0m`, so the highlight only
		// needs to re-assert its own foreground/bold after resets.
		// Bash mode is a whole-composer mode, so its rows get the `bashMode` tint
		// (same color as the `❯` prompt and pi's bash border). `$skill` mentions are
		// model-prompt syntax, so they are not highlighted inside a shell command:
		// `!echo $coss` stays one uniform command color instead of lighting up a
		// shell variable that happens to share a skill's name.
		if (isBashMode) {
			for (let i = 1; i < bottomBorder; i++) {
				lines[i] = highlightBashText(lines[i], this.piTheme);
			}
		} else {
			this.highlightSkills(lines, bottomBorder);
		}

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
		// Patch `userMessageBg` before the first frame so replayed history is
		// already Codex-colored; render() keeps it in sync afterwards.
		syncCodexUserMessageBg(theme);
		// Index the four skill formats (agents standard / codex / claude / pi)
		// for this session's working directory, including project-local roots.
		// Refetchable: new skills added mid-session show up without `/reload`.
		const skillIndex = createRefetchableSkillIndex(ctx.cwd);
		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
			return new CodexComposer(tui, editorTheme, keybindings, theme, skillIndex);
		});
		// `$skill` mention picker: stack on top of pi's built-in autocomplete
		// provider, so `@` file attachments, `/` commands and path completion
		// keep working. `$` becomes a trigger character for skills only.
		ctx.ui.addAutocompleteProvider((current) => createSkillAutocompleteProvider(current, skillIndex));
	});
}

/**
 * Codex Composer - restyles the pi input area to match the Codex CLI composer.
 *
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
 * Usage: pi --extension ./examples/extensions/codex-composer.ts
 */

import { CustomEditor, type ExtensionAPI, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { type EditorTheme, type TUI, visibleWidth } from "@earendil-works/pi-tui";

// Codex insets the textarea by two columns on the left (LIVE_PREFIX_COLS) and
// draws the prompt in that gutter. We reserve the same space via paddingX. `❯`
// (U+276F) is the heavy variant of Codex's `›` — the same shape but visually
// larger, and still a single column wide.
const PROMPT_CHAR = "❯";
const PROMPT_GUTTER_COLS = 2;

const RESET_BG = "\x1b[49m";

class CodexComposer extends CustomEditor {
	private piTheme: Theme;

	constructor(tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager, theme: Theme) {
		super(tui, editorTheme, keybindings, { paddingX: PROMPT_GUTTER_COLS });
		this.piTheme = theme;
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

	override render(width: number): string[] {
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
		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
			return new CodexComposer(tui, editorTheme, keybindings, theme);
		});
	});
}

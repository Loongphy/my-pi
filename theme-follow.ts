/**
 * theme-follow — live light/dark following on terminals that do not send color-scheme reports.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * pi's `system` theme is generated from the terminal's reported colors (OSC 10/11/4). It re-queries
 * those colors on startup, on `/reload`, and when the terminal sends a `CSI ?997;1n|2n` report
 * (DECSET 2031). There is deliberately no polling: pi#5874 ("No desire to bypass the terminal API
 * for that"), and pi#4427 declined a `theme_changed` extension event.
 *
 * Windows Terminal does not implement DECSET 2031 (microsoft/terminal#18375 is still open;
 * PR #20335 was rejected on 2026-07-31 with: "applications should be able to figure out the
 * prevailing color scheme background with an xterm color resource query (11;?) and make lightness
 * decisions based on that"). It *does* answer OSC 4/10/11 queries since 1.22, including after a
 * scheme flip. So on Windows Terminal (+ WSL/ConPTY) pi never re-queries and keeps the startup
 * palette forever.
 *
 * This extension implements exactly the rejected PR's advice: it re-issues the terminal color
 * query at a low rate, and when the answer changes it feeds the new colors back into pi's live
 * theme and asks pi to rebuild the system theme. Nothing is written to the terminal except the
 * standard OSC queries pi itself already uses; no Windows registry, no WT settings parsing, no
 * assumption about the OS or the emulator.
 *
 * ── How it stays cheap ──────────────────────────────────────────────────────
 * - The first query is delayed so pi's own 100 ms startup query finishes first.
 * - Only one query is in flight at a time; queries are spaced POLL_MS apart.
 * - A query whose answer equals pi's current colors is a no-op (no theme rebuild, no repaint).
 * - After several consecutive empty replies (a terminal that cannot answer OSC 10/11/4) polling
 *   stops rather than accumulating pending queries that could leak replies into the input stream.
 *
 * ── Configuration (environment variables) ──────────────────────────────────
 *   PI_THEME_FOLLOW=off                 disable entirely
 *   PI_THEME_FOLLOW_POLL_MS=3000       interval between queries (0 = disable)
 *   PI_THEME_FOLLOW_DELAY_MS=2000      delay before the first query
 *   PI_THEME_FOLLOW_TIMEOUT_MS=150     per-query timeout (matches pi's own 100 ms)
 *
 * ── Caveats ────────────────────────────────────────────────────────────────
 * - Only active while the current theme is `system`. Explicit themes and `light/dark` pairs are
 *   left alone, because forcing `setTheme("system")` would overwrite the user's setting.
 * - `Theme.resolvedColors.terminal` is a private field. It is the same object reference pi's
 *   theme module holds in `terminalColors`, so mutating it in place (never replacing it) makes a
 *   subsequent `setTheme("system")` regenerate every token from the new colors. If a future pi
 *   changes that layout, the extension disables itself instead of breaking.
 * - `setTheme("system")` may persist `"theme": "system"` into settings.json for users who never
 *   set a theme explicitly. That is exactly pi's default, and this repo already sets it.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, RgbColor, TerminalColors, TUI } from "@earendil-works/pi-tui";

const WIDGET_KEY = "theme-follow.capture";
const EMPTY_COMPONENT: Component = { render: () => [], invalidate: () => {} };

const SYSTEM_THEME = "system";
const MAX_EMPTY_REPLIES = 3;

function intEnv(name: string, fallback: number, min: number): number {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	const value = Number(raw);
	return Number.isFinite(value) && value >= min ? value : fallback;
}

const DISABLED = process.env.PI_THEME_FOLLOW === "off" || process.env.PI_THEME_FOLLOW === "0";
const POLL_MS = intEnv("PI_THEME_FOLLOW_POLL_MS", 3000, 0);
const START_DELAY_MS = intEnv("PI_THEME_FOLLOW_DELAY_MS", 2000, 0);
const QUERY_TIMEOUT_MS = intEnv("PI_THEME_FOLLOW_TIMEOUT_MS", 150, 50);

// ── Color comparison ────────────────────────────────────────────────────────

type MutableTerminalColors = {
	foreground?: RgbColor;
	background?: RgbColor;
	palette?: RgbColor[];
};

/** The shape of pi's live `Theme` proxy that this extension relies on. */
export interface ThemeLike {
	name?: string;
	colors?: unknown;
	resolvedColors?: { terminal?: MutableTerminalColors };
}

function sameRgb(a: RgbColor | undefined, b: RgbColor | undefined): boolean {
	if (a === b) return true;
	return !!a && !!b && a.r === b.r && a.g === b.g && a.b === b.b;
}

function samePalette(a: RgbColor[] | undefined, b: RgbColor[] | undefined): boolean {
	if (a === b) return true;
	if (!a || !b || a.length !== b.length) return false;
	return a.every((color, index) => sameRgb(color, b[index]));
}

function sameColors(a: MutableTerminalColors, b: MutableTerminalColors): boolean {
	return (
		sameRgb(a.foreground, b.foreground) &&
		sameRgb(a.background, b.background) &&
		samePalette(a.palette, b.palette)
	);
}

export interface SyncResult {
	applied: boolean;
	reason: "applied" | "not-system" | "no-resolved-colors" | "empty-report" | "unchanged";
}

/**
 * Feed a fresh OSC 10/11/4 answer into pi's live theme and rebuild the `system` theme when it
 * changed. Exported as a pure function so it can be exercised without a TTY.
 *
 * `setTheme` is called (rather than mutating the Theme instance directly) because pi's
 * `createSystemTheme()` reads the module-level `terminalColors` object we just mutated in place;
 * `setTheme("system")` also invalidates the whole component tree, which is what makes cached
 * user messages, tool rows and composer surfaces repaint with the new palette.
 */
export function syncThemeFromTerminalColors(
	theme: ThemeLike,
	reported: TerminalColors,
	setTheme: (name: string) => void,
): SyncResult {
	if (theme.name && theme.name !== SYSTEM_THEME) return { applied: false, reason: "not-system" };
	if (!reported.foreground && !reported.background && !reported.palette) {
		return { applied: false, reason: "empty-report" };
	}

	// `theme.colors` is a getter that builds `resolvedColors` on first access. Do not skip this:
	// without it `resolvedColors` is undefined and there is no object to mutate.
	void theme.colors;
	const terminal = theme.resolvedColors?.terminal;
	if (!terminal) return { applied: false, reason: "no-resolved-colors" };

	// Same field-wise merge as pi's own `applyTerminalColors()`: a partial reply must not erase a
	// previously reported background. The background is what decides light/dark, so require it.
	const next: MutableTerminalColors = {
		foreground: reported.foreground ?? terminal.foreground,
		background: reported.background ?? terminal.background,
		palette: reported.palette ?? terminal.palette,
	};
	if (!next.background) return { applied: false, reason: "empty-report" };
	if (sameColors(terminal, next)) return { applied: false, reason: "unchanged" };

	// In-place on purpose: pi holds this very object in its module-scope `terminalColors`.
	Object.assign(terminal, next);
	setTheme(SYSTEM_THEME);
	return { applied: true, reason: "applied" };
}

// ── TUI capture ─────────────────────────────────────────────────────────────

/**
 * Extension widget factories are invoked synchronously with the active TUI. Mount a zero-line
 * widget for one call and remove it immediately (same trick as `shortcuts.ts`), so this extension
 * adds nothing to the screen and does not compete with other widgets.
 */
function captureTui(ctx: ExtensionContext): TUI | undefined {
	let captured: TUI | undefined;
	try {
		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui) => {
				captured = tui;
				return EMPTY_COMPONENT;
			},
			{ placement: "belowEditor" },
		);
	} catch {
		return undefined;
	} finally {
		try {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		} catch {
			// TUI shutting down; `captured` below decides whether we can continue.
		}
	}
	return captured;
}

// ── Poll loop ───────────────────────────────────────────────────────────────

function startFollowing(ctx: ExtensionContext): (() => void) | undefined {
	if (POLL_MS <= 0 || DISABLED) return undefined;
	if (ctx.mode !== "tui" || !ctx.hasUI) return undefined;

	const theme = ctx.ui.theme as unknown as ThemeLike;
	if (theme.name && theme.name !== SYSTEM_THEME) return undefined;

	const tui = captureTui(ctx);
	if (!tui) return undefined;

	const setTheme = (name: string): void => {
		ctx.ui.setTheme(name);
	};

	let disposed = false;
	let inFlight = false;
	let emptyReplies = 0;
	let startTimer: ReturnType<typeof setTimeout> | undefined;
	let interval: ReturnType<typeof setInterval> | undefined;

	const stop = (): void => {
		if (disposed) return;
		disposed = true;
		if (startTimer) clearTimeout(startTimer);
		if (interval) clearInterval(interval);
	};

	const applyUnsafe = (reported: TerminalColors): void => {
		if (!reported.background) {
			// A timed-out or ConPTY-truncated query. Do not accumulate pending queries forever.
			emptyReplies++;
			if (emptyReplies >= MAX_EMPTY_REPLIES) {
				// Terminal did not answer OSC 10/11/4; PI_THEME_FOLLOW=off silences it.
				stop();
			}
			return;
		}
		emptyReplies = 0;

		const result = syncThemeFromTerminalColors(ctx.ui.theme as unknown as ThemeLike, reported, setTheme);
		if (result.reason === "no-resolved-colors") {
			// pi's Theme.resolvedColors layout changed; the extension needs updating.
			stop();
		}
	};

	const apply = (reported: TerminalColors): void => {
		if (disposed) return;
		try {
			applyUnsafe(reported);
		} catch {
			// A theme torn down by a concurrent /reload must never reject the poll promise.
		}
	};

	const tick = (): void => {
		if (disposed || inFlight) return;
		inFlight = true;
		let released = false;
		const release = (): void => {
			if (!released) {
				released = true;
				inFlight = false;
			}
		};
		try {
			void tui
				.queryTerminalColors({
					timeoutMs: QUERY_TIMEOUT_MS,
					// Replies arriving after the timeout still carry the new palette.
					onLateReply: (late) => apply(late),
				})
				.then(
					(colors) => apply(colors),
					() => {},
				)
				.finally(release);
		} catch {
			release();
		}
	};

	startTimer = setTimeout(() => {
		if (disposed) return;
		tick();
		interval = setInterval(tick, POLL_MS);
	}, START_DELAY_MS);

	return () => stop();
}

export default function (pi: ExtensionAPI): void {
	let stop: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		// `/reload` fires session_start again on the same module instance.
		stop?.();
		stop = startFollowing(ctx);
	});

	pi.on("session_shutdown", () => {
		stop?.();
		stop = undefined;
	});
}

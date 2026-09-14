/**
 * thinking-level
 *
 * One extension for everything about thinking (reasoning) levels. Two parts:
 *
 * 1. MEMORY — remembers the level you last chose per model and restores it when
 *    you switch back to that model (`/model`, the model selector, model
 *    cycling) and when a fresh session starts (`/new`, process startup).
 *    pi keeps a single session-wide level and only clamps it to the
 *    new model's capabilities, so switching from a model that tops out at
 *    `high` to one that supports `max` leaves you at the inherited `high`.
 *    Likewise a fresh session (`/new`, startup) resolves its level purely
 *    from pi's own settings (`modelThinkingLevels` → `defaultThinkingLevel`)
 *    and never emits `model_select` when the model is unchanged — so without
 *    a `session_start` hook the memory would never be applied there.
 *    This fixes both:
 *      - Model WITH a remembered level → that level is restored (pi clamps it if
 *        the model no longer supports it, so it degrades gracefully).
 *      - Model WITHOUT a remembered level → the level is raised to the highest
 *        level that model supports, whenever the current level is below it. If
 *        it is already at the new model's ceiling, it is left untouched.
 *      - Explicit scoped-model levels (`--models model:level`) are the fallback
 *        for models without a memory. Priority: remembered → scoped → maximum.
 *      - Manually setting a level on a model always updates its memory.
 *
 * 2. /model DISPLAY — shows which levels a model supports on the name line of
 *    pi's built-in model picker, so you can see what a model can do with
 *    thinking *before* selecting it:
 *
 *        Model Name: MiMo V2.5 Free · reasoning: off minimal low medium high
 *        Model Name: Kimi K3 · reasoning: low high max
 *        Model Name: Qwen3 Coder Next · no reasoning
 *
 *    The list comes from pi's own `getSupportedThinkingLevels(model)` — the very
 *    same function behind the `/thinking` options and the level clamp on switch
 *    — so it can never disagree with what pi will actually accept. A model that
 *    cannot think (reasoning: false, or every level nulled out in its
 *    thinkingLevelMap) says `· no reasoning` instead of listing levels. The
 *    level you are currently on is highlighted in pi's "success" colour — the
 *    same colour as the `Model catalogs refreshed.` line below it — but only
 *    while the highlighted row *is* the current model.
 *
 *    pi exports no colour helpers and does not export its live `theme`
 *    singleton, so every colour and reset this extension emits is read back out
 *    of pi's own freshly rendered text instead of being hardcoded: the
 *    highlight comes from pi's success-coloured text (the current-model `✓`, or
 *    the refresh status line), falling back to pi's accent colour (the
 *    selected-row `→`), and the closing sequence is the reset pi itself put on
 *    the line. Nothing is emitted on a render that offers neither, so the
 *    highlight follows whatever theme is live, including auto dark/light
 *    switching.
 *
 *    `/model` is a built-in interactive command — it is handled directly by the
 *    editor's submit handler, before extension commands and before the `input`
 *    event, so it cannot be replaced by registering a command of the same name
 *    (pi suffixes conflicting extension commands instead). The selector
 *    component itself, `ModelSelectorComponent`, IS exported by
 *    `@earendil-works/pi-coding-agent`, and extensions import the very same
 *    module instance the running app uses. So the extension wraps its
 *    `updateList` method: after pi rebuilds the list, the footer "Model Name:"
 *    Text child is rewritten. Every selection change, search keystroke and
 *    catalog refresh goes through `updateList`, so the line stays in sync for
 *    free. If pi ever renames or removes the method, or the footer line changes
 *    shape, the wrapper finds nothing to rewrite and `/model` keeps working
 *    untouched — the extension reports that it could not attach.
 *
 *    The wrapper is installed once per process and reads its configuration from
 *    a `globalThis` registry, so `/reload` (which re-evaluates this module)
 *    neither stacks wrappers nor leaves a stale toggle behind.
 *
 * No commands and no switches — the point of installing this is to see the
 * levels, so the display is always on. The only thing it writes is
 * ~/.pi/agent/thinking-level-memory.json (`${provider}/${modelId}` → level). If
 * pi's selector internals ever change so the display cannot be attached, the
 * extension says so once at session start instead of failing silently.
 *
 * Install: add "./thinking-level.ts" to the `pi.extensions` list in
 * ~/.pi/agent/extensions/package.json, then /reload.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import {
	getAgentDir,
	ModelSelectorComponent,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Spacer, stripTerminalSequences, Text } from "@earendil-works/pi-tui";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const VALID_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const MEMORY_FILE_NAME = "thinking-level-memory.json";

// ===========================================================================
// Shared helpers
// ===========================================================================

/** Levels the model supports, ordered off → minimal → … → max. */
function levelsFor(model: Model<any>): ThinkingLevel[] {
	return getSupportedThinkingLevels(model) as ThinkingLevel[];
}

/** Highest level the model supports (levelsFor is ordered, so the last wins). */
function maxThinkingLevel(model: Model<any>): ThinkingLevel {
	const levels = levelsFor(model);
	return levels[levels.length - 1] ?? "off";
}

function isValidLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (VALID_LEVELS as readonly string[]).includes(value);
}

function modelKey(model: Model<any> | undefined): string | undefined {
	if (!model || !model.id) return undefined;
	return `${model.provider}/${model.id}`;
}

interface ScopedModelLike {
	model: Model<any>;
	thinkingLevel?: ThinkingLevel;
}

/**
 * `ctx.scopedModels` is provided at runtime but is missing from the type bundle
 * some pi installs ship next to extensions, and absent entirely on older pi
 * builds. Read it through a narrow cast and degrade to "no scoped models"
 * instead of letting a missing field throw mid model switch.
 */
function scopedModelsOf(ctx: ExtensionContext): readonly ScopedModelLike[] {
	return (ctx as unknown as { scopedModels?: readonly ScopedModelLike[] }).scopedModels ?? [];
}

function readJson(file: string): unknown {
	try {
		return JSON.parse(readFileSync(file, "utf-8"));
	} catch {
		return undefined; // Missing or corrupt — callers fall back to defaults.
	}
}

function writeJson(file: string, value: unknown): void {
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf-8");
	} catch (err) {
		console.error(`[thinking-level] failed to save ${file}:`, err);
	}
}

// ===========================================================================
// Part 1 — per-model level memory
// ===========================================================================

/** `${provider}/${modelId}` → last level the user chose on that model. */
type LevelCache = Partial<Record<string, ThinkingLevel>>;

let cache: LevelCache = {};
let cacheFile = "";

/** Key of the model reported by the most recent model_select (the model the
 *  session was on before the current event). */
let currentModelKey: string | undefined;

/**
 * While the current model is unknown (right after extension load) a
 * thinking_level_select could be either a genuine user choice or the clamp pi
 * applies mid-switch. It is recorded tentatively; the very next model_select
 * decides: if its model matches, the event was the switch clamp and the
 * previous value is restored; otherwise it stays as a real user choice.
 */
let pendingRecord: { key: string; level: ThinkingLevel; prev: ThinkingLevel | undefined } | undefined;

/** True while we apply a remembered/scoped/max level inside model_select, so
 *  the resulting thinking_level_select isn't mistaken for a user choice. */
let applying = false;

function loadCache(): void {
	const parsed = readJson(cacheFile);
	if (parsed && typeof parsed === "object") {
		const next: LevelCache = {};
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (isValidLevel(value)) next[key] = value;
		}
		cache = next;
		return;
	}
	cache = {};
}

function saveCache(): void {
	writeJson(cacheFile, cache);
}

function remember(key: string, level: ThinkingLevel): void {
	if (cache[key] === level) return;
	cache[key] = level;
	saveCache();
}

/** Register the `thinking_level_select` / `model_select` / `session_start` handlers. */
function registerMemory(pi: ExtensionAPI): void {
	cacheFile = join(getAgentDir(), MEMORY_FILE_NAME);
	loadCache();

	/**
	 * Shared target resolution: remembered → scoped → maximum.
	 * Returns undefined when there is nothing to do (no memory/scope/max
	 * above current, or already at the target level).
	 */
	function resolveTarget(model: Model<any>, ctx: ExtensionContext, currentLevel: ThinkingLevel): ThinkingLevel | undefined {
		const key = modelKey(model);
		if (!key) return undefined;
		let target: ThinkingLevel | undefined = cache[key];
		if (target === undefined) {
			const scoped = scopedModelsOf(ctx).find(
				(sm) => sm.model.provider === model.provider && sm.model.id === model.id,
			);
			if (scoped?.thinkingLevel !== undefined) target = scoped.thinkingLevel;
		}
		if (target === undefined) {
			const maxLevel = maxThinkingLevel(model);
			if (maxLevel > currentLevel) {
				target = maxLevel;
			}
		}
		if (target === undefined || target === currentLevel) return undefined;
		return target;
	}

	function applyTarget(target: ThinkingLevel): void {
		applying = true;
		try {
			pi.setThinkingLevel(target);
		} finally {
			applying = false;
		}
	}

	// Record genuine user choices. Clamps pi applies mid-switch are skipped:
	// their event reports the *new* model, which never matches the model we
	// were last on, and the target model is handled by model_select instead.
	pi.on("thinking_level_select", (event, ctx) => {
		const key = modelKey(ctx.model);
		if (!key || applying) return;

		if (currentModelKey === undefined) {
			// Fresh load: record tentatively; model_select will roll it back
			// if it turns out to be the clamp of an in-flight model switch.
			pendingRecord = { key, level: event.level, prev: cache[key] };
			remember(key, event.level);
			return;
		}

		if (key === currentModelKey) {
			remember(key, event.level);
		}
		// else: switch clamp — do not record it for the new model.
	});

	// On switch: restore the remembered level; models without a memory are
	// bumped to their maximum supported level.
	// Skipped for source "restore": session resume already carries its own level.
	pi.on("model_select", (event, ctx) => {
		const key = modelKey(event.model);
		if (!key) return;

		// Resolve a tentatively recorded level from right after load.
		if (pendingRecord) {
			if (event.source !== "restore" && pendingRecord.key === key) {
				// It was pi's clamp during this very switch — roll it back.
				if (pendingRecord.prev === undefined) {
					delete cache[pendingRecord.key];
				} else {
					cache[pendingRecord.key] = pendingRecord.prev;
				}
				saveCache();
			}
			pendingRecord = undefined;
		}

		currentModelKey = key;
		if (event.source === "restore") return;

		// 1) remembered user preference, 2) explicit scoped-model level,
		// 3) default: the maximum level this model supports — raise to it
		//    whenever the current level is below it. That is this part's
		//    core job (e.g. previous model topped out at high, new model
		//    supports max → land on max, not on the inherited high).
		//
		//    pi semantics: on switch, pi first carries the old session level
		//    over and clamps it to the new model's range (setThinkingLevel
		//    runs before model_select is emitted), so pi.getThinkingLevel()
		//    here is exactly the level we would stay at without this
		//    extension. If it is already the new model's ceiling, the
		//    comparison fails and we leave the level untouched.
		const target = resolveTarget(event.model, ctx, pi.getThinkingLevel());
		if (target === undefined) return;
		applyTarget(target);
	});

	// On fresh sessions (`/new`, process startup) pi resolves the level purely
	// from its own settings and never emits `model_select` when the model is
	// unchanged (`_emitModelSelect` returns early on `modelsAreEqual`), so the
	// handler above never fires there. Restore the memory here instead.
	// Skipped for "resume" / "fork": those carry the transcript's own level
	// and continuing them must not be overridden. Skipped for "reload": the
	// live session already carries the right level and re-applying would only
	// append a redundant transcript entry.
	pi.on("session_start", (event, ctx) => {
		// The extension module instance survives `/new` (same process), so
		// re-sync the file and re-anchor the model tracking on every start.
		loadCache();
		currentModelKey = modelKey(ctx.model);
		pendingRecord = undefined;

		if (event.reason !== "startup" && event.reason !== "new") return;
		const model = ctx.model;
		if (!model) return;
		const target = resolveTarget(model, ctx, pi.getThinkingLevel());
		if (target === undefined) return;
		applyTarget(target);
	});
}

// ===========================================================================
// Part 2 — supported levels in the /model selector
// ===========================================================================

/** Literal pi writes on the footer line; used to locate the Text child. */
const NAME_MARKER = "Model Name:";
/** Markers for text this extension appended (idempotency guard). */
const SUFFIX_MARKER = "· reasoning:";
const SUFFIX_MARKER_NONE = "· no reasoning";

/**
 * One SGR (Select Graphic Rendition) run, e.g. "\x1b[38;5;244m". This is the only
 * place the ANSI syntax is written down: pi exports no colour helpers and does
 * not export its live `theme` singleton, so every colour and reset this
 * extension emits is read back out of pi's own rendered text rather than being
 * hardcoded. (For reference, pi's own Theme.fg() closes with "\x1b[39m".)
 */
const SGR_RUN = /(?:\x1b\[[0-9;]*m)+/;
const LEADING_SGR = new RegExp(`^${SGR_RUN.source}`);
const TRAILING_SGR = new RegExp(`${SGR_RUN.source}$`);
const SGR_RUNS = new RegExp(SGR_RUN.source, "g");

/**
 * Markers pi renders inside the model selector. They locate text, and more
 * importantly they expose the theme colours pi is actually using right now, so
 * the highlight follows whatever theme is live (including auto dark/light
 * switching). Order matters: success is the requested colour, accent is the
 * fallback for renders where no success-coloured text is present.
 */
/** Current-model badge on the list rows: `theme.fg("success", " ✓")`. */
const CURRENT_MODEL_CHECK = "✓";
/** Status line after a successful refresh: `theme.fg("success", ...)`. */
const REFRESH_OK = "Model catalogs refreshed.";
/** Selected-row marker: `theme.fg("accent", "→ ")`. */
const SELECTED_ROW = "→ ";

/** Shared across extension reloads so `/reload` cannot stack wrappers. */
const STATE_KEY = Symbol.for("pi.extensions.thinking-level.state");
const PATCHED_FLAG = Symbol.for("pi.extensions.thinking-level.patched");

interface SharedState {
	/** Reads the session's current level; replaced on every load. */
	currentLevel?: () => ThinkingLevel | undefined;
	/** Last highlight colour borrowed from pi's own output (theme live). */
	highlightAnsi?: string;
	/** True once the wrapper is live on ModelSelectorComponent. */
	attached: boolean;
	/** Human readable reason the wrapper could not be attached. */
	attachError?: string;
}

interface TextChild {
	text?: string;
	setText?: (text: string) => void;
}

interface ModelSelectorLike {
	listContainer?: { children?: TextChild[]; addChild?: (child: unknown) => void };
	filteredModels?: { model?: Model<any> }[];
	selectedIndex?: number;
	currentModel?: Model<any>;
	/** Set by pi whenever the last catalog refresh failed (private field, live at runtime). */
	errorMessage?: string;
}

function getState(): SharedState {
	const holder = globalThis as Record<symbol, SharedState | undefined>;
	if (!holder[STATE_KEY]) {
		holder[STATE_KEY] = { attached: false, currentLevel: undefined };
	}
	return holder[STATE_KEY] as SharedState;
}

/** The ANSI colour run immediately preceding `needle` (blanks allowed between). */
function ansiBefore(haystack: string, needle: string): string | undefined {
	const at = haystack.indexOf(needle);
	if (at < 0) return undefined;
	const before = haystack.slice(0, at);
	let found: string | undefined;
	SGR_RUNS.lastIndex = 0;
	let run: RegExpExecArray | null;
	while ((run = SGR_RUNS.exec(before)) !== null) {
		// Keep only runs that have nothing but blanks after them, i.e. the run
		// that actually opens `needle`. The last such run wins.
		if (before.slice(run.index + run[0].length).trim() === "") found = run[0];
	}
	return found;
}

/** The ANSI run immediately following `needle` (blanks allowed between). */
function ansiAfter(haystack: string, needle: string): string | undefined {
	const at = haystack.indexOf(needle);
	if (at < 0) return undefined;
	const rest = haystack.slice(at + needle.length);
	SGR_RUNS.lastIndex = 0;
	const run = SGR_RUNS.exec(rest);
	if (!run) return undefined;
	// Only the run that actually closes `needle`, i.e. nothing but blanks before it.
	if (rest.slice(0, run.index).trim() !== "") return undefined;
	return run[0];
}

/**
 * pi's muted colour and its reset, borrowed from a rendered row: the `[provider]`
 * badge on every row is `theme.fg("muted", ...)`, and the scroll indicator
 * `  (i/n)` is muted too. Falls back to no colour rather than inventing one.
 */
function findMutedAnsi(children: TextChild[]): { ansi: string; close: string } | undefined {
	for (const child of children) {
		const text = child.text;
		if (typeof text !== "string") continue;
		const badge = /\[([^\]]+)\]/.exec(stripTerminalSequences(text));
		if (!badge) continue;
		const ansi = ansiBefore(text, badge[0]);
		if (!ansi) continue;
		return { ansi, close: ansiAfter(text, badge[0]) ?? "" };
	}
	for (const child of children) {
		const text = child.text;
		if (typeof text !== "string") continue;
		if (!/^\s+\(\d+\/\d+\)$/.test(stripTerminalSequences(text))) continue;
		const ansi = LEADING_SGR.exec(text)?.[0];
		if (!ansi) continue;
		return { ansi, close: TRAILING_SGR.exec(text)?.[0] ?? "" };
	}
	return undefined;
}

/**
 * Colour to highlight the current level with, borrowed from pi's own output:
 * pi's success colour (the current-model `✓`, or the "Model catalogs refreshed."
 * status line) when visible, otherwise pi's accent colour — the colour of the
 * selected-row `→` marker. Undefined while a render shows none of them.
 */
function findHighlightAnsi(children: TextChild[]): string | undefined {
	for (const marker of [CURRENT_MODEL_CHECK, REFRESH_OK]) {
		for (const child of children) {
			const text = child.text;
			if (typeof text !== "string") continue;
			const ansi = ansiBefore(text, marker);
			if (ansi) return ansi;
		}
	}
	for (const child of children) {
		const text = child.text;
		if (typeof text !== "string") continue;
		// The selected row opens with the accent-coloured arrow, so the row's
		// very first SGR run is the accent colour.
		if (stripTerminalSequences(text).startsWith(SELECTED_ROW)) {
			return LEADING_SGR.exec(text)?.[0];
		}
	}
	return undefined;
}

/** Build the "· reasoning: ..." suffix, or "" when there is nothing to add. */
function buildSuffix(
	model: Model<any>,
	lineText: string,
	isHighlightedModel: boolean,
	highlightAnsi: string | undefined,
): string {
	// The colour the line is written in, and pi's own reset for it — both taken
	// from the string pi just produced, so nothing about them is assumed.
	const ansi = LEADING_SGR.exec(lineText)?.[0] ?? "";
	const close = TRAILING_SGR.exec(lineText)?.[0] ?? "";
	const levels = levelsFor(model);
	// "off" is not a reasoning level, it is the absence of one: a model whose
	// only available level is off (reasoning: false, or a thinkingLevelMap that
	// nulls every level) cannot think, so say that instead of listing "off".
	const usable = model.reasoning ? levels.filter((level) => level !== "off") : [];
	let body: string;

	if (usable.length === 0) {
		body = SUFFIX_MARKER_NONE;
	} else {
		const active = isHighlightedModel ? getState().currentLevel?.() : undefined;
		const rendered = levels
			.map((level) => {
				if (level !== active) return level;
				// Colour the current level like "Model catalogs refreshed." and put
				// the line's own colour back afterwards. With no colour to borrow
				// the level is simply left as-is rather than inventing one.
				return highlightAnsi ? `${highlightAnsi}${level}${ansi}` : level;
			})
			.join(" ");
		body = `${SUFFIX_MARKER} ${rendered}`;
	}

	return ` ${ansi}${body}${close}`;
}

/**
 * pi renders a failed catalog refresh *instead of* the name line:
 * `ModelSelectorComponent.updateList()` is `if (errorMessage) <error lines>
 * else if (no matches) … else <Model Name line>`, so “Could not refresh opencode;…”—
 * which is about the catalog, not about the highlighted model—silently takes the
 * levels away from the picker. Rebuild the line below the error, in pi's own
 * muted colour, so the two stop being coupled.
 */
function appendNameLine(selector: ModelSelectorLike): void {
	const state = getState();
	const children = selector.listContainer?.children;
	if (!children?.length) return;
	if (!selector.errorMessage) return; // nothing suppressed the line — nothing to restore
	const index = selector.selectedIndex ?? 0;
	const model = selector.filteredModels?.[index]?.model;
	if (!model) return;
	if (typeof selector.listContainer?.addChild !== "function") return;

	const muted = findMutedAnsi(children);
	const ansi = muted?.ansi ?? "";
	const close = muted?.close ?? "";
	const current = selector.currentModel;
	const isHighlightedModel = !!current && current.provider === model.provider && current.id === model.id;

	const seen = findHighlightAnsi(children);
	if (seen) state.highlightAnsi = seen;

	// Same shape as pi's own line: `  Model Name: <name>` + our suffix.
	const line = `${ansi}  ${NAME_MARKER} ${model.name ?? model.id}${close}`;
	const suffix = buildSuffix(model, line, isHighlightedModel, seen ?? state.highlightAnsi);
	// The blank line pi puts above the footer (its Spacer(1)).
	selector.listContainer.addChild(new Spacer(1));
	selector.listContainer.addChild(new Text(line + suffix, 0, 0));
}

/** Rewrite pi's freshly built "Model Name:" footer line for the highlighted row. */
function enhance(selector: ModelSelectorLike): void {
	const state = getState();
	const children = selector.listContainer?.children;
	if (!children?.length) return;

	const nameChild = children.find(
		(child) => typeof child.text === "string" && child.text.includes(NAME_MARKER),
	);
	const original = nameChild?.text;
	if (!nameChild || !original) {
		// No footer line in this render: pi showed the refresh error instead.
		appendNameLine(selector);
		return;
	}
	if (typeof nameChild.setText !== "function") return;
	// pi rebuilds the list on every update, so this is only a safety net.
	if (original.includes(SUFFIX_MARKER) || original.includes(SUFFIX_MARKER_NONE)) return;

	const index = selector.selectedIndex ?? 0;
	const model = selector.filteredModels?.[index]?.model;
	if (!model) return;

	const current = selector.currentModel;
	const isHighlightedModel = !!current && current.provider === model.provider && current.id === model.id;

	// Borrowed from this render when possible; the cached value keeps the colour
	// stable across renders that happen to show no success/accent-coloured text.
	const seen = findHighlightAnsi(children);
	if (seen) state.highlightAnsi = seen;

	const suffix = buildSuffix(model, original, isHighlightedModel, seen ?? state.highlightAnsi);
	if (suffix) nameChild.setText(original + suffix);
}

/**
 * Wrap ModelSelectorComponent.updateList once per process. Returns the reason
 * when the built-in selector could not be patched.
 */
function attach(): string | undefined {
	const state = getState();
	if (state.attached) return undefined;

	const proto = (ModelSelectorComponent as unknown as { prototype?: unknown })?.prototype as
		| { updateList?: (() => void) & { [PATCHED_FLAG]?: boolean } }
		| undefined;
	if (!proto) return "ModelSelectorComponent.prototype is missing (pi internals changed?)";

	const original = proto.updateList;
	if (typeof original !== "function") {
		return "ModelSelectorComponent.prototype.updateList is missing (pi internals changed?)";
	}

	if (original[PATCHED_FLAG]) {
		// A previous load already wrapped it; that wrapper reads this same
		// globalThis state, so there is nothing left to install.
		state.attached = true;
		return undefined;
	}

	const wrapped = function (this: ModelSelectorLike): void {
		original.call(this);
		try {
			enhance(this);
		} catch (err) {
			// Never let the decoration break the model picker.
			console.error("[thinking-level] failed to decorate model selector:", err);
		}
	} as unknown as (() => void) & { [PATCHED_FLAG]?: boolean };
	wrapped[PATCHED_FLAG] = true;
	proto.updateList = wrapped;
	state.attached = true;
	return undefined;
}

export default function thinkingLevelExtension(pi: ExtensionAPI): void {
	// ---------------------------------------------------------- part 1: memory
	registerMemory(pi);

	// --------------------------------------------------------- part 2: display
	const state = getState();
	state.currentLevel = () => {
		try {
			return pi.getThinkingLevel() as ThinkingLevel | undefined;
		} catch {
			return undefined;
		}
	};

	const attachError = attach();
	if (attachError) {
		state.attachError = attachError;
		console.error(`[thinking-level] /model display disabled: ${attachError}`);
	}

	pi.on("session_start", (_event, ctx) => {
		if (state.attachError) {
			ctx.ui.notify(`thinking-level: could not patch /model (${state.attachError})`, "warning");
		}
	});
}

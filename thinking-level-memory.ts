/**
 * thinking-level-memory
 *
 * Remembers the last reasoning (thinking) level per model and restores it
 * automatically whenever you switch back to that model via /model, the model
 * selector, or model cycling (scoped models included).
 *
 * Motivation: pi keeps a single session-wide thinking level and clamps it to
 * the current model's capabilities. Switching from a model that only supports
 * `high` to one that supports up to `max` leaves the level at `high` — you
 * have to raise it manually every time. This extension fixes that:
 *
 *   - Switching to a model with NO remembered level → the level is raised to
 *     the highest level that model supports (e.g. `max` for models that map
 *     it, `high` for models that don't, `off` for non-reasoning models)
 *     whenever the current level is below it. That is the whole point: if the
 *     previous model only supported `high` and the new one supports `max`,
 *     switching must land on `max`, not on the inherited `high`. If the level
 *     is already at the new model's ceiling, it is left untouched.
 *   - Switching to a model WITH a remembered level → the remembered level is
 *     restored (setThinkingLevel clamps it if the model no longer supports
 *     it, so it degrades gracefully).
 *   - Explicit scoped-model thinking levels (`--models model:level`) act as
 *     the fallback for models without a memory (pi itself applies them at
 *     switch time). Priority: remembered level → scoped level → max default.
 *   - Manually setting a level on a model always updates its remembered level.
 *
 * Why not just pi's built-in clamp? pi keeps the session-wide level and only
 * clamps it to the new model's capabilities (high stays high even on a model
 * that supports max). This extension is what actually bumps unrecorded models
 * to their maximum.
 *
 * How it works:
 *   - On `thinking_level_select` the level is recorded for the currently
 *     active model — but only when the change is a genuine user choice.
 *     Clamps pi applies mid-switch are detected (the event's model differs
 *     from the last model seen in model_select) and never recorded. A level
 *     changed right after extension load is recorded tentatively and rolled
 *     back if the immediately following model_select proves it was a switch
 *     clamp (the old value is preserved either way).
 *   - On `model_select` the remembered level for the new model is re-applied;
 *     models without a memory are bumped to their maximum supported level via
 *     getSupportedThinkingLevels().
 *   - Session resume (source "restore") is left alone: the session already
 *     carries its own level.
 *
 * Storage: ~/.pi/agent/thinking-level-memory.json (created on first change).
 *
 * Commands:
 *   /thinking-memory          - show remembered levels
 *   /thinking-memory clear    - forget all remembered levels
 *
 * Install: save to ~/.pi/agent/extensions/thinking-level-memory.ts and add
 * "./thinking-level-memory.ts" to the `pi.extensions` list in package.json,
 * then /reload.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const VALID_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const CACHE_FILE_NAME = "thinking-level-memory.json";

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

function modelKey(model: Model<any> | undefined): string | undefined {
	if (!model || !model.id) return undefined;
	return `${model.provider}/${model.id}`;
}

function isValidLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (VALID_LEVELS as readonly string[]).includes(value);
}

function loadCache(): void {
	try {
		const parsed: unknown = JSON.parse(readFileSync(cacheFile, "utf-8"));
		if (parsed && typeof parsed === "object") {
			const next: LevelCache = {};
			for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
				if (isValidLevel(value)) next[key] = value;
			}
			cache = next;
			return;
		}
	} catch {
		// Missing or corrupt cache file — start empty.
	}
	cache = {};
}

function saveCache(): void {
	try {
		mkdirSync(dirname(cacheFile), { recursive: true });
		writeFileSync(cacheFile, JSON.stringify(cache, null, 2) + "\n", "utf-8");
	} catch (err) {
		console.error(`[thinking-level-memory] failed to save ${cacheFile}:`, err);
	}
}

function remember(key: string, level: ThinkingLevel): void {
	if (cache[key] === level) return;
	cache[key] = level;
	saveCache();
}

/** Highest thinking level the model supports (getSupportedThinkingLevels is
 *  ordered off → minimal → … → max, so the last entry is the maximum). */
function maxThinkingLevel(model: Model<any>): ThinkingLevel {
	const levels = getSupportedThinkingLevels(model);
	return levels[levels.length - 1] ?? "off";
}

export default function thinkingLevelMemoryExtension(pi: ExtensionAPI): void {
	cacheFile = join(getAgentDir(), CACHE_FILE_NAME);
	loadCache();

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
		//    whenever the current level is below it. That is the extension's
		//    core job (e.g. previous model topped out at high, new model
		//    supports max → land on max, not the inherited high).
		//
		//    pi semantics: on switch, pi first carries the old session level
		//    over and clamps it to the new model's range (setThinkingLevel
		//    runs before model_select is emitted), so pi.getThinkingLevel()
		//    here is exactly the level we would stay at without this
		//    extension. If it is already the new model's ceiling, the
		//    comparison fails and we leave the level untouched; otherwise we
		//    raise to the max. (Earlier drafts compared against a "manual
		//    default" and a "pre-switch level" separately — under the
		//    current API both are this same value, so the two conditions
		//    were just one comparison in disguise.)
		let target: ThinkingLevel | undefined = cache[key];
		if (target === undefined) {
			const scoped = ctx.scopedModels.find(
				(sm) => sm.model.provider === event.model.provider && sm.model.id === event.model.id,
			);
			if (scoped?.thinkingLevel !== undefined) target = scoped.thinkingLevel;
		}
		if (target === undefined) {
			const maxLevel = maxThinkingLevel(event.model);
			if (maxLevel > pi.getThinkingLevel()) {
				target = maxLevel;
			}
		}

		if (target === undefined || pi.getThinkingLevel() === target) return;
		applying = true;
		try {
			pi.setThinkingLevel(target);
		} finally {
			applying = false;
		}
	});

	// /thinking-memory — inspect or clear the remembered levels.
	pi.registerCommand("thinking-memory", {
		description: "Show or clear per-model thinking level memory",
		handler: async (args, ctx) => {
			const arg = args?.trim().toLowerCase();
			if (arg === "clear") {
				cache = {};
				saveCache();
				ctx.ui.notify("Per-model thinking level memory cleared", "info");
				return;
			}
			const entries = Object.entries(cache).sort(([a], [b]) => a.localeCompare(b));
			if (entries.length === 0) {
				ctx.ui.notify(
					"No remembered thinking levels yet. Set a level on a model to record it; models without a record are switched to their maximum supported level.",
					"info",
				);
				return;
			}
			const summary = entries.map(([key, level]) => `${key} → ${level}`).join(" · ");
			ctx.ui.notify(`Remembered levels: ${summary}`, "info");
		},
	});
}

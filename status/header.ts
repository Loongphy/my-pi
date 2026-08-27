/**
 * Status Header Widget Module
 *
 * Renders a rich status line above the editor with:
 * - Model
 * - Current working directory + git branch
 * - Token statistics (input/output/cache, matching pi's built-in footer)
 * - Cache hit rate (cumulative / last request)
 * - Context usage (percentage / window)
 * - Token generation speed
 *
 * Also provides the /statusline configuration command helpers.
 */

import path from "node:path";
import fs from "node:fs";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type {
    ExtensionAPI,
    ExtensionContext,
    Theme,
    ThemeColor,
} from "@earendil-works/pi-coding-agent";
import type { GitStatus } from "./git.ts";
import { TokenSpeedEngine } from "./tps.ts";

// ── Thinking level → theme color ──

const THINKING_LEVEL_COLORS: Record<string, ThemeColor> = {
    off: "thinkingOff",
    minimal: "thinkingMinimal",
    low: "thinkingLow",
    medium: "thinkingMedium",
    high: "thinkingHigh",
    xhigh: "thinkingXhigh",
    max: "thinkingMax" as ThemeColor, // 安装包 theme.d.ts 漏了 thinkingMax（0.84.3 运行时支持）
};

// ── Token formatting (mirrors pi's built-in footer) ──

export function formatTokens(count: number): string {
    if (count < 1000) return count.toString();
    if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
    if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
    if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
    return `${Math.round(count / 1_000_000)}M`;
}

// ── Status line config ──

export interface StatusLineConfig {
    model: boolean;
    currentDir: boolean;
    gitBranch: boolean;
    tokenStats: boolean;
    cacheRate: boolean;
    contextUsage: boolean;
    tokenSpeed: boolean;
    ttft: boolean;
    thinking: boolean;
}

export const DEFAULT_STATUS_CONFIG: StatusLineConfig = {
    model: true,
    currentDir: true,
    gitBranch: true,
    tokenStats: true,
    cacheRate: true,
    contextUsage: true,
    tokenSpeed: true,
    ttft: true,
    thinking: true,
};

const STATUS_CONFIG_PATH = path.join(
    process.env.HOME || process.env.USERPROFILE || "~",
    ".pi",
    "agent",
    "statusline-config.json",
);

export function loadStatusConfig(): StatusLineConfig {
    try {
        const raw = fs.readFileSync(STATUS_CONFIG_PATH, "utf-8");
        return { ...DEFAULT_STATUS_CONFIG, ...JSON.parse(raw) };
    } catch {
        return { ...DEFAULT_STATUS_CONFIG };
    }
}

export function saveStatusConfig(config: StatusLineConfig): void {
    try {
        fs.mkdirSync(path.dirname(STATUS_CONFIG_PATH), { recursive: true });
        fs.writeFileSync(
            STATUS_CONFIG_PATH,
            JSON.stringify(config, null, 2),
            "utf-8",
        );
    } catch {
        /* silent */
    }
}

// ── Token stats (matches pi's built-in footer logic) ──

export interface TokenStats {
    totalInput: number;
    totalOutput: number;
    totalCacheRead: number;
    totalCacheWrite: number;
}

/**
 * Compute cumulative token stats from ALL session entries,
 * mirroring pi's built-in footer logic exactly.
 */
export function computeTokenStats(ctx: ExtensionContext): TokenStats {
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;
    try {
        for (const entry of ctx.sessionManager.getEntries()) {
            if (
                entry.type === "message" &&
                entry.message?.role === "assistant" &&
                entry.message.usage
            ) {
                totalInput += entry.message.usage.input || 0;
                totalOutput += entry.message.usage.output || 0;
                totalCacheRead += entry.message.usage.cacheRead || 0;
                totalCacheWrite += entry.message.usage.cacheWrite || 0;
            }
        }
    } catch {
        /* session not ready */
    }
    return { totalInput, totalOutput, totalCacheRead, totalCacheWrite };
}

/**
 * Compute the cache hit rate for the last assistant request.
 * Returns null when there is no usage data or the denominator is zero.
 */
export function computeLastCacheRate(ctx: ExtensionContext): number | null {
    try {
        const entries = ctx.sessionManager.getEntries();
        for (let i = entries.length - 1; i >= 0; i--) {
            const entry = entries[i];
            if (
                entry.type === "message" &&
                entry.message?.role === "assistant" &&
                entry.message.usage
            ) {
                const u = entry.message.usage;
                const cr = u.cacheRead || 0;
                const inp = u.input || 0;
                const denom = cr + inp;
                if (denom === 0) return null;
                return cr / denom;
            }
        }
    } catch {
        /* session not ready */
    }
    return null;
}

// ── Right-side width budget (stable dir-mode decision) ──
//
// The dir-mode decision reserves a fixed maximum width for the enabled
// right-side segments instead of measuring the live line. The budget is a
// constant per config + model context window, so the chosen directory mode
// only changes when the terminal width changes (or model/git state changes),
// never as cache % / context tokens / tps / TTFT grow or shrink.
//
// Tuning: max widths bias toward compression (never overflow). For a looser
// layout, replace the max strings below with typical widths plus a small
// buffer.
function rightSideBudget(config: StatusLineConfig, contextWindow: number | undefined): number {
    const sep = 3; // " │ "
    const segs: number[] = [];
    if (config.cacheRate) segs.push(24); // "Cache 100.0%/last 100.0%"
    if (config.contextUsage) {
        const cw = formatTokens(contextWindow ?? 0);
        segs.push(4 + 1 + cw.length + 1 + cw.length); // "100% X/Y"
    }
    if (config.tokenSpeed) segs.push(19); // "9999 t/s TTFT 99.9s"
    if (config.tokenStats) segs.push(26); // "↑9999k ↓9999k R9999k W9999k"
    if (segs.length === 0) return 0;
    // 段间分隔符 + 与左侧之间的分隔符
    return segs.reduce((a, b) => a + b + sep, 0) + sep;
}

// ── Status header rendering ──

export interface HeaderRenderData {
    gitStatus: GitStatus | null;
    tokenSpeedEngine: TokenSpeedEngine;
}

/**
 * Build the status header lines (single line) for the aboveEditor widget.
 * Uses the same token stats computation as pi's built-in footer.
 */
export function buildStatusHeader(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    data: HeaderRenderData,
    config: StatusLineConfig,
    theme: Theme,
    width?: number,
): string[] {
    const sep = theme.fg("borderMuted", " \u2502 ");

    // ── Expensive session-wide computation, done ONCE per render ──
    //
    // computeTokenStats walks ALL session entries. It must NOT run inside
    // the candidate loop below — each extra walk triples the per-render
    // cost and pins the event loop on long sessions.
    const stats = (config.tokenStats || config.cacheRate)
        ? computeTokenStats(ctx)
        : null;
    const hasUsageData = stats
        ? stats.totalInput > 0 || stats.totalCacheRead > 0
        : false;
    const lastRate =
        config.cacheRate && stats && hasUsageData
            ? computeLastCacheRate(ctx)
            : null;

    // ── Working directory: longest → shortest candidates ──
    //
    // When the assembled line does not fit the available width, shrink the
    // directory first (full path → basename → omitted) instead of chopping
    // the right edge. The trailing segments (cache rate, context usage,
    // token speed) are the live/interesting part and must survive narrow
    // terminals; the full cwd is the least critical piece on a narrow
    // screen. Right-edge truncation in the widget render stays as the
    // final safety net.
    const dirCandidates: Array<string | null> = [];
    if (config.currentDir) {
        let dir = ctx.cwd;
        const home = process.env.HOME || process.env.USERPROFILE;
        if (home && dir.startsWith(home)) dir = `~${dir.slice(home.length)}`;
        dirCandidates.push(dir);
        const base = path.basename(dir);
        if (base && base !== dir) dirCandidates.push(base);
        dirCandidates.push(null); // last resort: drop the directory
    } else {
        dirCandidates.push(null);
    }

    // ── Left part (model + dir + git) — the only input the dir-mode
    // decision may use. It depends on stable state (terminal width, model,
    // git), never on the live token/cache/speed values below.
    const buildLeft = (dir: string | null): string => {
        const parts: string[] = [];

        // 1. Model + Thinking:  gpt-5.5 low (no separator)
        if (config.model && ctx.model) {
            let modelPart = theme.fg("accent", `\uEE9C ${ctx.model.id}`);
            if (config.thinking && ctx.model.reasoning) {
                const level = pi.getThinkingLevel();
                const thinkColor = THINKING_LEVEL_COLORS[level] ?? "thinkingText";
                modelPart += ` ${theme.fg(thinkColor, level)}`;
            }
            parts.push(modelPart);
        }

        // 2. Working directory:  /path (basename or omitted on narrow widths)
        if (dir) {
            parts.push(theme.fg("success", `\uF07C ${dir}`));
        }

        // 3. Git branch + badges:  main ↑2 ↓1 +5 ?3
        if (config.gitBranch && data.gitStatus) {
            const git = data.gitStatus;
            let branchStr = `\uF418 ${git.branch}`;
            const badges: string[] = [];
            // ahead: ↑N green
            if (git.ahead > 0)
                badges.push(theme.fg("success", `\u2191${git.ahead}`));
            // behind: ↓N red
            if (git.behind > 0)
                badges.push(theme.fg("error", `\u2193${git.behind}`));
            // changed (staged + modified + deleted + conflicted): +N yellow
            const changed =
                git.staged + git.modified + git.deleted + git.conflicted;
            if (changed > 0) badges.push(theme.fg("warning", `+${changed}`));
            // untracked: ?N red
            if (git.untracked > 0)
                badges.push(theme.fg("error", `?${git.untracked}`));
            if (badges.length > 0) branchStr += " " + badges.join(" ");
            parts.push(theme.fg("text", branchStr));
        }

        if (parts.length === 0) return "";
        return parts.join(sep);
    };

    const buildLine = (dir: string | null): string => {
        const parts: string[] = [];
        const left = buildLeft(dir);
        if (left) parts.push(left);

        // 4. Token stats: ↑ tokens ↓ tokens
        // (stats precomputed once above — see buildStatusHeader)
        if (config.tokenStats && stats) {
            const statStrs: string[] = [];
            if (stats.totalInput)
                statStrs.push(`\u2191${formatTokens(stats.totalInput)}`);
            if (stats.totalOutput)
                statStrs.push(`\u2193${formatTokens(stats.totalOutput)}`);
            if (stats.totalCacheRead)
                statStrs.push(`R${formatTokens(stats.totalCacheRead)}`);
            if (stats.totalCacheWrite)
                statStrs.push(`W${formatTokens(stats.totalCacheWrite)}`);
            if (statStrs.length > 0) {
                parts.push(theme.fg("muted", statStrs.join(" ")));
            }
        }

        // 4b. Cache hit rate: cumulative / last request
        // Only show when usage data is available (e.g. after at least one assistant response).
        // On /reload or resume, session data loaded from disk provides the same source.
        if (config.cacheRate && stats && hasUsageData) {
            const cumDenom = stats.totalCacheRead + stats.totalInput;
            const cumRate = cumDenom > 0 ? stats.totalCacheRead / cumDenom : 0;
            const cumPct = (cumRate * 100).toFixed(1);
            const lastPct =
                lastRate !== null ? (lastRate * 100).toFixed(1) : "—";
            const cacheStr = `Cache ${cumPct}%/last ${lastPct}%`;
            parts.push(theme.fg("muted", cacheStr));
        }

        // 5. Context usage: 54%/128K or colored at high thresholds
        if (config.contextUsage) {
            const usage = ctx.getContextUsage();
            const contextWindow =
                usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
            const contextPct = usage?.percent;
            const contextTokens = usage?.tokens;
            let ctxStr: string;
            if (
                contextPct !== null &&
                contextPct !== undefined &&
                contextTokens !== null &&
                contextTokens !== undefined
            ) {
                ctxStr = `${contextPct.toFixed(0)}% ${formatTokens(contextTokens)}/${formatTokens(contextWindow)}`;
            } else if (contextPct !== null && contextPct !== undefined) {
                ctxStr = `${contextPct.toFixed(0)}%/${formatTokens(contextWindow)}`;
            } else {
                ctxStr = `?/${formatTokens(contextWindow)}`;
            }
            if (contextPct !== null && contextPct !== undefined) {
                if (contextPct > 90) {
                    parts.push(theme.fg("error", ctxStr));
                } else if (contextPct > 70) {
                    parts.push(theme.fg("warning", ctxStr));
                } else {
                    parts.push(theme.fg("muted", ctxStr));
                }
            } else {
                parts.push(theme.fg("muted", ctxStr));
            }
        }

        // 6. Token speed + TTFT (no separator between them, both accent colour)
        if (config.tokenSpeed && data.tokenSpeedEngine.tps > 0) {
            let speedStr = `\u{F04C5} ${data.tokenSpeedEngine.tps.toFixed(0)} t/s`;
            if (config.ttft && data.tokenSpeedEngine.ttftSec > 0) {
                speedStr += ` TTFT ${data.tokenSpeedEngine.ttftSec.toFixed(1)}s`;
            }
            parts.push(theme.fg("accent", speedStr));
        }

        if (parts.length === 0) return "";
        return parts.join(sep);
    };

    // Pick a directory mode using ONLY stable inputs — the terminal width, the
    // left part (model + dir + git) and a fixed budget reserved for the right
    // side. Live values (cache %, context tokens, tps, TTFT) must never enter
    // this decision: they change width constantly during a turn, and using
    // them made the header flicker between full path and basename as the
    // assembled line crossed the width threshold back and forth.
    //
    // When width is not provided (or ≤ 0) keep the historical behavior (full
    // path, no fit check) — the widget render truncates as the final safety
    // net.
    let dirMode: string | null;
    if (width === undefined || width <= 0) {
        dirMode = dirCandidates[0] ?? null;
    } else {
        const budget = rightSideBudget(config, ctx.model?.contextWindow);
        dirMode = null;
        for (const dir of dirCandidates) {
            if (visibleWidth(buildLeft(dir)) + budget <= width) {
                dirMode = dir;
                break;
            }
        }
        if (dirMode === null) dirMode = dirCandidates[dirCandidates.length - 1] ?? null;
    }
    return [buildLine(dirMode)];
}

// ── Status line config items (for /statusline command) ──

export const STATUSLINE_ITEMS: Array<{
    id: keyof StatusLineConfig;
    label: string;
    description: string;
}> = [
    { id: "model", label: "model", description: "Current model" },
    {
        id: "currentDir",
        label: "current-dir",
        description: "Current working directory with git branch",
    },
    {
        id: "gitBranch",
        label: "git-branch",
        description: "Git branch in path label",
    },
    {
        id: "tokenStats",
        label: "token-stats",
        description: "Input/output/cache token counts",
    },
    {
        id: "cacheRate",
        label: "cache-rate",
        description: "Cache hit rate (cumulative / last request)",
    },
    {
        id: "contextUsage",
        label: "context-usage",
        description: "Context window usage percentage",
    },
    {
        id: "tokenSpeed",
        label: "token-speed",
        description: "Token generation speed",
    },
    { id: "ttft", label: "ttft", description: "Time to first token" },
    { id: "thinking", label: "thinking", description: "Thinking level" },
];

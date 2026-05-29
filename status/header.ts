/**
 * Status Header Widget Module
 *
 * Renders a rich status line above the editor with:
 * - Model
 * - Current working directory + git branch
 * - Token statistics (input/output/cache, matching pi's built-in footer)
 * - Context usage (percentage / window)
 * - Token generation speed
 *
 * Also provides the /statusline configuration command helpers.
 */

import path from "node:path";
import fs from "node:fs";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { GitStatus } from "./git.ts";
import { TokenSpeedEngine } from "./tps.ts";

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
  contextUsage: true,
  tokenSpeed: true,
  ttft: true,
  thinking: true,
};

const STATUS_CONFIG_PATH = path.join(
  process.env.HOME || process.env.USERPROFILE || "~",
  ".pi", "agent", "statusline-config.json",
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
    fs.writeFileSync(STATUS_CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  } catch { /* silent */ }
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
      if (entry.type === "message" && entry.message?.role === "assistant" && entry.message.usage) {
        totalInput += entry.message.usage.input || 0;
        totalOutput += entry.message.usage.output || 0;
        totalCacheRead += entry.message.usage.cacheRead || 0;
        totalCacheWrite += entry.message.usage.cacheWrite || 0;
      }
    }
  } catch { /* session not ready */ }
  return { totalInput, totalOutput, totalCacheRead, totalCacheWrite };
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
): string[] {
  const parts: string[] = [];
  const sep = theme.fg("borderMuted", " \u2502 ");

  // 1. Model + Thinking:  gpt-5.5 low (no separator)
  if (config.model && ctx.model) {
    let modelPart = theme.fg("accent", `\uEE9C ${ctx.model.id}`);
    if (config.thinking && ctx.model.reasoning) {
      const level = pi.getThinkingLevel();
      const thinkColor = `thinking${level.charAt(0).toUpperCase() + level.slice(1)}` as const;
      modelPart += ` ${theme.fg(thinkColor, level)}`;
    }
    parts.push(modelPart);
  }

  // 2. Working directory:  /path
  if (config.currentDir) {
    let dir = ctx.cwd;
    const home = process.env.HOME || process.env.USERPROFILE;
    if (home && dir.startsWith(home)) dir = `~${dir.slice(home.length)}`;
    parts.push(theme.fg("success", `\uF07C ${dir}`));
  }

  // 3. Git branch + badges:  main ↑2 ↓1 +5 ?3
  if (config.gitBranch && data.gitStatus) {
    const git = data.gitStatus;
    let branchStr = `\uF418 ${git.branch}`;
    const badges: string[] = [];
    // ahead: ↑N green
    if (git.ahead > 0) badges.push(theme.fg("success", `\u2191${git.ahead}`));
    // behind: ↓N red
    if (git.behind > 0) badges.push(theme.fg("error", `\u2193${git.behind}`));
    // changed (staged + modified + deleted + conflicted): +N yellow
    const changed = git.staged + git.modified + git.deleted + git.conflicted;
    if (changed > 0) badges.push(theme.fg("warning", `+${changed}`));
    // untracked: ?N red
    if (git.untracked > 0) badges.push(theme.fg("error", `?${git.untracked}`));
    if (badges.length > 0) branchStr += " " + badges.join(" ");
    parts.push(theme.fg("text", branchStr));
  }

  // 4. Token stats: ↑ tokens ↓ tokens
  if (config.tokenStats) {
    const stats = computeTokenStats(ctx);
    const statStrs: string[] = [];
    if (stats.totalInput) statStrs.push(`\u2191${formatTokens(stats.totalInput)}`);
    if (stats.totalOutput) statStrs.push(`\u2193${formatTokens(stats.totalOutput)}`);
    if (stats.totalCacheRead) statStrs.push(`R${formatTokens(stats.totalCacheRead)}`);
    if (stats.totalCacheWrite) statStrs.push(`W${formatTokens(stats.totalCacheWrite)}`);
    if (statStrs.length > 0) {
      parts.push(theme.fg("muted", statStrs.join(" ")));
    }
  }

  // 5. Context usage: 54%/128K or colored at high thresholds
  if (config.contextUsage) {
    const usage = ctx.getContextUsage();
    const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
    const contextPct = usage?.percent;
    const contextTokens = usage?.tokens;
    let ctxStr: string;
    if (contextPct !== null && contextPct !== undefined && contextTokens !== null && contextTokens !== undefined) {
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

  if (parts.length === 0) return [""];
  const line = parts.join(sep);
  return [line];
}

// ── Status line config items (for /statusline command) ──

export const STATUSLINE_ITEMS: Array<{
  id: keyof StatusLineConfig;
  label: string;
  description: string;
}> = [
  { id: "model", label: "model", description: "Current model" },
  { id: "currentDir", label: "current-dir", description: "Current working directory with git branch" },
  { id: "gitBranch", label: "git-branch", description: "Git branch in path label" },
  { id: "tokenStats", label: "token-stats", description: "Input/output/cache token counts" },
  { id: "contextUsage", label: "context-usage", description: "Context window usage percentage" },
  { id: "tokenSpeed", label: "token-speed", description: "Token generation speed" },
  { id: "ttft", label: "ttft", description: "Time to first token" },
  { id: "thinking", label: "thinking", description: "Thinking level" },
];

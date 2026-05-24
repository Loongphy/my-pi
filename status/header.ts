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
 * Also provides git detection, token speed tracking, and
 * the /statusline configuration command helpers.
 */

import path from "node:path";
import fs from "node:fs";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

// ── Token formatting (mirrors pi's built-in footer) ──

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

// ── Git status ──

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  staged: number;
  modified: number;
  deleted: number;
  conflicted: number;
  untracked: number;
}

export async function collectGitStatus(
  cwd: string,
  execFn: (cmd: string, args: string[], opts?: { cwd: string }) => Promise<{ stdout: string }>,
): Promise<GitStatus | null> {
  try {
    const checkResult = await execFn("git", ["rev-parse", "--is-inside-work-tree"], { cwd }).catch(() => undefined);
    if (!checkResult?.stdout?.trim()?.startsWith("true")) return null;

    let branch = "detached";
    const branchResult = await execFn("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd }).catch(() => undefined);
    if (branchResult?.stdout?.trim()) {
      const b = branchResult.stdout.trim();
      branch = b === "HEAD" ? "detached" : b;
    }
    if (branch === "detached") {
      const shaResult = await execFn("git", ["rev-parse", "--short", "HEAD"], { cwd }).catch(() => undefined);
      if (shaResult?.stdout?.trim()) {
        branch = `detached@${shaResult.stdout.trim()}`;
      }
    }

    let ahead = 0;
    let behind = 0;
    const abResult = await execFn(
      "git", ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], { cwd },
    ).catch(() => undefined);
    if (abResult?.stdout?.trim()) {
      const parts = abResult.stdout.trim().split(/\s+/);
      ahead = parseInt(parts[0] || "0", 10) || 0;
      behind = parseInt(parts[1] || "0", 10) || 0;
    }

    let staged = 0;
    let modified = 0;
    let deleted = 0;
    let conflicted = 0;
    let untracked = 0;

    const statusResult = await execFn(
      "git", ["status", "--porcelain=2", "--untracked-files=normal"], { cwd },
    ).catch(() => undefined);
    if (statusResult?.stdout) {
      for (const line of statusResult.stdout.split("\n")) {
        if (line.startsWith("1 ")) {
          const xCh = line[2];
          const yCh = line[3];
          if (xCh === "u" || yCh === "u") { conflicted++; continue; }
          if (xCh === "?") { untracked++; continue; }
          if (xCh === "!") continue;
          if (xCh === "A" || xCh === "C" || xCh === "R") staged++;
          if (xCh === "M") staged++;
          if (xCh === "D") deleted++;
          if (yCh === "M" || yCh === "R") modified++;
          if (yCh === "D") deleted++;
        } else if (line.startsWith("2 ")) {
          staged++;
        } else if (line.startsWith("u ")) {
          conflicted++;
        } else if (line.startsWith("? ")) {
          untracked++;
        }
      }
    }

    return { branch, ahead, behind, staged, modified, deleted, conflicted, untracked };
  } catch {
    return null;
  }
}

// ── Token speed engine ──
//
// Tracks two metrics during assistant streaming:
//   1. TPS (tokens per second) — real-time via char/4 heuristic, final via usage.output
//   2. TTFT (time to first token) — wall-clock from message_start to first text/thinking delta
//
// TTFT is always a real time measurement (no estimation), so it is the same
// whether read during streaming or from the finalised message_end.

export class TokenSpeedEngine {
  private _isStreaming = false;
  private _finished = false;

  // Char-based estimation state
  private _charCount = 0;
  private _approxTokenCount = 0;
  private _tokenTimestamps: number[] = [];
  private _windowStartIndex = 0;

  // Real token count (from message_end usage)
  private _realOutputTokens = 0;

  // Timing — excludes TTFT for TPS calculation
  private _messageStartTime = 0;
  private _generationStartTime = 0;
  private _generationEndTime = 0;
  private _firstTokenArrived = false;

  // TTFT
  private _ttftMs = 0;

  private readonly TPS_WINDOW_MS = 1000;
  private readonly COMPACTION_THRESHOLD = 5000;

  get isStreaming() { return this._isStreaming; }

  /** Best token count available: real provider-reported when finished, otherwise approx char/4. */
  get tokenCount(): number {
    return this._finished && this._realOutputTokens > 0
      ? this._realOutputTokens
      : this._approxTokenCount;
  }

  /** Elapsed ms since generation started (excludes TTFT). Frozen at finish(). */
  get elapsedMs(): number {
    if (this._generationStartTime === 0) return 0;
    const end = this._finished && this._generationEndTime > 0 ? this._generationEndTime : Date.now();
    return end - this._generationStartTime;
  }
  get elapsedSeconds(): number { return this.elapsedMs / 1000; }

  /**
   * TTFT in seconds.
   *
   * Before first token arrives: returns a live (Date.now() - messageStart) value
   * so the status header shows a counting-up timer while the user waits.
   *
   * After first token: returns the frozen measured TTFT.
   */
  get ttftSec(): number {
    // First token has arrived — show the frozen measured value
    if (this._firstTokenArrived) return this._ttftMs / 1000;
    // Waiting for first token — live count-up from message_start
    if (this._isStreaming && this._messageStartTime > 0) {
      return (Date.now() - this._messageStartTime) / 1000;
    }
    return this._ttftMs / 1000;
  }

  /**
   * Tokens per second.
   *
   * During streaming: sliding-window over timestamps (1 s window),
   * falling back to overall average when elapsed < 1 s.
   *
   * After finish(): uses provider-reported real output tokens and
   * wall time from generation start (excludes TTFT).
   */
  get tps(): number {
    // Finished — use real provider-reported tokens (time frozen at finish())
    if (this._finished && this._realOutputTokens > 0) {
      const elapsed = this.elapsedMs;
      return elapsed === 0 ? 0 : this._realOutputTokens / (elapsed / 1000);
    }

    // Streaming — sliding window
    if (this._generationStartTime === 0) return 0;
    if (this.elapsedMs < this.TPS_WINDOW_MS) return this.tps_avg;

    const now = Date.now();
    const windowStart = now - this.TPS_WINDOW_MS;
    while (
      this._windowStartIndex < this._tokenTimestamps.length &&
      this._tokenTimestamps[this._windowStartIndex] < windowStart
    ) {
      this._windowStartIndex++;
    }
    const windowCount = this._tokenTimestamps.length - this._windowStartIndex;
    if (windowCount === 0) return this.tps_avg;
    const duration = (now - this._tokenTimestamps[this._windowStartIndex]) / 1000;
    if (duration === 0) return 0;
    return windowCount / duration;
  }

  /** Overall average TPS (used as fallback when < 1 s of data). */
  get tps_avg(): number {
    return this.elapsedSeconds === 0 ? 0 : this.tokenCount / this.elapsedSeconds;
  }

  /**
   * Call on message_start (assistant).
   * Records message-start wall time for TTFT calculation.
   */
  start() {
    this._isStreaming = true;
    this._finished = false;
    this._charCount = 0;
    this._approxTokenCount = 0;
    this._realOutputTokens = 0;
    this._messageStartTime = Date.now();
    this._generationStartTime = 0;
    this._firstTokenArrived = false;
    this._ttftMs = 0;
    this._tokenTimestamps = [];
    this._windowStartIndex = 0;
  }

  /**
   * Call on each text_delta / thinking_delta.
   *
   * Uses pi's own chars/4 heuristic (see estimateTokens() in compaction.ts)
   * to approximate real token count from the delta string.
   *
   * On the first call, records generation start time and TTFT.
   */
  recordToken(delta: string) {
    if (!this._isStreaming) return;

    // First token → mark generation start and measure TTFT
    if (!this._firstTokenArrived) {
      this._firstTokenArrived = true;
      this._generationStartTime = Date.now();
      this._ttftMs = this._generationStartTime - this._messageStartTime;
    }

    this._charCount += delta.length;

    // Pi's own estimateTokens heuristic: chars/4, minimum 1
    const approxTokens = Math.max(1, Math.round(delta.length / 4));
    this._approxTokenCount += approxTokens;

    // Push a timestamp per approx-token for sliding-window accuracy
    const now = Date.now();
    for (let i = 0; i < approxTokens; i++) {
      this._tokenTimestamps.push(now);
    }

    // Compact timestamp array to prevent unbounded growth
    if (this._windowStartIndex >= this.COMPACTION_THRESHOLD) {
      this._tokenTimestamps = this._tokenTimestamps.slice(this._windowStartIndex);
      this._windowStartIndex = 0;
    }
  }

  /**
   * Call on message_end (assistant).
   * Injects provider-reported real output token count so the final
   * status render shows the accurate TPS.
   */
  finish(realOutputTokens?: number) {
    this._isStreaming = false;
    this._finished = true;
    this._generationEndTime = Date.now();  // freeze time for stable TPS
    if (realOutputTokens !== undefined && realOutputTokens > 0) {
      this._realOutputTokens = realOutputTokens;
    }
    // Keep stats alive so the final status render reads real TPS
  }

  /** Full reset (e.g. on session_shutdown). */
  stop() {
    this._isStreaming = false;
    this._finished = false;
    this._generationEndTime = 0;
    this._tokenTimestamps = [];
    this._windowStartIndex = 0;
  }
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
  totalCost: number;
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
  let totalCost = 0;
  try {
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "message" && entry.message?.role === "assistant" && entry.message.usage) {
        totalInput += entry.message.usage.input || 0;
        totalOutput += entry.message.usage.output || 0;
        totalCacheRead += entry.message.usage.cacheRead || 0;
        totalCacheWrite += entry.message.usage.cacheWrite || 0;
        totalCost += entry.message.usage.cost?.total || 0;
      }
    }
  } catch { /* session not ready */ }
  return { totalInput, totalOutput, totalCacheRead, totalCacheWrite, totalCost };
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

  // 4. Token stats: ↑ tokens ↓ tokens $cost
  if (config.tokenStats) {
    const stats = computeTokenStats(ctx);
    const statStrs: string[] = [];
    if (stats.totalInput) statStrs.push(`\u2191${formatTokens(stats.totalInput)}`);
    if (stats.totalOutput) statStrs.push(`\u2193${formatTokens(stats.totalOutput)}`);
    if (stats.totalCacheRead) statStrs.push(`R${formatTokens(stats.totalCacheRead)}`);
    if (stats.totalCacheWrite) statStrs.push(`W${formatTokens(stats.totalCacheWrite)}`);
    if (stats.totalCost) statStrs.push(`\u0024${stats.totalCost.toFixed(3)}`);
    if (statStrs.length > 0) {
      parts.push(theme.fg("muted", statStrs.join(" ")));
    }
  }

  // 5. Context usage: 54%/128K or colored at high thresholds
  if (config.contextUsage) {
    const usage = ctx.getContextUsage();
    const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
    const contextPct = usage?.percent;
    let ctxStr: string;
    if (contextPct !== null && contextPct !== undefined) {
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

/**
 * Status Extension — Main Entry
 *
 * Orchestrates all sub-modules:
 *   - Animated terminal title + working indicator
 *   - Real-time "Working for" message
 *   - Turn duration display
 *   - Auto conversation title generation
 *   - Status header widget replacing footer (header.ts)
 *
 * Hides the built-in footer to avoid duplication.
 */

import fs from "node:fs";
import path from "node:path";
import { complete } from "@earendil-works/pi-ai/compat";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

import {
  loadStatusConfig,
  buildStatusHeader,
} from "./header.ts";
import { registerStatuslineCommand } from "./statusline.ts";
import {
  collectGitStatus,
  resolveGitDir,
  type GitStatus,
} from "./git.ts";
import { TokenSpeedEngine } from "./tps.ts";
import type { StatusLineConfig } from "./header.ts";
import {
  buildIdleTitle,
  startTitleAnimation,
  stopTitleAnimation,
  updateTitleFrame,
} from "./title.ts";

// ── State ──

interface AppState {
  // Title animation
  titleTimer: ReturnType<typeof setInterval> | null;
  frameIndex: number;
  activeCtx: ExtensionContext | null;

  // Agent lifecycle
  isWorking: boolean;
  isRetrying: boolean;
  workingMessageTimer: ReturnType<typeof setInterval> | null;
  agentStartMs: number | null;

  // Auto-title
  isAutoTitling: boolean;

  // Status header
  gitStatus: GitStatus | null;
  lastAgentDuration: string | null;
  gitRefreshTimer: ReturnType<typeof setTimeout> | null;
  renderDebounceTimer: ReturnType<typeof setTimeout> | null;
  activeTui: TUI | undefined;
  tokenSpeedEngine: TokenSpeedEngine;

  // TTFT live timer
  ttftTimer: ReturnType<typeof setInterval> | null;

  // fs.watch git state
  gitWatcher: fs.FSWatcher | null;
  gitWatchCwd: string | null;
  gitPollTimer: ReturnType<typeof setInterval> | null;

  // Self-event suppression: our own refresh runs git commands that can
  // write .git state (e.g. the index). Those writes fire our watcher and
  // must not schedule another refresh, or the loop never terminates.
  gitRefreshInFlight: boolean;
  lastGitRefreshEndMs: number;
}

function createInitialState(): AppState {
  return {
    titleTimer: null,
    frameIndex: 0,
    activeCtx: null,
    isWorking: false,
    isRetrying: false,
    workingMessageTimer: null,
    agentStartMs: null,
    isAutoTitling: false,
    gitStatus: null,
    lastAgentDuration: null,
    gitRefreshTimer: null,
    renderDebounceTimer: null,
    activeTui: undefined,
    tokenSpeedEngine: new TokenSpeedEngine(),
    ttftTimer: null,
    gitWatcher: null,
    gitWatchCwd: null,
    gitPollTimer: null,
    gitRefreshInFlight: false,
    lastGitRefreshEndMs: 0,
  };
}

// ── Empty footer (hides pi's built-in footer) ──

const emptyFooter = () => ({
  render: () => [] as string[],
  invalidate: () => {},
});

// ── Helpers ──

// Grace window after a self-triggered refresh during which watcher events
// are assumed to be fallout from our own git commands and ignored.
const GIT_SELF_EVENT_GRACE_MS = 1_000;

function formatDuration(ms: number, prefix: string): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${prefix} ${[h > 0 && `${h}h`, m > 0 && `${m}m`, `${s}s`].filter(Boolean).join(" ")}`;
}

// ── Working message timer ──
//
// NOTE: We only ever update the working *message* via setWorkingMessage().
// pi owns the working loader lifecycle (created on agent_start, cleared on
// agent_end / compaction / retry). We must NOT call setWorkingVisible(true)
// from a timer or from tool events to "keep the row alive" — see
// startWorkingMessage below for why that freezes the TUI.

function startWorkingMessage(ctx: ExtensionContext, state: AppState) {
  if (state.workingMessageTimer) return;
  state.agentStartMs = Date.now();
  ctx.ui.setWorkingMessage(formatDuration(0, "Working for"));
  state.workingMessageTimer = setInterval(() => {
    if (state.agentStartMs === null) return;
    // Only update the text. setWorkingMessage() updates the loader when pi
    // has one on screen and is a harmless no-op when it does not.
    //
    // The previous implementation called ctx.ui.setWorkingVisible(true) here
    // to "recreate the loader when it's missing". That is not safe: pi's
    // setWorkingVisible(true), while streaming, force-replaces whatever
    // status indicator is currently shown (retry countdown, auto-compaction,
    // branch summary, or a transiently-cleared container) with a brand-new
    // WorkingStatusIndicator. Each replacement constructs a new Loader that
    // starts its own 80ms animation interval and requests a render, and it
    // can leave a working loader alive in states where pi expects it to be
    // cleared. Fired every second (and on every tool_execution_start) this
    // fights pi's indicator state machine and drives a near-continuous
    // render loop. Because every render recomputes the status header — which
    // walks all session entries (computeTokenStats x2 + computeLastCacheRate)
    // plus getContextUsage() — the event loop gets pinned on long sessions
    // and the TUI becomes unresponsive ("卡死"). Letting pi own the loader
    // and only updating the text removes the conflict entirely.
    ctx.ui.setWorkingMessage(formatDuration(Date.now() - state.agentStartMs, "Working for"));
  }, 1_000);
}

function stopWorkingMessage(ctx: ExtensionContext, state: AppState) {
  if (state.workingMessageTimer) { clearInterval(state.workingMessageTimer); state.workingMessageTimer = null; }
  state.agentStartMs = null;
  ctx.ui.setWorkingMessage();
}

// ── Retry lifecycle helpers ──
//
// pi does not surface auto_retry_start / auto_retry_end to extensions (those
// AgentSessionEvents drive only the built-in TUI retry countdown). Retries are
// instead detected from agent_end: a run whose last assistant message ends with
// stopReason "error" is normally followed by pi's auto-retry (or a compaction
// continuation), so the working timer is kept alive and the next agent_start
// continues the same counter instead of restarting at 0s. agent_settled closes
// the timer out when no continuation ever starts (max retries hit, aborted
// backoff, non-retryable error).

/** True when the run's last assistant message ended in error. */
function endsWithError(messages: Array<{ role?: string; stopReason?: string }>): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant") return m.stopReason === "error";
  }
  return false;
}

/** Stop the working timer and record the total elapsed duration (agent_start → now). */
function finishWorking(ctx: ExtensionContext, state: AppState) {
  if (state.workingMessageTimer) {
    clearInterval(state.workingMessageTimer);
    state.workingMessageTimer = null;
  }
  const elapsedMs = state.agentStartMs !== null ? Date.now() - state.agentStartMs : null;
  state.agentStartMs = null;

  if (elapsedMs !== null) {
    const total = Math.round(elapsedMs / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    state.lastAgentDuration = [h > 0 && `${h}h`, m > 0 && `${m}m`, `${s}s`].filter(Boolean).join(" ");
  } else {
    ctx.ui.setWorkingMessage();
    ctx.ui.setWorkingVisible(false);
  }
}

// ── Auto title generation ──

function extractTextParts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const b = part as { type?: string; text?: string };
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts;
}

function buildTitlePrompt(entries: SessionEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message?.role) continue;
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") continue;
    const textParts = extractTextParts(entry.message.content);
    const text = textParts.join("\n").trim();
    if (!text) continue;
    const truncated = text.length > 500 ? text.slice(0, 500) + "\u2026" : text;
    lines.push(`${role === "user" ? "User" : "Assistant"}: ${truncated}`);
    if (lines.length > 40) break;
  }
  if (lines.length === 0) return "";
  return [
    "Generate a very short, concise title (\u22645 words, no quotes) for this conversation:",
    "",
    "<conversation>",
    lines.join("\n\n"),
    "</conversation>",
    "",
    "Title:",
  ].join("\n");
}

async function autoGenerateTitle(pi: ExtensionAPI, ctx: ExtensionContext, state: AppState): Promise<void> {
  if (pi.getSessionName()) return;
  if (state.isAutoTitling) return;
  if (!ctx.model) return;
  const branch = ctx.sessionManager.getBranch();
  if (!branch || branch.length < 2) return;
  const prompt = buildTitlePrompt(branch);
  if (!prompt) return;
  state.isAutoTitling = true;
  try {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
    if (!auth?.ok || !auth.apiKey) return;
    const response = await complete(ctx.model, {
      messages: [
        { role: "user" as const, content: [{ type: "text" as const, text: prompt }], timestamp: Date.now() },
      ],
    }, { apiKey: auth.apiKey, headers: auth.headers, maxTokens: 30 });
    const title = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text.trim()).join("")
      .replace(/^["']|["']$/g, "").trim();
    if (title && title.length > 0 && title.length <= 80) {
      pi.setSessionName(title);
      if (!state.isWorking) ctx.ui.setTitle(buildIdleTitle(pi));
    }
  } catch { /* best-effort */ }
  finally { state.isAutoTitling = false; }
}

// ── Widget management ──

function createWidgetFactory(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: AppState,
  config: StatusLineConfig,
) {
  return (tui: TUI, theme: Theme) => {
    state.activeTui = tui;

    return {
      render: (width: number) => {
        // Don't cache by width — state (gitStatus, tokenSpeed, etc.) changes
        // asynchronously and must always re-compute on re-render.
        const lines: string[] = [];
        if (state.lastAgentDuration) {
          const text = `Worked for ${state.lastAgentDuration}`;
          const plainLeft = `─ ${text} ─`;
          const fillerCount = width - 2 - visibleWidth(plainLeft);
          const filler = fillerCount > 0 ? theme.fg("dim", "─".repeat(fillerCount)) : "";
          lines.push(` ${theme.fg("dim", "─")} ${theme.fg("dim", text)} ${theme.fg("dim", "─")}${filler} `);
          lines.push(""); // bottom margin
        }
        const statusLines = buildStatusHeader(pi, ctx, {
          gitStatus: state.gitStatus,
          tokenSpeedEngine: state.tokenSpeedEngine,
        }, config, theme);
        for (const l of statusLines) {
          lines.push(truncateToWidth(l, width, theme.fg("dim", "...")));
        }
        return lines;
      },
      invalidate: () => {},
      dispose: () => {},
    };
  };
}

function updateWidget(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: AppState,
  config: StatusLineConfig,
) {
  ctx.ui.setWidget("status-header", createWidgetFactory(pi, ctx, state, config), {
    placement: "aboveEditor",
  });
}

// ── Extension entry ──

export default function (pi: ExtensionAPI) {
  const state = createInitialState();
  const configRef = { current: loadStatusConfig() };

  // ── git refresh helpers ──

  const doRefreshGit = async (cwd: string) => {
    state.gitRefreshInFlight = true;
    try {
      state.gitStatus = await collectGitStatus(cwd, pi.exec.bind(pi));
      state.activeTui?.requestRender();
    } finally {
      state.gitRefreshInFlight = false;
      state.lastGitRefreshEndMs = Date.now();
    }
  };

  const scheduleGitRefresh = (cwd: string) => {
    if (state.gitRefreshTimer) clearTimeout(state.gitRefreshTimer);
    state.gitRefreshTimer = setTimeout(() => void doRefreshGit(cwd), 300);
  };

  // ── fs.watch git watcher ──

  /** Start watching .git state files for external changes. */
  const startGitWatcher = async (cwd: string) => {
    stopGitWatcher();

    const gitDir = await resolveGitDir(cwd, pi.exec.bind(pi));
    if (!gitDir) return;

    state.gitWatchCwd = cwd;

    const onChange = () => {
      // Suppress events caused by our own refresh: even with
      // --no-optional-locks on git status, other commands or races can
      // write .git state while we refresh. Ignoring in-flight events and a
      // short grace window afterwards prevents a self-sustaining
      // watch -> refresh -> watch loop.
      if (state.gitRefreshInFlight) return;
      if (Date.now() - state.lastGitRefreshEndMs < GIT_SELF_EVENT_GRACE_MS) return;
      // Debounce: multiple fs events fire for a single git operation
      scheduleGitRefresh(cwd);
    };

    const onError = (err: Error) => {
      console.error("[status] git fs.watch error:", err.message);
      // Fall back to polling if fs.watch fails
      startGitPolling(cwd);
    };

    try {
      // Watch .git/ directory (catches HEAD, index, and ref changes)
      const watcher = fs.watch(gitDir, { recursive: false }, onChange);
      watcher.on("error", onError);

      // Also watch .git/refs/ recursively for branch/tag creation/deletion
      let refsWatcher: fs.FSWatcher | null = null;
      try {
        if (fs.existsSync(path.join(gitDir, "refs"))) {
          refsWatcher = fs.watch(path.join(gitDir, "refs"), { recursive: true }, onChange);
          refsWatcher.on("error", () => {});
        }
      } catch { /* refs may not exist in bare repos */ }

      state.gitWatcher = watcher;
      // Store refsWatcher on the watcher itself for cleanup
      (watcher as any)._refsWatcher = refsWatcher;

      // Also do a periodic poll as a safety net (WSL/Docker fs.watch is unreliable)
      startGitPolling(cwd);
    } catch (err) {
      console.error("[status] Failed to start git fs.watch, falling back to polling:", (err as Error).message);
      startGitPolling(cwd);
    }
  };

  /** Stop the git fs.watcher and polling timer. */
  const stopGitWatcher = () => {
    if (state.gitWatcher) {
      const refsWatcher = (state.gitWatcher as any)._refsWatcher as fs.FSWatcher | null;
      if (refsWatcher) refsWatcher.close();
      state.gitWatcher.close();
      state.gitWatcher = null;
    }
    if (state.gitPollTimer) {
      clearInterval(state.gitPollTimer);
      state.gitPollTimer = null;
    }
    state.gitWatchCwd = null;
  };

  /** Fallback periodic polling for platforms where fs.watch is unreliable (WSL, Docker). */
  const startGitPolling = (cwd: string) => {
    if (state.gitPollTimer) return;
    // Safety net only: fs.watch covers real-time updates. Kept slow (15s)
    // because each poll spawns 4-5 git processes and triggers a full header
    // render, which is expensive on long sessions.
    state.gitPollTimer = setInterval(() => {
      if (state.gitWatchCwd !== cwd) {
        // cwd changed, stop polling
        if (state.gitPollTimer) {
          clearInterval(state.gitPollTimer);
          state.gitPollTimer = null;
        }
        return;
      }
      void doRefreshGit(cwd);
    }, 15_000);
  };

  // ── Widget update helpers ──

  const doUpdateWidget = (ctx: ExtensionContext) => {
    updateWidget(pi, ctx, state, configRef.current);
  };

  const debouncedUpdate = (ctx: ExtensionContext) => {
    if (state.renderDebounceTimer) clearTimeout(state.renderDebounceTimer);
    state.renderDebounceTimer = setTimeout(() => {
      doUpdateWidget(ctx);
      state.activeTui?.requestRender();
    }, 150);
  };

  const immediateUpdate = (ctx: ExtensionContext) => {
    doUpdateWidget(ctx);
    state.activeTui?.requestRender();
  };

  // ── Retry lifecycle — keep timer running across retries ──
  // Retry detection lives in the agent_start / agent_end / agent_settled
  // handlers below (see the helpers above). pi's auto_retry_* events are not
  // bridged to extensions, so listening to them here would be a silent no-op.

  // ── Session lifecycle ──

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    // Hide built-in footer
    ctx.ui.setFooter(emptyFooter);

    state.isAutoTitling = false;
    state.isRetrying = false;

    state.lastAgentDuration = null;

    // Use pi's built-in working indicator (accent-colored braille spinner) so
    // the symbol in front of "Working for XXs" matches pi exactly. We
    // intentionally do NOT call setWorkingIndicator() with a custom spinner:
    // overriding it diverges from pi's look and needlessly rebuilds the
    // loader. The elapsed-time text is supplied via setWorkingMessage().
    ctx.ui.setTitle(buildIdleTitle(pi));

    // Initial git refresh + start fs.watch on .git state
    void doRefreshGit(ctx.cwd);
    void startGitWatcher(ctx.cwd);

    // Initial widget
    doUpdateWidget(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopTitleAnimation(ctx, state);
    stopWorkingMessage(ctx, state);
    ctx.ui.setWorkingMessage();
    ctx.ui.setWorkingVisible(false);
    ctx.ui.setWorkingIndicator();
    // Restore built-in footer
    ctx.ui.setFooter(undefined);

    stopGitWatcher();
    if (state.ttftTimer) { clearInterval(state.ttftTimer); state.ttftTimer = null; }
    if (state.gitRefreshTimer) { clearTimeout(state.gitRefreshTimer); state.gitRefreshTimer = null; }
    if (state.renderDebounceTimer) { clearTimeout(state.renderDebounceTimer); state.renderDebounceTimer = null; }
    state.tokenSpeedEngine.stop();
    state.activeTui = undefined;
  });

  // ── Agent lifecycle ──

  pi.on("agent_start", async (_event, ctx) => {
    const wasAlreadyWorking = state.isWorking;
    const isRetryRecovery = state.isRetrying;
    state.isRetrying = false; // consume the retry flag
    state.isWorking = true;
    state.lastAgentDuration = null;
    startTitleAnimation(pi, ctx, state);
    // Only reset the timer on fresh starts; retry/continuation attempts keep
    // the same elapsed-time counter running across attempts.
    if (!wasAlreadyWorking && !isRetryRecovery) {
      startWorkingMessage(ctx, state);
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    state.isWorking = false;
    stopTitleAnimation(ctx, state);
    ctx.ui.setTitle(buildIdleTitle(pi));

    // A run ending in error is normally followed by pi's auto-retry or a
    // compaction continuation. Keep the working timer running so the next
    // agent_start continues the same counter; agent_settled finalizes the
    // duration if no continuation ever starts.
    if (endsWithError(event.messages)) {
      state.isRetrying = true;
      return;
    }

    // 正常结束：停止计时器，记录总耗时（从 agent_start 到 agent_end）
    finishWorking(ctx, state);
    immediateUpdate(ctx);
    autoGenerateTitle(pi, ctx, state);
    scheduleGitRefresh(ctx.cwd);
  });

  // 一轮 agent 完全结束（无自动重试/压缩/排队续跑会再启动）。若曾标记重试但
  // 从未有新的 agent_start 消费（重试耗尽、退避被中断、或非可重试错误），
  // 在这里收尾计时器，避免 "Working for" 一直挂起。
  pi.on("agent_settled", async (_event, ctx) => {
    if (!state.isRetrying) return;
    state.isRetrying = false;
    finishWorking(ctx, state);
    immediateUpdate(ctx);
  });

  // ── Turn lifecycle ──

  pi.on("turn_start", async (_event, ctx) => {
    if (state.isWorking) {
      updateTitleFrame(pi, ctx, state);
    }
  });

  // ── Tool execution ──

  pi.on("tool_execution_start", async (_event, ctx) => {
    if (state.isWorking && state.titleTimer) {
      updateTitleFrame(pi, ctx, state);
    }
    // Refresh the elapsed-time text only. Do NOT call setWorkingVisible(true)
    // here: force-recreating pi's status indicator on every tool start fights
    // pi's indicator lifecycle and can freeze the TUI (see startWorkingMessage).
    // setWorkingMessage() is a no-op when pi has no active working loader.
    if (state.isWorking && state.agentStartMs !== null) {
      ctx.ui.setWorkingMessage(formatDuration(Date.now() - state.agentStartMs, "Working for"));
    }
  });

  pi.on("tool_execution_end", async (_event, ctx) => {
    if (state.isWorking && state.titleTimer) {
      updateTitleFrame(pi, ctx, state);
    }
  });

  // ── Message lifecycle (token speed tracking + widget updates) ──

  pi.on("before_provider_request", async () => {
    state.tokenSpeedEngine.recordHttpRequest();
  });

  pi.on("message_start", async (event) => {
    if (event.message?.role === "assistant") {
      state.tokenSpeedEngine.start();

      // Start a live TTFT timer that re-renders the status header
      // while the user waits for the first token to arrive.
      if (!state.ttftTimer) {
        state.ttftTimer = setInterval(() => {
          state.activeTui?.requestRender();
        }, 500);
      }
    }
  });

  pi.on("message_update", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const ev = (event as any).assistantMessageEvent;
    if (ev?.type === "text_delta" || ev?.type === "thinking_delta") {
      state.tokenSpeedEngine.recordToken(ev.delta);

      // First token arrived — TTFT is now frozen, stop the live timer
      if (state.ttftTimer) {
        clearInterval(state.ttftTimer);
        state.ttftTimer = null;
      }
    }
    debouncedUpdate(ctx);
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    // Safety: ensure TTFT timer is stopped even if no deltas arrived
    if (state.ttftTimer) {
      clearInterval(state.ttftTimer);
      state.ttftTimer = null;
    }
    state.tokenSpeedEngine.finish(event.message.usage?.output ?? 0);
    immediateUpdate(ctx);
  });

  // ── Model changes ──

  pi.on("model_select", async (_event, ctx) => {
    if (!state.isWorking) ctx.ui.setTitle(buildIdleTitle(pi));
    immediateUpdate(ctx);
  });

  // ── Thinking level changes ──

  pi.on("thinking_level_select", async (_event, ctx) => {
    immediateUpdate(ctx);
  });

  // ── /statusline command ──

  registerStatuslineCommand(pi, configRef, (ctx) => immediateUpdate(ctx), () => state.activeTui);
}

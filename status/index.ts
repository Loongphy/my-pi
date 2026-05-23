/**
 * Status Extension — Main Entry
 *
 * Orchestrates all sub-modules:
 *   - Animated terminal title + working indicator
 *   - Real-time "Working for" message
 *   - Turn duration display
 *   - Auto conversation title generation
 *   - Auto theme sync (theme.ts)
 *   - Status header widget replacing footer (header.ts)
 *
 * Hides the built-in footer to avoid duplication.
 */

import { complete } from "@earendil-works/pi-ai";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  Theme,
  WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

import { startThemeSync, stopThemeSync } from "./theme.ts";
import {
  collectGitStatus,
  loadStatusConfig,
  buildStatusHeader,
  TokenSpeedEngine,
} from "./header.ts";
import { registerStatuslineCommand } from "./statusline.ts";
import type { GitStatus, StatusLineConfig, HeaderRenderData } from "./header.ts";
import {
  SPINNER_FRAMES,
  buildWorkingTitle,
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
  isThinking: boolean;
  turnStartMs: number | null;
  lastTurnDurationMs: number | null;
  workingMessageTimer: ReturnType<typeof setInterval> | null;
  agentStartMs: number | null;

  // Auto-title
  isAutoTitling: boolean;

  // Theme
  themeTimer: ReturnType<typeof setInterval> | null;
  currentAutoTheme: string | null;

  // Status header
  gitStatus: GitStatus | null;
  gitRefreshTimer: ReturnType<typeof setTimeout> | null;
  renderDebounceTimer: ReturnType<typeof setTimeout> | null;
  activeTui: TUI | undefined;
  tokenSpeedEngine: TokenSpeedEngine;
}

function createInitialState(): AppState {
  return {
    titleTimer: null,
    frameIndex: 0,
    activeCtx: null,
    isWorking: false,
    isThinking: false,
    turnStartMs: null,
    lastTurnDurationMs: null,
    workingMessageTimer: null,
    agentStartMs: null,
    isAutoTitling: false,
    themeTimer: null,
    currentAutoTheme: null,
    gitStatus: null,
    gitRefreshTimer: null,
    renderDebounceTimer: null,
    activeTui: undefined,
    tokenSpeedEngine: new TokenSpeedEngine(),
  };
}

// ── Empty footer (hides pi's built-in footer) ──

const emptyFooter = () => ({
  render: () => [] as string[],
  invalidate: () => {},
});

// ── Helpers ──

function formatDuration(ms: number, prefix: string): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${prefix} ${[h > 0 && `${h}h`, m > 0 && `${m}m`, `${s}s`].filter(Boolean).join(" ")}`;
}

function buildWorkingIndicator(): WorkingIndicatorOptions {
  const colors = [
    "\x1b[38;2;255;179;186m", "\x1b[38;2;255;223;186m",
    "\x1b[38;2;255;255;186m", "\x1b[38;2;186;255;201m",
    "\x1b[38;2;186;225;255m", "\x1b[38;2;218;186;255m",
  ];
  const reset = "\x1b[39m";
  return {
    frames: SPINNER_FRAMES.map((f, i) => `${colors[i % colors.length]!}${f}${reset}`),
    intervalMs: 80,
  };
}

function showTurnDuration(ctx: ExtensionContext, durationMs: number) {
  ctx.ui.setWorkingMessage(formatDuration(durationMs, "Worked for"));
  ctx.ui.setWorkingVisible(true);
}

// ── Working message timer ──

function startWorkingMessage(ctx: ExtensionContext, state: AppState) {
  if (state.workingMessageTimer) return;
  state.agentStartMs = Date.now();
  ctx.ui.setWorkingMessage(formatDuration(0, "Working for"));
  state.workingMessageTimer = setInterval(() => {
    if (state.agentStartMs === null) return;
    ctx.ui.setWorkingMessage(formatDuration(Date.now() - state.agentStartMs, "Working for"));
  }, 1_000);
}

function stopWorkingMessage(ctx: ExtensionContext, state: AppState) {
  if (state.workingMessageTimer) { clearInterval(state.workingMessageTimer); state.workingMessageTimer = null; }
  state.agentStartMs = null;
  ctx.ui.setWorkingMessage();
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
    let cachedWidth: number | undefined;
    let cachedLines: string[] = [""];

    const renderData: HeaderRenderData = {
      gitStatus: state.gitStatus,
      tokenSpeedEngine: state.tokenSpeedEngine,
    };

    return {
      render: (width: number) => {
        if (cachedWidth === width) return cachedLines;
        const lines = buildStatusHeader(pi, ctx, renderData, config, theme);
        cachedLines = lines.map((l) => truncateToWidth(l, width, theme.fg("dim", "...")));
        cachedWidth = width;
        return cachedLines;
      },
      invalidate: () => { cachedWidth = undefined; },
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
    state.gitStatus = await collectGitStatus(cwd, pi.exec.bind(pi));
    state.activeTui?.requestRender();
  };

  const scheduleGitRefresh = (cwd: string) => {
    if (state.gitRefreshTimer) clearTimeout(state.gitRefreshTimer);
    state.gitRefreshTimer = setTimeout(() => void doRefreshGit(cwd), 300);
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

  // ── Session lifecycle ──

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    // Hide built-in footer
    ctx.ui.setFooter(emptyFooter);

    state.isAutoTitling = false;

    // Set working indicator (rainbow spinner)
    ctx.ui.setWorkingIndicator(buildWorkingIndicator());
    ctx.ui.setTitle(buildIdleTitle(pi));

    // Start auto theme sync
    await startThemeSync(pi, ctx, state);

    // Initial git refresh
    void doRefreshGit(ctx.cwd);

    // Initial widget
    doUpdateWidget(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopTitleAnimation(ctx, state);
    stopWorkingMessage(ctx, state);
    stopThemeSync(state);
    ctx.ui.setWorkingMessage();
    ctx.ui.setWorkingVisible(false);
    ctx.ui.setWorkingIndicator();
    // Restore built-in footer
    ctx.ui.setFooter(undefined);

    if (state.gitRefreshTimer) { clearTimeout(state.gitRefreshTimer); state.gitRefreshTimer = null; }
    if (state.renderDebounceTimer) { clearTimeout(state.renderDebounceTimer); state.renderDebounceTimer = null; }
    state.tokenSpeedEngine.stop();
    state.activeTui = undefined;
  });

  // ── Agent lifecycle ──

  pi.on("agent_start", async (_event, ctx) => {
    state.isWorking = true;
    state.isThinking = true;
    startTitleAnimation(pi, ctx, state);
    startWorkingMessage(ctx, state);
  });

  pi.on("agent_end", async (_event, ctx) => {
    state.isWorking = false;
    state.isThinking = false;
    stopTitleAnimation(ctx, state);
    ctx.ui.setTitle(buildIdleTitle(pi));

    if (state.workingMessageTimer) {
      clearInterval(state.workingMessageTimer);
      state.workingMessageTimer = null;
    }
    state.agentStartMs = null;

    if (state.lastTurnDurationMs !== null) {
      showTurnDuration(ctx, state.lastTurnDurationMs);
      state.lastTurnDurationMs = null;
    } else {
      ctx.ui.setWorkingMessage();
      ctx.ui.setWorkingVisible(false);
    }

    immediateUpdate(ctx);
    autoGenerateTitle(pi, ctx, state);
    scheduleGitRefresh(ctx.cwd);
  });

  // ── Turn lifecycle ──

  pi.on("turn_start", async (_event, ctx) => {
    state.turnStartMs = Date.now();
    state.isThinking = true;
    if (state.isWorking) {
      updateTitleFrame(pi, ctx, state);
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    state.isThinking = false;
    if (state.turnStartMs !== null) {
      state.lastTurnDurationMs = Date.now() - state.turnStartMs;
      state.turnStartMs = null;
    }
  });

  // ── Tool execution ──

  pi.on("tool_execution_start", async (_event, ctx) => {
    state.isThinking = false;
    if (state.isWorking && state.titleTimer) {
      updateTitleFrame(pi, ctx, state);
    }
  });

  pi.on("tool_execution_end", async (_event, ctx) => {
    state.isThinking = true;
    if (state.isWorking && state.titleTimer) {
      updateTitleFrame(pi, ctx, state);
    }
  });

  // ── Message lifecycle (token speed tracking + widget updates) ──

  pi.on("message_start", async (event) => {
    if (event.message?.role === "assistant") state.tokenSpeedEngine.start();
  });

  pi.on("message_update", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const ev = (event as any).assistantMessageEvent;
    if (ev?.type === "text_delta" || ev?.type === "thinking_delta") {
      state.tokenSpeedEngine.recordToken();
    }
    debouncedUpdate(ctx);
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    state.tokenSpeedEngine.stop();
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

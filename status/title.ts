/**
 * Terminal Title Module
 *
 * Manages the terminal emulator's tab/window title to show:
 * - ◉ unread dot (lit when the terminal is unfocused and something notable
 *   happened; cleared on focus in — xterm focus reporting, CSI 1004)
 * - ⏎N badge (queued steer/followUp messages still pending)
 * - Current working directory and session name
 * - Animated braille spinner during agent activity
 * - Tool execution context
 *
 * Uses ctx.ui.setTitle() to update the terminal title.
 */

import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── Spinner frames (shared with working indicator) ──

export const SPINNER_FRAMES = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];

// ── State ──

export interface TitleState {
  titleTimer: ReturnType<typeof setInterval> | null;
  frameIndex: number;
  activeCtx: ExtensionContext | null;
}

// ── Title builders ──

function getTitleParts(pi: ExtensionAPI) {
  return {
    cwd: path.basename(process.cwd()),
    session: pi.getSessionName() ?? null,
  };
}

/**
 * Queue badge: ⏎ (U+23CE) + remaining count of queued steer/followUp messages.
 * Hidden entirely when nothing is queued, so the title stays unchanged in the
 * common case. Kept right after the π symbol so terminal tab truncation
 * (which eats the right edge) never cuts it off.
 */
function buildQueueBadge(pendingCount: number): string | null {
  return pendingCount > 0 ? `\u23CE${pendingCount}` : null;
}

/** Unread marker: ◉ (U+25C9) prefix, first token of the title. */
function buildHead(prefix: string, unread: boolean): string {
  return unread ? `\u25C9 ${prefix}` : prefix;
}

export function buildWorkingTitle(pi: ExtensionAPI, _frame: string, pendingCount = 0, unread = false): string {
  const { cwd, session } = getTitleParts(pi);
  // Spinner prefix intentionally dropped: working title stays static (`π ...`),
  // matching the idle title. Call sites still pass the current frame; ignored.
  const head = buildHead("\u03C0", unread);
  const parts = [head];
  const badge = buildQueueBadge(pendingCount);
  if (badge) parts.push(badge);
  parts.push(cwd);
  if (session) parts.push(session);
  return parts.join(" \u00B7 ");
}

export function buildIdleTitle(pi: ExtensionAPI, pendingCount = 0, unread = false): string {
  const { cwd, session } = getTitleParts(pi);
  const head = buildHead("\u03C0", unread);
  const parts = [head];
  const badge = buildQueueBadge(pendingCount);
  if (badge) parts.push(badge);
  parts.push(cwd);
  if (session) parts.push(session);
  return parts.join(" \u00B7 ");
}

// ── Animation lifecycle ──

export function startTitleAnimation(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: TitleState,
  getTitleData?: () => { pending: number; unread: boolean },
): void {
  if (state.titleTimer) return;
  state.activeCtx = ctx;
  state.titleTimer = setInterval(() => {
    if (!state.activeCtx) return;
    const data = getTitleData?.() ?? { pending: 0, unread: false };
    state.activeCtx.ui.setTitle(buildWorkingTitle(pi, SPINNER_FRAMES[state.frameIndex % SPINNER_FRAMES.length]!, data.pending, data.unread));
    state.frameIndex++;
  }, 100);
}

export function stopTitleAnimation(ctx: ExtensionContext, state: TitleState): void {
  if (state.titleTimer) { clearInterval(state.titleTimer); state.titleTimer = null; }
  state.frameIndex = 0;
  state.activeCtx = null;
}

/** Set the terminal title to the current animation frame (without advancing the spinner). */
export function updateTitleFrame(pi: ExtensionAPI, ctx: ExtensionContext, state: TitleState, pendingCount = 0, unread = false): void {
  ctx.ui.setTitle(buildWorkingTitle(pi, SPINNER_FRAMES[state.frameIndex % SPINNER_FRAMES.length]!, pendingCount, unread));
  state.activeCtx = ctx;
}

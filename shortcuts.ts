/**
 * shortcuts - Keyboard shortcuts for pi
 *
 * Adds:
 *   Alt+C  - Copy current input box content to clipboard
 *   Alt+K  - Jump to the previous final assistant answer (fullscreen)
 *   Alt+J  - Jump to the next final assistant answer (fullscreen)
 *
 * Note: deliberately NOT Ctrl+Shift+C. Under Windows Terminal that chord belongs
 * to the terminal's own Copy action: with any text selected in the terminal,
 * WT copies the selection and never delivers the key to pi (it only forwards
 * Ctrl+Shift+C when no selection exists). Alt+C is not bound by WT or by any
 * built-in pi/extension binding.
 *
 * Why Alt+J/K instead of Ctrl+Shift+Up/Down? Those are pi's built-in OSC 133
 * "semantic prompt" navigation keys. They stop at every marked message: user
 * messages and final assistant messages both carry an OSC 133 A zone. With
 * several queued prompts, that means two stops per turn. Alt+J/K walk only the
 * final assistant reply of each turn, so one press per queued prompt.
 */

import { execSync, spawnSync } from "node:child_process";
import { platform } from "node:os";
import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  BashExecutionComponent,
  SkillInvocationMessageComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, type Component, type TUI } from "@earendil-works/pi-tui";

/** Detect if running inside WSL by checking /proc/version for "Microsoft" or "WSL". */
function isWSL(): boolean {
  try {
    const version = readFileSync("/proc/version", "utf8");
    return /microsoft|wsl/i.test(version);
  } catch {
    return false;
  }
}

function copyToClipboard(text: string): boolean {
  if (!text) return false;

  try {
    const os = platform();

    if (os === "darwin") {
      // macOS
      execSync("pbcopy", { input: text });
    } else if (os === "win32") {
      // Windows native
      execSync("clip", { input: text });
    } else if (isWSL()) {
      // WSL — pipe UTF-8 text to PowerShell via stdin (same approach as Codex)
      // Set InputEncoding to UTF8 so Set-Clipboard receives correct Unicode.
      const result = spawnSync("powershell.exe", [
        "-NoProfile",
        "-Command",
        "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; $ErrorActionPreference = 'Stop'; $text = [Console]::In.ReadToEnd(); Set-Clipboard -Value $text",
      ], {
        input: text,
        timeout: 5000,
        stdio: ["pipe", "ignore", "pipe"],
      });
      if (result.error || result.status !== 0) {
        return false;
      }
    } else {
      // Native Linux: try wl-copy (Wayland) first, then xclip (X11)
      try {
        execSync("wl-copy", { input: text });
      } catch {
        execSync("xclip -selection clipboard", { input: text });
      }
    }
    return true;
  } catch {
    return false;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Fullscreen transcript navigation: jump between final assistant answers
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Pi's extension UI does not expose the transcript renderer, but widget
 * factories receive the active TUI instance synchronously. Mount a zero-line
 * widget below the editor for the duration of one call, grab the renderer,
 * and remove the widget again before the next frame is drawn.
 */
const TUI_CAPTURE_WIDGET = "shortcuts.transcript-navigation.capture";
const EMPTY_COMPONENT: Component = {
  render: () => [],
  invalidate: () => {},
};

interface ScrollViewLike {
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly children?: unknown[];
  getContentWidth(width: number): number;
  scrollTo(row: number): void;
  scrollToEnd(): void;
}

interface LayoutRectLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface LayoutBoxLike {
  component: unknown;
  rect: LayoutRectLike;
  children?: LayoutBoxLike[];
  scrollView?: ScrollViewLike;
}

interface FullscreenTuiLike extends TUI {
  currentLayout?: { root: LayoutBoxLike };
  getPrimaryScrollView?(): ScrollViewLike;
}

interface AssistantMessageLike {
  role?: string;
  content?: unknown;
}

interface AssistantComponentLike {
  lastMessage?: AssistantMessageLike;
}

interface AnswerTarget {
  component: unknown;
  row: number;
}

interface NavigationState {
  scrollView: ScrollViewLike;
  components: unknown[];
  index: number;
  scrollTop: number;
}

let navigationState: NavigationState | undefined;

function getFullscreenTui(ctx: ExtensionContext): FullscreenTuiLike | undefined {
  if (ctx.mode !== "tui" || !ctx.hasUI) return undefined;

  let captured: TUI | undefined;
  try {
    ctx.ui.setWidget(
      TUI_CAPTURE_WIDGET,
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
      ctx.ui.setWidget(TUI_CAPTURE_WIDGET, undefined);
    } catch {
      // The TUI may be shutting down; the captured instance is still usable
      // only if the widget was actually installed, which the check below covers.
    }
  }

  if (!captured || captured.mode !== "fullscreen") return undefined;
  return captured as FullscreenTuiLike;
}

/** A candidate answer body: assistant text with no tool calls. */
function isAnswerCandidate(component: unknown): boolean {
  if (!component || typeof component !== "object") return false;
  const message = (component as AssistantComponentLike).lastMessage;
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return false;

  let hasText = false;
  for (const part of message.content) {
    if (!part || typeof part !== "object") continue;
    const block = part as { type?: unknown; text?: unknown };
    if (block.type === "toolCall") return false;
    if (block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) {
      hasText = true;
    }
  }
  return hasText;
}

/**
 * Marks the start of a user turn in the rendered transcript. Skill blocks and
 * user-initiated bash runs are turns too; without them a later answer would
 * overwrite the previous turn's target instead of starting a new one.
 */
function isTurnBoundary(component: unknown): boolean {
  if (!component || typeof component !== "object") return false;
  if (
    component instanceof UserMessageComponent ||
    component instanceof BashExecutionComponent ||
    component instanceof SkillInvocationMessageComponent
  ) {
    return true;
  }
  // Fallback for environments where the extension gets a different class
  // instance than the renderer (the names are preserved in pi's dist).
  const name = (component as { constructor?: { name?: string } }).constructor?.name;
  return (
    name === "UserMessageComponent" ||
    name === "BashExecutionComponent" ||
    name === "SkillInvocationMessageComponent"
  );
}

function findScrollBox(box: LayoutBoxLike, scrollView: ScrollViewLike): LayoutBoxLike | undefined {
  if (box.scrollView === scrollView) return box;
  for (const child of box.children ?? []) {
    const found = findScrollBox(child, scrollView);
    if (found) return found;
  }
  return undefined;
}

/** Only plain Containers concatenate their children in render order. */
function isSequentialContainer(component: unknown): component is Container {
  return component instanceof Container && component.render === Container.prototype.render;
}

interface RenderableLike {
  render?: (width: number) => string[];
  children?: unknown[];
}

/**
 * Collect one stop per user turn: the last answer candidate before the next
 * turn boundary. Retries, aborted partial replies, and intermediate assistant
 * messages therefore cannot become extra stops; only the final body remains.
 *
 * Fullscreen does not lay out individual transcript entries as separate boxes:
 * the document is one leaf node inside the ScrollView. Walk the document's
 * component tree instead and accumulate each component's rendered height at
 * the scroll viewport's content width. That is the same width and the same
 * render order the ScrollView uses for `scrollContentLines`.
 */
function collectAnswerTargets(
  tui: FullscreenTuiLike,
  scrollView: ScrollViewLike,
  scrollBox: LayoutBoxLike,
): AnswerTarget[] {
  if (!tui.currentLayout) return [];
  const document = scrollView.children?.[0];
  if (!document) return [];

  const width = Math.max(1, scrollView.getContentWidth(scrollBox.rect.width));
  const targets: AnswerTarget[] = [];
  let pending: AnswerTarget | undefined;
  let row = 0;

  const measure = (component: unknown): void => {
    if (!component || typeof component !== "object") return;
    const renderable = component as RenderableLike;

    if (isTurnBoundary(component)) {
      if (pending) {
        targets.push(pending);
        pending = undefined;
      }
      row += renderable.render?.(width).length ?? 0;
      return;
    }

    if (isAnswerCandidate(component)) {
      // Same turn: a later candidate (retry, continuation) replaces the
      // earlier one instead of creating another stop.
      pending = { component, row };
      row += renderable.render?.(width).length ?? 0;
      return;
    }

    if (isSequentialContainer(component)) {
      for (const child of renderable.children ?? []) measure(child);
      return;
    }

    row += renderable.render?.(width).length ?? 0;
  };

  measure(document);
  if (pending) targets.push(pending);
  return targets;
}

/** Index of the answer currently occupying the viewport (latest visible start). */
function currentAnswerIndex(targets: readonly AnswerTarget[], scrollView: ScrollViewLike): number {
  const viewportBottom = scrollView.scrollTop + Math.max(1, scrollView.viewportHeight);
  let index = -1;
  for (let i = 0; i < targets.length; i++) {
    if (targets[i]!.row < viewportBottom) index = i;
    else break;
  }
  return index;
}

function sameTargets(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((component, index) => component === b[index]);
}

function navigateAnswers(ctx: ExtensionContext, direction: -1 | 1): void {
  const tui = getFullscreenTui(ctx);
  if (!tui) return;

  const scrollView = tui.getPrimaryScrollView?.();
  if (!scrollView) return;
  const root = tui.currentLayout?.root;
  if (!root) return;
  const scrollBox = findScrollBox(root, scrollView);
  if (!scrollBox) return;

  const targets = collectAnswerTargets(tui, scrollView, scrollBox);
  if (targets.length === 0) return;

  const components = targets.map((target) => target.component);
  let index: number;

  // Reuse the previous cursor only while the user has not scrolled manually
  // and the transcript has not been rebuilt. Otherwise derive the cursor from
  // the viewport, then step one turn in the requested direction.
  if (
    navigationState &&
    navigationState.scrollView === scrollView &&
    navigationState.scrollTop === scrollView.scrollTop &&
    sameTargets(navigationState.components, components)
  ) {
    index = navigationState.index + direction;
  } else {
    index = currentAnswerIndex(targets, scrollView) + direction;
  }

  if (index < 0) {
    // No earlier turn: still make "previous" useful for a long single answer
    // by moving to its first line when we are below it.
    const current = currentAnswerIndex(targets, scrollView);
    const target = current >= 0 ? targets[current] : undefined;
    if (target && scrollView.scrollTop > target.row) {
      scrollView.scrollTo(target.row);
      navigationState = { scrollView, components, index: current, scrollTop: scrollView.scrollTop };
    }
    return;
  }

  if (index >= targets.length) {
    // Past the last answer: return to the live end of the transcript.
    scrollView.scrollToEnd();
    navigationState = {
      scrollView,
      components,
      index: targets.length - 1,
      scrollTop: scrollView.scrollTop,
    };
    return;
  }

  scrollView.scrollTo(targets[index]!.row);
  navigationState = { scrollView, components, index, scrollTop: scrollView.scrollTop };
}

export default function (pi: ExtensionAPI) {
  pi.registerShortcut("alt+c", {
    description: "Copy input box content to clipboard",
    handler: async (ctx) => {
      const text = ctx.ui.getEditorText();
      if (text) {
        copyToClipboard(text);
      }
    },
  });

  pi.registerShortcut("alt+k", {
    description: "Jump to previous final assistant answer (fullscreen)",
    handler: (ctx) => navigateAnswers(ctx, -1),
  });

  pi.registerShortcut("alt+j", {
    description: "Jump to next final assistant answer (fullscreen)",
    handler: (ctx) => navigateAnswers(ctx, 1),
  });
}

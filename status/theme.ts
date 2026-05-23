/**
 * Theme Detection & Auto-Sync Module
 *
 * Cross-platform system dark/light mode detection and
 * automatic pi theme switching.
 */

import { platform } from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── Module constants (not exported externally) ──

const execAsync = promisify(exec);
const THEME_POLL_INTERVAL_MS = 3000;

// ── State needed by theme sync ──

export interface ThemeSyncState {
  themeTimer: ReturnType<typeof setInterval> | null;
  currentAutoTheme: string | null;
  activeCtx: ExtensionContext | null;
}

export const themeSyncStateDefaults: ThemeSyncState = {
  themeTimer: null,
  currentAutoTheme: null,
  activeCtx: null,
};

// ── WSL detection ──

export function isWSL(): boolean {
  return !!process.env.WSL_DISTRO_NAME;
}

// ── System theme detection ──

export async function isDarkMode(): Promise<boolean> {
  try {
    if (isWSL()) {
      // Try PowerShell first (Windows 10+), fall back to reg.exe
      try {
        const { stdout } = await execAsync(
          `powershell.exe -NoProfile -Command "(Get-ItemPropertyValue -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize' -Name AppsUseLightTheme)" 2>/dev/null`,
        );
        const trimmed = stdout.trim();
        if (trimmed === "0") return true;
        if (trimmed === "1") return false;
      } catch { /* fall through */ }

      const { stdout } = await execAsync(
        `reg.exe query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize" /v AppsUseLightTheme 2>/dev/null`,
      );
      return stdout.includes("0x0");
    }

    const os = platform();
    if (os === "darwin") {
      const { stdout } = await execAsync(
        "defaults read -g AppleInterfaceStyle 2>/dev/null || echo Light",
      );
      return stdout.trim().toLowerCase() === "dark";
    } else if (os === "win32") {
      const { stdout } = await execAsync(
        'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize" /v AppsUseLightTheme',
      );
      return stdout.includes("0x0");
    } else if (os === "linux") {
      const { stdout } = await execAsync(
        "gsettings get org.gnome.desktop.interface color-scheme 2>/dev/null || echo 'default'",
      );
      const trimmed = stdout.trim().toLowerCase();
      if (trimmed.includes("dark")) return true;
      if (trimmed.includes("light")) return false;
      const { stdout: gtk } = await execAsync(
        "gsettings get org.gnome.desktop.interface gtk-theme 2>/dev/null || echo ''",
      );
      return gtk.trim().toLowerCase().includes("dark");
    }
  } catch {
    // fallback to light
  }
  return false;
}

// ── Theme sync lifecycle ──

export async function startThemeSync(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: ThemeSyncState,
): Promise<void> {
  // Clear any existing timer and stop previous sync
  stopThemeSync(state);

  // Store the current ctx so the interval callback always uses the latest
  state.activeCtx = ctx;

  const target = await resolveTargetTheme();
  state.currentAutoTheme = target;
  ctx.ui.setTheme(target);

  state.themeTimer = setInterval(async () => {
    // Use the stored ctx (updated on each session_start)
    if (!state.activeCtx) return;
    const target = await resolveTargetTheme();
    if (target !== state.currentAutoTheme) {
      state.currentAutoTheme = target;
      state.activeCtx.ui.setTheme(target);
    }
  }, THEME_POLL_INTERVAL_MS);
}

export function stopThemeSync(state: ThemeSyncState): void {
  if (state.themeTimer) {
    clearInterval(state.themeTimer);
    state.themeTimer = null;
  }
  state.currentAutoTheme = null;
  state.activeCtx = null;
}

async function resolveTargetTheme(): Promise<string> {
  return (await isDarkMode()) ? "dark" : "light";
}

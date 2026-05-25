/**
 * shortcuts - Keyboard shortcuts for pi
 *
 * Adds:
 *   Ctrl+Shift+C  - Copy current input box content to clipboard
 */

import { execSync, spawnSync } from "node:child_process";
import { platform } from "node:os";
import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

export default function (pi: ExtensionAPI) {
  pi.registerShortcut("ctrl+shift+c", {
    description: "Copy input box content to clipboard",
    handler: async (ctx) => {
      const text = ctx.ui.getEditorText();
      if (text) {
        copyToClipboard(text);
      }
    },
  });
}

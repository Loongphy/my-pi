/**
 * /statusline Command Module
 *
 * Interactive configuration UI for toggling which items
 * appear in the status header widget.
 */

import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  STATUSLINE_ITEMS,
  saveStatusConfig,
} from "./header.ts";
import type { StatusLineConfig } from "./header.ts";

/**
 * Register the /statusline command.
 *
 * @param pi          Extension API
 * @param configRef   Mutable reference to the current config (handler mutates .current)
 * @param onUpdate    Called with ctx when the config changes (to rebuild the widget)
 * @param getTui      Returns the current TUI instance (or undefined)
 */
export function registerStatuslineCommand(
  pi: ExtensionAPI,
  configRef: { current: StatusLineConfig },
  onUpdate: (ctx: ExtensionContext) => void,
  getTui: () => TUI | undefined,
): void {
  pi.registerCommand("statusline", {
    description: "Configure which items to display in the status header",
    handler: async (_args, ctx) => {
      const savedConfig = { ...configRef.current };

      await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
        const working = { ...configRef.current };
        let selectedIdx = 0;
        let cachedWidth: number | undefined;
        let cachedLines: string[] | undefined;

        const invalidate = () => { cachedWidth = undefined; cachedLines = undefined; };

        const render = (width: number): string[] => {
          if (cachedLines && cachedWidth === width) return cachedLines;

          const lines: string[] = [];
          lines.push(theme.fg("accent", theme.bold("Configure Status Header")));
          lines.push(theme.fg("muted", "Select which items to display in the status header."));
          lines.push("");

          for (let i = 0; i < STATUSLINE_ITEMS.length; i++) {
            const item = STATUSLINE_ITEMS[i];
            const checked = working[item.id];
            const isSelected = i === selectedIdx;
            const cursor = isSelected ? theme.fg("accent", "\u203A") : " ";
            const checkbox = checked ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
            const label = isSelected ? theme.fg("accent", item.label) : theme.fg("text", item.label);
            const labelPad = 22;
            const paddedLabel = label + " ".repeat(Math.max(0, labelPad - visibleWidth(item.label)));
            const desc = theme.fg("dim", item.description);
            lines.push(truncateToWidth(`${cursor} ${checkbox} ${paddedLabel}${desc}`, width, ""));
          }

          lines.push("");
          lines.push(theme.fg("dim", "Space = toggle \u2502 Enter = confirm \u2502 Esc = cancel"));
          cachedWidth = width;
          cachedLines = lines;
          return lines;
        };

        return {
          render,
          invalidate,
          handleInput: (data: string) => {
            if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
              if (selectedIdx > 0) selectedIdx--;
              invalidate(); tui.requestRender();
            } else if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
              if (selectedIdx < STATUSLINE_ITEMS.length - 1) selectedIdx++;
              invalidate(); tui.requestRender();
            } else if (data === " ") {
              const item = STATUSLINE_ITEMS[selectedIdx];
              working[item.id] = !working[item.id];
              configRef.current = { ...working };
              onUpdate(ctx);
              getTui()?.requestRender();
              invalidate(); tui.requestRender();
            } else if (matchesKey(data, Key.enter)) {
              configRef.current = { ...working };
              saveStatusConfig(configRef.current);
              done("saved");
            } else if (matchesKey(data, Key.escape)) {
              configRef.current = { ...savedConfig };
              onUpdate(ctx);
              getTui()?.requestRender();
              done(null);
            }
          },
        };
      });
    },
  });
}

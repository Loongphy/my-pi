import { CustomEditor, DynamicBorder, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

let dynamicBorderPatched = false;

function patchDynamicBorder(theme: any) {
  if (dynamicBorderPatched) return;
  dynamicBorderPatched = true;

  const bashAnsi = theme.getFgAnsi("bashMode");
  const dimAnsi = theme.getFgAnsi("dim");
  const orig = DynamicBorder.prototype.render;

  DynamicBorder.prototype.render = function (width: number): string[] {
    const result = orig.call(this, width);
    if (result.length === 1) {
      const line = result[0] as string;
      if (line.includes(bashAnsi) || line.includes(dimAnsi)) {
        return [];
      }
    }
    return result;
  };
}

function isBorderLine(line: string): boolean {
  const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
  return /^─+$/.test(stripped) || /^─+ [↑↓] \d+ more/.test(stripped);
}

class FramedEditor extends CustomEditor {
  private appTheme;

  constructor(tui: any, editorTheme: any, keybindings: any, appTheme: any) {
    super(tui, editorTheme, keybindings);
    this.appTheme = appTheme;
  }

  render(width: number): string[] {
    const innerWidth = Math.max(10, width - 4);
    const lines = super.render(innerWidth);
    if (lines.length === 0) return lines;

    const dim = (s: string) => this.appTheme.fg("dim", s);
    const result: string[] = [];

    result.push(dim(`╭${"─".repeat(width - 2)}╮`));

    let isFirst = true;
    let autocompleteStart = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;

      if (i === 0) continue;

      if (isBorderLine(line, innerWidth)) {
        autocompleteStart = i + 1;
        break;
      }

      const prefix = isFirst ? `${dim("│")}${dim("❯")} ` : `${dim("│")}  `;
      isFirst = false;

      const lw = visibleWidth(line);
      const padding = lw < innerWidth ? " ".repeat(innerWidth - lw) : "";
      result.push(`${prefix}${line}${padding}${dim("│")}`);
    }

    result.push(dim(`╰${"─".repeat(width - 2)}╯`));

    if (autocompleteStart >= 0) {
      for (let i = autocompleteStart; i < lines.length; i++) {
        result.push(lines[i]!);
      }
    }

    return result;
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    patchDynamicBorder(ctx.ui.theme);

    ctx.ui.setEditorComponent((tui, editorTheme, kb) => {
      const editor = new FramedEditor(tui, editorTheme, kb, ctx.ui.theme);
      editor.setPaddingX(0);
      return editor;
    });
  });
}

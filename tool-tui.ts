/**
 * tool-tui - compact one-line tool rendering inspired by Devin CLI.
 *
 * Supported tools: read, write, edit, bash (and powershell).
 * Collapsed rows show only the call summary; ctrl+o expands the normal pi output.
 */

import { isAbsolute, relative } from "node:path";
import {
	ToolExecutionComponent,
	type ExtensionAPI,
	type Theme,
	type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Box, type Component, Container, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const TOOL_TUI_MARKER = "__toolTui";

function markToolTui<T extends ToolRenderers>(renderers: T): T {
	(renderers as any)[TOOL_TUI_MARKER] = true;
	return renderers;
}

/**
 * pi's ToolExecutionComponent always emits one blank line above a self-rendered tool row.
 * Drop it only between consecutive tool-tui rows; keep it when the row follows
 * assistant text/thinking or a different tool, so sections stay visually separated.
 * The wrapper is replaced on /reload so a fixed version takes effect without a restart.
 */
function findParent(root: any, target: any): any {
	const children = root?.children;
	if (!Array.isArray(children)) return undefined;
	if (children.includes(target)) return root;
	for (const child of children) {
		const parent = findParent(child, target);
		if (parent) return parent;
	}
	return undefined;
}

function parentOf(component: any): any {
	const cached = component.__toolTuiParent;
	if (cached && Array.isArray(cached.children) && cached.children.includes(component)) {
		return cached;
	}
	const parent = findParent(component.ui, component);
	if (parent) component.__toolTuiParent = parent;
	return parent;
}

const ORIGINAL_RENDER = Symbol.for("tool-tui.original-render");
const PATCHED_RENDER = Symbol.for("tool-tui.patched-render");

function installTightSpacingPatch(): void {
	const proto = ToolExecutionComponent.prototype as any;
	const current = proto.render;
	if (typeof current !== "function") return;

	// On the first load this is pi's render. On /reload it is our previous wrapper,
	// so keep the true original instead of stacking wrappers. If another extension
	// patched after us, chain through theirs instead of dropping it.
	if (current !== proto[PATCHED_RENDER]) {
		proto[ORIGINAL_RENDER] = current;
	}
	const originalRender = proto[ORIGINAL_RENDER];

	const wrapper = function (this: any, width: number) {
		const lines = originalRender.call(this, width);
		if (!this.toolDefinition?.[TOOL_TUI_MARKER] || lines.length === 0) return lines;

		const parent = parentOf(this);
		const siblings = parent?.children;
		const index = Array.isArray(siblings) ? siblings.indexOf(this) : -1;
		const previous = index > 0 ? siblings[index - 1] : undefined;
		const tight = previous?.toolDefinition?.[TOOL_TUI_MARKER] === true;
		const hasLeadingBlank = lines[0] === "";

		// Normalize instead of only dropping: a previous tool-tui wrapper may already
		// have removed the blank unconditionally, so add it back when this row starts
		// a new section (after thinking text or a different tool).
		if (tight && hasLeadingBlank) return lines.slice(1);
		if (!tight && !hasLeadingBlank) return ["", ...lines];
		return lines;
	};

	proto[PATCHED_RENDER] = wrapper;
	proto.render = wrapper;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Single-line text that truncates with an ellipsis and never wraps. */
class OneLine implements Component {
	private readonly text: string;
	private readonly keepEnd: string;
	private readonly paddingX: number;

	constructor(text: string, keepEnd = "", paddingX = 1) {
		this.text = text;
		this.keepEnd = keepEnd;
		this.paddingX = paddingX;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const available = Math.max(1, width - this.paddingX * 2);
		const suffix = this.keepEnd
			? truncateToWidth(this.keepEnd, Math.max(0, available - 1), "…")
			: "";
		const bodyWidth = Math.max(1, available - visibleWidth(suffix));
		const firstLine = this.text.split("\n")[0] ?? "";
		const body = truncateToWidth(firstLine, bodyWidth, "…");
		const pad = " ".repeat(this.paddingX);
		const withPadding = pad + body + suffix + pad;
		const fill = Math.max(0, width - visibleWidth(withPadding));
		return [withPadding + " ".repeat(fill)];
	}
}

interface ToolTuiState {
	// read
	lines?: number;
	end?: number;
	image?: boolean;

	// write/edit
	added?: number;
	removed?: number;
	fromResult?: boolean;

	// waiting spinner
	spinner?: ReturnType<typeof setInterval>;
	spinnerFrame?: number;

	// errors
	error?: string;
	exitCode?: number | null;
}

interface ToolResultLike {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: any;
	isError?: boolean;
}

interface RenderContextLike {
	args: any;
	state: ToolTuiState;
	cwd: string;
	isPartial: boolean;
	isError: boolean;
	invalidate: () => void;
}

function resultText(result: ToolResultLike): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
}

function firstLine(text: string, max = 100): string {
	const line = text.trim().split("\n")[0]?.trim() ?? "";
	return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

function asNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function displayPath(value: unknown, cwd: string): string {
	if (typeof value !== "string" || value.length === 0) return "...";
	const rel = isAbsolute(value) ? relative(cwd, value) : value;
	if (!rel) return ".";
	return rel.startsWith(".") ? rel : `./${rel}`;
}

function stopSpinner(state: ToolTuiState): void {
	if (state.spinner) {
		clearInterval(state.spinner);
		state.spinner = undefined;
	}
}

function statusIcon(ctx: RenderContextLike, theme: Theme): string {
	if (ctx.isError) {
		stopSpinner(ctx.state);
		return theme.fg("error", "✗");
	}
	if (ctx.isPartial) {
		if (!ctx.state.spinner) {
			ctx.state.spinnerFrame = 0;
			ctx.state.spinner = setInterval(() => {
				ctx.state.spinnerFrame = ((ctx.state.spinnerFrame ?? 0) + 1) % SPINNER_FRAMES.length;
				ctx.invalidate();
			}, 100);
		}
		return theme.fg("warning", SPINNER_FRAMES[ctx.state.spinnerFrame ?? 0]);
	}
	stopSpinner(ctx.state);
	return theme.fg("success", "✓");
}

function labelText(text: string, theme: Theme, ctx: RenderContextLike): string {
	const color = ctx.isError ? "error" : ctx.isPartial ? "warning" : "success";
	return theme.fg(color, theme.bold(text));
}

function verb(done: string, running: string, theme: Theme, ctx: RenderContextLike): string {
	return labelText(ctx.isPartial ? running : done, theme, ctx);
}

function countLines(value: unknown): number {
	if (typeof value !== "string" || value.length === 0) return 0;
	const text = value.endsWith("\n") ? value.slice(0, -1) : value;
	return text.length === 0 ? 0 : text.split("\n").length;
}

function readInfo(result: ToolResultLike): { lines: number; image: boolean } {
	const image = result.content.some((block) => block.type === "image");
	let text = resultText(result);
	// Strip the continuation/truncation footer the read tool appends.
	text = text.replace(/\n\n\[(?:Showing lines |\d+ more lines in file)[\s\S]*$/, "");
	const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
	return { lines: normalized.length === 0 ? 0 : normalized.split("\n").length, image };
}

function diffStats(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) added++;
		else if (line.startsWith("-") && !line.startsWith("---")) removed++;
	}
	return { added, removed };
}

function editArgsStats(args: any): { added: number; removed: number } {
	const edits = Array.isArray(args?.edits)
		? args.edits
		: args?.oldText !== undefined || args?.newText !== undefined
			? [{ oldText: args.oldText, newText: args.newText }]
			: [];
	let added = 0;
	let removed = 0;
	for (const edit of edits) {
		added += countLines(edit?.newText);
		removed += countLines(edit?.oldText);
	}
	return { added, removed };
}

function updateErrorState(result: ToolResultLike, ctx: RenderContextLike): void {
	if (!ctx.isError) return;
	const error = firstLine(resultText(result));
	if (ctx.state.error !== error) {
		ctx.state.error = error;
		ctx.invalidate();
	}
}

function updateReadState(result: ToolResultLike, ctx: RenderContextLike): void {
	if (ctx.isError) {
		updateErrorState(result, ctx);
		return;
	}

	const { lines, image } = readInfo(result);
	const start = asNumber(ctx.args?.offset) ?? 1;
	const end = lines > 0 ? start + lines - 1 : undefined;
	if (ctx.state.lines !== lines || ctx.state.image !== image || ctx.state.end !== end) {
		ctx.state.lines = lines;
		ctx.state.image = image;
		ctx.state.end = end;
		ctx.invalidate();
	}
}

function updateEditState(result: ToolResultLike, ctx: RenderContextLike): void {
	if (ctx.isError) {
		updateErrorState(result, ctx);
		return;
	}

	const diff = result.details?.diff;
	if (typeof diff !== "string") return;
	const stats = diffStats(diff);
	if (
		!ctx.state.fromResult ||
		ctx.state.added !== stats.added ||
		ctx.state.removed !== stats.removed
	) {
		ctx.state.added = stats.added;
		ctx.state.removed = stats.removed;
		ctx.state.fromResult = true;
		ctx.invalidate();
	}
}

function updateShellState(result: ToolResultLike, ctx: RenderContextLike): void {
	if (!ctx.isError) return;

	const text = resultText(result);
	const match = text.match(/Command exited with code (\d+)\s*$/);
	const exitCode = match ? Number(match[1]) : null;
	const error = match ? undefined : firstLine(text);
	if (ctx.state.exitCode !== exitCode || ctx.state.error !== error) {
		ctx.state.exitCode = exitCode;
		ctx.state.error = error;
		ctx.invalidate();
	}
}

function expandedResult(
	base: ToolRenderers | undefined,
	result: any,
	options: any,
	theme: Theme,
	ctx: any,
): Component {
	if (!options.isPartial) stopSpinner(ctx.state);
	if (!options.expanded) return new Container();
	const content = base?.renderResult?.(result, options, theme, ctx) ?? new Container();
	const box = new Box(1, 0);
	box.addChild(content);
	return box;
}

function createReadRenderer(base: ToolRenderers | undefined): ToolRenderers {
	return {
		...base,
		renderShell: "self",
		renderCall(args: any, theme, ctx) {
			const state = ctx.state as ToolTuiState;
			const start = asNumber(args?.offset) ?? 1;
			const requestedLimit = asNumber(args?.limit);
			const hasRange = args?.offset != null || args?.limit != null;
			const end =
				state.end ?? (requestedLimit !== undefined ? start + requestedLimit - 1 : undefined);

			let text = `${statusIcon(ctx, theme)} `;
			if (hasRange) {
				text += `${verb("Read lines", "Reading lines", theme, ctx)} ${theme.fg("warning", end !== undefined ? `${start}-${end}` : `${start}-…`)} ${theme.fg("toolOutput", "in")} `;
			} else {
				text += `${verb("Read", "Reading", theme, ctx)} `;
			}
			text += theme.fg("accent", displayPath(args?.path ?? args?.file_path, ctx.cwd));

			let keepEnd = "";
			if (ctx.isError && state.error) {
				keepEnd = theme.fg("error", ` ${state.error}`);
			} else if (state.image) {
				keepEnd = theme.fg("muted", " image");
			} else if (state.lines !== undefined) {
				keepEnd = theme.fg("muted", ` ${state.lines} lines`);
			} else if (requestedLimit !== undefined) {
				keepEnd = theme.fg("muted", ` ${requestedLimit} lines`);
			}
			return new OneLine(text, keepEnd);
		},
		renderResult(result, options, theme, ctx) {
			updateReadState(result as ToolResultLike, ctx);
			return expandedResult(base, result, options, theme, ctx);
		},
	};
}

function createWriteRenderer(base: ToolRenderers | undefined): ToolRenderers {
	return {
		...base,
		renderShell: "self",
		renderCall(args: any, theme, ctx) {
			const state = ctx.state as ToolTuiState;
			const content = args?.content;
			const lines = typeof content === "string" ? countLines(content) : undefined;

			let text = `${statusIcon(ctx, theme)} ${verb("Wrote", "Writing", theme, ctx)} ${theme.fg("accent", displayPath(args?.path ?? args?.file_path, ctx.cwd))}`;
			let keepEnd = "";
			if (ctx.isError && state.error) {
				keepEnd = theme.fg("error", ` ${state.error}`);
			} else if (lines !== undefined) {
				keepEnd = ` ${theme.fg("success", `+${lines}`)} ${theme.fg("error", "-0")}`;
			}
			return new OneLine(text, keepEnd);
		},
		renderResult(result, options, theme, ctx) {
			updateErrorState(result as ToolResultLike, ctx);
			return expandedResult(base, result, options, theme, ctx);
		},
	};
}

function createEditRenderer(base: ToolRenderers | undefined): ToolRenderers {
	return {
		...base,
		renderShell: "self",
		renderCall(args: any, theme, ctx) {
			const state = ctx.state as ToolTuiState;
			if (!state.fromResult) {
				const stats = editArgsStats(args);
				state.added = stats.added;
				state.removed = stats.removed;
			}

			let text = `${statusIcon(ctx, theme)} ${verb("Edited", "Editing", theme, ctx)} ${theme.fg("accent", displayPath(args?.path ?? args?.file_path, ctx.cwd))}`;
			let keepEnd = "";
			if (ctx.isError && state.error) {
				keepEnd = theme.fg("error", ` ${state.error}`);
			} else {
				keepEnd = ` ${theme.fg("success", `+${state.added ?? 0}`)} ${theme.fg("error", `-${state.removed ?? 0}`)}`;
			}
			return new OneLine(text, keepEnd);
		},
		renderResult(result, options, theme, ctx) {
			updateEditState(result as ToolResultLike, ctx);
			return expandedResult(base, result, options, theme, ctx);
		},
	};
}

function createShellRenderer(base: ToolRenderers | undefined, shellName: string): ToolRenderers {
	const label = shellName === "powershell" ? "ps" : "bash";
	return {
		...base,
		renderShell: "self",
		renderCall(args: any, theme, ctx) {
			const state = ctx.state as ToolTuiState;
			const command =
				typeof args?.command === "string" ? args.command.replace(/\n/g, " ") : "...";
			const timeout = asNumber(args?.timeout);

			let text = `${statusIcon(ctx, theme)} ${labelText(label, theme, ctx)} ${theme.fg("warning", command)}`;
			let keepEnd = "";
			if (timeout !== undefined) {
				keepEnd += theme.fg("muted", ` (timeout ${timeout}s)`);
			}
			if (ctx.isError) {
				if (state.exitCode != null) {
					keepEnd += theme.fg("error", ` (exit ${state.exitCode})`);
				} else if (state.error) {
					keepEnd += theme.fg("error", ` ${state.error}`);
				}
			}
			return new OneLine(text, keepEnd);
		},
		renderResult(result, options, theme, ctx) {
			updateShellState(result as ToolResultLike, ctx);
			return expandedResult(base, result, options, theme, ctx);
		},
	};
}

export default function (pi: ExtensionAPI) {
	installTightSpacingPatch();
	pi.registerToolRenderer((name, next): ToolRenderers | undefined => {
		const base = next();
		switch (name) {
			case "read":
				return markToolTui(createReadRenderer(base));
			case "write":
				return markToolTui(createWriteRenderer(base));
			case "edit":
				return markToolTui(createEditRenderer(base));
			case "bash":
				return markToolTui(createShellRenderer(base, "bash"));
			case "powershell":
				return markToolTui(createShellRenderer(base, "powershell"));
			default:
				return base;
		}
	});
}

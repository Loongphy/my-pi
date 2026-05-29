/**
 * Compact Tool Renderer Extension
 *
 * Inspired by Codex's "Exploring" mode - consolidates consecutive file reads
 * and search operations into single-line summaries.
 *
 * Features:
 * - Consecutive read operations are merged: "Read file1.ts, file2.ts, file3.ts"
 * - Search/grep operations show compact: "Search 'pattern' in path"
 * - Find/ls operations show compact: "List path"
 * - Tool results show line counts instead of full content
 *
 * Usage: pi -e ./compact-tool-renderer.ts
 */

import type {
	EditToolDetails,
	ExtensionAPI,
	ReadToolDetails,
} from "@earendil-works/pi-coding-agent";
import {
	createBashTool,
	createEditToolDefinition,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

// ============================================================================
// Helper: render compact Codex-style tool lines.
// ============================================================================

function toolLine(text: string, theme: any): Text {
	return new Text(`${theme.fg("dim", "•")} ${text.replace(/\n/g, "\n  ")}`, 0, 0);
}

function indentedText(text: string): Text {
	return new Text(text, 2, 0);
}

function commandOutputText(text: string): Text {
	const lines = text.split("\n");
	const rendered = lines
		.map((line, index) => `${index === 0 ? "  └ " : "    "}${line}`)
		.join("\n");
	return new Text(rendered, 0, 0);
}

function countTextLines(text: string): number {
	if (text.length === 0) return 0;
	return text.split("\n").length;
}

function formatLineRange(start: number | undefined, end: number | undefined, theme: any): string {
	if (start === undefined) return "";
	if (end === undefined || end === start) {
		return theme.fg("success", `:${start}`);
	}
	return theme.fg("success", `:${start}-${end}`);
}

function countDiffStats(diff: string): { additions: number; removals: number } {
	let additions = 0;
	let removals = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) additions++;
		if (line.startsWith("-") && !line.startsWith("---")) removals++;
	}
	return { additions, removals };
}

function formatAdditions(additions: number, theme: any): string {
	return `${theme.fg("dim", "(")}${theme.fg("success", `+${additions}`)}${theme.fg("dim", ")")}`;
}

function formatDiffStats(additions: number, removals: number, theme: any): string {
	return `${theme.fg("dim", "(")}${theme.fg("success", `+${additions}`)} ${theme.fg("error", `-${removals}`)}${theme.fg("dim", ")")}`;
}

function appendStatsToEditHeader(component: Component, stats: string | undefined) {
	if (!stats || !("children" in component)) return component;
	const children = (component as any).children;
	const header = Array.isArray(children) ? children[0] : undefined;
	if (!header || typeof header.setText !== "function" || typeof header.text !== "string") return component;

	const baseText = header.text.replace(/\s+\(\+\d+\s+-\d+\)$/, "");
	header.setText(`${baseText} ${stats}`);
	return component;
}

function padToWidth(line: string, width: number): string {
	const padding = Math.max(0, width - visibleWidth(line));
	return line + " ".repeat(padding);
}

function bashCallLine(command: string, theme: any): Component {
	return {
		render(width: number): string[] {
			const prefix = `${theme.fg("dim", "•")} ${theme.fg("toolTitle", theme.bold("Ran "))}`;
			const continuationPrefix = "  │ ";
			const firstWidth = Math.max(1, width - visibleWidth(prefix));
			const continuationWidth = Math.max(1, width - visibleWidth(continuationPrefix));
			const commandLines = wrapTextWithAnsi(theme.fg("accent", command), firstWidth);
			const lines: string[] = [];

			if (commandLines.length === 0) {
				return [padToWidth(prefix.trimEnd(), width)];
			}

			lines.push(padToWidth(prefix + commandLines[0], width));
			for (let index = 1; index < commandLines.length; index++) {
				for (const wrappedLine of wrapTextWithAnsi(commandLines[index], continuationWidth)) {
					lines.push(padToWidth(continuationPrefix + wrappedLine, width));
				}
			}
			return lines;
		},
	};
}

// ============================================================================
// Global state for tool aggregation
// ============================================================================

interface PendingToolCall {
	toolName: string;
	args: any;
	toolCallId: string;
}

// Track pending tool calls for aggregation
const pendingExploreCalls: PendingToolCall[] = [];
const BATCH_WINDOW_MS = 2000; // Consider calls within 2s as part of the same batch
let lastExploreTime = 0;

function addPendingExplore(toolName: string, args: any, toolCallId: string) {
	const now = Date.now();
	
	// Clear old calls if batch window expired
	if (now - lastExploreTime > BATCH_WINDOW_MS) {
		pendingExploreCalls.length = 0;
	}
	
	// Only add if not already in the list
	if (!pendingExploreCalls.find(c => c.toolCallId === toolCallId)) {
		pendingExploreCalls.push({ toolName, args, toolCallId });
	}
	
	lastExploreTime = now;
}

function getExploreSummary(cwd: string): { toolName: string; details: string[] }[] {
	const summary: Map<string, string[]> = new Map();
	
	for (const call of pendingExploreCalls) {
		const { toolName, args } = call;
		
		if (toolName === "read") {
			const filePath = args.path || "unknown";
			// Show relative path if possible
			const displayPath = filePath.startsWith(cwd) ? filePath.slice(cwd.length + 1) : filePath;
			if (!summary.has("read")) {
				summary.set("read", []);
			}
			summary.get("read")!.push(displayPath);
		} else if (toolName === "grep") {
			const pattern = args.pattern || "";
			const searchPath = args.path ? args.path.replace(cwd, "").replace(/^\//, "") : "";
			summary.set("grep", [`${pattern}${searchPath ? ` in ${searchPath}` : ""}`]);
		} else if (toolName === "find") {
			const searchPath = args.path ? args.path.replace(cwd, "").replace(/^\//, "") : ".";
			summary.set("find", [`"${args.pattern || ""}" in ${searchPath}`]);
		} else if (toolName === "ls") {
			const lsPath = args.path ? args.path.replace(cwd, "").replace(/^\//, "") : ".";
			summary.set("ls", [lsPath]);
		}
	}
	
	return Array.from(summary.entries()).map(([toolName, details]) => ({ toolName, details }));
}

function isFirstExploreCall(toolCallId: string): boolean {
	return pendingExploreCalls.length > 0 && pendingExploreCalls[0].toolCallId === toolCallId;
}

function isInExploreBatch(toolCallId: string): boolean {
	// Check if this tool call is part of a batch (not the first one)
	const index = pendingExploreCalls.findIndex(c => c.toolCallId === toolCallId);
	return index > 0;
}

// ============================================================================
// Shell detection helpers
// ============================================================================

function extractCommand(command: string): string {
	const bashLcMatch = command.match(/^(?:\/bin\/)?(?:ba)?sh\s+-lc\s+(.+)$/s);
	if (bashLcMatch) {
		return bashLcMatch[1];
	}
	const zshMatch = command.match(/^(?:\/bin\/)?zsh\s+(?:-[cl]\s+)?(.+)$/s);
	if (zshMatch) {
		return zshMatch[1];
	}
	const fishMatch = command.match(/^(?:\/bin\/)?fish\s+(?:-[cl]\s+)?(.+)$/s);
	if (fishMatch) {
		return fishMatch[1];
	}
	const shMatch = command.match(/^\/bin\/sh\s+(?:-[cl]\s+)?(.+)$/s);
	if (shMatch) {
		return shMatch[1];
	}
	return command;
}

// ============================================================================
// Main extension
// ============================================================================

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();

	// --- Read tool: Codex-style rendering (no box, with aggregation) ---
	const originalRead = createReadTool(cwd);
	pi.registerTool({
		name: "read",
		label: "read",
		description: originalRead.description,
		parameters: originalRead.parameters,
		renderShell: "self",

		async execute(toolCallId, params, signal, onUpdate) {
			return originalRead.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme, context) {
			// Register this tool call for aggregation
			addPendingExplore("read", args, context.toolCallId);
			
			// Check if this is the first explore call
			const isFirst = isFirstExploreCall(context.toolCallId);
			
			if (isFirst && pendingExploreCalls.length > 1) {
				// Show aggregated summary
				const summary = getExploreSummary(cwd);
				let text = "";
				
				for (const { toolName, details } of summary) {
					if (text) text += "\n";
					text += theme.fg("toolTitle", theme.bold(`${toolName} `));
					text += theme.fg("accent", details.join(", "));
				}
				
				return toolLine(text, theme);
			}
			
			if (isFirst) {
				// Single read - show full path
				const filePath = args.path || "unknown";
				const displayPath = filePath.startsWith(cwd) ? filePath.slice(cwd.length + 1) : filePath;
				const state = context.state as any;
				const startLine = state.startLine ?? (args.offset ?? (args.limit !== undefined ? 1 : undefined));
				const endLine =
					state.endLine ??
					(args.limit !== undefined ? (args.offset ?? 1) + args.limit - 1 : undefined);
				
				let text = theme.fg("toolTitle", theme.bold("read "));
				text += theme.fg("accent", displayPath);
				text += formatLineRange(startLine, endLine, theme);
				
				return toolLine(text, theme);
			}
			
			// Not first - hide this call (it's included in the first call's summary)
			return new Text("", 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			// If this call is part of a batch (not first), hide the result
			if (isInExploreBatch(context.toolCallId)) {
				return new Text("", 0, 0);
			}

			if (isPartial) return indentedText(theme.fg("warning", "Reading..."));

			const details = result.details as ReadToolDetails | undefined;
			const content = result.content[0];

			if (content?.type === "image") {
				return indentedText(theme.fg("success", "Image loaded"));
			}

			if (content?.type !== "text") {
				return indentedText(theme.fg("error", "No content"));
			}

			const startLine = context.args?.offset ?? 1;
			const lineCount = countTextLines(content.text);
			if (lineCount > 0) {
				const state = context.state as any;
				const endLine = startLine + lineCount - 1;
				if (state.startLine !== startLine || state.endLine !== endLine) {
					state.startLine = startLine;
					state.endLine = endLine;
					context.invalidate();
				}
			}

			// Don't show anything in collapsed mode
			if (!expanded) {
				return new Text("", 0, 0);
			}

			// Show content when expanded
			const lines = content.text.split("\n").slice(0, 15);
			let text = "";
			for (const line of lines) {
				text += `${theme.fg("dim", line)}\n`;
			}
			if (content.text.split("\n").length > 15) {
				text += theme.fg("muted", `... ${content.text.split("\n").length - 15} more lines`);
			}
			return indentedText(text.trimEnd());
		},
	});

	// --- Grep tool: compact search rendering (no box, with aggregation) ---
	const originalGrep = createGrepTool(cwd);
	pi.registerTool({
		name: "grep",
		label: "grep",
		description: originalGrep.description,
		parameters: originalGrep.parameters,
		renderShell: "self",

		async execute(toolCallId, params, signal, onUpdate) {
			return originalGrep.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme, context) {
			// Register this tool call for aggregation
			addPendingExplore("grep", args, context.toolCallId);
			
			// Check if this is the first explore call
			const isFirst = isFirstExploreCall(context.toolCallId);
			
			if (isFirst && pendingExploreCalls.length > 1) {
				// Show aggregated summary
				const summary = getExploreSummary(cwd);
				let text = "";
				
				for (const { toolName, details } of summary) {
					if (text) text += "\n";
					text += theme.fg("toolTitle", theme.bold(`${toolName} `));
					text += theme.fg("accent", details.join(", "));
				}
				
				return toolLine(text, theme);
			}
			
			if (isFirst) {
				// Single grep - show pattern
				let text = theme.fg("toolTitle", theme.bold("grep "));
				text += theme.fg("accent", `"${args.pattern}"`);

				if (args.path) {
					const displayPath = args.path.startsWith(cwd)
						? args.path.slice(cwd.length + 1)
						: args.path;
					text += theme.fg("muted", ` in ${displayPath}`);
				}

				return toolLine(text, theme);
			}
			
			// Not first - hide this call
			return new Text("", 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			// If this call is part of a batch (not first), hide the result
			if (isInExploreBatch(context.toolCallId)) {
				return new Text("", 0, 0);
			}

			// Don't show any result text
			return new Text("", 0, 0);
		},
	});

	// --- Find tool: compact file listing (no box, with aggregation) ---
	const originalFind = createFindTool(cwd);
	pi.registerTool({
		name: "find",
		label: "find",
		description: originalFind.description,
		parameters: originalFind.parameters,
		renderShell: "self",

		async execute(toolCallId, params, signal, onUpdate) {
			return originalFind.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme, context) {
			// Register this tool call for aggregation
			addPendingExplore("find", args, context.toolCallId);
			
			// Check if this is the first explore call
			const isFirst = isFirstExploreCall(context.toolCallId);
			
			if (isFirst && pendingExploreCalls.length > 1) {
				// Show aggregated summary
				const summary = getExploreSummary(cwd);
				let text = "";
				
				for (const { toolName, details } of summary) {
					if (text) text += "\n";
					text += theme.fg("toolTitle", theme.bold(`${toolName} `));
					text += theme.fg("accent", details.join(", "));
				}
				
				return toolLine(text, theme);
			}
			
			if (isFirst) {
				// Single find - show pattern
				let text = theme.fg("toolTitle", theme.bold("find "));

				if (args.pattern) {
					text += theme.fg("accent", `"${args.pattern}"`);
				}

				if (args.path) {
					const displayPath = args.path.startsWith(cwd)
						? args.path.slice(cwd.length + 1)
						: args.path;
					text += theme.fg("muted", ` in ${displayPath}`);
				}

				return toolLine(text, theme);
			}
			
			// Not first - hide this call
			return new Text("", 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			// If this call is part of a batch (not first), hide the result
			if (isInExploreBatch(context.toolCallId)) {
				return new Text("", 0, 0);
			}

			// Don't show any result text
			return new Text("", 0, 0);
		},
	});

	// --- Bash tool: Codex-style rendering (no box) ---
	const originalBash = createBashTool(cwd);
	pi.registerTool({
		name: "bash",
		label: "bash",
		description: originalBash.description,
		parameters: originalBash.parameters,
		renderShell: "self",

		async execute(toolCallId, params, signal, onUpdate) {
			return originalBash.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme, _context) {
			const command = args.command || "";
			const displayCommand = extractCommand(command);

			return bashCallLine(displayCommand, theme);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			if (isPartial) return commandOutputText(theme.fg("warning", "Running..."));

			const content = result.content[0];
			const output = content?.type === "text" ? content.text : "";

			// Check for error
			if (content?.type === "text" && content.text.startsWith("Error")) {
				return commandOutputText(theme.fg("error", content.text));
			}

			// Extract exit code from output
			const exitMatch = output.match(/exit code: (\d+)/);
			const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : 0;

			// Get clean output (remove exit code line if present)
			const cleanOutput = output.replace(/exit code: \d+\n?/, "").trim();
			const hasOutput = cleanOutput.length > 0;

			if (!hasOutput) {
				if (exitCode !== 0) {
					return commandOutputText(theme.fg("error", `exit ${exitCode} (no output)`));
				}
				return commandOutputText(theme.fg("dim", "(no output)"));
			}

			// Has output - show with indentation like Codex
			const lines = cleanOutput.split("\n");
			let text = "";

			if (exitCode !== 0) {
				text += theme.fg("error", `exit ${exitCode}`) + "\n";
			}

			const maxLines = expanded ? 50 : 10;
			const displayLines = lines.slice(0, maxLines);
			for (const line of displayLines) {
				text += `${theme.fg("dim", line)}\n`;
			}

			if (lines.length > maxLines) {
				text += theme.fg("muted", `... ${lines.length - maxLines} more lines`);
			}

			return commandOutputText(text.trimEnd());
		},
	});

	// --- Edit tool: Pi default success renderer with compact failure rendering. ---
	const originalEdit = createEditToolDefinition(cwd);
	pi.registerTool({
		name: "edit",
		label: "edit",
		description: originalEdit.description,
		parameters: originalEdit.parameters,
		renderShell: "self",

		async execute(toolCallId, params, signal, onUpdate) {
			return originalEdit.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme, context) {
			const filePath = args.path || args.file_path || "unknown";
			const displayPath = filePath.startsWith(cwd) ? filePath.slice(cwd.length + 1) : filePath;
			const state = context.state as any;

			if (state.isFailed) {
				let text = theme.fg("error", "✗ ");
				text += theme.fg("toolTitle", "edit ");
				text += theme.fg("accent", displayPath);
				if (state.additions !== undefined || state.removals !== undefined) {
					text += ` ${formatDiffStats(state.additions ?? 0, state.removals ?? 0, theme)}`;
				}
				return new Text(text, 0, 0);
			}

			const component = originalEdit.renderCall?.(args, theme, context) ?? new Text("", 0, 0);
			const stats =
				state.additions !== undefined || state.removals !== undefined
					? formatDiffStats(state.additions ?? 0, state.removals ?? 0, theme)
					: undefined;
			return appendStatsToEditHeader(component, stats);
		},

		renderResult(result, options, theme, context) {
			const { isPartial } = options;
			if (isPartial) return new Text("", 0, 0);

			const content = result.content[0];
			const isError =
				context.isError ||
				(content?.type === "text" && (content.text.includes("Error") || content.text.includes("Could not")));

			if (isError) {
				const state = context.state as any;
				if (!state.isFailed) {
					state.isFailed = true;
					context.invalidate();
				}
				return new Text("", 0, 0);
			}

			const details = result.details as EditToolDetails | undefined;
			if (!details?.diff) {
				return new Text("", 0, 0);
			}

			const { additions, removals } = countDiffStats(details.diff);
			const state = context.state as any;
			if (state.additions !== additions || state.removals !== removals) {
				state.additions = additions;
				state.removals = removals;
				context.invalidate();
			}

			return originalEdit.renderResult?.(result, options, theme, context) ?? new Text("", 0, 0);
		},
	});

	// --- Write tool: compact tool-name rendering. ---
	const originalWrite = createWriteTool(cwd);
	pi.registerTool({
		name: "write",
		label: "write",
		description: originalWrite.description,
		parameters: originalWrite.parameters,
		renderShell: "self",

		async execute(toolCallId, params, signal, onUpdate) {
			return originalWrite.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme, context) {
			const filePath = args.path || "unknown";
			const displayPath = filePath.startsWith(cwd) ? filePath.slice(cwd.length + 1) : filePath;

			// Check if failed
			const state = context.state as any;
			const isFailed = state?.isFailed === true;
			const lineCount =
				state?.lineCount ?? (typeof args.content === "string" ? countTextLines(args.content) : undefined);

			let text = "";
			if (isFailed) {
				text += theme.fg("error", "✗ ");
				text += theme.fg("toolTitle", "write ");
				text += theme.fg("accent", displayPath);
				if (lineCount !== undefined) {
					text += ` ${formatAdditions(lineCount, theme)}`;
				}
			} else {
				text += theme.fg("toolTitle", theme.bold("write "));
				text += theme.fg("accent", displayPath);

				if (lineCount !== undefined) {
					text += ` ${formatAdditions(lineCount, theme)}`;
				}
			}

			return toolLine(text, theme);
		},

		renderResult(result, { isPartial }, theme, context) {
			if (isPartial) return indentedText(theme.fg("warning", "Writing..."));

			const content = result.content[0];

			if (content?.type === "text" && content.text.includes("Error")) {
				(context.state as any).isFailed = true;
				return new Text("", 0, 0);
			}

			const args = context.args;
			if (args?.content) {
				const state = context.state as any;
				const lineCount = countTextLines(args.content);
				if (state.lineCount !== lineCount) {
					state.lineCount = lineCount;
					context.invalidate();
				}
			}

			return new Text("", 0, 0);
		},
	});

	// --- Ls tool: compact directory listing (no box, with aggregation) ---
	const originalLs = createLsTool(cwd);
	pi.registerTool({
		name: "ls",
		label: "ls",
		description: originalLs.description,
		renderShell: "self",
		parameters: originalLs.parameters,

		async execute(toolCallId, params, signal, onUpdate) {
			return originalLs.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme, context) {
			// Register this tool call for aggregation
			addPendingExplore("ls", args, context.toolCallId);
			
			// Check if this is the first explore call
			const isFirst = isFirstExploreCall(context.toolCallId);
			
			if (isFirst && pendingExploreCalls.length > 1) {
				// Show aggregated summary
				const summary = getExploreSummary(cwd);
				let text = "";
				
				for (const { toolName, details } of summary) {
					if (text) text += "\n";
					text += theme.fg("toolTitle", theme.bold(`${toolName} `));
					text += theme.fg("accent", details.join(", "));
				}
				
				return toolLine(text, theme);
			}
			
			if (isFirst) {
				// Single ls - show path
				let text = theme.fg("toolTitle", theme.bold("ls "));

				if (args.path) {
					const displayPath = args.path.startsWith(cwd)
						? args.path.slice(cwd.length + 1)
						: args.path;
					text += theme.fg("accent", displayPath || ".");
				} else {
					text += theme.fg("accent", ".");
				}

				return toolLine(text, theme);
			}
			
			// Not first - hide this call
			return new Text("", 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			// If this call is part of a batch (not first), hide the result
			if (isInExploreBatch(context.toolCallId)) {
				return new Text("", 0, 0);
			}

			if (isPartial) return indentedText(theme.fg("warning", "Listing..."));

			const content = result.content[0];
			const output = content?.type === "text" ? content.text : "";

			const entryCount = output.split("\n").filter((l) => l.trim()).length;

			if (entryCount === 0) {
				return indentedText(theme.fg("dim", "Empty directory"));
			}

			// Don't show entry count, just show expanded content if needed
			if (expanded) {
				const lines = output.split("\n").slice(0, 20);
				let text = "";
				for (const line of lines) {
					text += `${theme.fg("dim", line)}\n`;
				}
				if (entryCount > 20) {
					text += theme.fg("muted", `... ${entryCount - 20} more entries`);
				}
				return indentedText(text.trimEnd());
			}

			return new Text("", 0, 0);
		},
	});
}

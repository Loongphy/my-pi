/**
 * Collapse Tools Extension
 *
 * Shows compact tool call info (name + key parameters), but hides output by default.
 * Press Ctrl+O to expand/collapse and view full output.
 * Fully adapts to the system theme — no hardcoded colors.
 */

import type {
    EditToolDetails,
    ExtensionAPI,
    ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
    createBashTool,
    createEditTool,
    createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

// ── helper: render a compact tool-call line ──────────────────────────

function formatRenderCall(
    toolName: string,
    args: Record<string, unknown>,
    theme: any,
): string {
    const title = theme.fg("toolTitle", theme.bold(toolName));
    let params = "";

    switch (toolName) {
        case "bash": {
            params = theme.fg("muted", args.command ?? "");
            if (args.timeout)
                params += theme.fg("dim", ` (timeout: ${args.timeout}s)`);
            break;
        }

        case "write": {
            params = theme.fg("accent", args.path ?? "");
            if (typeof args.content === "string") {
                const lines = args.content.split("\n").length;
                params += theme.fg("dim", ` (${lines} lines)`);
            }
            break;
        }
        case "edit": {
            params = theme.fg("accent", args.path ?? "");
            if (Array.isArray(args.edits)) {
                params += theme.fg(
                    "dim",
                    ` (${args.edits.length} edit${args.edits.length > 1 ? "s" : ""})`,
                );
            }
            break;
        }

        default:
            params = theme.fg("dim", JSON.stringify(args));
    }

    return `${title} ${params}`;
}

// ── helper: render a unified diff with theme colors ──────────────────

function renderThemedDiff(diffText: string, theme: any): string {
    return diffText
        .split("\n")
        .map((line) => {
            const clean = line.replace(/\t/g, "   ");
            if (clean.startsWith("+")) return theme.fg("toolDiffAdded", clean);
            if (clean.startsWith("-"))
                return theme.fg("toolDiffRemoved", clean);
            if (clean.startsWith("@"))
                return theme.fg("toolDiffContext", clean);
            return theme.fg("dim", clean);
        })
        .join("\n");
}

// ── helper: create renderResult for each tool ────────────────────────

function makeRenderResult(
    toolName: string,
    originalRenderResult?: (
        result: any,
        options: ToolRenderResultOptions,
        theme: any,
        context: any,
    ) => any,
) {
    return (
        result: any,
        options: ToolRenderResultOptions,
        theme: any,
        context: any,
    ) => {
        const { expanded, isPartial } = options;

        // While running: show a minimal indicator
        if (isPartial) {
            return new Text(theme.fg("dim", "Running..."), 0, 0);
        }

        // Collapsed (default) — empty, but valid so pi doesn't crash
        if (!expanded) {
            return new Text("", 0, 0);
        }

        // Expanded — special-case edit to show diff (matches default behaviour)
        if (toolName === "edit") {
            const diff = (result.details as EditToolDetails | undefined)?.diff;
            if (typeof diff === "string" && diff.trim().length > 0) {
                return new Text("\n" + renderThemedDiff(diff, theme), 0, 0);
            }
        }

        // Expanded — use original renderer if the tool provides one
        if (originalRenderResult) {
            return originalRenderResult(result, options, theme, context);
        }

        // Expanded — fallback: show raw text content
        const textContent = result.content?.find((c: any) => c.type === "text");
        const text = textContent?.type === "text" ? textContent.text : "";
        return new Text(text ? "\n" + theme.fg("toolOutput", text) : "", 0, 0);
    };
}

// ── main extension factory ───────────────────────────────────────────

export default function (pi: ExtensionAPI) {
    const cwd = process.cwd();

    // Override the 4 default built-in tools
    const DEFAULT_TOOLS = ["bash", "edit", "write"] as const;
    for (const name of DEFAULT_TOOLS) {
        overrideTool(name);
    }

    // ── Create original tool instances and override them ──────────────

    function overrideTool(name: string) {
        const factories: Record<
            string,
            () => {
                name: string;
                label: string;
                description: string;
                parameters: any;
                execute: any;
                renderCall?: any;
                renderResult?: any;
            }
        > = {
            bash: () => createBashTool(cwd),
            write: () => createWriteTool(cwd),
            edit: () => createEditTool(cwd),
        };

        const factory = factories[name];
        if (!factory) return;

        const tool = factory();
        const toolDef = tool as any;
        pi.registerTool({
            name: tool.name,
            label: tool.label,
            description: tool.description,
            parameters: tool.parameters,
            renderShell: toolDef.renderShell ?? "default",
            prepareArguments: toolDef.prepareArguments,
            executionMode: toolDef.executionMode,
            execute: tool.execute,
            renderCall: (args: any, theme: any) => {
                return new Text(
                    formatRenderCall(tool.name, args ?? {}, theme),
                    0,
                    0,
                );
            },
            renderResult: makeRenderResult(tool.name, tool.renderResult),
        });
    }
}

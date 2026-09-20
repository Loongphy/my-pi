/**
 * Session Workbench
 *
 * Two capabilities:
 *  1) Persistent status bar (setStatus): shows the currently executing
 *     tool/command in real time, cleared automatically when it finishes.
 *     ⏳ bash: npm run build
 *
 *  2) Alt+H or /workbench: opens an overlay panel — a single list of all
 *     user messages (newest first), COLLAPSED by default: the selected row
 *     expands in place to show the user message plus the assistant's final
 *     text reply only. Thinking, tool calls and other intermediate steps
 *     stay hidden in this view.
 *
 *     Layout: /tree list style — `›` cursor, accent `user:` / success
 *     `assistant:` role labels, fixed 5-column timestamp (HH:MM), wrapped
 *     continuation lines align under their label, no dim styling.
 *
 *     Enter opts into a deep preview of the selected turn: the full process
 *     in /tree list style — one row per step: thinking, every tool call with
 *     its ✓/✗ status, and the final reply, as `•` bullets. ↑↓ selects a
 *     step; Enter opens that step's full content (scrollable). Enter on the
 *     user row reuses the message; Esc returns to the list. The cursor
 *     lands on the first assistant text row; g/G (Home/End) jump to the
 *     top/bottom.
 *
 *     V opens a reader for the final reply itself: original line breaks
 *     preserved, wrapped and scrollable — for reading/copying the answer
 *     verbatim without digging through the process.
 *
 *       ↑↓ select · PgUp/PgDn scroll · V read reply · Enter detail
 *       C copy · Esc / Q close
 *
 * Install: save to ~/.pi/agent/extensions/session-workbench.ts,
 *          add "./session-workbench.ts" to the pi.extensions list in package.json,
 *          then /reload.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { execSync, spawnSync } from "node:child_process";
import { platform } from "node:os";
import { readFileSync } from "node:fs";

// ═══════════════════════════════════════════════════════════════
// Status bar: live label for the currently executing tool/command,
// cleared automatically when it finishes
// ═══════════════════════════════════════════════════════════════

const STATUS_KEY = "workbench.activity";

function summarizeArgs(toolName: string, args: unknown): string {
	try {
		const a = (args ?? {}) as Record<string, unknown>;
		switch (toolName) {
			case "bash":
				return typeof a.command === "string" ? a.command : "";
			case "read":
			case "write":
			case "edit":
				return typeof a.filePath === "string" ? a.filePath : typeof a.path === "string" ? a.path : "";
			case "grep":
				return `${a.pattern ?? ""}${typeof a.path === "string" ? " " + a.path : ""}`.trim();
			case "find":
				return typeof a.path === "string" ? a.path : "";
			case "ls":
				return typeof a.path === "string" ? a.path : ".";
			default: {
				if (!args) return "";
				const s = JSON.stringify(args);
				return s.length > 80 ? s.slice(0, 80) + "…" : s;
			}
		}
	} catch {
		return "";
	}
}

// ═══════════════════════════════════════════════════════════════
// History extraction: collapsed view = user message + final text
// reply; the full step-by-step process stays available behind Enter
// ═══════════════════════════════════════════════════════════════

interface TurnStep {
	kind: "text" | "thinking" | "tool" | "toolResult";
	text?: string; // text body (assistant reply) or thinking content
	toolName?: string;
	argsSummary?: string;
	/** Full tool result text (capped); shown in the step detail view. */
	resultText?: string;
	isError?: boolean;
}

/** Cap for stored tool-result text so the step view stays responsive. */
const MAX_RESULT_CHARS = 20_000;

interface HistoryItem {
	id: string;
	text: string;
	timestamp: string;
	/** Final assistant text reply ("" until one arrives); shown when expanded. */
	reply: string;
	/** Full process of the turn (deep preview), in execution order. */
	turn: TurnStep[];
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((p: unknown) => (p as { type?: string; text?: unknown })?.type === "text")
			.map((p: unknown) => (p as { text: string }).text ?? "")
			.join("\n");
	}
	return "";
}

function collectHistory(entries: readonly { type: string; id: string; timestamp: string; message?: unknown }[]): HistoryItem[] {
	const result: HistoryItem[] = [];
	let current: HistoryItem | null = null;
	let turn: TurnStep[] = [];
	let replyParts: string[] = [];

	const flush = () => {
		if (current) {
			current.reply = replyParts.join("\n");
			current.turn = turn;
			result.push(current);
		}
	};

	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message) continue;
		const msg = entry.message as {
			role?: string;
			content?: unknown;
			toolName?: string;
			isError?: boolean;
		};
		if (msg.role === "user") {
			flush();
			const text = contentText(msg.content);
			if (text.trim()) {
				current = { id: entry.id, text, timestamp: entry.timestamp, reply: "", turn: [] };
				turn = [];
				replyParts = [];
			} else {
				current = null;
			}
		} else if (msg.role === "assistant") {
			const parts = Array.isArray(msg.content) ? msg.content : [];
			for (const p of parts as Array<{ type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown }>) {
				if (p?.type === "text" && typeof p.text === "string") {
					if (p.text.trim()) {
						turn.push({ kind: "text", text: p.text });
						replyParts.push(p.text);
					}
				} else if (p?.type === "thinking" && typeof p.thinking === "string") {
					if (p.thinking.trim()) turn.push({ kind: "thinking", text: p.thinking });
				} else if (p?.type === "toolCall" && p.name) {
					turn.push({ kind: "tool", toolName: p.name, argsSummary: summarizeArgs(p.name, p.arguments) });
				}
			}
		} else if (msg.role === "toolResult") {
			const t = contentText(msg.content);
			turn.push({
				kind: "toolResult",
				toolName: msg.toolName,
				resultText: t.slice(0, MAX_RESULT_CHARS),
				isError: msg.isError,
			});
		}
	}
	flush();
	return result;
}

// ═══════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════

/** Timestamp: always "HH:MM" (compact, fixed-width column). */
function fmtTimestamp(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "??:??";
	const two = (n: number) => String(n).padStart(2, "0");
	return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

function padRight(s: string, len: number): string {
	const vw = visibleWidth(s);
	return s + " ".repeat(Math.max(0, len - vw));
}

function isWSL(): boolean {
	try {
		return /microsoft|wsl/i.test(readFileSync("/proc/version", "utf8"));
	} catch {
		return false;
	}
}

function copyText(text: string): boolean {
	if (!text) return false;
	try {
		const os = platform();
		if (os === "darwin") {
			execSync("pbcopy", { input: text });
		} else if (os === "win32") {
			execSync("clip", { input: text });
		} else if (isWSL()) {
			spawnSync(
				"powershell.exe",
				[
					"-NoProfile",
					"-Command",
					"[Console]::InputEncoding = [System.Text.Encoding]::UTF8; $ErrorActionPreference = 'Stop'; $text = [Console]::In.ReadToEnd(); Set-Clipboard -Value $text",
				],
				{ input: text, timeout: 5000, stdio: ["pipe", "ignore", "pipe"] },
			);
		} else {
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

// ═══════════════════════════════════════════════════════════════
// Overlay component
// ═══════════════════════════════════════════════════════════════

interface ComponentLike {
	render(width: number): string[];
	handleInput?(data: string): void;
	invalidate(): void;
	dispose?(): void;
}

// ── Layout & timing constants ──
// Fixed timestamp column width; keeps the message body column stable.
const TIME_W = 5;
// Tree-style list columns: "› HH:MM user: " vs the deeper "assistant: " rows.
const MSG_COL_W = 14;
const REPLY_COL_W = 19;
const REPLY_LABEL = "assistant: ";
// Overlay panel height clamp (terminal rows minus border/title/hint chrome).
const PANEL_MIN_ROWS = 12;
const PANEL_MAX_ROWS = 30;
const PANEL_CHROME_ROWS = 6;
// Transient clipboard-flash lifetime & its poll interval.
const FLASH_MS = 2000;
const FLASH_POLL_MS = 250;
// PgUp/PgDn jump size (list rows or text lines depending on view).
const PAGE_STEP = 8;

/** One selectable row in the turn overview: the user message or a step. */
interface OverviewRow {
	kind: "user" | "thinking" | "tool" | "text";
	step?: TurnStep;
	/** The tool's result step (tool rows only); merged as ✓/✗ status. */
	result?: TurnStep;
}

class WorkbenchComponent implements ComponentLike {
	private selected = 0;
	private previewScroll = 0;
	private rows: number;
	private timer: ReturnType<typeof setInterval> | null = null;
	private flashMsg: string | null = null;
	private flashUntil = 0;
	private mode: "list" | "detail" | "step" | "reply" = "list";
	/** Selected row in the turn overview (0 = user row, then steps). */
	private stepSel = 0;
	/** Scroll offset inside the step/reply reader views. */
	private stepScroll = 0;

	constructor(
		private tui: { terminal: { rows: number; columns: number }; requestRender(force?: boolean): void },
		private theme: {
			fg(color: string, text: string): string;
			bg(color: string, text: string): string;
			bold(text: string): string;
		},
		private done: () => void,
		private useText: (text: string) => void,
		private history: HistoryItem[],
	) {
		this.rows = Math.max(PANEL_MIN_ROWS, Math.min(PANEL_MAX_ROWS, tui.terminal.rows - PANEL_CHROME_ROWS));
		// Start with the newest user message selected
		this.selected = Math.max(0, this.history.length - 1);
		// Timer only drives the transient "copied" flash
		this.timer = setInterval(() => {
			if (this.flashMsg && Date.now() > this.flashUntil) {
				this.flashMsg = null;
				this.tui.requestRender();
			}
		}, FLASH_POLL_MS);
	}

	invalidate(): void {
		/* no cached render state */
	}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	/** True for keys that navigate one level back (Esc / Backspace / q). */
	private isBackKey(data: string): boolean {
		return matchesKey(data, "escape") || matchesKey(data, "backspace") || data === "q" || data === "Q";
	}

	/** Copy text to the clipboard and flash a transient confirmation. */
	private flashCopy(text: string, okMsg: string): void {
		if (!text.trim()) return;
		this.flashMsg = copyText(text) ? okMsg : "Copy failed";
		this.flashUntil = Date.now() + FLASH_MS;
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (this.mode === "detail") {
			this.handleDetailInput(data);
			return;
		}
		if (this.mode === "step") {
			this.handleStepInput(data);
			return;
		}
		if (this.mode === "reply") {
			this.handleReplyInput(data);
			return;
		}

		if (this.isBackKey(data)) {
			this.done();
			return;
		}

		const n = this.history.length;
		if (matchesKey(data, "up")) {
			this.selected = Math.max(0, this.selected - 1);
			this.previewScroll = 0;
		} else if (matchesKey(data, "down")) {
			this.selected = Math.min(n - 1, this.selected + 1);
			this.previewScroll = 0;
		} else if (matchesKey(data, "pageUp")) {
			this.previewScroll = Math.max(0, this.previewScroll - PAGE_STEP);
		} else if (matchesKey(data, "pageDown")) {
			this.previewScroll += PAGE_STEP;
		} else if (data === "v" || data === "V") {
			const h = this.history[this.selected];
			if (h && h.reply.trim()) {
				// V → read the full reply verbatim (original line breaks kept)
				this.mode = "reply";
				this.stepScroll = 0;
			} else {
				this.flashMsg = "(awaiting reply)";
				this.flashUntil = Date.now() + FLASH_MS;
			}
		} else if (matchesKey(data, "return")) {
			const h = this.history[this.selected];
			if (h && h.turn.length > 0) {
				// Enter → deep preview of this turn's full process; land the cursor
				// on the first assistant text row (turns often contain several text
				// outputs interleaved with tool calls), fallback to the top.
				this.mode = "detail";
				const firstText = this.overviewRows().findIndex((r) => r.kind === "text");
				this.stepSel = firstText >= 0 ? firstText : 0;
			} else if (h && h.text.trim()) {
				// No process recorded → put the message in the editor directly
				this.useText(h.text);
				this.done();
				return;
			}
		} else if (data === "c" || data === "C") {
			this.flashCopy(this.history[this.selected]?.text ?? "", "✓ Copied to clipboard");
		}
		this.tui.requestRender();
	}

	private handleDetailInput(data: string): void {
		const rows = this.overviewRows();
		if (this.isBackKey(data)) {
			// Back to the list
			this.mode = "list";
		} else if (matchesKey(data, "return")) {
			if (this.stepSel === 0) {
				// User row → reuse the message in the editor
				const h = this.history[this.selected];
				if (h && h.text.trim()) this.useText(h.text);
				this.done();
				return;
			}
			// Step row → open its full detail
			this.mode = "step";
			this.stepScroll = 0;
		} else if (data === "c" || data === "C") {
			// Copy whatever row is selected (user message / thinking / tool args / reply)
			const row = rows[this.stepSel];
			this.flashCopy(row ? this.stepContent(row) : "", "✓ Copied");
		} else if (matchesKey(data, "home") || data === "g") {
			this.stepSel = 0;
		} else if (matchesKey(data, "end") || data === "G") {
			this.stepSel = rows.length - 1;
		} else if (matchesKey(data, "up")) {
			this.stepSel = Math.max(0, this.stepSel - 1);
		} else if (matchesKey(data, "down")) {
			this.stepSel = Math.min(rows.length - 1, this.stepSel + 1);
		} else if (matchesKey(data, "pageUp")) {
			this.stepSel = Math.max(0, this.stepSel - PAGE_STEP);
		} else if (matchesKey(data, "pageDown")) {
			this.stepSel = Math.min(rows.length - 1, this.stepSel + PAGE_STEP);
		}
		this.tui.requestRender();
	}

	private handleStepInput(data: string): void {
		const row = this.overviewRows()[this.stepSel];
		if (this.isBackKey(data)) {
			// Back to the turn overview
			this.mode = "detail";
		} else if (matchesKey(data, "return")) {
			const text = row ? this.stepContent(row) : "";
			if (text.trim()) this.useText(text);
			this.done();
			return;
		} else if (data === "c" || data === "C") {
			this.flashCopy(row ? this.stepContent(row) : "", "✓ Copied to clipboard");
		} else if (matchesKey(data, "up")) {
			this.stepScroll = Math.max(0, this.stepScroll - 1);
		} else if (matchesKey(data, "down")) {
			this.stepScroll += 1;
		} else if (matchesKey(data, "pageUp")) {
			this.stepScroll = Math.max(0, this.stepScroll - PAGE_STEP);
		} else if (matchesKey(data, "pageDown")) {
			this.stepScroll += PAGE_STEP;
		}
		this.tui.requestRender();
	}

	private handleReplyInput(data: string): void {
		if (this.isBackKey(data)) {
			// Back to the list
			this.mode = "list";
		} else if (data === "c" || data === "C") {
			this.flashCopy(this.history[this.selected]?.reply ?? "", "✓ Copied reply");
		} else if (matchesKey(data, "up")) {
			this.stepScroll = Math.max(0, this.stepScroll - 1);
		} else if (matchesKey(data, "down")) {
			this.stepScroll += 1;
		} else if (matchesKey(data, "pageUp")) {
			this.stepScroll = Math.max(0, this.stepScroll - PAGE_STEP);
		} else if (matchesKey(data, "pageDown")) {
			this.stepScroll += PAGE_STEP;
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(30, width - 2);
		const lines: string[] = [];

		const mkBorder = (l: string, r: string, content: string) =>
			th.fg("border", l) + padRight(truncateToWidth(content, innerW), innerW) + th.fg("border", r);
		const mkRow = (content: string, selected = false) => {
			const body = padRight(truncateToWidth(content, innerW), innerW);
			return th.fg("border", "│") + (selected ? th.bg("selectedBg", body) : body) + th.fg("border", "│");
		};

		// ── Title row ──
		const selH = this.history[this.selected];
		let title: string;
		if (this.mode === "step" && selH) {
			const row = this.overviewRows()[this.stepSel];
			title = ` ${th.fg("accent", "Step")} · ${th.fg("muted", row ? this.stepLabel(row) : "")}`;
		} else if (this.mode === "reply" && selH) {
			title = ` ${th.fg("accent", "Reply")} · ${th.fg("muted", fmtTimestamp(selH.timestamp))}`;
		} else if (this.mode === "detail" && selH) {
			title = ` ${th.fg("accent", "Detail")} · ${th.fg("muted", fmtTimestamp(selH.timestamp))} · ${th.fg("muted", `${selH.turn.length} steps`)}`;
		} else {
			title = ` ${th.fg("accent", "Session Workbench")}  ${th.fg("muted", "Alt+H open · Esc close" + (selH && selH.turn.length > 0 ? " · Enter detail" : ""))}`;
		}
		lines.push(mkBorder("╭", "╮", title));

		const contentRows = this.rows - 2;

		if (this.history.length === 0) {
			lines.push(mkRow(th.fg("muted", "  No user messages yet")));
			for (let i = 1; i < contentRows; i++) lines.push(mkRow(""));
		} else if (this.mode === "detail") {
			this.renderDetail(lines, innerW, contentRows, th, mkRow);
		} else if (this.mode === "step") {
			this.renderStep(lines, innerW, contentRows, th, mkRow);
		} else if (this.mode === "reply") {
			this.renderReply(lines, innerW, contentRows, mkRow);
		} else {
			this.renderList(lines, innerW, contentRows, th, mkRow);
		}

		// ── Bottom hint row ──
		const hint = this.flashMsg
			? th.fg("success", this.flashMsg)
			: this.mode === "reply"
				? th.fg("muted", "↑↓ scroll · C copy · Esc back")
				: this.mode === "step"
					? th.fg("muted", "↑↓ scroll · Enter to editor · C copy · Esc back")
					: this.mode === "detail"
						? th.fg("muted", "↑↓ select · Enter step detail · g/G top/end · C copy · Esc back")
						: th.fg("muted", "↑↓ select · PgUp/PgDn scroll · V read reply · Enter detail · C copy · Esc close");
		lines.push(mkBorder("├", "┤", ` ${hint}`));
		lines.push(mkBorder("╰", "╯", ""));

		return lines;
	}

	private renderList(
		lines: string[],
		innerW: number,
		contentRows: number,
		th: { fg(color: string, text: string): string; bg(color: string, text: string): string; bold(text: string): string },
		mkRow: (content: string, selected?: boolean) => string,
	): void {
		// Tree-style fixed columns (widths kept in sync via the constants above):
		//   "  › 12:30 user: "     → MSG_COL_W cols
		//   "        assistant: "  → REPLY_COL_W cols
		const msgW = Math.max(10, innerW - MSG_COL_W);
		const replyW = Math.max(10, innerW - REPLY_COL_W);

		const msgLines = (h: HistoryItem): string[] => wrapTextWithAnsi(h.text, msgW);
		// Collapsed-by-default rows show the final text reply in full (scrollable
		// via PgUp/PgDn); intermediate steps stay hidden until Enter drills into
		// the detail view.
		const replyLines = (h: HistoryItem): string[] =>
			h.reply ? wrapTextWithAnsi(h.reply.replace(/\s+/g, " ").trim(), replyW) : [];

		// Per-item height: 1 (collapsed) or message lines + reply lines (expanded)
		const heights = this.history.map((h, i) =>
			i === this.selected ? Math.max(1, msgLines(h).length + (replyLines(h).length || 1)) : 1,
		);
		const total = heights.reduce((a, b) => a + b, 0);
		const blockStart = heights.slice(0, this.selected).reduce((a, b) => a + b, 0);
		const blockH = heights[this.selected] ?? 1;
		const maxScroll = Math.max(0, blockH - contentRows);
		this.previewScroll = Math.min(this.previewScroll, maxScroll);

		// Window start: keep the selected block visible; scroll inside the block if it overflows
		let top: number;
		if (blockH > contentRows) {
			top = blockStart + this.previewScroll;
		} else {
			const ideal = blockStart - Math.floor((contentRows - blockH) / 2);
			top = Math.max(0, Math.min(ideal, Math.max(0, total - contentRows)));
		}

		// Build the flattened layout (row → message + role)
		const layout: Array<{ i: number; kind: "summary" | "msg" | "reply"; li: number }> = [];
		for (let i = 0; i < this.history.length; i++) {
			const h = this.history[i]!;
			if (i === this.selected) {
				msgLines(h).forEach((_, li) => layout.push({ i, kind: "msg", li }));
				const rl = replyLines(h);
				if (rl.length > 0) {
					rl.forEach((_, li) => layout.push({ i, kind: "reply", li }));
				} else {
					layout.push({ i, kind: "reply", li: -1 });
				}
			} else {
				layout.push({ i, kind: "summary", li: 0 });
			}
		}

		for (let r = 0; r < contentRows; r++) {
			const entry = layout[top + r];
			let content = "";
			const selected = entry?.i === this.selected;
			if (entry) {
				const h = this.history[entry.i]!;
				if (entry.kind === "summary") {
					const time = padRight(th.fg("muted", fmtTimestamp(h.timestamp)), TIME_W);
					content = `  ${time} ${th.fg("accent", "user: ")}${truncateToWidth(h.text.replace(/\s+/g, " ").trim(), msgW)}`;
				} else if (entry.kind === "msg") {
					const ml = msgLines(h);
					if (entry.li === 0) {
						const time = padRight(th.fg("muted", fmtTimestamp(h.timestamp)), TIME_W);
						content = `${th.fg("accent", "› ")}${time} ${th.fg("accent", "user: ")}${th.bold(ml[0] ?? "")}`;
					} else {
						// Align under the "user: " label
						content = `${' '.repeat(MSG_COL_W)}${th.bold(ml[entry.li] ?? "")}`;
					}
				} else if (entry.li === -1) {
					content = `${' '.repeat(REPLY_COL_W - REPLY_LABEL.length)}${th.fg("success", REPLY_LABEL)}${th.fg("muted", "(awaiting reply)")}`;
				} else {
					content = `${' '.repeat(REPLY_COL_W - REPLY_LABEL.length)}${th.fg("success", REPLY_LABEL)}${replyLines(h)[entry.li] ?? ""}`;
				}
			}
			lines.push(mkRow(content, selected));
		}
	}

	/** Turn overview rows: the user message followed by one row per step (tool results merged as status). */
	private overviewRows(): OverviewRow[] {
		const h = this.history[this.selected];
		if (!h) return [{ kind: "user" }];
		const rows: OverviewRow[] = [{ kind: "user" }];
		let lastTool: OverviewRow | null = null;
		for (const step of h.turn) {
			if (step.kind === "toolResult") {
				if (lastTool && !lastTool.result) lastTool.result = step;
				continue;
			}
			const row: OverviewRow = { kind: step.kind, step };
			rows.push(row);
			lastTool = step.kind === "tool" ? row : null;
		}
		return rows;
	}

	/** Label shown in the step title for an overview row. */
	private stepLabel(row: OverviewRow): string {
		switch (row.kind) {
			case "user":
				return "user";
			case "thinking":
				return "thinking";
			case "tool":
				return row.step?.toolName ?? "tool";
			case "text":
				return "assistant";
		}
	}

	/** Text reused via Enter / copy for an overview row. */
	private stepContent(row: OverviewRow): string {
		if (row.kind === "user") return this.history[this.selected]?.text ?? "";
		if (row.kind === "tool") return row.step?.argsSummary ?? "";
		return row.step?.text ?? "";
	}

	/** Turn overview: the full process as a /tree-style list, one row per step. */
	private renderDetail(
		lines: string[],
		innerW: number,
		contentRows: number,
		th: { fg(color: string, text: string): string; bg(color: string, text: string): string; bold(text: string): string },
		mkRow: (content: string, selected?: boolean) => string,
	): void {
		const h = this.history[this.selected];
		if (!h) return;

		const rows = this.overviewRows();
		this.stepSel = Math.min(this.stepSel, rows.length - 1);

		const detail: string[] = [];
		const rowW = (prefix: string) => Math.max(10, innerW - visibleWidth(prefix));

		// Number assistant text rows (turns often contain several replies).
		const textTotal = rows.filter((r) => r.kind === "text").length;
		let textIdx = 0;

		for (let i = 0; i < rows.length; i++) {
			const row = rows[i]!;
			const sel = i === this.stepSel;
			const cursor = sel ? th.fg("accent", "› ") : "  ";
			let line = "";

			if (row.kind === "user") {
				const text = h.text.replace(/\s+/g, " ").trim();
				const prefix = `${cursor}${th.fg("accent", "user: ")}`;
				line = `${prefix}${truncateToWidth(text, rowW(prefix))}`;
			} else if (row.kind === "thinking") {
				const text = (row.step?.text ?? "").replace(/\s+/g, " ").trim();
				const prefix = `${cursor}${th.fg("muted", "• ")}${th.fg("muted", "thinking")}${text ? ": " : ""}`;
				line = `${prefix}${truncateToWidth(text, rowW(prefix))}`;
			} else if (row.kind === "tool") {
				const name = row.step?.toolName ?? "tool";
				const args = (row.step?.argsSummary ?? "").replace(/\s+/g, " ").trim();
				const status = row.result
					? row.result.isError
						? th.fg("error", "✗")
						: th.fg("success", "✓")
					: "";
				const prefix = `${cursor}${th.fg("muted", "• ")}${status ? `${status} ` : ""}${th.fg("toolTitle", name)}${args ? ": " : ""}`;
				line = `${prefix}${args ? th.fg("muted", truncateToWidth(args, rowW(prefix))) : ""}`;
			} else if (row.kind === "text") {
				textIdx++;
				const text = (row.step?.text ?? "").replace(/\s+/g, " ").trim();
				const label = textTotal > 1 ? `assistant ${textIdx}/${textTotal}` : "assistant";
				const prefix = `${cursor}${th.fg("muted", "• ")}${th.fg("success", label)}${text ? ": " : ""}`;
				line = `${prefix}${truncateToWidth(text, rowW(prefix))}`;
			}
			// Selected row: bold on top of the row background for a clear indicator.
			detail.push(sel ? th.bold(line) : line);
		}

		// Scroll window: keep the selected row centered
		const maxScroll = Math.max(0, detail.length - contentRows);
		const start = Math.max(0, Math.min(this.stepSel - Math.floor(contentRows / 2), maxScroll));
		for (let r = 0; r < contentRows; r++) {
			const line = detail[start + r];
			lines.push(mkRow(line ?? "", line !== undefined && start + r === this.stepSel));
		}
	}

	/** Step detail: the full content of the selected step, wrapped and scrollable. */
	private renderStep(
		lines: string[],
		innerW: number,
		contentRows: number,
		th: { fg(color: string, text: string): string; bg(color: string, text: string): string; bold(text: string): string },
		mkRow: (content: string, selected?: boolean) => string,
	): void {
		const h = this.history[this.selected];
		if (!h) return;

		const row = this.overviewRows()[this.stepSel];
		if (!row) return;

		const detail: string[] = [];
		const bodyW = Math.max(10, innerW - 2);

		if (row.kind === "user") {
			const label = "user: ";
			const labelW = visibleWidth(label);
			const wrapped = wrapTextWithAnsi(h.text, Math.max(10, bodyW - labelW));
			detail.push(`${th.fg("accent", label)}${wrapped[0] ?? ""}`);
			for (const l of wrapped.slice(1)) detail.push(`${' '.repeat(labelW)}${l}`);
		} else if (row.kind === "thinking") {
			const label = "thinking: ";
			const labelW = visibleWidth(label);
			const wrapped = wrapTextWithAnsi(row.step?.text ?? "", Math.max(10, bodyW - labelW));
			detail.push(`${th.fg("muted", label)}${wrapped[0] ?? ""}`);
			for (const l of wrapped.slice(1)) detail.push(`${' '.repeat(labelW)}${l}`);
		} else if (row.kind === "text") {
			// Show which of the turn's replies this is, e.g. "assistant 2/3:"
			const all = this.overviewRows().filter((r) => r.kind === "text");
			const idx = all.indexOf(row) + 1;
			const label = all.length > 1 ? `assistant ${idx}/${all.length}: ` : "assistant: ";
			const labelW = visibleWidth(label);
			const wrapped = wrapTextWithAnsi(row.step?.text ?? "", Math.max(10, bodyW - labelW));
			detail.push(`${th.fg("success", label)}${wrapped[0] ?? ""}`);
			for (const l of wrapped.slice(1)) detail.push(`${' '.repeat(labelW)}${l}`);
		} else if (row.kind === "tool") {
			const name = row.step?.toolName ?? "tool";
			const args = (row.step?.argsSummary ?? "").trim();
			const header = `${th.fg("toolTitle", name)}${args ? ": " : ""}`;
			const headerW = visibleWidth(header);
			const argsWrapped = wrapTextWithAnsi(args, Math.max(10, bodyW - headerW));
			detail.push(`${header}${argsWrapped[0] ?? ""}`);
			for (const l of argsWrapped.slice(1)) detail.push(`${' '.repeat(headerW)}${l}`);
			const res = row.result;
			if (res) {
				const icon = res.isError ? th.fg("error", "✗") : th.fg("success", "✓");
				detail.push(`  ${th.fg("muted", "result:")} ${icon}`);
				const resText = (res.resultText ?? "").trim();
				if (resText) {
					const resWrapped = wrapTextWithAnsi(resText, Math.max(10, bodyW - 4));
					for (const l of resWrapped) detail.push(`    ${l}`);
				} else {
					detail.push(`    ${th.fg("muted", "(no output)")}`);
				}
			} else {
				detail.push(`  ${th.fg("muted", "result: (none recorded)")}`);
			}
		}

		// Scroll window
		const maxScroll = Math.max(0, detail.length - contentRows);
		this.stepScroll = Math.min(this.stepScroll, maxScroll);
		const start = Math.max(0, Math.min(this.stepScroll, maxScroll));
		for (let r = 0; r < contentRows; r++) {
			lines.push(mkRow(detail[start + r] ?? ""));
		}
	}

	/** Reply reader: the final assistant text, original line breaks preserved. */
	private renderReply(
		lines: string[],
		innerW: number,
		contentRows: number,
		mkRow: (content: string, selected?: boolean) => string,
	): void {
		const h = this.history[this.selected];
		if (!h) return;

		const detail: string[] = [];
		const bodyW = Math.max(10, innerW - 2);
		// Split on newlines first so paragraphs/code blocks keep their shape,
		// then wrap each physical line to the panel width.
		for (const line of h.reply.split("\n")) {
			const wrapped = wrapTextWithAnsi(line, bodyW);
			if (wrapped.length > 0) {
				detail.push(...wrapped);
			} else {
				detail.push("");
			}
		}

		// Scroll window
		const maxScroll = Math.max(0, detail.length - contentRows);
		this.stepScroll = Math.min(this.stepScroll, maxScroll);
		const start = Math.max(0, Math.min(this.stepScroll, maxScroll));
		for (let r = 0; r < contentRows; r++) {
			lines.push(mkRow(detail[start + r] ?? ""));
		}
	}
}

// ═══════════════════════════════════════════════════════════════
// Open the workbench
// ═══════════════════════════════════════════════════════════════

async function openWorkbench(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Session Workbench requires interactive (TUI) mode", "error");
		return;
	}

	const entries = ctx.sessionManager.getEntries() as unknown as {
		type: string;
		id: string;
		timestamp: string;
		message?: unknown;
	}[];
	const history = collectHistory(entries);

	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			return new WorkbenchComponent(
				tui as never,
				theme as never,
				() => done(undefined),
				(text) => ctx.ui.pasteToEditor(text),
				history,
			);
		},
		{
			overlay: true,
			overlayOptions: {
				width: "80%",
				maxHeight: "85%",
				anchor: "center",
			},
		},
	);
}

// ═══════════════════════════════════════════════════════════════
// Extension entry point
// ═══════════════════════════════════════════════════════════════

export default function (pi: ExtensionAPI) {
	// ── Command and shortcut ──
	pi.registerCommand("workbench", {
		description: "Open session workbench (message history)",
		handler: async (_args, ctx) => {
			await openWorkbench(ctx);
		},
	});

	pi.registerShortcut("alt+h", {
		description: "Open session workbench",
		handler: async (ctx) => {
			await openWorkbench(ctx);
		},
	});
}

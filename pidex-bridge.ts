// pidex-bridge: Pi TUI → PiDex web bridge (one-way TUI → web).
//
// Streams agent state and message deltas from a TUI session to the PiDex
// server over a unix socket (newline-delimited JSON, same shape as herdr's
// integration), so the web UI can mirror what the terminal is doing:
//   - session identity (id + file) on session_start
//   - working/idle state (agent_start / agent_settled) + queued flag
//   - token-level deltas (text/thinking/toolcall) while streaming
//   - full assistant messages on message_end, tool lifecycle events
//
// Strictly one-way: the web side never sends input through this channel.
//
// Gating: only ctx.mode === "tui" reports. The headless modes (rpc/print —
// including PiDex's own server runtime, which loads this same extensions
// dir) stay silent, so a session can never report from both sides.
//
// The socket is best-effort: if PiDex server isn't running the plugin stays
// fully passive (connect failures are swallowed, retried with backoff).

import net from "node:net";

const SOCKET_PATH = (() => {
	const p = process.env.PIDEX_BRIDGE_SOCKET;
	if (p) return process.platform === "win32" && !p.startsWith("\\\\.\\pipe\\") ? `\\\\.\\pipe\\${p}` : p;
	return process.platform === "win32" ? "\\\\.\\pipe\\pidex-bridge" : "/tmp/pidex-bridge.sock";
})();

const source = "pidex:tui";

type AgentState = "working" | "idle";

let socket: net.Socket | undefined;
let connecting = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let backoffMs = 250;
const outbox: string[] = [];

function scheduleReconnect(): void {
	if (retryTimer || connecting) return;
	retryTimer = setTimeout(() => {
		retryTimer = undefined;
		backoffMs = Math.min(backoffMs * 2, 8000);
		connect();
	}, backoffMs);
	retryTimer.unref?.();
}

function connect(): void {
	if (connecting || (socket && socket.writable)) return;
	connecting = true;
	const s = net.createConnection(SOCKET_PATH);
	s.setNoDelay(true);
	s.on("connect", () => {
		connecting = false;
		backoffMs = 250;
		while (outbox.length && s.writable) s.write(outbox.shift()!);
	});
	s.on("data", () => {
		// The bridge is one-way; drain and ignore anything the server sends.
	});
	s.on("error", () => {
		// swallow — server may not be running
	});
	s.on("close", () => {
		connecting = false;
		if (socket === s) socket = undefined;
		scheduleReconnect();
	});
	socket = s;
}

function send(msg: Record<string, unknown>): void {
	const line = JSON.stringify({ source, ...msg }) + "\n";
	if (socket && socket.writable) {
		socket.write(line);
		return;
	}
	// queue while connecting (bounded)
	if (outbox.length < 200) outbox.push(line);
	connect();
}

export default function (pi: any) {
	let enabled = false;
	let sessionId: string | undefined;
	let sessionFile: string | undefined;
	let lastState: AgentState | undefined;
	let lastQueued: boolean | undefined;

	function sessionRef() {
		return { sessionId, sessionFile };
	}

	function sendState(state: AgentState, queued?: boolean, detail?: string): void {
		if (!enabled) return;
		if (state === lastState && queued === lastQueued && !detail) return;
		lastState = state;
		lastQueued = queued;
		send({ type: "state", state, queued, detail, ...sessionRef() });
	}

	function updateSessionRef(ctx: any): void {
		try {
			const id = ctx?.sessionManager?.getSessionId?.();
			sessionId = typeof id === "string" && id.length > 0 ? id : undefined;
		} catch {
			sessionId = undefined;
		}
		try {
			const file = ctx?.sessionManager?.getSessionFile?.();
			sessionFile = typeof file === "string" && file.startsWith("/") ? file : undefined;
		} catch {
			sessionFile = undefined;
		}
	}

	pi.on("session_start", (_event: unknown, ctx: any) => {
		// TUI only — see the file header for why the mode gate matters.
		if (ctx?.mode !== "tui") return;
		enabled = true;
		updateSessionRef(ctx);
		lastState = undefined;
		lastQueued = undefined;
		send({ type: "hello", ...sessionRef(), cwd: ctx?.project?.cwd ?? process.cwd() });
		const idle = ctx?.isIdle?.() !== false;
		sendState(idle ? "idle" : "working", ctx?.hasPendingMessages?.() === true);
	});

	pi.on("agent_start", (_event: unknown, ctx: any) => {
		if (!enabled) return;
		updateSessionRef(ctx);
		sendState("working", false);
	});

	pi.on("message_update", (event: any) => {
		if (!enabled) return;
		const e = event?.assistantMessageEvent;
		if (!e) return;
		// Forward token-level deltas as-is; the web side accumulates them.
		if (e.type === "text_delta" || e.type === "thinking_delta" || e.type === "toolcall_delta") {
			send({ type: "delta", kind: e.type, contentIndex: e.contentIndex, delta: e.delta });
		} else if (e.type === "text_start" || e.type === "thinking_start" || e.type === "toolcall_start") {
			send({ type: "block_start", kind: e.type, contentIndex: e.contentIndex });
		}
	});

	pi.on("message_end", (event: any) => {
		if (!enabled) return;
		const message = event?.message;
		if (message?.role === "assistant" || message?.role === "user" || message?.role === "toolResult") {
			send({ type: "message", message });
		}
	});

	pi.on("tool_execution_start", (event: any) => {
		if (!enabled) return;
		send({ type: "tool", toolCallId: event?.toolCallId, toolName: event?.toolName, status: "start" });
	});

	pi.on("tool_execution_end", (event: any) => {
		if (!enabled) return;
		send({ type: "tool", toolCallId: event?.toolCallId, toolName: event?.toolName, status: "end", isError: event?.isError === true });
	});

	pi.on("agent_end", (event: any) => {
		if (!enabled) return;
		const messages = Array.isArray(event?.messages) ? event.messages : [];
		const last = messages.at(-1);
		const aborted = last?.stopReason === "aborted";
		send({ type: "agent_end", aborted });
	});

	pi.on("agent_settled", (_event: unknown, ctx: any) => {
		if (!enabled || ctx?.isIdle?.() !== true) return;
		sendState("idle", ctx?.hasPendingMessages?.() === true);
	});
}

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI, AfterProviderResponseEvent, ModelSelectEvent } from "@earendil-works/pi-coding-agent";

// ============================================================
// Configuration
// ============================================================
const DEFAULT_MAX_KB = 512;
const MAX_ENTRIES = 500;

const CWD = process.cwd();
// Derive a safe directory name from the full CWD path, matching the pi sessions convention:
// e.g. /coding/ccusage → --coding-ccusage--
const SESSION_DIR_NAME = `--${CWD.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
const REQUESTS_DIR = resolve(homedir(), ".pi", "agent", "requests");
const LOG_FILE = process.env.PI_REQUEST_LOG_FULL || join(REQUESTS_DIR, `${SESSION_DIR_NAME}.request.log`);
const MAX_BYTES = (parseInt(process.env.PI_REQUEST_LOG_MAX_KB || "", 10) || DEFAULT_MAX_KB) * 1024;

// ============================================================
// Helpers
// ============================================================

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Sanitize URL: mask API keys / tokens / secrets in query params */
function sanitizeUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.search) {
      const params = new URLSearchParams(u.search);
      let changed = false;
      for (const key of params.keys()) {
        const kl = key.toLowerCase();
        if (kl.includes("key") || kl.includes("token") || kl.includes("secret") || kl.includes("auth") || kl.includes("pass")) {
          params.set(key, "***");
          changed = true;
        }
      }
      if (changed) {
        u.search = params.toString();
        return u.toString();
      }
    }
  } catch { /* ignore invalid URLs */ }
  return url;
}

/** Sanitize error message: strip potential keys/tokens */
function sanitizeError(msg: string): string {
  return msg.replace(/(sk-|tp-)[a-zA-Z0-9_-]{10,}/g, "$1***");
}

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const l = k.toLowerCase();
    // ── auth / secrets: show only prefix+suffix ──
    if (l === "authorization" || l === "api-key" || l === "x-api-key" || l === "cookie") {
      out[k] = v.length > 12 ? v.slice(0, 8) + "..." + v.slice(-4) : "***";
    }
    // ── set-cookie: mask values, keep cookie names ──
    else if (l === "set-cookie") {
      out[k] = v.replace(/([^=]+)=([^;]+)/g, "$1=***");
    }
    // ── SDK noise: skip ──
    else if (l.startsWith("x-stainless")) {
      continue;
    }
    // ── everything else: pass through ──
    else {
      out[k] = v;
    }
  }
  return out;
}

function appendLog(text: string): void {
  try {
    const line = text.endsWith("\n") ? text : text + "\n";
    appendFileSync(LOG_FILE, line, "utf-8");
    if (statSync(LOG_FILE).size > MAX_BYTES) rollLog();
  } catch { /* silent */ }
}

function rollLog(): void {
  try {
    if (!existsSync(LOG_FILE)) return;
    const content = readFileSync(LOG_FILE, "utf-8");
    const lines = content.split("\n");
    if (lines.length > MAX_ENTRIES) {
      const keepFrom = lines.length - Math.floor(MAX_ENTRIES * 0.7);
      writeFileSync(LOG_FILE, lines.slice(Math.max(0, keepFrom)).join("\n"), "utf-8");
    } else {
      writeFileSync(LOG_FILE, lines.slice(Math.floor(lines.length / 2)).join("\n"), "utf-8");
    }
  } catch { /* silent */ }
}

function getMsgPreview(payload: unknown): { msgs: number; roles: string; chars: string; lastUser: string } {
  try {
    const body = payload as Record<string, unknown>;
    const messages = body?.messages as Array<Record<string, unknown>> | undefined;
    if (!messages || !Array.isArray(messages)) {
      return { msgs: 0, roles: "?", chars: "0", lastUser: "" };
    }
    const roles = [...new Set(messages.map((m) => String(m?.role ?? "?")))].join(", ");
    const totalChars = messages.reduce((s, m) => {
      const c = m?.content;
      if (typeof c === "string") return s + c.length;
      if (Array.isArray(c)) return s + JSON.stringify(c).length;
      return s;
    }, 0);
    let lastUser = "";
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "user") {
        const c = messages[i].content;
        lastUser = truncate(typeof c === "string" ? c : JSON.stringify(c), 200);
        break;
      }
    }
    return { msgs: messages.length, roles, chars: fmtBytes(totalChars), lastUser };
  } catch {
    return { msgs: 0, roles: "?", chars: "0", lastUser: "" };
  }
}

// ============================================================
// State: cache payload info until fetch fires
// ============================================================
let pendingPayload: {
  model: string;
  msgs: number;
  roles: string;
  chars: string;
  lastUser: string;
  ts: string;
} | null = null;

// Simple dedup: track recently logged request keys (url@ts) to avoid duplicates
const recentLogs = new Set<string>();
function markLogged(key: string): boolean {
  if (recentLogs.has(key)) return false;
  recentLogs.add(key);
  if (recentLogs.size > 20) {
    const first = recentLogs.values().next().value;
    if (first) recentLogs.delete(first);
  }
  return true;
}

// ============================================================
// Monkey-patch fetch to capture REAL HTTP request headers
// ============================================================

const originalFetch = globalThis.fetch;

if (typeof originalFetch === "function") {
  globalThis.fetch = async function interceptedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const ts = new Date().toISOString();
    const url = (typeof input === "string" ? input : input instanceof URL ? input.href : input.url) as string;
    const method = init?.method || "GET";

    // Only log provider requests
    const isProviderReq = url.includes("opencode") || url.includes("chat") || url.includes("api");
    let bodySize = 0;
    if (init?.body) {
      if (typeof init.body === "string") bodySize = Buffer.byteLength(init.body, "utf-8");
      else if (init.body instanceof ArrayBuffer || ArrayBuffer.isView(init.body)) {
        bodySize = (init.body as ArrayBufferView).byteLength || (init.body as ArrayBuffer).byteLength;
      }
    }

    // Extract headers from init or Request object
    let headers: Record<string, string> = {};
    if (init?.headers) {
      if (typeof (init.headers as Headers).forEach === "function") {
        (init.headers as Headers).forEach((v, k) => { headers[k] = v; });
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers) headers[k] = v;
      } else {
        headers = { ...(init.headers as Record<string, string>) };
      }
    }
    if (input instanceof Request) {
      input.headers.forEach((v, k) => { if (!headers[k]) headers[k] = v; });
    }
    headers = sanitizeHeaders(headers);

    // Dedup: same url + method + ts → skip duplicate log
    const dedupKey = `${method} ${url} @ ${ts.slice(0, 19)}`;
    const isDuplicate = !markLogged(dedupKey);

    if (isProviderReq && !isDuplicate) {
      // Build a clean REQUEST block
      const model = pendingPayload?.model || "?";
      const msgs = pendingPayload?.msgs ?? 0;
      const roles = pendingPayload?.roles || "";
      const chars = pendingPayload?.chars || "";
      const lastUser = pendingPayload?.lastUser || "";
      const bodyInfo = bodySize > 0 ? `  body:       ${fmtBytes(bodySize)}` : "";
      const msgInfo = msgs > 0 ? `  messages:   ${msgs} [${roles}], ≈${chars}` : "";
      const lastInfo = lastUser ? `  last_user:  "${lastUser}"` : "";

      // Format headers as compact key-value lines
      const headerLines = Object.entries(headers)
        .map(([k, v]) => `    ${k.padEnd(24)} ${v}`)
        .join("\n");

      const safeUrl = sanitizeUrl(url);
      const block = [
        ``,
        `┌─ [${ts}] REQUEST ${method} ${safeUrl}`,
        bodyInfo,
        msgInfo,
        lastInfo,
        `│ request-headers:`,
        headerLines,
        `└─`,
      ].filter(Boolean).join("\n");

      appendLog(block);
    }

    try {
      const response = await originalFetch.call(globalThis, input, init);

      if (isProviderReq && !isDuplicate) {
        const respHeaders: Record<string, string> = {};
        response.headers.forEach((v, k) => { respHeaders[k] = v; });

        const rhLines = Object.entries(respHeaders)
          .filter(([k]) => k !== "cf-ray" && k !== "server") // skip noisy ones
          .map(([k, v]) => `    ${k.padEnd(24)} ${v}`)
          .join("\n");

        appendLog(
          `┌─ [${ts}] RESPONSE ${response.status}` +
          `\n│ headers:${rhLines ? "\n" + rhLines : " (none)"}` +
          `\n│ cf-ray:    ${respHeaders["cf-ray"] || "—"}` +
          `\n└─`
        );
      }

      return response;
    } catch (err) {
      if (isProviderReq && !isDuplicate) {
        const errMsg = err instanceof Error ? err.message : String(err);
        appendLog(`!! [${ts}] FETCH ERROR: ${sanitizeError(errMsg)}`);
      }
      throw err;
    }
  };
}

// ============================================================
// Extension entry point
// ============================================================
export default function (pi: ExtensionAPI): void {
  try {
    const logDir = dirname(LOG_FILE);
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  } catch { /* ignore */ }

  // Cache payload info for the next fetch request
  pi.on("before_provider_request", (event: { type: string; payload: unknown }) => {
    const preview = getMsgPreview(event.payload);
    let model = "";
    try {
      const body = event.payload as Record<string, unknown>;
      if (body?.model) model = String(body.model);
    } catch { /* ignore */ }
    pendingPayload = {
      model: model || "?",
      msgs: preview.msgs,
      roles: preview.roles,
      chars: preview.chars,
      lastUser: preview.lastUser,
      ts: new Date().toISOString(),
    };
  });

  // Log session start
  pi.on("session_start", () => {
    const sep = `\n${"━".repeat(72)}`;
    appendLog(`${sep}\n▶ [${new Date().toISOString()}] SESSION START (PID=${process.pid})`);
    appendLog(`  project:    ${SESSION_DIR_NAME}`);
    appendLog(`  cwd:        ${CWD}`);
    appendLog(`  log:        ${LOG_FILE}`);
    appendLog(`  max:        ${fmtBytes(MAX_BYTES)}, max_entries: ${MAX_ENTRIES}`);
    appendLog(`  session_id: ${process.env.OPENCODE_SESSION_ID || "N/A"}`);
    appendLog(`  fetch-hook: ${typeof originalFetch === "function"}`);
  });

  // Log model switches
  pi.on("model_select", (event: ModelSelectEvent) => {
    const modelStr = `${event.model.provider}/${event.model.id}`;
    appendLog(`ℹ [${new Date().toISOString()}] MODEL → ${modelStr} (${event.source})`);
  });
}

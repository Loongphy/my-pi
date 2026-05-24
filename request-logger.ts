import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI, ModelSelectEvent } from "@earendil-works/pi-coding-agent";

// ============================================================
// Configuration
// ============================================================
const DEFAULT_MAX_KB = 512;

const CWD = process.cwd();
const SESSION_DIR_NAME = `--${CWD.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
const REQUESTS_DIR = resolve(homedir(), ".pi", "agent", "requests");
const MAX_BYTES = (parseInt(process.env.PI_REQUEST_LOG_MAX_KB || "", 10) || DEFAULT_MAX_KB) * 1024;

// Per-session log file (set on session_start)
let currentLogFile = "";
function getLogFile(): string {
  return currentLogFile || join(REQUESTS_DIR, `${SESSION_DIR_NAME}.request.log`);
}

const KEEP_SESSION_LOGS = 10;
function cleanupOldLogs(): void {
  try {
    const dir = join(REQUESTS_DIR, SESSION_DIR_NAME);
    if (!existsSync(dir)) return;
    const files = readdirSync(dir)
      .filter(f => f.startsWith("requests-") && f.endsWith(".log"))
      .sort()
      .reverse();
    if (files.length > KEEP_SESSION_LOGS) {
      for (const f of files.slice(KEEP_SESSION_LOGS)) {
        unlinkSync(join(dir, f));
      }
    }
  } catch { /* silent */ }
}

// ============================================================
// 429 rate-limit workaround for opencode.ai
// See: https://github.com/earendil-works/pi/issues/3671
// See: https://github.com/earendil-works/pi/issues/4666
// ============================================================

/** Parse retry-after: integer seconds, HTTP-date, or retry-after-ms. */
function parseRetryAfter(
  retryAfter: string | null,
  retryAfterMs: string | null,
): number | null {
  if (retryAfterMs) {
    const ms = Number(retryAfterMs);
    if (Number.isFinite(ms) && ms > 0) return Math.ceil(ms / 1000);
  }
  if (!retryAfter) return null;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = new Date(retryAfter);
  if (!Number.isNaN(date.getTime())) {
    const diffMs = date.getTime() - Date.now();
    return diffMs > 0 ? Math.ceil(diffMs / 1000) : 0;
  }
  return null;
}

/** Format seconds → "3h 59m", "2m 30s", "45s". */
function formatTime(seconds: number): string {
  if (seconds <= 0) return "now";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  return parts.join(" ");
}

// ============================================================
// Helpers
// ============================================================

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

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
  } catch { /* ignore */ }
  return url;
}

function sanitizeError(msg: string): string {
  return msg.replace(/(sk-|tp-)[a-zA-Z0-9_-]{10,}/g, "$1***");
}

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const l = k.toLowerCase();
    if (l === "authorization" || l === "api-key" || l === "x-api-key" || l === "cookie") {
      out[k] = v.length > 12 ? v.slice(0, 8) + "..." + v.slice(-4) : "***";
    } else if (l === "set-cookie") {
      out[k] = v.replace(/([^=]+)=([^;]+)/g, "$1=***");
    } else if (l.startsWith("x-stainless")) {
      continue;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function appendLog(text: string): void {
  try {
    const file = getLogFile();
    const line = text.endsWith("\n") ? text : text + "\n";
    appendFileSync(file, line, "utf-8");
    if (statSync(file).size > MAX_BYTES) rollLog();
  } catch { /* silent */ }
}

function rollLog(): void {
  try {
    const file = getLogFile();
    if (!existsSync(file)) return;
    const content = readFileSync(file, "utf-8");
    const lines = content.split("\n");
    writeFileSync(file, lines.slice(Math.floor(lines.length / 2)).join("\n"), "utf-8");
  } catch { /* silent */ }
}

// ============================================================
// FIFO queue: correlate before_provider_request → next fetch
// ============================================================
const pendingPayloads: { model: string }[] = [];

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
// Intercept fetch via Object.defineProperty
// ============================================================

let _underlyingFetch = globalThis.fetch;

if (typeof _underlyingFetch === "function") {
  Object.defineProperty(globalThis, "fetch", {
    get() {
      return async function interceptedFetch(
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> {
        const ts = new Date().toISOString();
        const url = (typeof input === "string" ? input : input instanceof URL ? input.href : input.url) as string;
        const method = init?.method || "GET";

        const payload = pendingPayloads.shift() ?? null;
        const isProviderReq = payload !== null;

        let bodySize = 0;
        if (init?.body) {
          if (typeof init.body === "string") bodySize = Buffer.byteLength(init.body, "utf-8");
          else if (init.body instanceof ArrayBuffer || ArrayBuffer.isView(init.body)) {
            bodySize = (init.body as ArrayBufferView).byteLength || (init.body as ArrayBuffer).byteLength;
          }
        }

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

        const dedupKey = `${method} ${url} @ ${ts.slice(0, 19)}`;
        const isDuplicate = !markLogged(dedupKey);

        if (isProviderReq && !isDuplicate) {
          const headerLines = Object.entries(headers)
            .map(([k, v]) => `    ${k.padEnd(24)} ${v}`)
            .join("\n");

          // Build request-body section
          let bodySection = "";
          if (init?.body && typeof init.body === "string") {
            try {
              const parsed = JSON.parse(init.body) as Record<string, unknown>;
              const bodyEntries: [string, string][] = [];

              const modelVal = parsed.model || payload?.model || "";
              if (modelVal) bodyEntries.push(["model", String(modelVal)]);

              if (Array.isArray(parsed.messages)) {
                const rawMsgs = parsed.messages as Array<Record<string, unknown>>;
                const totalChars = rawMsgs.reduce((s, m) => {
                  const c = m?.content;
                  if (typeof c === "string") return s + c.length;
                  if (Array.isArray(c)) return s + JSON.stringify(c).length;
                  return s;
                }, 0);
                bodyEntries.push(["messages", `≈${fmtBytes(totalChars)}`]);
              }

              const shownKeys = new Set(["model", "messages"]);
              const otherCount = Object.keys(parsed).filter(k => !shownKeys.has(k)).length;
              if (otherCount > 0) bodyEntries.push(["…", "…"]);

              if (bodyEntries.length > 0) {
                bodySection = `│ body:\n` +
                  bodyEntries.map(([k, v]) => `    ${k.padEnd(24)} ${v}`).join("\n");
              }
            } catch {
              if (bodySize > 0) {
                bodySection = `│ body:\n    body_size                ${fmtBytes(bodySize)}`;
              }
            }
          } else if (bodySize > 0) {
            bodySection = `│ body:\n    body_size                ${fmtBytes(bodySize)}`;
          }

          const safeUrl = sanitizeUrl(url);
          const block = [
            `[${ts}] REQUEST ${method} ${safeUrl}`,
            `│ header:`,
            headerLines,
            bodySection,
            `└─`,
          ].filter(Boolean).join("\n");

          appendLog(block);
        }

        try {
          let response = await _underlyingFetch.call(globalThis, input, init);

          // Log original 429 before rewriting (so logs show real status)
          const isRateLimited = response.status === 429 && url.includes("opencode.ai");
          if (isProviderReq && !isDuplicate && isRateLimited) {
            const respHeaders: Record<string, string> = {};
            response.headers.forEach((v, k) => { respHeaders[k] = v; });
            const rhLines = Object.entries(respHeaders)
              .map(([k, v]) => `    ${k.padEnd(24)} ${v}`)
              .join("\n");
            appendLog(
              `[${ts}] RESPONSE 429 (rewritten to 400 by rate-limit workaround)` +
              `\n│ header:\n${rhLines}\n└─`
            );
          }

          // 429 workaround for opencode.ai: rewrite to 400 with reset time
          // SDK sleeps for exact retry-after with no cap, causing pi to hang.
          if (isRateLimited) {
            const seconds = parseRetryAfter(
              response.headers.get("retry-after"),
              response.headers.get("retry-after-ms"),
            );
            const limitMs = seconds != null && seconds > 0 ? seconds * 1000 : 60_000;
            const timeStr = formatTime(Math.ceil(limitMs / 1000));
            response = new Response(`Usage limit reached: Resets in ${timeStr}`, {
              status: 400,
              statusText: "Usage Limited",
              headers: { "content-type": "text/plain" },
            });
          }

          // Skip logging rewritten 400 (already logged original 429 above)
          if (isProviderReq && !isDuplicate && !isRateLimited) {
            const respHeaders: Record<string, string> = {};
            response.headers.forEach((v, k) => { respHeaders[k] = v; });

            const rhLines = Object.entries(respHeaders).length > 0
              ? Object.entries(respHeaders).map(([k, v]) => `    ${k.padEnd(24)} ${v}`).join("\n")
              : "    (none)";

            // For non-2xx responses, clone and read the response body for diagnostics
            let bodySection = "";
            if (response.status < 200 || response.status >= 300) {
              try {
                const cloned = response.clone();
                const bodyText = await cloned.text();
                const MAX_BODY_CHARS = 8192;

                // Try to pretty-print JSON first (parse full body, then truncate formatted output)
                let display: string;
                try {
                  const parsed = JSON.parse(bodyText);
                  display = JSON.stringify(parsed, null, 2);
                } catch {
                  // Not valid JSON — use raw text directly
                  display = bodyText;
                }

                // Truncate the final display string
                if (display.length > MAX_BODY_CHARS) {
                  display = display.slice(0, MAX_BODY_CHARS) + `\n... (truncated, ${fmtBytes(display.length)} total)`;
                }

                bodySection = `\n│ body:\n` + display.split("\n").map(l => `    ${l}`).join("\n");
              } catch (bodyErr) {
                bodySection = `\n│ body: (failed to read: ${bodyErr instanceof Error ? bodyErr.message : String(bodyErr)})`;
              }
            }

            appendLog(
              `[${ts}] RESPONSE ${response.status}` +
              `\n│ header:\n${rhLines}` +
              bodySection +
              `\n└─`
            );
          }

          return response;
        } catch (err) {
          if (isProviderReq && !isDuplicate) {
            const errMsg = err instanceof Error ? err.message : String(err);
            appendLog(`[${ts}] FETCH ERROR: ${sanitizeError(errMsg)}`);
          }
          throw err;
        }
      };
    },
    set(v) {
      _underlyingFetch = v;
    },
    configurable: true,
    enumerable: true,
  });
}

// ============================================================
// Extension entry point
// ============================================================
export default function (pi: ExtensionAPI): void {
  // Ensure base requests directory exists
  try {
    if (!existsSync(REQUESTS_DIR)) mkdirSync(REQUESTS_DIR, { recursive: true });
  } catch { /* ignore */ }

  // Push minimal model info so the fetch interceptor knows this is a provider request.
  pi.on("before_provider_request", (event: { type: string; payload: unknown }) => {
    let model = "";
    try {
      const body = event.payload as Record<string, unknown>;
      if (body?.model) model = String(body.model);
    } catch { /* ignore */ }
    pendingPayloads.push({ model: model || "?" });
  });

  // Log session start — create per-session file
  pi.on("session_start", () => {
    const sessionId = process.env.OPENCODE_SESSION_ID || "unknown";
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const sessionDir = join(REQUESTS_DIR, SESSION_DIR_NAME);
    if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
    currentLogFile = join(sessionDir, `requests-${ts}-${sessionId}.log`);
    cleanupOldLogs();

    appendLog(`[${new Date().toISOString()}] SESSION START (session_id=${sessionId}, cwd=${CWD})`);
  });

  // Log model switches
  pi.on("model_select", (event: ModelSelectEvent) => {
    const modelStr = `${event.model.provider}/${event.model.id}`;
    appendLog(`[${new Date().toISOString()}] MODEL ${modelStr} (${event.source})`);
  });
}


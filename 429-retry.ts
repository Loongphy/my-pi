/**
 * 429 Rate Limit Retry Plugin
 *
 * When the API returns 429 (Too Many Requests), wait a computed amount of
 * time and retry automatically, instead of letting the request fail or hang
 * forever inside the SDK.
 *
 * The default wait sequence grows linearly (5s, 10s, 20s, 30s, 60s, 90s, ...
 * then +30s per retry after 30s) to avoid pointless exponential backoff; a
 * fixed wait can be set with /429-retry <seconds>.
 *
 * Use the /429-retry command to toggle the feature on/off.
 *
 * Cooperation with the request-logger plugin (unified 429 flow):
 * - request-logger only logs/monitors; 429 responses pass through untouched
 * - this plugin retries every 429 at the fetch layer (default sequence
 *   5s,10s,20s,30s,60s,90s... +30s each, up to MAX_RETRIES times)
 * - 429 ownership is decided by URL gating (see RATE_LIMIT_RULES): when a
 *   provider's permanent/hard-limit signature matches, the original response
 *   is handed back untouched and the provider handles it (workbuddy raises a
 *   purchase prompt, the opencode SDK classifies the error by marker);
 *   unowned/unmatched 429s are always retried by default. UI output belongs
 *   to the provider; this plugin never oversteps.
 *
 * NOTE: this file is intentionally pure ASCII. Older versions mixed in
 * non-ASCII characters (CJK comments, em dashes) that show up as mojibake in
 * some terminals/editors. The Chinese literals below are kept ONLY inside the
 * workbuddy regex patterns, because Tencent's quota-exhausted responses are
 * actually matched in Chinese.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Incremental retry wait sequence (seconds): 5, 10, 20, 30, 60, 90, 120, ...
// After 30s each retry adds a fixed +30s, so pointless waits do not explode.
const RETRY_WAIT_SEQUENCE_SECONDS = [5, 10, 20, 30];

// Maximum retry count (guards against infinite loops). With the default
// sequence 5,10,20,30,60,90...+30s each, 15 retries take ~40 minutes at most;
// ownership rules / the generic hard-limit check (shouldReturnResponse) exit
// early, so the budget is rarely exhausted.
const MAX_RETRIES = 15;

// ============================================================
// 429 ownership rules (URL gating; no global keyword fallback)
//
// One rule per provider: `match` decides "whose request is this", `isTerminal`
// decides "is this provider's 429 permanent/hard-limit" (hit -> hand the
// original response back, no retry). Requests matching no rule -> retry by
// default (5,10,20,30,60,90...+30s, max 15 times). Business handling (purchase
// prompts, error classification, UI output) always stays in the provider's own
// code.
// ============================================================

interface RateLimitRule {
  name: string; // provider name (shown in the status bar)
  match(url: string): boolean;
  isTerminal(body: string): boolean;
}

/** Extract the error code from a 429 body (handles error.data.code / error.code wrappers). */
function extractErrorCode(body: string): number | undefined {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const err = (parsed?.error ?? parsed) as Record<string, unknown>;
    const data = (err?.data ?? {}) as Record<string, unknown>;
    return (data?.code ?? err?.code) as number | undefined;
  } catch {
    return undefined;
  }
}

const RATE_LIMIT_RULES: RateLimitRule[] = [
  // workbuddy (CodeBuddy CN): quota exhausted = code 14018 / quota wording.
  // Aligned with workbuddy dist's isQuotaExhausted; under URL gating it is
  // safe to match "usage limit" (that wording only appears on
  // copilot.tencent.com and cannot misfire on other providers).
  // NOTE: keep the Chinese terms below as UTF-8 bytes - Tencent's error
  // bodies are in Chinese and must be matched literally.
  {
    name: "workbuddy",
    match: (url) => url.includes("copilot.tencent.com"),
    isTerminal: (body) => {
      if (extractErrorCode(body) === 14018) return true;
      return /额度已用尽|加量包|quota exhausted|insufficient_quota|usage limit/i.test(body);
    },
  },
  // opencode (Codex-compatible endpoint): usage-limit error types (same
  // classification as pi upstream's isTerminalRateLimitError); on hit the
  // response is handed back and the SDK reports by marker.
  {
    name: "opencode",
    match: (url) => /opencode\.ai/i.test(url),
    isTerminal: (body) =>
      /FreeUsageLimitError|GoUsageLimitError|UsageLimitError|insufficient_quota|Monthly usage limit/i.test(body),
  },
  // trae-work: no trustworthy permanent-429 signature yet (code 1001 is an
  // auth expiry handled by the trae plugin itself), so no rule -> default
  // retry. Add a rule here once a signature is found.
];

// A server-requested wait longer than this is treated as a hard limit and
// handed back immediately (no retry) - pure HTTP semantics
// (Retry-After / body reset time), applied to any request, independent of
// any provider signature.
const HARD_LIMIT_WAIT_MS = 10 * 60 * 1000; // 10 minutes

export default function (pi: ExtensionAPI) {
  // State
  let enabled = true;
  let isRateLimited = false;
  let lastRateLimitTime: number | null = null;
  let retryCount = 0;
  // Fixed wait time explicitly set by the user via /429-retry <seconds>
  // (null = use the incremental sequence)
  let customWaitMs: number | null = null;
  let _ctx: ExtensionContext | null = null;

  // Keep a reference to the current fetch (possibly request-logger's wrapper)
  const currentFetch = globalThis.fetch;

  /**
   * Parse the wait time (ms) requested by the response.
   *
   * Prefers the Retry-After / retry-after-ms headers; when both are missing,
   * falls back to parsing the reset time from the body (e.g. opencode.ai's
   * "Usage limit reached: Resets in 1h 2m 3s").
   */
  async function parseWaitTimeFromResponse(response: Response): Promise<number | null> {
    // Check Retry-After headers
    const retryAfter = response.headers.get("Retry-After");
    const retryAfterMs = response.headers.get("retry-after-ms");

    if (retryAfterMs) {
      const ms = parseInt(retryAfterMs, 10);
      if (!isNaN(ms) && ms > 0) return ms;
    }

    if (retryAfter) {
      const seconds = parseInt(retryAfter, 10);
      if (!isNaN(seconds) && seconds >= 0) return seconds * 1000;

      // Try parsing as HTTP-date
      const date = new Date(retryAfter);
      if (!isNaN(date.getTime())) {
        const diffMs = date.getTime() - Date.now();
        if (diffMs > 0) return diffMs;
      }
    }

    // Fallback: extract "Resets in Xh Ym Zs" style reset time from the body
    try {
      const cloned = response.clone();
      const body = await cloned.text();
      const timeMatch = body.match(/Resets? in (\d+[hms](?:\s*\d+[hms])*)/i);
      if (timeMatch) {
        const timeStr = timeMatch[1];
        let totalSeconds = 0;

        const hours = timeStr.match(/(\d+)h/);
        const minutes = timeStr.match(/(\d+)m/);
        const seconds = timeStr.match(/(\d+)s/);

        if (hours) totalSeconds += parseInt(hours[1]) * 3600;
        if (minutes) totalSeconds += parseInt(minutes[1]) * 60;
        if (seconds) totalSeconds += parseInt(seconds[1]);

        if (totalSeconds > 0) return totalSeconds * 1000;
      }
    } catch {
      // Ignore body read/parse errors
    }

    return null;
  }

  /**
   * Compute the wait time (ms) before the `attempt`-th retry.
   *
   * Default: incremental sequence 5s, 10s, 20s, 30s, 60s, 90s, 120s, ...
   * (+30s per retry after 30s) so pointless retries do not drag on too long;
   * if the user explicitly set a fixed wait via /429-retry <seconds>, that
   * fixed value is used instead.
   */
  function getRetryWaitMs(attempt: number): number {
    if (customWaitMs !== null) {
      return customWaitMs;
    }
    if (attempt <= RETRY_WAIT_SEQUENCE_SECONDS.length) {
      return RETRY_WAIT_SEQUENCE_SECONDS[attempt - 1] * 1000;
    }
    const base = RETRY_WAIT_SEQUENCE_SECONDS[RETRY_WAIT_SEQUENCE_SECONDS.length - 1];
    return (base + (attempt - RETRY_WAIT_SEQUENCE_SECONDS.length) * 30) * 1000;
  }

  /** Human-readable description of the current wait strategy (for the status bar) */
  function describeWaitStrategy(): string {
    return customWaitMs !== null ? `${customWaitMs / 1000}s` : "5,10,20,30,60,90...+30s each";
  }

  /**
   * Find the ownership rule for a request URL (no match = undefined -> default retry).
   */
  function findRule(input: RequestInfo | URL): RateLimitRule | undefined {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return RATE_LIMIT_RULES.find((r) => r.match(url));
  }

  /**
   * Decide whether this 429 should be handed back (no retry):
   * 1. Generic hard limit: server-requested wait exceeds HARD_LIMIT_WAIT_MS
   *    (10 min) - pure HTTP semantics (Retry-After / body reset time), applies
   *    to any request;
   * 2. Ownership rule hit: the provider's isTerminal says permanent/hard limit.
   *    On hit the original response is handed back and the provider handles it
   *    (UI output belongs to the provider).
   */
  async function shouldReturnResponse(
    response: Response,
    rule: RateLimitRule | undefined,
    rawWaitMs: number,
  ): Promise<boolean> {
    if (rawWaitMs > HARD_LIMIT_WAIT_MS) return true;
    if (!rule) return false;
    try {
      const cloned = response.clone();
      const body = await cloned.text();
      return rule.isTerminal(body);
    } catch {
      return false;
    }
  }

  /**
   * Format seconds into a human-readable string
   */
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

  /**
   * Before handing the response back, inject the server-provided reset time
   * into the body (resets_in field) so the SDK error can show "when it will
   * recover". Only touches JSON bodies and only adds a field (never breaks
   * content or changes the status code), so workbuddy's parseErrorJson etc.
   * are unaffected.
   */
  async function annotateResetTime(response: Response, waitMs: number | null): Promise<Response> {
    if (!waitMs || waitMs <= 0) return response;
    try {
      const cloned = response.clone();
      const body = await cloned.text();
      if (!body.trim().startsWith("{")) return response; // JSON bodies only
      const parsed = JSON.parse(body) as Record<string, unknown>;
      if (typeof parsed?.resets_in === "string") return response; // already present
      const headers = new Headers(response.headers);
      headers.delete("content-length"); // new body length differs; avoid header mismatch
      return new Response(JSON.stringify({ ...parsed, resets_in: formatTime(Math.ceil(waitMs / 1000)) }), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch {
      return response;
    }
  }

  /**
   * Create the fetch wrapper with retry logic
   */
  async function fetchWithRetry(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    // If disabled, call the current fetch directly
    if (!enabled) {
      return currentFetch.call(globalThis, input, init);
    }

    const signal = init?.signal ?? null;
    let attempts = 0;
    let response = await currentFetch.call(globalThis, input, init);

    // 429s are retried uniformly at the fetch layer; request-logger no longer
    // rewrites them, responses pass through untouched
    while (response.status === 429 && attempts < MAX_RETRIES) {
      // Parse the server-requested wait time (Retry-After header or body reset
      // time, uncapped); fall back to the incremental sequence when absent
      const serverWaitMs = await parseWaitTimeFromResponse(response);
      const rawWaitMs = serverWaitMs ?? getRetryWaitMs(attempts + 1);

      // Ownership check: generic hard limit (wait > 10min) first, then the URL
      // rule; on hit the original response is handed back without retry - the
      // provider handles it (workbuddy raises a purchase prompt, the SDK
      // reports by error marker); UI output belongs to the provider, so no
      // notify here
      const rule = findRule(input);
      if (await shouldReturnResponse(response, rule, rawWaitMs)) {
        // Inject the server-provided reset time before handing back
        // (Retry-After header / body "Resets in"), so the SDK error shows
        // "when it will recover"
        const annotated = await annotateResetTime(response, serverWaitMs);
        const theme = _ctx?.ui?.theme;
        if (theme) {
          _ctx?.ui?.setStatus?.(
            "429-retry",
            theme.fg("dim", rule
              ? `429 handled by ${rule.name} - surfacing error (no retry)`
              : "Rate limit reset window too long (>10m) - surfacing error (no retry)")
          );
        }
        isRateLimited = false;
        return annotated;
      }

      attempts++;
      isRateLimited = true;
      lastRateLimitTime = Date.now();
      retryCount = attempts;

      // Give a prominent notice before the first retry (setStatus alone is
      // easy to miss)
      if (attempts === 1) {
        _ctx?.ui?.notify?.(
          `Received 429 (Too Many Requests) - will auto retry ${MAX_RETRIES} times (wait sequence: ${describeWaitStrategy()}); disable with /429-retry off`,
          "warning"
        );
      }

      // Ensure the wait is at least 1 second and capped to avoid endless waits
      let actualWaitMs = Math.max(rawWaitMs, 1000);
      actualWaitMs = Math.min(actualWaitMs, HARD_LIMIT_WAIT_MS);

      // Countdown display (updates the same status line in place, no
      // accumulation); controlled by AbortSignal
      const theme = _ctx?.ui?.theme;
      const endTime = Date.now() + actualWaitMs;
      while (Date.now() < endTime) {
        // Aborted (Esc / Ctrl+C): stop retrying immediately and hand the
        // current response back to the SDK
        if (signal?.aborted) {
          return response;
        }
        const remainingSec = Math.ceil((endTime - Date.now()) / 1000);
        if (remainingSec <= 0) break;
        if (theme) {
          _ctx?.ui?.setStatus?.(
            "429-retry",
            theme.fg("dim", `Rate limited (429). Waiting ${remainingSec}s before retry ${attempts}/${MAX_RETRIES}...`)
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      // Retry the request
      response = await currentFetch.call(globalThis, input, init);
    }

    // If we were rate limited but now recovered, silently clear the state
    if (isRateLimited && response.status !== 429) {
      isRateLimited = false;
      retryCount = 0;
      _ctx?.ui?.setStatus?.("429-retry", undefined);
    }

    // If still 429 after the maximum retry count
    if (response.status === 429 && attempts >= MAX_RETRIES) {
      const theme = _ctx?.ui?.theme;
      if (theme) {
        _ctx?.ui?.setStatus?.(
          "429-retry",
          theme.fg("dim", `Rate limit persists after ${MAX_RETRIES} retries`)
        );
      }
    }

    return response;
  }

  /**
   * Enable the fetch wrapper
   */
  function enableWrapper() {
    Object.defineProperty(globalThis, "fetch", {
      get() {
        return fetchWithRetry;
      },
      set(v) {
        // If someone overrides fetch, update our underlying fetch
        // so request-logger keeps working
        (currentFetch as any) = v;
      },
      configurable: true,
      enumerable: true,
    });
  }

  /**
   * Disable the fetch wrapper (restore the original fetch)
   */
  function disableWrapper() {
    // Restore the original fetch (possibly request-logger's wrapper)
    Object.defineProperty(globalThis, "fetch", {
      get() {
        return currentFetch;
      },
      set(v) {
        (globalThis as any)._fetch = v;
      },
      configurable: true,
      enumerable: true,
    });

    isRateLimited = false;
    retryCount = 0;
    _ctx?.ui?.setStatus?.("429-retry", undefined);
  }

  // Enable the wrapper on init
  enableWrapper();

  // Register the /429-retry command
  pi.registerCommand("429-retry", {
    description: "Toggle 429 retry or set wait time (e.g. /429-retry 30)",
    handler: async (args, ctx) => {
      const theme = ctx.ui.theme;
      const arg = args?.trim().toLowerCase();

      // Parse args: a number sets the wait time
      if (arg && /^\d+$/.test(arg)) {
        const seconds = parseInt(arg, 10);
        if (seconds > 0) {
          customWaitMs = seconds * 1000;
          ctx.ui.notify(`429 retry wait time set to ${seconds}s`, "info");
          ctx.ui.setStatus(
            "429-retry",
            theme.fg("dim", `429 retry: ${enabled ? "ON" : "OFF"} (${seconds}s)`)
          );
        } else {
          ctx.ui.notify("Wait time must be > 0", "error");
        }
        return;
      }

      // Parse args: on/off/enable/disable
      if (arg === "on" || arg === "enable" || arg === "true") {
        enabled = true;
        enableWrapper();
        ctx.ui.notify("429 retry enabled", "info");
      } else if (arg === "off" || arg === "disable" || arg === "false") {
        enabled = false;
        disableWrapper();
        ctx.ui.notify("429 retry disabled", "info");
      } else if (!arg) {
        // No args: toggle
        enabled = !enabled;
        if (enabled) {
          enableWrapper();
          ctx.ui.notify("429 retry enabled", "info");
        } else {
          disableWrapper();
          ctx.ui.notify("429 retry disabled", "info");
        }
      } else {
        ctx.ui.notify("Usage: /429-retry [on|off|<seconds>]", "warning");
        return;
      }

      // Update the status bar
      ctx.ui.setStatus(
        "429-retry",
        enabled
          ? theme.fg("dim", `429 retry: ON (${describeWaitStrategy()})`)
          : theme.fg("dim", "429 retry: OFF")
      );
    },
  });

  // Initialize the context on session start
  pi.on("session_start", async (_event, ctx) => {
    _ctx = ctx;
    const theme = ctx.ui.theme;
    ctx.ui.setStatus(
      "429-retry",
      theme.fg("dim", `429 retry: ${enabled ? "ON" : "OFF"} (${describeWaitStrategy()})`)
    );

    // Hide the initial status after 3 seconds (if not rate limited)
    setTimeout(() => {
      if (!isRateLimited) {
        ctx.ui.setStatus("429-retry", undefined);
      }
    }, 3000);
  });

  // Listen for provider response events for extra logging
  pi.on("after_provider_response", (event, ctx) => {
    _ctx = ctx;
    if (event.status === 429) {
      // Log the 429 event (actual retries are handled by the fetch wrapper)
      console.log(`[429-retry] Detected 429 response at ${new Date().toISOString()}`);
    }
  });

  // Cleanup: restore the original fetch on session shutdown
  pi.on("session_shutdown", async () => {
    disableWrapper();
  });
}
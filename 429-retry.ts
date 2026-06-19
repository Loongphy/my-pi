/**
 * 429 Rate Limit Retry Plugin
 *
 * 当 API 返回 429 (Too Many Requests) 时，等待指定时间后自动重试，
 * 而不是让请求失败或被 SDK 无限挂起。
 *
 * 通过 /429-retry 命令可以启用/关闭此功能。
 *
 * 与 request-logger 插件兼容：
 * - request-logger 会将 429 改写为 400（防止 SDK 挂起）
 * - 本插件检测改写后的 400 响应，提取等待时间并重试
 * - 两者协作工作，不会冲突
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// 默认重试等待时间（毫秒）
const DEFAULT_WAIT_MS = 30_000; // 30 秒

// 最大重试次数（防止无限循环）
const MAX_RETRIES = 10;

export default function (pi: ExtensionAPI) {
  // 状态
  let enabled = true;
  let isRateLimited = false;
  let lastRateLimitTime: number | null = null;
  let retryCount = 0;
  let waitMs = DEFAULT_WAIT_MS;
  let _ctx: ExtensionContext | null = null;

  // 保存当前的 fetch（可能是 request-logger 的包装版本）
  const currentFetch = globalThis.fetch;

  /**
   * 从响应中解析等待时间
   */
  function parseWaitTimeFromResponse(response: Response): number | null {
    // 检查 Retry-After 头
    const retryAfter = response.headers.get("Retry-After");
    const retryAfterMs = response.headers.get("retry-after-ms");

    if (retryAfterMs) {
      const ms = parseInt(retryAfterMs, 10);
      if (!isNaN(ms) && ms > 0) return ms;
    }

    if (retryAfter) {
      const seconds = parseInt(retryAfter, 10);
      if (!isNaN(seconds) && seconds >= 0) return seconds * 1000;

      // 尝试解析为 HTTP-date
      const date = new Date(retryAfter);
      if (!isNaN(date.getTime())) {
        const diffMs = date.getTime() - Date.now();
        if (diffMs > 0) return diffMs;
      }
    }

    return null;
  }

  /**
   * 检查响应是否为 request-logger 改写后的 429
   * request-logger 将 429 改写为 400，body 包含 "Usage limit reached"
   */
  function isRewrittenRateLimit(response: Response): boolean {
    // 检查是否为 400 状态码
    if (response.status !== 400) return false;

    // 检查 statusText 是否为 "Usage Limited"
    if (response.statusText === "Usage Limited") return true;

    return false;
  }

  /**
   * 从改写后的响应中提取等待时间
   */
  async function extractWaitTimeFromRewrittenResponse(response: Response): Promise<number> {
    try {
      const cloned = response.clone();
      const body = await cloned.text();

      // 尝试从 body 中提取时间信息
      // 格式: "Usage limit reached: Resets in Xh Ym Zs" 或类似
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
      // 忽略解析错误
    }

    // 默认等待时间
    return waitMs;
  }

  /**
   * 格式化时间为人类可读格式
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
   * 创建带重试逻辑的 fetch 包装器
   */
  async function fetchWithRetry(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    // 如果功能未启用，直接调用当前 fetch
    if (!enabled) {
      return currentFetch.call(globalThis, input, init);
    }

    let attempts = 0;
    let response = await currentFetch.call(globalThis, input, init);

    // 检查是否为 429 响应（原始或改写后的）
    while ((response.status === 429 || isRewrittenRateLimit(response)) && attempts < MAX_RETRIES) {
      attempts++;
      isRateLimited = true;
      lastRateLimitTime = Date.now();
      retryCount = attempts;

      // 解析等待时间
      let actualWaitMs: number;

      if (response.status === 429) {
        // 原始 429 响应
        actualWaitMs = parseWaitTimeFromResponse(response) ?? waitMs;
      } else {
        // 改写后的 400 响应
        actualWaitMs = await extractWaitTimeFromRewrittenResponse(response);
      }

      // 确保等待时间至少为 1 秒
      actualWaitMs = Math.max(actualWaitMs, 1000);

      // 限制最大等待时间（防止过长等待）
      const maxWaitMs = 10 * 60 * 1000; // 10 分钟
      actualWaitMs = Math.min(actualWaitMs, maxWaitMs);

      // 倒计时显示（原地更新同一行，不累积）
      const theme = _ctx?.ui?.theme;
      const endTime = Date.now() + actualWaitMs;
      while (Date.now() < endTime) {
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

      // 重试请求
      response = await currentFetch.call(globalThis, input, init);
    }

    // 如果之前被限流但现在恢复正常，静默清除状态
    if (isRateLimited && response.status !== 429 && !isRewrittenRateLimit(response)) {
      isRateLimited = false;
      retryCount = 0;
      _ctx?.ui?.setStatus?.("429-retry", undefined);
    }

    // 如果达到最大重试次数仍然 429
    if ((response.status === 429 || isRewrittenRateLimit(response)) && attempts >= MAX_RETRIES) {
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
   * 启用 fetch 包装
   */
  function enableWrapper() {
    Object.defineProperty(globalThis, "fetch", {
      get() {
        return fetchWithRetry;
      },
      set(v) {
        // 如果有人覆盖 fetch，更新我们的底层 fetch
        // 这样 request-logger 可以正常工作
        (currentFetch as any) = v;
      },
      configurable: true,
      enumerable: true,
    });
  }

  /**
   * 禁用 fetch 包装（恢复原始 fetch）
   */
  function disableWrapper() {
    // 恢复原始的 fetch（可能包含 request-logger 的包装）
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

  // 初始化时启用包装
  enableWrapper();

  // 注册 /429-retry 命令
  pi.registerCommand("429-retry", {
    description: "Toggle 429 retry or set wait time (e.g. /429-retry 30)",
    handler: async (args, ctx) => {
      const theme = ctx.ui.theme;
      const arg = args?.trim().toLowerCase();

      // 解析参数：数字表示设置等待时间
      if (arg && /^\d+$/.test(arg)) {
        const seconds = parseInt(arg, 10);
        if (seconds > 0) {
          waitMs = seconds * 1000;
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

      // 解析参数：on/off/enable/disable
      if (arg === "on" || arg === "enable" || arg === "true") {
        enabled = true;
        enableWrapper();
        ctx.ui.notify("429 retry enabled", "info");
      } else if (arg === "off" || arg === "disable" || arg === "false") {
        enabled = false;
        disableWrapper();
        ctx.ui.notify("429 retry disabled", "info");
      } else if (!arg) {
        // 无参数：切换状态
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

      // 更新状态栏
      ctx.ui.setStatus(
        "429-retry",
        enabled
          ? theme.fg("dim", `429 retry: ON (${waitMs / 1000}s)`)
          : theme.fg("dim", "429 retry: OFF")
      );
    },
  });

  // session_start 时初始化上下文
  pi.on("session_start", async (_event, ctx) => {
    _ctx = ctx;
    const theme = ctx.ui.theme;
    ctx.ui.setStatus(
      "429-retry",
      theme.fg("dim", `429 retry: ${enabled ? "ON" : "OFF"}`)
    );

    // 3秒后隐藏初始状态（如果没有被限流）
    setTimeout(() => {
      if (!isRateLimited) {
        ctx.ui.setStatus("429-retry", undefined);
      }
    }, 3000);
  });

  // 监听 provider 响应事件，用于额外日志记录
  pi.on("after_provider_response", (event, ctx) => {
    _ctx = ctx;
    if (event.status === 429) {
      // 记录 429 事件（实际重试由 fetch 包装器处理）
      console.log(`[429-retry] Detected 429 response at ${new Date().toISOString()}`);
    }
  });

  // 清理：session 关闭时恢复原始 fetch
  pi.on("session_shutdown", async () => {
    disableWrapper();
  });
}

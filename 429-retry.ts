/**
 * 429 Rate Limit Retry Plugin
 *
 * 当 API 返回 429 (Too Many Requests) 时，等待指定时间后自动重试，
 * 而不是让请求失败或被 SDK 无限挂起。
 *
 * 重试等待时间默认按递增序列增长（5s, 10s, 20s, 30s, 60s, 90s, ...，
 * 到达 30s 后每次 +30s），避免指数退避拖长无意义的等待；
 * 也可通过 /429-retry <seconds> 设为固定值。
 *
 * 通过 /429-retry 命令可以启用/关闭此功能。
 *
 * 与 request-logger 插件兼容：
 * - request-logger 会将 429 改写为 400（防止 SDK 挂起）
 * - 本插件检测改写后的 400 响应，提取等待时间并重试
 * - 两者协作工作，不会冲突
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// 递增重试等待序列（秒）：5, 10, 20, 30, 60, 90, 120, ...
// 到达 30s 后每次固定 +30s，避免指数退避把无意义的等待拖得太长。
const RETRY_WAIT_SEQUENCE_SECONDS = [5, 10, 20, 30];

// 最大重试次数（防止无限循环）
const MAX_RETRIES = 10;

// 重置窗口超过此值即视为"硬限制"，立即失败（不重试）。
// 判定依据（错误标记的来源与逻辑）详见 isHardUsageLimit()。
const HARD_LIMIT_WAIT_MS = 10 * 60 * 1000; // 10 分钟

export default function (pi: ExtensionAPI) {
  // 状态
  let enabled = true;
  let isRateLimited = false;
  let lastRateLimitTime: number | null = null;
  let retryCount = 0;
  // 用户通过 /429-retry <seconds> 显式设置的固定等待时间（null = 使用递增序列）
  let customWaitMs: number | null = null;
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
   * 计算第 attempt 次重试前的等待时间（毫秒）。
   *
   * 默认按递增序列：5s, 10s, 20s, 30s, 60s, 90s, 120s, ...（到达 30s 后
   * 每次 +30s），避免指数退避让无意义的重试拖太长；若用户通过
   * /429-retry <seconds> 显式设置了固定等待时间，则优先使用固定值。
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

  /** 当前等待策略的人类可读描述（用于状态栏） */
  function describeWaitStrategy(): string {
    return customWaitMs !== null ? `${customWaitMs / 1000}s` : "5,10,20,30,60,90...+30s/次";
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
  async function extractWaitTimeFromRewrittenResponse(response: Response, attempt: number): Promise<number> {
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

    // 默认等待时间（按递增序列）
    return getRetryWaitMs(attempt);
  }

  /**
   * 检测"硬"用量限制（不可重试）——命中即快速失败，不进入重试循环。
   *
   * 判定依据（与 pi 上游 isTerminalRateLimitError 的错误分类一致）：
   * 1. 响应 body 携带不可重试的用量限制错误标记。这些标记源自 opencode.ai
   *    （Codex 兼容接口）的错误类型：FreeUsageLimitError（免费档）、
   *    GoUsageLimitError（Go 档）等；insufficient_quota 亦是 OpenAI 的通用
   *    quota 错误码。按 body 文本匹配，对任何 provider 生效（无 URL 门控）。
   * 2. 重置窗口超过 HARD_LIMIT_WAIT_MS（10 分钟）——在合理重试窗口内不会恢复。
   *
   * 命中后：把原始响应交还上层 SDK，让它抛出错误并停止 agent（错误信息含
   * 重置时间），而不是空转最多约 100 分钟（10 次 × 10 分钟）做无意义的重试。
   */
  async function isHardUsageLimit(response: Response, rawWaitMs: number): Promise<boolean> {
    // 信号 1：响应 body 中含有明确的不可重试错误类型
    try {
      const cloned = response.clone();
      const body = await cloned.text();
      if (/FreeUsageLimitError|GoUsageLimitError|UsageLimitError|insufficient_quota|Monthly usage limit/i.test(body)) {
        return true;
      }
    } catch {
      // 忽略 body 读取失败
    }
    // 信号 2：重置窗口超过上限——在合理重试窗口内不会恢复
    return rawWaitMs > HARD_LIMIT_WAIT_MS;
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
      // 解析服务器请求的等待时间（未封顶）；服务器未给出时按递增序列
      const rawWaitMs = response.status === 429
        ? (parseWaitTimeFromResponse(response) ?? getRetryWaitMs(attempts + 1))
        : await extractWaitTimeFromRewrittenResponse(response, attempts + 1);

      // 硬用量限制（判定见 isHardUsageLimit）：立即失败，把原始响应交还上层
      // SDK，让它抛出错误并停止 agent（同时展示重置时间），而不是空转重试。
      if (await isHardUsageLimit(response, rawWaitMs)) {
        const theme = _ctx?.ui?.theme;
        if (theme) {
          _ctx?.ui?.setStatus?.(
            "429-retry",
            theme.fg("dim", "Usage limit reached — surfacing error (no retry)")
          );
        }
        isRateLimited = false;
        return response;
      }

      attempts++;
      isRateLimited = true;
      lastRateLimitTime = Date.now();
      retryCount = attempts;

      // 确保等待时间至少为 1 秒，并封顶防止过长等待
      let actualWaitMs = Math.max(rawWaitMs, 1000);
      actualWaitMs = Math.min(actualWaitMs, HARD_LIMIT_WAIT_MS);

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
          ? theme.fg("dim", `429 retry: ON (${describeWaitStrategy()})`)
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
      theme.fg("dim", `429 retry: ${enabled ? "ON" : "OFF"} (${describeWaitStrategy()})`)
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

/**
 * OpenCode Provider Plugin — opencode / opencode-go provider 增强
 *
 * 功能：headers/payload 伪装（免费档校验绕行）、模型列表直连保活。
 * 免费档由上游推理服务（console/inf 系 provider）做客户端指纹校验
 * （2.0.x 抓包+二分实测，v1 指纹已失效）：
 *   ① payload.stream 必须为 true（非流式一律 403 FreeTierError）；
 *   ② tools 数组需 ≥2 个官方白名单工具名（缺失/为空/任意名都拒）；
 *   ③ header 宽松：v2 UA 形态 opencode/{channel}/{ver}/{client}，附带
 *     x-session-affinity/X-Session-Id（官方 v2 会话亲和头）。
 * system prompt 不注入官方锚点（2.0.x 实测非门槛），保留 pi 原生 system。
 * 压缩后自动续跑；模型元数据来源（api.json 目录 > pi.dev 人工条目，
 * api 字段以目录为准——人工条目会过期，mimo-v2.6-flash-free 曾被错标
 * openai-responses 导致 zen /responses 500）；免费档模型（id 后缀 -free
 * 或 OPENCODE_FREE_RETRY_MODELS 名单）连续 FREE_SESSION_RESET_AFTER 次 >500
 * 后自动轮换 x-opencode-session 并补发 continue（换桶抽签，详见 FREE 常量处
 * 注释）；另有手动 /opencode-session-reset。
 *
 * 环境变量：OPENCODE_UA / OPENCODE_SPOOF / OPENCODE_FILTER_TOOLS /
 * OPENCODE_AUTO_CONTINUE_AFTER_COMPACT / OPENCODE_SESSION_RESET_* /
 * OPENCODE_FREE_RETRY_MODELS / OPENCODE_FREE_SESSION_RESET_AFTER /
 * OPENCODE_FREE_MAX_ROTATIONS / OPENCODE_FREE_CONTINUE_DELAY_MS /
 * OPENCODE_MODELS_URL（api.json 源覆盖）
 */

import { ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// 与官方 opencode packages/opencode/package.json 同步（UA 用）。
// v2 起官方推理 UA 与目录 UA 同形（packages/core/src/session/model-request.ts
// 的 App.useragent）：opencode/{channel}/{version}/{client}，不再带
// ai-sdk/provider-utils 后缀。旧形态目前仍被接受，但按官方最新形态对齐。
const OPENCODE_VERSION = "2.0.15";

const OPENCODE_UA_DEFAULT = `opencode/latest/${OPENCODE_VERSION}/cli`;
const OPENCODE_UA = process.env.OPENCODE_UA || OPENCODE_UA_DEFAULT;
// 统一为官方 v2 UA 形态；保留 OPENCODE_UA_<API> 按 api 形态覆盖的逃生门。
function uaForApi(api: string | undefined): string {
  if (process.env.OPENCODE_UA) return process.env.OPENCODE_UA;
  const key = api ?? "openai-completions";
  const envKey = `OPENCODE_UA_${key.toUpperCase().replace(/-/g, "_")}`;
  return process.env[envKey] || OPENCODE_UA;
}
// 目录/模型列表拉取用的官方 UA 形态：opencode/{channel}/{version}/{client}
// （packages/core/src/models-dev.ts，发布版 channel=latest）
const OPENCODE_CATALOG_UA = OPENCODE_UA_DEFAULT;

const LENGTH = 26;
let lastTimestamp = 0;
let counter = 0;

function randomBase62(length: number): string {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const bytes = randomBytes(length);
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % 62];
  }
  return result;
}

// 与官方 util/id.ts 同构的 ULID 风格 ID：{prefix}_{6字节时间戳hex}{14字符base62}。
// ses_ 用 descending（时间戳取反，新会话排前面），msg_ 用 ascending。
function createId(prefix: string, direction: "ascending" | "descending"): string {
  const currentTimestamp = Date.now();
  if (currentTimestamp !== lastTimestamp) {
    lastTimestamp = currentTimestamp;
    counter = 0;
  }

  counter++;
  let now = BigInt(currentTimestamp) * 0x1000n + BigInt(counter);
  if (direction === "descending") now = ~now;

  let time = "";
  for (let i = 0; i < 6; i++) {
    time += Number((now >> BigInt(40 - 8 * i)) & 0xffn)
      .toString(16)
      .padStart(2, "0");
  }

  return `${prefix}_${time}${randomBase62(LENGTH - 12)}`;
}

const OPENCODE_PROVIDERS = new Set(["opencode", "opencode-go"]);

function isOpencodeProvider(provider: string | undefined): boolean {
  return provider !== undefined && OPENCODE_PROVIDERS.has(provider);
}

/** 宽松门控：尚未选过模型时放行，默认视为 opencode 场景。 */
function gateAllowsOpencode(): boolean {
  return currentProvider === undefined || isOpencodeProvider(currentProvider);
}

const AUTO_CONTINUE_ENABLED = process.env.OPENCODE_AUTO_CONTINUE_AFTER_COMPACT !== "0";
const AUTO_CONTINUE_PROMPT = process.env.OPENCODE_AUTO_CONTINUE_PROMPT || "continue";
const MAX_CONSECUTIVE_AUTO_CONTINUES = 5;
const AUTO_CONTINUE_DELAY_MS = 300;

const SESSION_RESET_AUTO_CONTINUE = process.env.OPENCODE_SESSION_RESET_AUTO_CONTINUE !== "0";
const SESSION_RESET_PROMPT = process.env.OPENCODE_SESSION_RESET_PROMPT || "continue";
const SESSION_RESET_DELAY_MS = Math.max(0, Number(process.env.OPENCODE_SESSION_RESET_DELAY_MS) || 300);

// 免费档连续 5xx 自动轮换：内核自带重试（settings.retry）先在内部消化失败，
// 若同一片段内累计 ≥FREE_SESSION_RESET_AFTER 次「HTTP >500 的真实状态错误」，
// 在整轮收场（agent_settled）时轮换 x-opencode-session 并补发 continue。
// 轮换为什么有效：zen 网关以 "{model}/{sessionId}" 做上游粘性绑定且仅 200 写库，
// 同一 SID 永远撞同一坏上游；SID 末 4 字符参与确定性哈希选桶，换 SID 即对新桶
// 独立抽签（逃脱概率 ≈ 1 - 1/N）。网络/quota 类错误不计入；成功输出即清零；
// 用户输入或切模型会重置轮换预算。名单与 429-retry.ts 共享同一环境变量。
// 默认按 id 后缀判断免费档（zen 免费模型清一色 *-free，另有 big-pickle 等
// 零价别名）；OPENCODE_FREE_RETRY_MODELS 提供精确名单时改用名单。
const FREE_RETRY_MODELS_ENV = process.env.OPENCODE_FREE_RETRY_MODELS;
const FREE_RETRY_MODELS = new Set(
  (FREE_RETRY_MODELS_ENV || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const FREE_SESSION_RESET_AFTER = Math.max(1, Number(process.env.OPENCODE_FREE_SESSION_RESET_AFTER) || 3);
const FREE_MAX_ROTATIONS = Math.max(1, Number(process.env.OPENCODE_FREE_MAX_ROTATIONS) || 5);
const FREE_CONTINUE_DELAY_MS = Math.max(0, Number(process.env.OPENCODE_FREE_CONTINUE_DELAY_MS) || 10_000);

const AUTH_ERROR_RE = /api error: 40[13]\b|invalid(?:[_\s]api)?[_\s]key|unauthorized|forbidden/i;

function isFreeRetryModel(modelId: string | undefined | null): boolean {
  if (typeof modelId !== "string") return false;
  if (FREE_RETRY_MODELS_ENV !== undefined) return FREE_RETRY_MODELS.has(modelId);
  return modelId.endsWith("-free") || modelId === "big-pickle";
}

// 从 errorMessage 提取 HTTP 状态码；锚点模式避免误抓 body 里的随机数字
function extractHttpStatus(message: string | undefined | null): number | undefined {
  if (!message) return undefined;
  const patterns = [
    /^\s*(\d{3}):\s/,                                        // "503: <body>"
    /[(:]\s*(\d{3})\s*\)\s*:/,                              // "prefix (503): ..."
    /\berror\s*:\s*(\d{3})\b/i,                             // "API error: 429 ..."
    /\bstatus(?:\s+code)?[:=\s]+(\d{3})\b/i,                // "status: 503"
    /\b(\d{3})\s+(?:-\s*)?(?:service unavailable|internal server error|bad gateway|gateway time.?out|overloaded|unavailable)\b/i,
  ];
  for (const re of patterns) {
    const m = re.exec(message);
    if (m) {
      const n = Number(m[1]);
      if (n >= 400 && n <= 599) return n;
    }
  }
  return undefined;
}

let currentProvider: string | undefined;

let autoContinueEnabled = AUTO_CONTINUE_ENABLED;
let autoContinueArmed = false;
let consecutiveAutoContinues = 0;

let retryTimer: ReturnType<typeof setTimeout> | undefined;

// —— 免费档连续 5xx 轮换状态 ——
interface TurnAssistantMessage {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
  model?: string;
}
let consecutiveServerErrors = 0; // 连续 >500 计数，成功输出即清零
let pendingSessionReset = false; // 计数达阈值，待 agent_settled 轮换并续跑
let freeRotations = 0; // 已自动轮换次数（上限 FREE_MAX_ROTATIONS，用户输入/成功后清零）

function clearRetryTimer() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = undefined;
  }
}

// 内核对扩展动作的异步失败完全静默（emitError 无监听者），排障只能自己记日志
const RETRY_DEBUG = process.env.OPENCODE_RETRY_DEBUG === "1";
function debugLog(msg: string) {
  if (!RETRY_DEBUG) return;
  try {
    appendFileSync("/tmp/opencode-provider-debug.log", `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

const OPENCODE_ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";
const OPENCODE_GO_MODELS_URL = "https://opencode.ai/zen/go/v1/models";
const MODELS_FETCH_TIMEOUT_MS = 12000;

// ── 模型元数据层：直连 models.opencode.ai/api.json ─────────────────────────
// v2 起官方 CLI 不再落盘 ~/.cache/opencode/models.json（models --refresh 已移除），
// 本扩展直接拉官方目录 api.json（与 models-dev.ts 的 fetchApi 同源）。内存缓存
// 1h；本地 models.json 若存在（旧版 CLI 写过）作为离线兜底。
// 元数据优先级（2.0.x 实测修正）：api.json 目录 > pi.dev 人工条目 —— 人工条目的
// api 字段会过期（mimo-v2.6-flash-free 曾被错标 openai-responses → zen /responses
// 500），目录才是路由真相。
const OPENCODE_CACHE_MODELS_PATH = join(
  process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
  "opencode",
  "models.json",
);
const OPENCODE_API_JSON_URL = process.env.OPENCODE_MODELS_URL
  ? `${process.env.OPENCODE_MODELS_URL.replace(/\/$/, "")}/api.json`
  : "https://models.opencode.ai/api.json";
const OPENCODE_API_CACHE_TTL_MS = 60 * 60_000;
const ZEN_V1_BASE_URL = "https://opencode.ai/zen/v1";
const ZEN_GO_BASE_URL = "https://opencode.ai/zen/go/v1";

type OpencodeCacheSections = Record<string, { api?: string; npm?: string; models: Record<string, any> } | undefined>;

function pickSections(blob: Record<string, any> | undefined): OpencodeCacheSections | undefined {
  if (!blob) return undefined;
  const pick = (id: string) => {
    const p = blob[id];
    return p ? { api: p.api, npm: p.npm, models: p.models ?? {} } : undefined;
  };
  return { opencode: pick("opencode"), "opencode-go": pick("opencode-go") };
}

function readOpencodeCache(): OpencodeCacheSections | undefined {
  try {
    return pickSections(JSON.parse(readFileSync(OPENCODE_CACHE_MODELS_PATH, "utf8")));
  } catch {
    return undefined;
  }
}

let apiJsonCache: { at: number; sections: OpencodeCacheSections } | undefined;
let apiJsonLastFail = 0;

// 拉取 api.json 并按 provider 切段。失败有 60s 重试间隔，避免每次刷新都打。
async function fetchApiJson(signal: AbortSignal, timeoutMs: number): Promise<OpencodeCacheSections | undefined> {
  if (apiJsonCache && Date.now() - apiJsonCache.at < OPENCODE_API_CACHE_TTL_MS) return apiJsonCache.sections;
  if (Date.now() - apiJsonLastFail < 60_000) return apiJsonCache?.sections;
  try {
    const blob = await fetchJson(OPENCODE_API_JSON_URL, undefined, signal, timeoutMs);
    const sections = pickSections(blob);
    if (sections) apiJsonCache = { at: Date.now(), sections };
    return sections;
  } catch {
    apiJsonLastFail = Date.now();
    return apiJsonCache?.sections;
  }
}

// 腿级诊断（一行一条，无 token/对话内容）：下次 /model 再报
// “Could not refresh opencode” 时，用它判定到底是 base 层（pi.dev）先抛
// （此时本腿往往还没跑完、日志里没有对应行），还是本腿自己卡住。
function refreshLog(provider: string, msg: string) {
  try {
    appendFileSync("/tmp/opencode-refresh.log", `${new Date().toISOString()} ${provider} ${msg}\n`);
  } catch {}
}

// 真正的 error.message 只有 TUI 拿到过（它只显示 provider 名），进程外的复现脚本
// （troubleshooting/scripts/check-opencode-refresh.mjs）又抓不到进程内的时序，所以这里
// 一次性包住 ModelRuntime.refresh，把每条 errors 的 message/cause/stack 记到同一个日志：
//   · 有 trace 行、但本轮没有 zen 行      → base 层（withRemoteCatalog → pi.dev）先抛；
//   · 有 trace 行、也有 zen ok/persist ok → 是本腿之后才抛的（组合层 publish/
//     applyExtension、models-store/auth 文件锁、凭据读取等）。
const REFRESH_TRACE_FLAG = Symbol.for("pi.extensions.opencode-provider.refreshTrace");
function installRefreshTrace(): void {
  const holder = globalThis as any;
  if (holder[REFRESH_TRACE_FLAG]) return;
  const proto = (ModelRuntime as any)?.prototype;
  const original = proto?.refresh;
  if (!proto || typeof original !== "function") return;
  holder[REFRESH_TRACE_FLAG] = true;
  proto.refresh = async function (this: unknown, options?: any): Promise<any> {
    const started = Date.now();
    const result: any = await original.call(this, options);
    try {
      const errors: Map<string, any> | undefined = result?.errors;
      if (errors && errors.size) {
        const opts = options ?? {};
        const providers = Array.isArray(opts.providers) ? opts.providers.join("|") : "*";
        refreshLog(
          "trace",
          `refresh errors=${errors.size} in=${Date.now() - started}ms allowNetwork=${opts.allowNetwork} ` +
            `force=${opts.force} providers=${providers} aborted=${result?.aborted}`,
        );
        for (const [pid, err] of errors) {
          refreshLog("trace", `  ${pid}: ${err?.message ?? String(err)}`);
          if (err?.cause?.message) refreshLog("trace", `    cause: ${err.cause.message}`);
          refreshLog("trace", `    stack: ${String(err?.stack ?? "").split("\n").slice(1, 5).join(" <- ")}`);
        }
      }
    } catch {}
    return result;
  };
}

// 会话启动预热：冷进程启动时内核先用纯内置 provider 做一次全量刷新，此时本插件
// 还没注册，opencode 走的就是裸 withRemoteCatalog —— 若落盘过期（>3h，隔夜首次）
// 它必去拉 pi.dev，赶上冷启动惊群（几十个 provider 并发 + CLI 子进程）就容易
// 429/超时而 throw，TUI 只显示 provider 名（Could not refresh opencode）。
// 刷新链内的 touchStoredFreshness 够不着这次启动刷新，所以在 session_start 用
// 官方 FileModelsStore（同锁协议、同格式，动态定位已安装版本）把自家两条目提前
// 保鲜；之后的一切刷新里 base 都走「新鲜跳过」，pi.dev 拉取实质上不再发生。
// 找不到官方实现时静默跳过（链内 touch 仍在，不影响正常链路）。
const PREWARM_STALE_MS = 3 * 60 * 60 * 1000;
let prewarmDone = false;
async function loadInstalledFileModelsStore(): Promise<any | undefined> {
  try {
    const base = join(homedir(), ".vite-plus", "packages", "@earendil-works", "pi-coding-agent");
    const vers = readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
      .reverse(); // 最新安装优先
    for (const v of vers) {
      const p = join(
        base, v, "lib", "node_modules", "@earendil-works", "pi-coding-agent",
        "dist", "core", "models-store.js",
      );
      try {
        const mod = await import(pathToFileURL(p).href);
        if (mod?.FileModelsStore) return mod;
      } catch {
        /* 换下一个版本目录 */
      }
    }
  } catch {}
  return undefined;
}

async function prewarmStoredFreshness(): Promise<void> {
  if (prewarmDone) return;
  prewarmDone = true;
  try {
    const storeMod = await loadInstalledFileModelsStore();
    if (!storeMod) return;
    const agentDir =
      process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
    const store = new storeMod.FileModelsStore(join(agentDir, "models-store.json"));
    for (const provider of ["opencode", "opencode-go"] as const) {
      let entry: any;
      try {
        entry = await store.read(provider);
      } catch {
        continue;
      }
      const checkedAt = entry?.checkedAt;
      if (typeof checkedAt === "number" && Date.now() - checkedAt <= PREWARM_STALE_MS) continue;
      try {
        await store.write(provider, {
          models: Array.isArray(entry?.models) ? entry.models : [],
          checkedAt: Date.now(),
          lastModified: entry?.lastModified ?? 0,
          etag: entry?.etag,
        });
        refreshLog(provider, "prewarm bump checkedAt (was stale/missing)");
      } catch {}
    }
  } catch {}
}

// models.dev → pi api 协议映射。用 store 里 61 个 pi.dev 人工条目实测校准：
//   @ai-sdk/anthropic → anthropic-messages (14)
//   @ai-sdk/openai → openai-responses (24)
//   @ai-sdk/google* → google-generative-ai (6)
//   @ai-sdk/openai-compatible（provider 级默认）→ openai-completions (17)
function modelsDevApi(npm: string | undefined): string {
  if (npm?.includes("anthropic")) return "anthropic-messages";
  if (npm?.includes("google")) return "google-generative-ai";
  if (npm?.includes("openai-compatible")) return "openai-completions";
  return "openai-responses";
}

// 与 pi-ai getEffortThinkingLevelMap 语义一致（scripts/models-dev-reasoning-options.ts）：
// effort 选项映射到 pi 的 thinking levels，无对应值的档位补 null，无任何可映射值时返回 undefined。
const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
function effortThinkingLevelMap(options: any): Record<string, string | null> | undefined {
  const values = (options ?? []).flatMap((o: any) => (o?.type === "effort" ? o.values : []));
  if (values.length === 0) return undefined;
  const supported = new Set(values.filter((v: unknown): v is string => typeof v === "string"));
  if (!THINKING_LEVELS.some((level) => supported.has(level)) && !supported.has("none")) return undefined;
  const map: Record<string, string | null> = { off: supported.has("none") ? "none" : null };
  for (const level of THINKING_LEVELS) map[level] = supported.has(level) ? level : null;
  return map;
}

// 免费档模型集合（api.json 中 cost 全 0），refresh 时填充。
// 用途：①匿名免费档请求必须 stream:true（上游 FreeTierError 指纹校验，2.0.x 实测）；
// ②无 OPENCODE_FREE_RETRY_MODELS 时该集合也作为 5xx 轮换名单的补充。
const freeModelIds = new Set<string>();

// 官方 fromModelsDevModel（provider.ts）字段映射的 pi 等价物：
// limit.context→contextWindow、limit.output→maxTokens、modalities.input→input（只留 pi 支持的
// text/image）、cost 逐字段换名；compat 取 pi.dev 人工条目的众数模式（24 个 responses 全带
// sessionAffinityFormat=openai-nosession，completions 众数带 maxTokensField=supportsStore 等三件套）。
// providerNpm：模型级 provider.npm 常为 null，回退到 provider 段级 npm（opencode 段为
// @ai-sdk/openai-compatible → openai-completions）。
function convertModelsDevModel(m: any, baseUrl: string, providerNpm?: string) {
  const api = modelsDevApi(m.provider?.npm ?? providerNpm);
  const compat =
    api === "openai-responses"
      ? { sessionAffinityFormat: "openai-nosession" }
      : api === "openai-completions"
        ? { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens" }
        : {};
  return {
    id: m.id,
    name: m.name ?? m.id,
    api,
    baseUrl,
    reasoning: m.reasoning ?? false,
    input: (m.modalities?.input ?? ["text"]).filter((x: string) => x === "text" || x === "image"),
    cost: {
      input: m.cost?.input ?? 0,
      output: m.cost?.output ?? 0,
      cacheRead: m.cost?.cache_read ?? 0,
      cacheWrite: m.cost?.cache_write ?? 0,
    },
    contextWindow: m.limit?.context ?? 128_000,
    maxTokens: m.limit?.output ?? m.limit?.input ?? 32_000,
    thinkingLevelMap: effortThinkingLevelMap(m.reasoning_options),
    compat,
  };
}

async function fetchJson(
  url: string,
  apiKey: string | undefined,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<any> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": OPENCODE_CATALOG_UA,
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(url, { headers, signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`${url} ${res.status} ${txt.slice(0, 200)}`);
  }
  return res.json();
}

function resolveApiKey(context: any): string | undefined {
  const cred = context?.credential as { type?: string; key?: string; access?: string } | undefined;
  if (cred?.type === "api_key" && cred.key) return cred.key;
  if (cred?.type === "oauth" && cred.access) return cred.access;
  return process.env.OPENCODE_API_KEY || undefined;
}

function toModelEntry(m: any) {
  return {
    id: m.id,
    name: m.name,
    api: m.api,
    baseUrl: m.baseUrl,
    reasoning: m.reasoning,
    input: m.input,
    cost: m.cost,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    thinkingLevelMap: m.thinkingLevelMap,
    compat: m.compat,
  };
}

// 把共享 models-store.json 条目的 checkedAt 提前，使其永远「新鲜」：
// pi 的 withRemoteCatalog 包装层在 checkedAt >4h 时会请求 pi.dev 且失败即让整个
// opencode 刷新 throw（即使 zen 本身可达），提前保鲜让它永远走「新鲜跳过」分支。
async function touchStoredFreshness(
  provider: "opencode" | "opencode-go",
  context: any,
): Promise<void> {
  const stored = context?.stored as Record<string, any> | undefined;
  // 缺少 stored 或 checkedAt 时也要初始化，避免 withRemoteCatalog 因 checkedAt 无效而每次都去 pi.dev 并 throw
  if (!stored) {
    try {
      await context?.publish?.({
        persist: {
          models: [],
          checkedAt: Date.now(),
          lastModified: 0,
          etag: undefined,
        },
      });
    } catch {}
    return;
  }
  if (typeof stored.checkedAt !== "number") {
    try {
      await context?.publish?.({
        persist: {
          models: (stored.models ?? []).map((m: any) =>
            typeof m === "object" && m !== null ? { ...m, provider } : m,
          ),
          checkedAt: Date.now(),
          lastModified: stored.lastModified ?? Date.now(),
          etag: stored.etag,
        },
      });
    } catch {}
    return;
  }
  // 阈值 3h（<4h 触发线），避免每次恢复都写盘
  if (Date.now() - stored.checkedAt <= 3 * 60 * 60 * 1000) return;
  try {
    await context?.publish?.({
      persist: {
        models: (stored.models ?? []).map((m: any) =>
          typeof m === "object" && m !== null ? { ...m, provider } : m,
        ),
        checkedAt: Date.now(),
        lastModified: stored.lastModified ?? Date.now(),
        etag: stored.etag,
      },
    });
  } catch {}
}

async function refreshOpencodeProvider(
  provider: "opencode" | "opencode-go",
  context: any,
): Promise<any[] | undefined> {
  const known = new Map<string, any>();
  for (const m of context?.stored?.models ?? []) known.set(m.id, m);

  // 离线/缓存恢复阶段必须用 stored 还原列表，否则 /new 重建 provider 后
  // 模型列表会退化成 pi 内置的少数几个，opencode 模型不可选
  if (!context?.allowNetwork) {
    // 顺带用 stored 的零价条目预填免费档集合（stream 指纹要用，等不到联网刷新）
    for (const m of known.values()) {
      const c = m?.cost;
      if (c && (c.input ?? 0) === 0 && (c.output ?? 0) === 0) freeModelIds.add(m.id);
    }
    if (known.size === 0) {
      await touchStoredFreshness(provider, context);
      return undefined;
    }
    await touchStoredFreshness(provider, context);
    return [...known.values()].map(toModelEntry);
  }

  const url = provider === "opencode" ? OPENCODE_ZEN_MODELS_URL : OPENCODE_GO_MODELS_URL;

  // 本腿开跑 = base 层（withRemoteCatalog → pi.dev）没抛；顺带记下它会看到的保鲜输入，
  // 好判断“若哪天它抛了”是不是因为落盘过期（age > 4h 或 lastModified 缺失）。
  const storedCheckedAt = context?.stored?.checkedAt;
  refreshLog(
    provider,
    `net phase force=${String(context?.force)} stored=${known.size} ` +
      `age=${typeof storedCheckedAt === "number" ? Date.now() - storedCheckedAt : "n/a"}ms ` +
      `lastModified=${String(context?.stored?.lastModified)} aborted=${String(context?.signal?.aborted)}`,
  );

  let liveIds: string[];
  const zenStart = Date.now();
  try {
    liveIds = ((await fetchJson(url, resolveApiKey(context), context.signal, MODELS_FETCH_TIMEOUT_MS))?.data ?? []).map(
      (m: any) => m.id,
    );
    refreshLog(provider, `zen ok live=${liveIds.length} known=${known.size} in=${Date.now() - zenStart}ms`);
  } catch (e) {
    // 网络失败：保持 stored 恢复的列表不动，顺带保鲜 checkedAt
    refreshLog(provider, `zen fail in=${Date.now() - zenStart}ms err=${(e as Error)?.message?.slice(0, 120) ?? e}`);
    await touchStoredFreshness(provider, context);
    return undefined;
  }
  if (liveIds.length === 0) {
    // 保持保鲜，避免 checkedAt 陈旧导致下次必走 pi.dev 并 throw
    await touchStoredFreshness(provider, context);
    return undefined;
  }

  // 不对 /v1/models 做交集过滤：zen 返回什么就显示什么。元数据来源：
  // 1) models.opencode.ai/api.json（官方目录，权威路由信息 api/baseUrl）——
  //    内存缓存 1h，miss 时拉一次；
  // 2) stored（pi.dev 人工条目）只作元数据补充，其 api 字段可能过期
  //    （mimo-v2.6-flash-free 曾被标 openai-responses → zen /responses 500），
  //    目录有该模型时 api 一律以目录为准；
  // 3) 本地 ~/.cache/opencode/models.json（v1 CLI 遗产）仅作 api.json 拉不到时的兜底。
  let sections = await fetchApiJson(context.signal, MODELS_FETCH_TIMEOUT_MS);
  if (!sections || liveIds.some((id) => !sections?.[provider]?.models?.[id] && !known.has(id))) {
    // 有未知 id 但缓存段不全：缓存可能陈旧，强制重拉一次（受 TTL 外强制刷新）
    if (apiJsonCache && Date.now() - apiJsonCache.at < OPENCODE_API_CACHE_TTL_MS && apiJsonCache.sections === sections) {
      apiJsonCache = undefined;
      sections = await fetchApiJson(context.signal, MODELS_FETCH_TIMEOUT_MS);
    }
  }
  if (!sections) sections = readOpencodeCache();
  const section = sections?.[provider];
  const devBase = section?.api || (provider === "opencode" ? ZEN_V1_BASE_URL : ZEN_GO_BASE_URL);

  // 免费档集合（cost 全 0）：供 stream 强制与 5xx 轮换名单使用
  for (const id of liveIds) {
    const md = section?.models?.[id];
    const c = md?.cost ?? known.get(id)?.cost;
    if (c && (c.input ?? 0) === 0 && (c.output ?? 0) === 0) freeModelIds.add(id);
  }

  const out: any[] = [];
  for (const id of liveIds) {
    const md = section?.models?.[id];
    const curated = known.get(id);
    if (curated && !md) {
      out.push(toModelEntry(curated));
      continue;
    }
    if (md) {
      // 目录收录：以目录为准生成，人工条目仅补充目录缺的精修字段
      const entry = convertModelsDevModel({ ...md, id }, devBase, section?.npm);
      if (curated) {
        entry.name = curated.name ?? entry.name;
        if (curated.thinkingLevelMap && !entry.thinkingLevelMap) entry.thinkingLevelMap = curated.thinkingLevelMap;
      }
      out.push(entry);
    }
    // 既无目录条目也无人工条目（如 zen-go 的 hy3-preview）：连 api 协议
    // 都无从确定，硬造必然 400，只能等目录收录后自动出现。
  }
  if (out.length === 0) {
    await touchStoredFreshness(provider, context);
    return undefined;
  }

  try {
    await context?.publish?.({
      persist: {
        models: out.map((m) => ({ ...m, provider })),
        checkedAt: Date.now(),
        lastModified: Date.now(),
        etag: `live-${Date.now()}`,
      },
    });
    refreshLog(provider, `persist ok out=${out.length} live=${liveIds.length}`);
  } catch {}

  return out;
}

// 免费档伪装：上游推理服务校验客户端指纹。2.0.x 实测（2026-01 重测，老指纹已全面 403）：
// ① payload.stream 必须为 true —— 非流式请求一律 403 FreeTierError；
// ② tools 数组必须非空且 ≥2 个官方白名单工具名（任意名不计入，单工具名也拒）；
// ③ header 校验宽松：v1/v2 UA 形态、x-opencode-* 有无都过，x-session-affinity/
//    X-Session-Id 为 v2 官方新增，照发。
// system prompt 不注入官方锚点（实测非门槛），保留 pi 原生 system。
// 验证标准 = mimo-v2.6-flash-free / big-pickle 实际返回 200 流。
const SPOOF_ENABLED = process.env.OPENCODE_SPOOF !== "0";

// 默认关闭：免费档只要求四件套存在，无需过滤其余工具。开启会删掉末位工具上的
// cache_control 断点，因此过滤后需在新的末位补回。
const TOOL_FILTER_ENABLED = process.env.OPENCODE_FILTER_TOOLS === "1";

// 官方内置工具名白名单（opencode builtin 工具，v1+v2 合并）
const OFFICIAL_TOOL_NAMES = new Set([
  "invalid",
  "question",
  "bash",
  "shell",
  "read",
  "glob",
  "grep",
  "edit",
  "write",
  "task",
  "subagent",
  "webfetch",
  "todowrite",
  "websearch",
  "skill",
  "apply_patch",
  "lsp",
  "plan",
  "execute",
]);

// 免费档指纹要求 ≥2 个白名单官方工具名（2.0.x 实测）。同时注 v1/v2 两套命名
// （bash 与 shell、read 均算白名单），pi 原生工具通常已满足。
const REQUIRED_TOOL_NAMES = ["bash", "shell", "glob", "grep", "read"] as const;
// 免费档指纹要求的最小白名单工具数
const MIN_WHITELIST_TOOLS = 2;

// stub 描述：引导模型优先用 pi 的等价真实工具，降低误调 stub 的概率
const TOOL_STUB_HINTS: Record<string, string> = {
  bash: "Executes a given bash command in a persistent shell session with optional timeout.",
  shell: "Executes a shell command. Prefer the dedicated bash tool if available.",
  glob: "Fast file pattern matching tool. If a find tool is available, prefer it; otherwise use bash with find/ls.",
  grep: "Searches file contents using regular expressions. Prefer the dedicated grep/search tool if available.",
  read: "Reads a file from the local filesystem.",
};

// 各 payload 形状的 tool 结构不同：chat/completions 是 {type:"function",function:{name}},
// messages/responses 是顶层 {name}。按形状取名、按形状补 stub。
function toolNameOf(t: any): string | undefined {
  if (typeof t?.name === "string") return t.name;
  if (typeof t?.function?.name === "string") return t.function.name;
  return undefined;
}

function makeToolStub(payload: Record<string, any>, name: string): Record<string, any> {
  const params = { type: "object", properties: {}, additionalProperties: true };
  const tools = Array.isArray(payload.tools) ? (payload.tools as any[]) : [];
  // 以已有工具条目的形状为准：有 function 包装 = openai chat/completions；
  // 顶层 name + input_schema = anthropic messages；顶层 name + parameters = responses。
  const sample = tools.find((t) => t && typeof t === "object");
  if (sample && typeof sample === "object") {
    if (typeof sample.function === "object" && sample.function !== null) {
      return { type: "function", function: { name, description: TOOL_STUB_HINTS[name] ?? name, parameters: params } };
    }
    if ("input_schema" in sample) {
      return { name, description: TOOL_STUB_HINTS[name] ?? name, input_schema: params };
    }
    // responses 形状或未知顶层 name 形状
    return { type: "function", name, description: TOOL_STUB_HINTS[name] ?? name, parameters: params };
  }
  // tools 数组为空：按 payload 顶层键判别
  if (Array.isArray(payload.system)) {
    return { name, description: TOOL_STUB_HINTS[name] ?? name, input_schema: params };
  }
  return { type: "function", function: { name, description: TOOL_STUB_HINTS[name] ?? name, parameters: params } };
}

// 2.0.x 门槛：tools 中需 ≥MIN_WHITELIST_TOOLS 个白名单工具名（非白名单名不计）。
// 不足时从 REQUIRED_TOOL_NAMES 里挑缺的补 stub 直到达标。
function ensureRequiredTools(payload: Record<string, any>): boolean {
  const tools = payload.tools as any[];
  const present = new Set(tools.map(toolNameOf).filter(Boolean));
  const whitelisted = [...present].filter((n) => OFFICIAL_TOOL_NAMES.has(n as string));
  if (whitelisted.length >= MIN_WHITELIST_TOOLS) return false;
  let added = false;
  for (const name of REQUIRED_TOOL_NAMES) {
    if (whitelisted.length >= MIN_WHITELIST_TOOLS) break;
    if (present.has(name)) continue;
    tools.push(makeToolStub(payload, name));
    present.add(name);
    whitelisted.push(name);
    added = true;
  }
  return added;
}

function spoofPayload(payload: Record<string, any>, modelId: string): boolean {
  let changed = false;

  // 免费档指纹（2.0.x 实测）：tools 数组必须含 ≥2 个白名单官方工具名，否则
  // 403 FreeTierError "free tier can only be used from within OpenCode"。
  // tools 字段缺失/为空同样被拒——标题生成等小调用不带 tools 就会挂，
  // 所以缺字段时也注入 stub（只影响请求形状，与官方 agent 请求一致）。
  // stub 描述里引导模型用对应的真实工具，即便模型误调也只是普通工具错误，
  // 远好于整轮 403。
  if (Array.isArray(payload.tools)) {
    changed = ensureRequiredTools(payload) || changed;
  } else if (payload.tools === undefined || payload.tools === null) {
    payload.tools = REQUIRED_TOOL_NAMES.slice(0, MIN_WHITELIST_TOOLS).map((name) => makeToolStub(payload, name));
    changed = true;
  }

  // 免费档指纹（2.0.x 实测）：stream 必须为 true。匿名免费档的非流式请求必 403，
  // 对免费模型强制改写 stream=true（pi 正常路径本来就流式，只兜底标题生成等小调用；
  // 三种 api 形态里 stream 字段同名同义）。
  if (freeModelIds.has(modelId) && payload.stream !== true) {
    payload.stream = true;
    changed = true;
  }

  if (TOOL_FILTER_ENABLED && Array.isArray(payload.tools)) {
    const toolName = (t: any) => (typeof t?.name === "string" ? t.name : t?.function?.name);
    const filtered = payload.tools.filter((t: any) => {
      const name = toolName(t);
      return typeof name === "string" && OFFICIAL_TOOL_NAMES.has(name);
    });
    if (filtered.length !== payload.tools.length) {
      payload.tools = filtered;
      changed = true;
      // 过滤删掉了 pi 打在末位工具上的 cache_control 断点，需在新的末位补回
      const last = payload.tools[payload.tools.length - 1];
      if (last && typeof last === "object") {
        (last as any).cache_control = { type: "ephemeral" };
      }
    }
  }

  return changed;
}

export default function (pi: ExtensionAPI) {
  const setEnv = (name: string, value: string) => {
    process.env[name] = value;
  };

  // /model 只报 provider 名，装上这个才看得到真正的 error.message（写进 /tmp/opencode-refresh.log）
  installRefreshTrace();

  pi.on("session_start", async (_event, _ctx) => {
    setEnv("OPENCODE_SESSION_ID", createId("ses", "descending"));
    consecutiveAutoContinues = 0;
    autoContinueArmed = false;
    consecutiveServerErrors = 0;
    pendingSessionReset = false;
    freeRotations = 0;
    // 保鲜先行（见 prewarmStoredFreshness 注释）：不阻塞启动，失败静默。
    void prewarmStoredFreshness().catch(() => {});
  });

  pi.on("session_shutdown", async () => {
    autoContinueArmed = false;
    clearRetryTimer();
  });

  pi.on("before_agent_start", async (_event, _ctx) => {
    setEnv("OPENCODE_REQUEST_ID", createId("msg", "ascending"));
  });

  // 直接注入 headers：$ENV 插值在 SEA/新 loader 下可能失效，此处为兜底双保险。
  pi.on("before_provider_headers", async (event, ctx) => {
    if (!isOpencodeProvider(ctx.model?.provider)) return;
    const sid = process.env.OPENCODE_SESSION_ID;
    const rid = process.env.OPENCODE_REQUEST_ID;
    event.headers["User-Agent"] = uaForApi(ctx.model?.api);
    event.headers["x-opencode-client"] = "cli";
    event.headers["x-opencode-project"] = "global";
    if (sid) {
      event.headers["x-opencode-session"] = sid;
      // v2 官方附带会话亲和头（packages/core/src/session/model-request.ts）
      event.headers["x-session-affinity"] = sid;
      event.headers["X-Session-Id"] = sid;
    }
    if (rid) event.headers["x-opencode-request"] = rid;
  });

  pi.on("before_provider_request", async (event, ctx) => {
    if (!SPOOF_ENABLED) return undefined;
    if (!isOpencodeProvider(ctx.model?.provider)) return undefined;
    const payload = event.payload as Record<string, any> | undefined;
    if (!payload || typeof payload !== "object") return undefined;

    const modelId = typeof payload.model === "string" ? payload.model : ctx.model?.id ?? "";
    return spoofPayload(payload, modelId) ? payload : undefined;
  });

  pi.on("model_select", async (event) => {
    currentProvider = event.model.provider;
    // 手动切换模型 = 用户接管：重置续跑计数与轮换预算
    consecutiveAutoContinues = 0;
    consecutiveServerErrors = 0;
    pendingSessionReset = false;
    freeRotations = 0;
  });

  pi.on("session_compact", async (event) => {
    if (!autoContinueEnabled) return;
    if (event.reason === "manual") return; // 手动 /compact：不自动续跑
    if (!gateAllowsOpencode()) return;
    autoContinueArmed = true;
  });

  pi.on("session_compact_failed", async () => {
    autoContinueArmed = false;
    clearRetryTimer();
  });

  // 新 turn 启动说明会话正在自行继续：撤销待发动作，避免双发
  pi.on("agent_start", async () => {
    autoContinueArmed = false;
    clearRetryTimer();
  });

  // assistant 以 error 停止 → 免费档累计连续 >500；达到阈值武装轮换，
  // 待 agent_settled（内核自身重试预算烧完后）执行轮换 + 补发 continue。
  pi.on("turn_end", async (event) => {
    const msg = event.message as TurnAssistantMessage | undefined;
    if (msg?.role !== "assistant") return;

    // 成功停止 → 片段结束：计数与轮换预算全部清零，不叠加旧账
    if (msg.stopReason !== "error") {
      consecutiveServerErrors = 0;
      pendingSessionReset = false;
      freeRotations = 0;
      return;
    }

    if (!gateAllowsOpencode()) return;
    if (!isFreeRetryModel(msg.model)) return;

    const message = msg.errorMessage ?? "";
    if (AUTH_ERROR_RE.test(message)) return; // 认证类错误重试/轮换都无意义

    const status = extractHttpStatus(message);
    if (status !== undefined && status > 500) {
      consecutiveServerErrors++;
      if (consecutiveServerErrors >= FREE_SESSION_RESET_AFTER && freeRotations < FREE_MAX_ROTATIONS) {
        pendingSessionReset = true;
        debugLog(`5xx x${consecutiveServerErrors} -> rotate armed (${freeRotations}/${FREE_MAX_ROTATIONS})`);
      }
    }
  });

  // 派发 continue 并验证是否真的启动了新 run。内核对扩展动作的异步失败完全
  // 静默（runtime.sendUserMessage 返回 undefined，异常进 emitError 而 TUI 没有
  // errorListener），唯一可靠的失败检测是「派发后 8s 会话仍完全空闲」；检到
  // 则告警并重派最多 3 次，最常见原因是 OAuth 过期（提示 /login）。LLM 调用
  // 不可能 8s 内走完整个生命周期，故无误报。
  function dispatchContinue(settleCtx: unknown, promptText: string, attemptNo: number) {
    const c = settleCtx as
      | {
          isIdle?: () => boolean;
          hasPendingMessages?: () => boolean;
          ui?: { notify?: (msg: string, level?: string) => void };
        }
      | undefined;
    const notifyWarn = (msg: string) => {
      try {
        c?.ui?.notify?.(msg, "warning");
      } catch {}
    };
    debugLog(`dispatch #${attemptNo}: "${promptText.slice(0, 40)}"`);
    try {
      const dispatched = pi.sendUserMessage(promptText) as unknown;
      if (dispatched instanceof Promise) {
        dispatched.catch((err: unknown) => {
          debugLog(`dispatch #${attemptNo} rejected: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      debugLog(`dispatch #${attemptNo} threw sync: ${m}`);
      notifyWarn(`opencode: auto-continue failed: ${m}`);
      return;
    }
    setTimeout(() => {
      let idle = true;
      let pending = false;
      try {
        idle = c?.isIdle?.() ?? true;
        pending = c?.hasPendingMessages?.() ?? false;
      } catch {}
      debugLog(`post-dispatch #${attemptNo}: idle=${idle} pending=${pending}`);
      if (!idle || pending) return; // 新 run 已启动 / 有排队消息，视为成功
      notifyWarn(
        `opencode: continue #${attemptNo} did not start (session still idle). ` +
          `If this persists, credentials may have expired - run /login opencode.`,
      );
      if (attemptNo < 3) {
        setTimeout(() => dispatchContinue(settleCtx, promptText, attemptNo + 1), 30_000);
      } else {
        notifyWarn("opencode: giving up auto-continue after 3 dispatch attempts.");
      }
    }, 8000);
  }

  // 压缩后自动续跑：session_compact（非手动）武装，收场后补发一条 continue。
  // 阈值压缩时内核不会自己续跑；overflow 恢复时内核先自行 continue，
  // 成功则上面的 agent_start 已撤销武装，失败落在这里兜底。
  pi.on("agent_settled", async (_event, ctx) => {
    // 优先级 1：压缩续跑
    if (autoContinueArmed) {
      if (consecutiveAutoContinues >= MAX_CONSECUTIVE_AUTO_CONTINUES) return;
      autoContinueArmed = false;
      consecutiveAutoContinues++;
      clearRetryTimer();
      retryTimer = setTimeout(() => dispatchContinue(ctx, AUTO_CONTINUE_PROMPT, 1), AUTO_CONTINUE_DELAY_MS);
      return;
    }

    // 优先级 2：免费档连续 5xx → 轮换 SID 后补发 continue（新请求即重新分桶）
    if (!pendingSessionReset || !gateAllowsOpencode()) return;
    pendingSessionReset = false;
    if (freeRotations >= FREE_MAX_ROTATIONS) {
      debugLog("rotate skipped: rotation budget exhausted");
      ctx?.ui?.notify?.(
        `opencode: upstream keeps 5xx-ing - gave up after ${FREE_MAX_ROTATIONS} session rotations`,
        "warning",
      );
      return;
    }
    freeRotations++;
    try {
      const newSid = createId("ses", "descending");
      setEnv("OPENCODE_SESSION_ID", newSid);
      consecutiveServerErrors = 0;
      debugLog(`rotated sid -> ...${newSid.slice(-4)} (round ${freeRotations}/${FREE_MAX_ROTATIONS})`);
      ctx?.ui?.notify?.(
        `opencode: ${FREE_SESSION_RESET_AFTER}x 5xx - rotated opencode session id (…${newSid.slice(-4)}), continuing`,
        "info",
      );
    } catch (err) {
      debugLog(`rotate failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    clearRetryTimer();
    retryTimer = setTimeout(() => dispatchContinue(ctx, "continue", 1), FREE_CONTINUE_DELAY_MS);
  });

  // 用户真实输入 = 用户接管：重置自动续跑与轮换预算（定时器由随后的 agent_start 撤销）
  pi.on("input", async (event) => {
    if (event.source === "interactive") {
      consecutiveAutoContinues = 0;
      freeRotations = 0;
    }
  });

  pi.registerCommand("opencode-auto-continue", {
    description:
      "Toggle auto-continue after context compaction for opencode. Usage: /opencode-auto-continue [on|off]",
    handler: async (args, ctx) => {
      const arg = args?.trim().toLowerCase();
      if (arg === "on") autoContinueEnabled = true;
      else if (arg === "off") autoContinueEnabled = false;
      ctx.ui.notify(`opencode auto-continue after compaction: ${autoContinueEnabled ? "ON" : "OFF"}`, "info");
    },
  });

  // 手动轮换会话 ID：逃离 zen 上游粘性绑定。新 SID 末 4 字符随机 → 重新哈希分桶，
  // 每次执行都是独立抽签，不中断当前对话上下文。
  pi.registerCommand("opencode-session-reset", {
    description: "Rotate x-opencode-session and trigger next turn via user continue. Usage: /opencode-session-reset [custom-id]",
    handler: async (args, ctx) => {
      const custom = (args ?? "").trim() || undefined;
      const sessionId = custom || createId("ses", "descending");
      setEnv("OPENCODE_SESSION_ID", sessionId);
      setEnv("OPENCODE_REQUEST_ID", createId("msg", "ascending"));
      const shown = sessionId.length > 24 ? `${sessionId.slice(0, 21)}…` : sessionId;

      // streaming 直接 abort；待发定时器靠 clearRetryTimer 打断。
      // ExtensionCommand 在 prompt#_tryExecuteExtensionCommand 中立即执行，streaming 中也能进来。
      const wasIdle = typeof (ctx as any).isIdle === "function" ? (ctx as any).isIdle() : true;
      if (!wasIdle) {
        try { ctx.abort(); } catch {}
        try { await (ctx as any).waitForIdle?.(); } catch {}
        if (SESSION_RESET_DELAY_MS > 0) await new Promise((r) => setTimeout(r, Math.min(SESSION_RESET_DELAY_MS, 80)));
      }
      clearRetryTimer();
      consecutiveServerErrors = 0;
      pendingSessionReset = false;
      freeRotations = 0;

      if (!SESSION_RESET_AUTO_CONTINUE) {
        ctx.ui.notify(`opencode session id rotated → ${shown}${custom ? " (custom)" : " (random)"}; next request will be re-bucketed (auto-continue disabled)`, "info");
        return;
      }

      ctx.ui.notify(`opencode session id rotated → ${shown}${custom ? " (custom)" : " (random)"}; re-bucketed, sending user continue`, "info");

      const doTrigger = () => {
        try {
          const idleNow = typeof (ctx as any).isIdle === "function" ? (ctx as any).isIdle() : true;
          if (idleNow) pi.sendUserMessage(SESSION_RESET_PROMPT);
          else pi.sendUserMessage(SESSION_RESET_PROMPT, { deliverAs: "steer" });
        } catch (e: any) {
          try { ctx.ui.notify(`continue failed: ${e?.message ?? String(e)}`, "warning"); } catch {}
        }
      };
      if (typeof queueMicrotask === "function") queueMicrotask(doTrigger);
      else setTimeout(doTrigger, 0);
    },
  });

  // headers 用 $ENV 引用是旧版 loader 路径，新版由 before_provider_headers 兜底注入
  const PROVIDER_HEADERS: Record<string, string> = {
    "User-Agent": OPENCODE_UA,
    "x-opencode-project": "global",
    "x-opencode-session": "$OPENCODE_SESSION_ID",
    "x-opencode-request": "$OPENCODE_REQUEST_ID",
    "x-opencode-client": "cli",
    "x-session-affinity": "$OPENCODE_SESSION_ID",
    "X-Session-Id": "$OPENCODE_SESSION_ID",
  };

  for (const id of ["opencode", "opencode-go"] as const) {
    pi.registerProvider(id, {
      headers: { ...PROVIDER_HEADERS },
      // undefined 返回意为「保持 stored 不动」，类型层声明不含 undefined，此处断言
      async refreshModels(context) {
        return refreshOpencodeProvider(id, context) as Promise<any[]>;
      },
    });
  }
}

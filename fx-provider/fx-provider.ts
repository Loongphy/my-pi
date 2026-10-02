/**
 * FX Provider — 以 fx CLI 的真实调用方式直连 Vercel AI Gateway 免费促销池。
 *
 * 协议（对照 vercel-labs/fx 源码 + fx-gateway-proxy 社区逆向，2026-08-21 复核）：
 *   - 端点：POST https://ai-gateway.vercel.sh/v3/ai/language-model
 *     （Vercel 内部语言模型 RPC 规范 v4，非 OpenAI /v1/chat/completions）
 *   - 专属特征头（网关据此识别 fx 来源并开放免费促通道）：
 *       User-Agent: fx/0.0.4
 *       HTTP-Referer: https://github.com/vercel-labs/fx
 *       X-Title: fx
 *       ai-gateway-protocol-version: 0.0.1
 *       ai-language-model-specification-version: 4
 *       ai-language-model-id: <model>（如 zai/glm-5.2）
 *       ai-language-model-streaming: true
 *       （fx 0.0.4 不再发送 x-session-id / x-session-affinity；网关按 client_ip+key
 *        自行派生 hot-pod 亲和 session，客户端无需携带 —— 2026-08-21 对照实测抓包）
 *   线上字节序（对齐 Zig std.http sendHead 逐行核实）：标准头（authorization /
 *   user-agent / content-type）小写、扩展头（HTTP-Referer / X-Title / ai-*）保留大小写；
 *   流式请求无 Accept 头；keep_alive=false => connection: close（Node 以 agent:false 实现）
 *   - 请求体为 v3 prompt 结构（非 OpenAI messages）：
 *       {"prompt":[{role,system|user|assistant|tool,...}],
 *        "tools":[{type:"function",name,description,inputSchema}],
 *        "toolChoice":{"type":"auto"},
 *        "maxOutputTokens":N,
 *        "reasoning":"xhigh|high|auto|none",
 *        "providerOptions":{"gateway":{"speed":"fast"}}（-fast 模型）,
 *        "headers":{"user-agent":"fx/0.0.4"}}（根级指纹）
 *   - 流式响应：SSE `data: {json}`（事件: response-metadata / reasoning-delta /
 *     text-delta / tool-input-start|delta|end / tool-call / finish / error），
 *     兼容 AI SDK data-stream 的 `0:{json}` 前缀行。
 *
 * 认证（apiKey）：优先 Pi 已解析的凭证（auth.json 中 "fx".key，与 "vercel-ai-gateway"
 * 共用同一把 vck_ 密钥）→ 环境变量 VERCEL_AI_GATEWAY_KEY → 直读 auth.json。
 *
 * 模型（免费促销池，2026-08-21）：
 *   - zai/glm-5.2      深度思考 / 工具调用 / 多模态，1M 名义上下文，128K 输出
 *   - zai/glm-5.2-fast 极速 / 工具调用 / 多模态，1M 名义上下文，128K 输出
 *   contextWindow 声明 256K（网关请求体 1MiB 硬上限的换算值）：Pi 在估算上下文
 *   超过 256K-16K 时自动 summarize 压缩，保证请求体不触顶 413。
 *
 * 配置（环境变量）：
 *   FX_USER_AGENT           可选，默认 fx/0.0.4（一般不要改，指纹用于促销池识别）
 *   FX_GATEWAY_URL          可选，默认 https://ai-gateway.vercel.sh/v3/ai/language-model
 *   FX_DEBUG_BODY   "1"     打印请求体（排障）
 *   FX_DEBUG_STREAM "1"     打印原始流事件（排障）
 *
 * 重试（自包含，不复用 Pi 内置重试 / 其它插件 retry，对齐 fx CLI 0.0.4
 * src/core/agent/runtime/model_response_recovery.zig）：
 *   - 可重试状态码 429/500/502/503/504（isRetryableModelStatus）
 *   - 仅未流出任何内容时整单重发；退避 Retry-After 优先否则指数
 *     250ms→1s→2s→4s→8s→16s→30s 封顶；上限 10 次
 *   - -fast 模型失败后降级（去掉 providerOptions.speed=fast，对齐 disableFastRouteAfterFailure）
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  AssistantMessage,
  Message,
  Model,
  SimpleStreamOptions,
  TextContent,
  ThinkingContent,
  ToolCall,
  Tool,
  ToolResultMessage,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAssistantMessageEventStream,
  getCurrentTools,
  type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const FX_PROVIDER_ID = "fx";
const USER_AGENT = process.env.FX_USER_AGENT?.trim() || "fx/0.0.4";
// 运行时读取，允许测试/动态切换网关地址（env 变更即时生效，不受模块加载时点限制）
function gatewayUrl(): string {
  return process.env.FX_GATEWAY_URL?.trim() || "https://ai-gateway.vercel.sh/v3/ai/language-model";
}

// ---------------------------------------------------------------------------
// fx CLI 式重试（对齐 vercel-labs/fx src/core/agent/runtime/model_response_recovery.zig，
// 2026-08-21 源码逐行复核）：自包含实现，不依赖/不复用 Pi 内置重试或其它插件 retry。
//   - 可重试状态码：429 / 500 / 502 / 503 / 504（isRetryableModelStatus，其余不可重试）
//   - 仅“未流出任何内容”的失败才整单重发（status!==200 即未开始流，天然满足）
//   - 退避：Retry-After 头优先 → min(sec, 30)；否则指数序列 250ms→1s→2s→4s→8s→16s→30s
//   - 上限：FX_MAX_PROVIDER_ATTEMPTS=10 次（default_max_provider_attempts）
// ---------------------------------------------------------------------------
const FX_MAX_PROVIDER_ATTEMPTS = 10;
const FX_MAX_RETRY_AFTER_SECONDS = 30;

/** fx isRetryableModelStatus：429/500/502/503/504 可重试，其余不可。 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/** 指数退避延迟（ms）：精确移植 retryDelayNs —— 1→250ms，2→1s，之后×2，封顶 30s。 */
function fxRetryDelayMs(attempt: number): number {
  if (attempt <= 0) return 0;
  if (attempt === 1) return 250;
  let seconds = 1;
  let current = 2;
  while (current < attempt && seconds < FX_MAX_RETRY_AFTER_SECONDS) {
    seconds = Math.min(seconds * 2, FX_MAX_RETRY_AFTER_SECONDS);
    current += 1;
  }
  return seconds * 1000;
}

/** 解析 Retry-After 头（秒数形式）；非数字/HTTP-date 一律忽略（网关用秒数）。 */
function parseRetryAfter(header: string | string[] | undefined): number | null {
  if (header == null) return null;
  const v = (Array.isArray(header) ? header[0] : header).trim();
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 模型目录（fx-gateway-proxy README 实测配置；免费促销池）
// ---------------------------------------------------------------------------

// 注意：模型名义支持 1M 上下文，但网关请求体硬上限实测 ~1MiB（1048576 字节，
// 2026-08-21 二分实测：1048596B→200，1048696B→413 AI_APICallError；gzip 请求体
// 网关不解压，压缩无效）。contextWindow 声明 256K，让 Pi 阈值压缩（shouldCompact:
// > 256K - 16384）尽量提前介入。
//
// ⚠ 但 Pi 的阈值压缩只基于 estimateContextTokens，而它只数“消息文本”字符 / 4，
//   不计入 context.tools 的 JSON-Schema inputSchema 与逐消息 JSON 开销。工具集大
//   + 长会话时，实际请求体远超 token 估算对应字节数，阈值压缩未必能在触顶前触发
//   （实测：估算 ~192K token 时 body 已达 980KB）。因此真正的兑底是“硬溢出路径”：
//   发送前 body 预算 / 网关 413 抛出的错误文本按 Pi 的 isContextOverflow 模式构造
//   （exceeds the context window / token limit exceeded / request_too_large），
//   让 _checkCompaction 的 overflow 路径（Case 1: compact-and-retry）识别并自动压缩
//   重试，而不是直接终态失败。前提是 makeAssistant 的 model 字段填真实 model.id
//   （见该函数注释），否则 sameModel 判定失败会连这条兑底也短路掉。
const FX_CONTEXT_WINDOW = 256_000;
const FX_MAX_TOKENS = 128_000;

/** 网关请求体硬上限（实测 ~1048576B）；预算检查留 ~48KB 余量。 */
const FX_MAX_REQUEST_BODY_BYTES = 1_000_000;

/** Pi 思考等级 → v3 reasoning 字段（网关仅认 none/auto/high/xhigh）。 */
const THINKING_MAP: Record<string, string | null> = {
  off: null, // 不带 reasoning 字段 = 关闭深度思考
  minimal: null,
  low: null,
  medium: null,
  high: "high",
  xhigh: "xhigh",
  max: "xhigh",
};

const FX_MODELS = [
  {
    id: "zai/glm-5.2",
    name: "GLM 5.2 (FX Free)",
    reasoning: true,
    thinkingLevelMap: THINKING_MAP,
    // 与网关目录声明一致（Pi models-store 2026-08-19：zai/glm-5.2 input 仅 text；
    // fx 协议虽支持 file part 图片，本插件未实测，故不声明 image）
    input: ["text"] as ("text" | "image")[],
    cost: { input: 1.1, output: 3.851, cacheRead: 0.275, cacheWrite: 0 },
    contextWindow: FX_CONTEXT_WINDOW,
    maxTokens: FX_MAX_TOKENS,
  },
  {
    id: "zai/glm-5.2-fast",
    name: "GLM 5.2 Fast (FX Free)",
    reasoning: true,
    thinkingLevelMap: THINKING_MAP,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 2.1, output: 6.6, cacheRead: 0.21, cacheWrite: 0 },
    contextWindow: FX_CONTEXT_WINDOW,
    maxTokens: FX_MAX_TOKENS,
  },
];

// ---------------------------------------------------------------------------
// 认证：Pi 解析的 apiKey → 环境变量 → auth.json（vercel-ai-gateway / fx 同源密钥）
// ---------------------------------------------------------------------------

function authJsonCandidates(): string[] {
  const roots = new Set<string>();
  const piConfigDir = process.env.PI_CONFIG_DIR?.trim();
  if (piConfigDir) roots.add(piConfigDir);
  roots.add(homedir());
  roots.add("/root");
  return [...roots].map((r) => join(r, ".pi", "agent", "auth.json")).filter(existsSync);
}

function readKeyFromAuthJson(): string {
  for (const file of authJsonCandidates()) {
    try {
      const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
      // fx 自身凭证优先；其次复用 Pi 现有 vercel-ai-gateway 的密钥（同源 vck_）
      const key = data?.[FX_PROVIDER_ID]?.key ?? data?.["vercel-ai-gateway"]?.key;
      if (typeof key === "string" && key.trim()) return key.trim();
    } catch {
      /* 单个文件损坏则跳过 */
    }
  }
  return "";
}

async function resolveApiKey(apiKey?: string): Promise<string> {
  const candidates = [apiKey ?? "", process.env.VERCEL_AI_GATEWAY_KEY ?? "", readKeyFromAuthJson()];
  for (const c of candidates) {
    if (c && c.trim() && !["dummy", "none", "null", "placeholder", "ollama"].includes(c.trim().toLowerCase())) {
      return c.trim();
    }
  }
  throw new Error(
    "No Vercel AI Gateway API key. Put the vck_ key under \"fx\" (or \"vercel-ai-gateway\") in /root/.pi/agent/auth.json, or set VERCEL_AI_GATEWAY_KEY.",
  );
}

// ---------------------------------------------------------------------------
// v3 载荷构建（与 vercel-labs/fx gateway_json.zig 完全一致的形状）
// ---------------------------------------------------------------------------

type V3Part =
  | { type: "text"; text: string }
  | { type: "file"; data: string; mediaType: string }
  | { type: "image"; image: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: Record<string, any> };

type V3PromptEntry =
  | { role: "system"; content: string }
  | { role: "user"; content: V3Part[] }
  | { role: "assistant"; content: V3Part[] }
  | { role: "tool"; content: { type: "tool-result"; toolCallId: string; toolName: string; output: { type: "text"; value: string } }[] };

function plainText(m: Message): string {
  if (typeof m.content === "string") return m.content;
  const parts: string[] = [];
  for (const p of m.content) {
    const c = p as { type?: string; text?: string; thinking?: string };
    if (c.type === "text") parts.push(c.text ?? "");
    else if (c.type === "thinking") parts.push(c.thinking ?? "");
  }
  return parts.join("\n").trim();
}

/** Pi 消息 → v3 prompt（tool 消息必须是 assistant tool-call 的紧邻后继，保持原始顺序即可）。
 *  TranscriptContext 的 system 消息原位渲染：content 可为 TextContent[]，
 *  sections 的非 null 值追加在 content 之后。 */
function buildPrompt(messages: Message[]): V3PromptEntry[] {
  const prompt: V3PromptEntry[] = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      const parts: string[] = [];
      const content = msg.content;
      if (typeof content === "string") {
        if (content) parts.push(content);
      } else if (Array.isArray(content)) {
        const text = content.map((c) => (c?.type === "text" ? (c.text ?? "") : "")).join("");
        if (text) parts.push(text);
      }
      for (const value of Object.values(msg.sections ?? {})) {
        if (value !== null && value.length > 0) parts.push(value);
      }
      const text = parts.join("\n\n");
      if (text.trim()) prompt.push({ role: "system", content: text });
    } else if (msg.role === "assistant") {
      const parts: V3Part[] = [];
      for (const p of msg.content) {
        if (p.type === "text") {
          if (p.text) parts.push({ type: "text", text: p.text });
        } else if (p.type === "toolCall") {
          const args = p.arguments && typeof p.arguments === "object" ? p.arguments : {};
          parts.push({ type: "tool-call", toolCallId: p.id, toolName: p.name, input: args });
        }
        // thinking 不回传（v3 prompt 无 reasoning 槽位；fx 同样不回流）
      }
      if (parts.length === 0) continue; // 空 assistant 消息（纯 thinking）跳过，避免网关 400
      prompt.push({ role: "assistant", content: parts });
    } else if (msg.role === "user") {
      const parts: V3Part[] = [];
      if (typeof msg.content === "string") {
        if (msg.content.trim()) parts.push({ type: "text", text: msg.content });
      } else {
        for (const p of msg.content) {
          if (p.type === "text") {
            if (p.text) parts.push({ type: "text", text: p.text });
          } else if (p.type === "image") {
            // Pi ImageContent: { data: base64, mimeType } → v3 file part（与 fx 一致）
            parts.push({ type: "file", data: p.data, mediaType: p.mimeType || "image/png" });
          }
        }
      }
      if (parts.length === 0) continue;
      prompt.push({ role: "user", content: parts });
    } else if (msg.role === "toolResult") {
      const text = plainText(msg as ToolResultMessage);
      prompt.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: msg.toolCallId || "",
            toolName: msg.toolName || "unknown",
            output: { type: "text", value: text || (msg.isError ? "工具执行失败" : "") },
          },
        ],
      });
    }
  }
  return prompt;
}

/** Pi 工具 → v3 function 工具（inputSchema = JSON Schema）。 */
function buildTools(tools?: Tool[]): Record<string, any>[] {
  if (!tools || tools.length === 0) return [];
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.parameters ?? { type: "object", properties: {} },
  }));
}

/** Pi ThinkingLevel → v3 reasoning（未配置/关闭时返回 undefined，省略字段）。 */
function mapReasoning(level: string | undefined): string | undefined {
  if (!level) return undefined;
  const mapped = THINKING_MAP[level];
  if (!mapped) return undefined;
  return mapped;
}

interface GatewayEvent {
  type: string;
  [key: string]: any;
}

/** 解析网关流的一行：`data: {json}` / `{json}` / `N:{json}`（AI SDK data-stream 前缀）。 */
function parseSseLine(raw: string): GatewayEvent | null | undefined {
  let line = raw.replace(/\r$/, "");
  if (!line || line.startsWith(":")) return undefined; // 空行/注释
  if (line === "DONE") return null;
  if (line.startsWith("data:")) {
    const rest = line.slice(5).trimStart();
    if (rest === "[DONE]") return null;
    line = rest;
  }
  // data-stream 的 "0:{...}" 前缀：取第一个 { 之后的内容
  const brace = line.indexOf("{");
  if (brace >= 0) line = line.slice(brace);
  if (!line.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" && typeof parsed.type === "string" ? parsed : undefined;
  } catch {
    if (process.env.FX_DEBUG_STREAM === "1") console.warn(`[fx] bad sse line: ${raw.slice(0, 200)}`);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Pi 事件流工具
// ---------------------------------------------------------------------------

function makeAssistant(
  content: (TextContent | ThinkingContent | ToolCall)[],
  stopReason: AssistantMessage["stopReason"] = "stop",
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number; costTotal?: number },
  errorMessage?: string,
  responseModel?: string,
  // modelId 必须传已注册的 store model.id（如 "zai/glm-5.2"），否则 Pi 的
  // _checkCompaction sameModel 判定（assistantMessage.model === this.model.id）
  // 永远 false → 溢出压缩路径（compact-and-retry）不会触发，超大 body 错误
  // 无法被自动压缩兜住，直接终态失败。
  modelId?: string,
): AssistantMessage {
  const input = usage?.input ?? 0;
  const output = usage?.output ?? 0;
  const cacheRead = usage?.cacheRead ?? 0;
  const cacheWrite = usage?.cacheWrite ?? 0;
  // 兜底：网关字段变更导致上游误把对象赋给 errorMessage 时，这里保证最终是字符串，
  // 避免 TUI 显示 `Error: [object Object]`。
  const safeErrorMessage = toErrorMessage(errorMessage);
  return {
    role: "assistant",
    content: content.map((b) => ({ ...b })),
    api: "fx-gateway",
    provider: FX_PROVIDER_ID,
    // 用真实注册 model.id（非字面值 "fx"），让 Pi 的 sameModel 判定命中，
    // 使 isContextOverflow → _runAutoCompaction("overflow", willRetry) 能触发压缩重试。
    model: modelId ?? FX_PROVIDER_ID,
    responseModel,
    usage: {
      input,
      output,
      cacheRead,
      cacheWrite,
      ...(typeof usage?.reasoning === "number" ? { reasoning: usage.reasoning } : {}),
      // 与 anthropic/openai provider 一致：totalTokens 含 cacheRead/cacheWrite
      totalTokens: input + output + cacheRead + cacheWrite,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: usage?.costTotal ?? 0,
      },
    },
    stopReason,
    errorMessage: safeErrorMessage,
    timestamp: Date.now(),
  };
}

/** 从 usage 与网关账单估算总成本（账单缺失时按模型价目表估算，免费促销池通常为 $0）。 */
function estimateCost(model: Model<string>, input: number, output: number, cacheRead: number): number {
  const c = model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return (
    (input / 1_000_000) * (c.input ?? 0) +
    (output / 1_000_000) * (c.output ?? 0) +
    (cacheRead / 1_000_000) * (c.cacheRead ?? 0)
  );
}

// ---------------------------------------------------------------------------
// streamSimple：模拟 fx 的流式调用
// ---------------------------------------------------------------------------

function streamFxChat(
  model: Model<string>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const signal = options?.signal;

  // 作用域提升：让 catch/finally 也能读到流状态
  let aborted = false;
  let usage: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number } | undefined;
  let responseModel: string | undefined;

  (async () => {
    let req: ClientRequest | undefined; // 传输层请求句柄（onAbort 中断用）
    const onAbort = () => {
      aborted = true;
      req?.destroy(); // 中断连接：res 'close'(未读完) → queue.fail → 读取循环抛错 → 按 aborted 归口
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const apiKey = await resolveApiKey(options?.apiKey);
      // TranscriptContext: system 消息（含 prompt 与 toolsAdded/toolsRemoved）
      // 已在 context.messages 里，原位交给 buildPrompt / getCurrentTools。
      const prompt = buildPrompt(context.messages);
      if (prompt.length === 0) throw new Error("empty prompt");
      const tools = buildTools(getCurrentTools(context.messages));
      const reasoning = mapReasoning(options?.reasoning);

      // 字段逐字节对齐 fx gateway_json.zig buildGatewayRequestBodyWithSettings：
      //   prompt → tools → toolChoice → maxOutputTokens → reasoning →
      //   providerOptions → headers（withRequestUserAgent 末位注入）；fx 从不发 temperature
      // withFast=false 时省略 providerOptions（对齐 fx disableFastRouteAfterFailure：
      // provider_unavailable 且可安全重放时降级 canonical 路由，不再请求 fast 池）
      const buildBodyStr = (withFast: boolean): string => {
        const bodyParts = [
          `"prompt":${JSON.stringify(prompt)}`,
          `"tools":${JSON.stringify(tools)}`,
          `"toolChoice":${JSON.stringify({ type: "auto" })}`,
          `"maxOutputTokens":${options?.maxTokens ?? model.maxTokens ?? FX_MAX_TOKENS}`,
        ];
        if (reasoning) bodyParts.push(`"reasoning":${JSON.stringify(reasoning)}`);
        if (withFast) {
          bodyParts.push(`"providerOptions":${JSON.stringify({ gateway: { speed: "fast" } })}`);
        }
        bodyParts.push(`"headers":${JSON.stringify({ "user-agent": USER_AGENT })}`);
        return `{${bodyParts.join(",")}}`;
      };

      const headers: Record<string, string> = {
        // Zig sendHead 顺序近似：authorization → user-agent → content-type → 扩展头；
        // Node 会把 Host / Connection: close(agent:false) / Content-Length 附在末尾；
        // 与 fx 0.0.4 一致：不发送 x-session-id / x-session-affinity（网关自行派生亲和）
        authorization: `Bearer ${apiKey}`,
        "user-agent": USER_AGENT,
        "content-type": "application/json",
        "HTTP-Referer": "https://github.com/vercel-labs/fx",
        "X-Title": "fx",
        "ai-gateway-protocol-version": "0.0.1",
        "ai-language-model-specification-version": "4",
        "ai-language-model-id": model.id,
        "ai-language-model-streaming": "true",
      };

      // ---- 传输：node:https（http 兼容本地 mock）；agent:false = 单请求连接 ----
      // ---- fx CLI 式重试（自包含，不复用 Pi 内置/其它插件 retry）----
      const requester = gatewayUrl().startsWith("https:") ? httpsRequest : httpRequest;
      let fastDisabled = false; // 对齐 fx disableFastRouteAfterFailure：失败后去掉 speed:fast
      let attempt = 0;
      let res: IncomingMessage | undefined;
      for (;;) {
        attempt += 1;
        if (aborted) throw new Error("aborted");

        // -fast 模型在 provider_unavailable 降级后，重试不再请求 fast 池
        const bodyForAttempt = buildBodyStr(model.id.endsWith("-fast") && !fastDisabled);
        // 发送前 body 预算（兜底）：Pi 自动压缩基于 token 估算（仅数消息文本，不含工具
        // schema / JSON 开销），在工具集大 + 长会话时明显低估实际 body，无法在阈值处触发；
        // 因此这里作为“硬溢出”兆头：错误文本按 Pi 的 isContextOverflow 模式构造
        // （exceeds the context window / token limit exceeded），让 _checkCompaction 的
        // overflow 路径（Case 1: compact-and-retry）能识别并自动压缩，而不是直接终态失败。
        const bodyBytes = Buffer.byteLength(bodyForAttempt, "utf8");
        if (bodyBytes > FX_MAX_REQUEST_BODY_BYTES) {
          throw new Error(
            `FX gateway request too large: ${(bodyBytes / 1024).toFixed(0)}KB body exceeds the context window / gateway ~1MiB request body limit (token limit exceeded: input too large; 上下文过大，请压缩/清理历史消息或换用更大窗口的模型)`,
          );
        }
        if (process.env.FX_DEBUG_BODY === "1") {
          console.warn(`[fx] BODY ${bodyForAttempt.slice(0, 3000)}`);
        }
        const attemptRes = await new Promise<IncomingMessage>((resolve, reject) => {
          req = requester(gatewayUrl(), { method: "POST", headers, agent: false }, resolve);
          req.on("error", reject);
          req.end(bodyForAttempt);
        });
        res = attemptRes;
        req!.on("error", () => { /* 响应阶段错误统一走 res */ });

        if (res.statusCode === 200) break; // 进入流式响应；之后不再整单重发（definitely_unsent 语义）

        // 读错误体 + 规范化（保持既有诊断文本）
        const text = await new Promise<string>((resolve) => {
          let acc = "";
          res.on("data", (c: Buffer) => (acc += c.toString("utf8")));
          res.on("end", () => resolve(acc));
          res.on("error", () => resolve(acc));
        });
        let detail = text.slice(0, 300);
        try {
          const o = JSON.parse(text) as { error?: { message?: string } };
          if (o?.error?.message) detail = o.error.message;
        } catch { /* 非 JSON 错误体 */ }
        // 413 / request_too_large 属于“请求体超限”溢出，与发送前 body 预算同源；
        // 这里让错误文本也命中 Pi 的 isContextOverflow 模式（request_too_large /
        // token limit exceeded / exceeds the context window），使溢出压缩路径能触发，
        // 而不是被当成不可重试的 400 直接终态失败。
        if (res.statusCode === 413 || /request_too_large|too large|body.*exceed/i.test(detail)) {
          detail = `request_too_large: ${detail || "gateway request body exceeds limit"} (token limit exceeded: input too large)`;
        }
        const norm = normalizeRetryMessage(detail, { statusCode: res.statusCode });

        if (!isRetryableStatus(res.statusCode) || attempt >= FX_MAX_PROVIDER_ATTEMPTS) {
          const exhausted = isRetryableStatus(res.statusCode) ? ` · recovery exhausted after ${attempt}/${FX_MAX_PROVIDER_ATTEMPTS} attempts` : "";
          throw new Error(`FX gateway HTTP ${res.statusCode}${exhausted}: ${norm}`);
        }

        // 对齐 fx disableFastRouteAfterFailure：provider_unavailable（非 429）可安全重放 → 降级
        if (model.id.endsWith("-fast") && res.statusCode !== 429 && !fastDisabled) fastDisabled = true;

        // 退避：Retry-After 头优先，否则指数序列（对齐 decide/retryDelayNs）
        const retryAfterSec = parseRetryAfter(res.headers["retry-after"]);
        const delayMs =
          retryAfterSec != null
            ? Math.min(retryAfterSec, FX_MAX_RETRY_AFTER_SECONDS) * 1000
            : fxRetryDelayMs(attempt);
        if (process.env.FX_DEBUG_BODY === "1") {
          console.warn(`[fx] HTTP ${res.statusCode} → retry ${attempt + 1}/${FX_MAX_PROVIDER_ATTEMPTS} in ${delayMs}ms${fastDisabled ? " (fast 降级)" : ""}`);
        }
        await sleep(delayMs);
        if (aborted) throw new Error("aborted");
      }

      const queue = new ChunkQueue();
      res!.on("data", (c: Buffer) => queue.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res!.on("end", () => queue.finish());
      res!.on("error", (e) => queue.fail(e));
      res!.on("close", () => {
        if (!res!.readableEnded && !aborted)
          queue.fail(new Error(normalizeRetryMessage("connection closed prematurely")));
      });
      const decoder = new TextDecoder();

      // ---- 事件状态机 ----
      let started = false;
      const parts: { kind: "thinking" | "text" | "tool"; index: number }[] = [];
      let nextIndex = 0;
      let thinkingIdx = -1;
      let thinkingText = "";
      let textIdx = -1;
      let textText = "";
      const toolCalls = new Map<
        string,
        { name: string; argsAcc: string; idx: number; finalized: boolean; input: Record<string, any> }
      >();
      let costTotal: number | undefined;
      let finishReason: AssistantMessage["stopReason"] = "stop";
      let streamError: string | undefined;

      const buildContent = (): (TextContent | ThinkingContent | ToolCall)[] => {
        const out: (TextContent | ThinkingContent | ToolCall)[] = [];
        const toolList = [...toolCalls.entries()]; // [id, state]
        for (const p of [...parts].sort((a, b) => a.index - b.index)) {
          if (p.kind === "thinking" && thinkingIdx >= 0) {
            out.push({ type: "thinking", thinking: thinkingText });
          } else if (p.kind === "text" && textIdx >= 0) {
            out.push({ type: "text", text: textText });
          } else if (p.kind === "tool") {
            const hit = toolList.find(([, t]) => t.idx === p.index);
            if (hit) {
              const [id, t] = hit;
              const args = t.finalized ? t.input : safeParseArgs(t.argsAcc);
              out.push({ type: "toolCall", id, name: t.name, arguments: args });
            }
          }
        }
        return out;
      };

      const buildPartial = (stop: AssistantMessage["stopReason"] = finishReason): AssistantMessage =>
        makeAssistant(buildContent(), stop, usage, undefined, responseModel, model.id);

      const emit = (event: Parameters<AssistantMessageEventStream["push"]>[0]) => stream.push(event);

      const ensureStart = () => {
        if (!started) {
          started = true;
          emit({ type: "start", partial: buildPartial() });
        }
      };

      const handleReasoningDelta = (delta: string) => {
        if (!delta) return;
        ensureStart();
        if (thinkingIdx < 0) {
          thinkingIdx = nextIndex++;
          parts.push({ kind: "thinking", index: thinkingIdx });
          emit({ type: "thinking_start", contentIndex: thinkingIdx, partial: buildPartial() });
        }
        thinkingText += delta;
        emit({ type: "thinking_delta", contentIndex: thinkingIdx, delta, partial: buildPartial() });
      };

      const handleTextDelta = (delta: string) => {
        if (!delta) return;
        ensureStart();
        if (textIdx < 0) {
          textIdx = nextIndex++;
          parts.push({ kind: "text", index: textIdx });
          emit({ type: "text_start", contentIndex: textIdx, partial: buildPartial() });
        }
        textText += delta;
        emit({ type: "text_delta", contentIndex: textIdx, delta, partial: buildPartial() });
      };

      const handleToolStart = (id: string, name: string) => {
        if (toolCalls.has(id)) return;
        ensureStart();
        const idx = nextIndex++;
        toolCalls.set(id, { name: name || "unknown", argsAcc: "", idx, finalized: false, input: {} });
        parts.push({ kind: "tool", index: idx });
        emit({ type: "toolcall_start", contentIndex: idx, partial: buildPartial() });
      };

      const handleToolDelta = (id: string, delta: string) => {
        const t = toolCalls.get(id);
        if (!t || t.finalized) return;
        ensureStart();
        t.argsAcc += delta;
        emit({ type: "toolcall_delta", contentIndex: t.idx, delta, partial: buildPartial() });
      };

      const handleToolCall = (id: string, name: string, input: any) => {
        if (!toolCalls.has(id)) {
          handleToolStart(id, name);
        }
        const t = toolCalls.get(id)!;
        t.input = input && typeof input === "object" ? input : safeParseArgs(t.argsAcc);
        t.finalized = true;
        emit({
          type: "toolcall_end",
          contentIndex: t.idx,
          toolCall: { type: "toolCall", id, name: t.name, arguments: t.input },
          partial: buildPartial(),
        });
      };

      const finalizeToolcalls = () => {
        for (const [id, t] of toolCalls) {
          if (!t.finalized) {
            t.input = safeParseArgs(t.argsAcc);
            t.finalized = true;
            emit({
              type: "toolcall_end",
              contentIndex: t.idx,
              toolCall: { type: "toolCall", id, name: t.name, arguments: t.input },
              partial: buildPartial(),
            });
          }
        }
      };

      const endThinkingAndText = () => {
        if (thinkingIdx >= 0 && !thinkingEnded) {
          thinkingEnded = true;
          emit({ type: "thinking_end", contentIndex: thinkingIdx, content: thinkingText, partial: buildPartial() });
        }
        if (textIdx >= 0 && !textEnded) {
          textEnded = true;
          emit({ type: "text_end", contentIndex: textIdx, content: textText, partial: buildPartial() });
        }
      };
      let thinkingEnded = false;
      let textEnded = false;

      // ---- 读取流（事件状态机不变，feed 来源换成队列）----
      let packet = "";
      let sawFinish = false;
      for (;;) {
        const { done: rdDone, value } = await queue.next();
        if (rdDone) break;
        packet += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = packet.indexOf("\n")) >= 0) {
          const line = packet.slice(0, nl);
          packet = packet.slice(nl + 1);
          const ev = parseSseLine(line);
          if (ev === null) {
            sawFinish = true; // data: [DONE]
            break;
          }
          if (!ev) continue;
          if (process.env.FX_DEBUG_STREAM === "1") {
            console.warn(`[fx] EVENT ${JSON.stringify(ev).slice(0, 400)}`);
          }
          switch (ev.type) {
            case "response-metadata": {
              if (typeof ev.modelId === "string") responseModel = ev.modelId;
              break;
            }
            case "reasoning-delta":
              handleReasoningDelta(String(ev.delta ?? ""));
              break;
            case "reasoning-start":
            case "reasoning-end":
              break; // 无内容事件，状态由 delta 驱动
            case "text-delta":
              handleTextDelta(String(ev.delta ?? ""));
              break;
            case "text-start":
            case "text-end":
              break;
            case "tool-input-start":
              handleToolStart(String(ev.id ?? ev.toolCallId ?? ""), String(ev.toolName ?? ev.name ?? ""));
              break;
            case "tool-input-delta":
              handleToolDelta(String(ev.id ?? ""), String(ev.delta ?? ""));
              break;
            case "tool-input-end":
              break;
            case "tool-call":
              handleToolCall(
                String(ev.toolCallId ?? ev.id ?? ""),
                String(ev.toolName ?? "unknown"),
                ev.input,
              );
              break;
            case "finish": {
              sawFinish = true;
              const fr: any = ev.finishReason;
              const unified = typeof fr === "object" ? fr?.unified ?? fr?.raw : typeof fr === "string" ? fr : "stop";
              if (unified === "tool-calls") {
                finishReason = "toolUse";
              } else if (unified === "length") {
                finishReason = "length";
              } else if (unified === "error" || ev.error) {
                finishReason = "error";
                const fe: any = ev.error;
                const feText =
                  (fe && typeof fe === "object" && typeof fe.message === "string" && fe.message) ||
                  (typeof fe === "string" && fe) ||
                  "";
                streamError = normalizeRetryMessage(feText || streamError || `provider error: ${unified}`);
              } else {
                // stop / content-filter / other → 正常结束
                finishReason = "stop";
                if (unified === "content-filter") streamError = "content filtered by gateway";
              }
              const u: any = ev.usage ?? {};
              const it: any = u.inputTokens ?? {};
              const ot: any = u.outputTokens ?? {};
              // 网关 inputTokens.total 是【含 cacheRead 的总输入】，cacheRead/cacheWrite 是其子集。
              // Pi 的 usage.input 语义是【未缓存的输入】(与 cacheRead/cacheWrite 互斥)，
              // 参考 packages/ai/src/api/openai-responses-shared.ts:
              //   input: Math.max(0, input_tokens - cachedTokens - cacheWriteTokens)
              // 网关同样提供了互斥的 noCache 字段；缺失时从 total 反推，避免双重计数
              // (否则 cache-stats 会每轮误判 ~满额 prompt 的 cache miss)。
              const cacheRead = Number(it.cacheRead ?? 0);
              const cacheWrite = Number(it.cacheWrite ?? 0);
              let inputUncached: number;
              if (typeof it.noCache === "number") {
                inputUncached = Number(it.noCache ?? 0);
              } else {
                const total = Number(it.total ?? 0);
                inputUncached = Math.max(0, total - cacheRead - cacheWrite);
              }
              usage = {
                input: inputUncached,
                output: Number(ot.total ?? 0),
                cacheRead,
                cacheWrite,
                ...(typeof ot.reasoning === "number" ? { reasoning: ot.reasoning } : {}),
              };
              const g: any = ev.providerMetadata?.gateway;
              if (g && typeof g.cost === "string") {
                const n = Number(g.cost);
                if (Number.isFinite(n)) costTotal = n;
              }
              break;
            }
            case "error": {
              // 网关 error 事件可能是 { message, code } 或 { error: { message } }，
              // 也可能直接 { error: "..." }；统一取字符串，避免对象透传成 [object Object]。
              const errObj: any = ev.error;
              const errText =
                (typeof ev.message === "string" && ev.message) ||
                (typeof errObj === "string" && errObj) ||
                (errObj && typeof errObj === "object" && typeof errObj.message === "string" && errObj.message) ||
                "";
              // 规范化：transient 错误映射到可重试关键词（fx 走 node:https，
              // 不经 429-retry 的 fetch 层，只能靠会话级重试的 errorMessage 匹配）
              streamError = normalizeRetryMessage(errText || streamError || "gateway error", { ev });
              break;
            }
            default:
              break; // start/start-step/finish-step/source/file/raw/未知事件忽略
          }
          if (sawFinish) break;
        }
        if (sawFinish) break;
      }
      if (aborted) {
        const partial = makeAssistant(buildContent(), "aborted", usage, "aborted by user", responseModel, model.id);
        stream.push({ type: "error", reason: "aborted", error: partial });
        stream.end(partial);
        return;
      }

      // 流自然结束但没有 finish 事件：兜底
      ensureStart();
      endThinkingAndText();
      finalizeToolcalls();

      const hasContent = thinkingText || textText || toolCalls.size > 0;
      if (streamError && finishReason !== "toolUse") {
        if (finishReason !== "error") {
          finishReason = "error";
        }
      } else if (!sawFinish && !hasContent) {
        throw new Error("stream ended without a terminal response event: empty response");
      }

      const finalUsage = usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: undefined };
      const costEstimate =
        costTotal ?? estimateCost(model, finalUsage.input, finalUsage.output, finalUsage.cacheRead);
      const final = makeAssistant(
        buildContent(),
        finishReason,
        { ...finalUsage, costTotal: costEstimate },
        streamError,
        responseModel,
        model.id,
      );
      if (finishReason === "error" || streamError) {
        stream.push({ type: "error", reason: "error", error: final });
      } else {
        stream.push({ type: "done", reason: finishReason as "stop" | "length" | "toolUse", message: final });
      }
      stream.end(final);
    } catch (err) {
      const isAbort = aborted || (err instanceof Error && err.name === "AbortError");
      const msg = isAbort ? "aborted by user" : toErrorMessage(err) ?? "unknown error";
      const partial = makeAssistant([], isAbort ? "aborted" : "error", usage, msg, responseModel, model.id);
      stream.push({ type: "error", reason: isAbort ? "aborted" : "error", error: partial });
      stream.end(partial);
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  })();

  return stream;
}

/** 把 res 的 data 事件适配成可 await 的块队列（保留读取循环的状态机代码不变）。 */
class ChunkQueue {
  private chunks: Buffer[] = [];
  private done = false;
  private err?: Error;
  private waiters: {
    resolve: (v: { done: boolean; value?: Buffer }) => void;
    reject: (e: Error) => void;
  }[] = [];

  push(c: Buffer): void {
    this.chunks.push(c);
    this.pump();
  }
  finish(): void {
    this.done = true;
    this.pump();
  }
  fail(e: Error): void {
    this.err = e;
    this.done = true;
    this.pump();
  }
  next(): Promise<{ done: boolean; value?: Buffer }> {
    if (this.err) return Promise.reject(this.err);
    if (this.chunks.length) return Promise.resolve({ done: false, value: this.chunks.shift() });
    if (this.done) return Promise.resolve({ done: true });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
  private pump(): void {
    while (this.waiters.length > 0) {
      const { resolve, reject } = this.waiters[0];
      if (this.err) {
        this.waiters.shift();
        reject(this.err);
        continue;
      }
      if (this.chunks.length) {
        this.waiters.shift();
        resolve({ done: false, value: this.chunks.shift() });
        continue;
      }
      if (this.done) {
        this.waiters.shift();
        resolve({ done: true });
        continue;
      }
      break;
    }
  }
}

function safeParseArgs(s: string): Record<string, any> {
  if (!s.trim()) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : {};
  } catch {
    return { _raw: s.slice(0, 500) };
  }
}

/** 把任意值规范成单行错误字符串，避免对象被模板插值成 `[object Object]`。 */
function toErrorMessage(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.message || v.toString();
  if (typeof v === "object") {
    const o = v as Record<string, any>;
    const msg = typeof o.message === "string" ? o.message : "";
    const code = o.code != null ? String(o.code) : "";
    const text = [code, msg || JSON.stringify(v)].filter(Boolean).join(": ");
    return text || JSON.stringify(v);
  }
  return String(v);
}

/**
 * 把网关 transient 错误规范化成能稳定命中 Pi 会话级重试模式
 * (`isRetryableAssistantError` 的 RETRYABLE_PROVIDER_ERROR_PATTERN) 的文本，
 * 同时保留原始信息作为补充；配额/鉴权类返回明确不可重试的文本。
 *
 * Pi 的可重试模式关键词（节选）：429 / 5xx / rate.?limit / too many
 * requests / overloaded / service.?unavailable / connection.?error /
 * connection.?refused / connection.?lost / timeout / fetch failed /
 * stream ended / ended without ...；不可重试模式：quota exceeded /
 * insufficient_quota / billing / FreeUsageLimitError / auth 1001。
 *
 * fx-provider 走 node:https 而非 fetch，所以 429-retry 插件的 fetch 层
 * 重试碰不到它，只能依赖会话级重试——而会话级重试靠 errorMessage 文本
 * 匹配。因此这里必须把 transient 错误映射到带标准关键词的文本，避免
 * “upstream gateway error”/“Bad gateway”/“Connection reset”这类裸文本
 * 漏判为不可重试而直接终态中断。
 */
function normalizeRetryMessage(raw: string | undefined, hint?: { statusCode?: number; ev?: any }): string {
  const rawTrim = (raw ?? "").trim();
  const code = hint?.ev?.code;
  const status = hint?.statusCode;

  // 1) 明确不可重试：鉴权失效 / 配额 / 计费 —— 保留原文，命中不可重试模式
  if (code === 1001 || /invalid.*api.?key|api.?key.*(invalid|expired|missing)|unauthor/i.test(rawTrim)) {
    return `FX auth failed (1001): ${rawTrim || "API key invalid or expired"}`;
  }
  if (
    /quota.?exceeded|insufficient_quota|free.?usage.?limit|GoUsageLimitError|FreeUsageLimitError|usage.?limit|out.?of.?budget|billing/i.test(
      rawTrim,
    )
  ) {
    return rawTrim || "quota exceeded";
  }

  // 2) HTTP 状态码驱动的分类（流外错误 / 网关 error 事件带 status）
  if (status === 429 || /429|too many requests|rate.?limit/i.test(rawTrim)) {
    return `429 Too Many Requests${rawTrim ? ": " + rawTrim : ""}`;
  }
  if (status === 500 || /\b500\b|internal.?server.?error|internal.?error/i.test(rawTrim)) {
    return `500 Internal Server Error${rawTrim ? ": " + rawTrim : ""}`;
  }
  if (status === 502 || /\b502\b|bad.?gateway/i.test(rawTrim)) {
    return `502 Bad Gateway${rawTrim ? ": " + rawTrim : ""}`;
  }
  if (status === 503 || /\b503\b|service.?unavailable|unavailable/i.test(rawTrim)) {
    return `503 Service Unavailable${rawTrim ? ": " + rawTrim : ""}`;
  }
  if (status === 504 || status === 524 || /\b(504|524)\b|gateway.?timeout|timed.?out|timeout/i.test(rawTrim)) {
    return `504 Gateway Timeout${rawTrim ? ": " + rawTrim : ""}`;
  }

  // 3) transient 连接 / 传输 / 流异常 —— 映射到 connection/network/ended without
  if (
    /connection.?(reset|closed|dropped|lost|refused)|other side closed|socket.?(hang|closed)|reset before headers|premature/i.test(
      rawTrim,
    )
  ) {
    return `connection error: ${rawTrim || "connection closed prematurely"}`;
  }
  if (/stream ended|ended without|empty response|empty stream/i.test(rawTrim)) {
    return `stream ended without a terminal response event: ${rawTrim || "empty response"}`;
  }
  if (/overloaded|server.?error|provider.?error|upstream.?error|gateway.?error/i.test(rawTrim)) {
    return `503 Service Unavailable: ${rawTrim}`; // 上游网关抖动按 5xx 重试
  }

  // 4) 未知 transient —— 兜底用带 provider error 关键词，命中可重试模式
  // （仅在已有 finishReason=error 上下文里调用，避免误伤正常流）
  return rawTrim || "provider error";
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

export default function fxExtension(pi: ExtensionAPI): void {
  pi.registerProvider(FX_PROVIDER_ID, {
    name: "FX Free (Vercel AI Gateway)",
    baseUrl: "https://ai-gateway.vercel.sh",
    api: "fx-gateway",
    apiKey: "$VERCEL_AI_GATEWAY_KEY",
    streamSimple: streamFxChat as (
      model: Model<string>,
      context: TranscriptContext,
      options?: SimpleStreamOptions,
    ) => AssistantMessageEventStream,
    models: FX_MODELS,
  });
}
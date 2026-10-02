/**
 * FX provider smoke test（开发用，不参与 Pi 加载）:
 * 本地 mock 网关验证
 *  1. 原始字节级：头部名/大小写/顺序对齐 Zig std.http sendHead（标准头小写、扩展头保留大小写、
 *     无 Accept、connection: close），请求体字段顺序 prompt→tools→toolChoice→maxOutputTokens→
 *     reasoning→providerOptions→headers（末位），无 temperature
 *  2. SSE 流（reasoning/text/tool/finish）是否正确翻译成 Pi 事件流
 *
 * 运行（需 pi-mono 的 esbuild）：
 *   esbuild fx-provider.ts --bundle --platform=node --format=esm --outfile=fx-provider.js \
 *     --external:@earendil-works/pi-coding-agent --external:@earendil-works/pi-ai
 *   esbuild smoke-test.ts --bundle --platform=node --format=esm --outfile=smoke-test.mjs \
 *     --external:@earendil-works/pi-coding-agent --external:@earendil-works/pi-ai
 *   node smoke-test.mjs
 * 跑完删除 fx-provider.js / smoke-test.mjs 编译产物。
 */
import { createServer } from "node:http";
import { strict as assert } from "node:assert";
import { normalizeContext } from "@earendil-works/pi-ai";

const captured: any = {};
let server: any;
const seenRequests: any[] = [];

const GATEWAY = "http://127.0.0.1:18180";

const FIXTURE = [
  `data: {"type":"response-metadata","modelId":"zai/glm-5.2","providerMetadata":{"gateway":{"generationId":"gen_1"}}}`,
  "",
  `data: {"type":"reasoning-start","id":"r1"}`,
  "",
  `data: {"type":"reasoning-delta","id":"r1","delta":"让我先分析一下"}`,
  "",
  `data: {"type":"reasoning-end","id":"r1"}`,
  "",
  `data: {"type":"text-start","id":"t1"}`,
  "",
  `data: {"type":"text-delta","id":"t1","delta":"你好，"}`,
  "",
  `data: {"type":"text-delta","id":"t1","delta":"我是 GLM 5.2。"}`,
  "",
  `data: {"type":"text-end","id":"t1"}`,
  "",
  `data: {"type":"tool-input-start","id":"c1","toolName":"bash"}`,
  "",
  `data: {"type":"tool-input-delta","id":"c1","delta":"{\\"command\\":\\"pwd\\",\\"timeout\\":30}"}`,
  "",
  `data: {"type":"tool-input-end","id":"c1"}`,
  "",
  `data: {"type":"tool-call","toolCallId":"c1","toolName":"bash","input":{"command":"pwd","timeout":30}}`,
  "",
  `data: {"type":"finish","finishReason":{"unified":"tool-calls","raw":"tool_calls"},"usage":{"inputTokens":{"total":42,"cacheRead":10},"outputTokens":{"total":17,"reasoning":9}},"providerMetadata":{"gateway":{"cost":"0.0000"}}}`,
  "",
  `data: [DONE]`,
  "",
].join("\n");

server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    // rawHeaders 保留线上原始大小写与顺序（含 Node 自动附加的 Host/Connection/Content-Length）
    const lines: string[] = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    seenRequests.push({ headers: req.headers, body: JSON.parse(body), lines, bodyRaw: body });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(FIXTURE);
  });
});
await new Promise((r) => server.listen(18180, "127.0.0.1", r));

// 加载扩展（default export 注册 provider）
process.env.FX_GATEWAY_URL = GATEWAY + "/v3/ai/language-model";
const mod = await import("./fx-provider.js");
const fakePi: any = { registerProvider: (id: string, cfg: any) => (captured.provider = { id, cfg }) };
mod.default(fakePi);

const { id, cfg } = captured.provider;
assert.equal(id, "fx");
const model = cfg.models[0];

// ---- 调用 streamSimple ----
// pi >= 0.86: streamSimple 接收 TranscriptContext，normalizeContext 把
// systemPrompt/tools 折叠进 leading system 消息。
const context = normalizeContext({
  systemPrompt: "你是测试助手",
  messages: [
    { role: "user", content: "运行 pwd 并输出", timestamp: Date.now() },
  ],
  tools: [
    { name: "bash", description: "Run a shell command", parameters: { type: "object", properties: { command: { type: "string" } } } },
    { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
  ],
});

const stream = cfg.streamSimple(model, context, { apiKey: "vck_test", reasoning: "xhigh" });
const events: any[] = [];
for await (const ev of stream) events.push(ev);
const finalMsg = await stream.result();

const req0 = seenRequests[0];

// ---- 1. 原始字节：头部名/大小写/顺序（对齐 Zig std.http sendHead）----
const lines = req0.lines;
assert.equal(lines[0], "authorization: Bearer vck_test", "Zig 小写 authorization");
assert.equal(lines[1], "user-agent: fx/0.0.4", "Zig 小写 user-agent");
assert.equal(lines[2], "content-type: application/json", "Zig 小写 content-type");
assert.equal(lines[3], "HTTP-Referer: https://github.com/vercel-labs/fx", "扩展头保留大小写");
assert.equal(lines[4], "X-Title: fx", "扩展头保留大小写");
assert.equal(lines[5], "ai-gateway-protocol-version: 0.0.1");
assert.equal(lines[6], "ai-language-model-specification-version: 4");
assert.equal(lines[7], "ai-language-model-id: zai/glm-5.2");
assert.equal(lines[8], "ai-language-model-streaming: true");
// 与 fx 0.0.4 一致：不发送 x-session-id / x-session-affinity（网关自行派生亲和）
assert.equal(lines.some((l) => l.split(": ")[0].toLowerCase().startsWith("x-session")), false, "无 session 头");
// Node 自动附加（Zig 中这些在中间位置，Node 只能在末尾——传输层残余差异）
assert.equal(lines[9].startsWith("Host: "), true, "Host");
assert.equal(lines[10], "Connection: close", "agent:false => connection: close（对齐 fx keep_alive=false）");
assert.ok(lines[11].startsWith("Content-Length: "), "Content-Length");
assert.equal(lines.length, 12, "无多余头部");
const allNames = lines.map((l) => l.split(": ")[0]);
assert.equal(allNames.some((n) => /^accept$/i.test(n)), false, "流式请求无 Accept 头（与 fx 一致）");

// ---- 2. 原始字节：请求体字段顺序 + 无 temperature ----
const body = req0.bodyRaw;
assert.match(
  body,
  /^\{"prompt":\[.*\],"tools":\[.*\],"toolChoice":\{"type":"auto"\},"maxOutputTokens":128000,"reasoning":"xhigh","headers":\{"user-agent":"fx\/0\.0\.4"\}\}$/,
  "字段顺序 prompt→tools→toolChoice→maxOutputTokens→reasoning→headers(末位)",
);
assert.equal(body.includes("temperature"), false, "fx 从不发 temperature");
assert.equal(body.includes("providerOptions"), false, "非 -fast 模型无 providerOptions");

// ---- 3. 请求体语义 ----
const b = req0.body;
assert.deepEqual(b.headers, { "user-agent": "fx/0.0.4" }, "body 根级指纹");
assert.equal(b.reasoning, "xhigh");
assert.equal(b.maxOutputTokens, 128000);
assert.deepEqual(b.toolChoice, { type: "auto" });
assert.deepEqual(b.prompt[0], { role: "system", content: "你是测试助手" });
assert.deepEqual(b.prompt[1], { role: "user", content: [{ type: "text", text: "运行 pwd 并输出" }] });
assert.equal(b.tools.length, 2);
assert.equal(b.tools[0].type, "function");
assert.equal(b.tools[0].name, "bash");
assert.deepEqual(b.tools[0].inputSchema, { type: "object", properties: { command: { type: "string" } } });

// ---- 3.5 -fast 模型 → providerOptions 注入（位置在 headers 之前）----
const fastModel = cfg.models[1];
const s2 = cfg.streamSimple(fastModel, context, { apiKey: "vck_test" });
for await (const _ of s2) { /* drain */ }
await s2.result();
const req1 = seenRequests[1];
const body2 = req1.bodyRaw;
assert.match(
  body2,
  /\{"prompt":\[.*\],"tools":\[.*\],"toolChoice":\{"type":"auto"\},"maxOutputTokens":128000,"providerOptions":\{"gateway":\{"speed":"fast"\}\},"headers":\{"user-agent":"fx\/0\.0\.4"\}\}$/,
  "-fast: providerOptions 在 headers 之前",
);
assert.equal(body2.includes("reasoning"), false, "未配置 reasoning → 省略字段（与 fx 一致）");
assert.equal(req1.headers["ai-language-model-id"], "zai/glm-5.2-fast");

// ---- 4. 事件翻译 ----
const types = events.map((e) => e.type);
assert.ok(types.includes("start"), "有 start");
assert.ok(types.includes("thinking_start") && types.includes("thinking_delta") && types.includes("thinking_end"));
assert.ok(types.includes("text_start") && types.includes("text_delta") && types.includes("text_end"));
assert.ok(types.includes("toolcall_start") && types.includes("toolcall_delta") && types.includes("toolcall_end"));
assert.ok(types.includes("done"), "以 done 结束");

const thinking = events.find((e) => e.type === "thinking_end");
assert.equal(thinking.content, "让我先分析一下");
const text = events.find((e) => e.type === "text_end");
assert.equal(text.content, "你好，我是 GLM 5.2。");
const tcEnd = events.find((e) => e.type === "toolcall_end");
assert.deepEqual(tcEnd.toolCall, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "pwd", timeout: 30 } });

// ---- 5. 最终消息 ----
assert.equal(finalMsg.stopReason, "toolUse");
// fixture: inputTokens.total=42 含 cacheRead=10（无 noCache → 兜底 input=42-10-0=32）
assert.equal(finalMsg.usage.input, 32, "input = noCache (互斥于 cacheRead)");
assert.equal(finalMsg.usage.output, 17);
assert.equal(finalMsg.usage.cacheRead, 10);
assert.equal(finalMsg.usage.reasoning, 9);
assert.equal(finalMsg.usage.totalTokens, 59, "totalTokens = input+output+cacheRead+cacheWrite");
assert.equal(finalMsg.usage.cost.total, 0);
assert.equal(finalMsg.responseModel, "zai/glm-5.2");

// ---- 6. fx CLI 式重试（对齐 model_response_recovery.zig，2026-08-21）----
// 用独立 mock 服务器（18181）避免污染主测试的 seenRequests 索引；
// gatewayUrl() 运行时读 env，切地址即可让 provider 打到重试 mock。
const retrySeen: any[] = [];
let retryMode: "ok" | "failN" | "always503" | "always400" = "ok";
let retryRemaining = 0;
let retryAfterHeader: string | undefined;

const retryServer = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const lines: string[] = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    retrySeen.push({ headers: req.headers, body: JSON.parse(body), lines, bodyRaw: body });
    const fail503 = () => {
      const h: Record<string, string> = { "content-type": "application/json" };
      if (retryAfterHeader != null) h["retry-after"] = retryAfterHeader;
      res.writeHead(503, h);
      res.end(JSON.stringify({ error: { message: "no_available_providers: No providers are currently available" } }));
    };
    if (retryMode === "failN") {
      if (retryRemaining > 0) {
        retryRemaining--;
        return fail503();
      }
    } else if (retryMode === "always503") {
      return fail503();
    } else if (retryMode === "always400") {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "invalid request" } }));
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(FIXTURE);
  });
});
await new Promise<void>((r) => retryServer.listen(18181, "127.0.0.1", r));
process.env.FX_GATEWAY_URL = "http://127.0.0.1:18181/v3/ai/language-model";

// 6a. -fast 模型：503×1 后成功 → 2 次请求，且降级去掉 providerOptions（disableFastRouteAfterFailure）
retryMode = "failN";
retryRemaining = 1;
retryAfterHeader = undefined;
const s3 = cfg.streamSimple(cfg.models[1], context, { apiKey: "vck_test" });
for await (const _ of s3) { /* drain */ }
const r3 = await s3.result();
assert.equal(r3.stopReason, "toolUse", "503 后重试成功");
assert.equal(retrySeen.length, 2, "503×1 → 共 2 次请求");
assert.equal(retrySeen[0].bodyRaw.includes("providerOptions"), true, "首次带 speed:fast");
assert.equal(retrySeen[1].bodyRaw.includes("providerOptions"), false, "降级后去掉 providerOptions");
assert.equal(retrySeen[1].bodyRaw.includes('"headers":{"user-agent":"fx/0.0.4"}'), true, "重试 body 指纹保持");
assert.equal(retrySeen[1].headers["ai-language-model-id"], "zai/glm-5.2-fast", "模型 id 不变（降级仅去 fast）");

// 6b. Retry-After 头优先：503 + Retry-After: 2 → 等待 ~2s（而非指数退避 250ms）
retrySeen.length = 0;
retryMode = "failN";
retryRemaining = 1;
retryAfterHeader = "2";
const t0 = Date.now();
const s4 = cfg.streamSimple(model, context, { apiKey: "vck_test" });
for await (const _ of s4) { /* drain */ }
await s4.result();
const elapsed4 = Date.now() - t0;
assert.ok(elapsed4 >= 1900, `Retry-After:2 → 等待 >=1.9s（实测 ${elapsed4}ms）`);
assert.equal(retrySeen.length, 2, "Retry-After 场景共 2 次请求");

// 6c. 持续 503（Retry-After: 0）→ 10 次尝试后耗尽，报告 recovery exhausted
retrySeen.length = 0;
retryMode = "always503";
retryAfterHeader = "0";
const s5 = cfg.streamSimple(model, context, { apiKey: "vck_test" });
let err5: any;
for await (const ev of s5) {
  if (ev.type === "error") err5 = ev;
}
await s5.result();
assert.equal(retrySeen.length, 10, "10 次尝试后耗尽");
assert.match(err5.error.errorMessage, /recovery exhausted after 10\/10 attempts/, "耗尽消息带 attempt 计数");

// 6d. 400 不可重试 → 立即失败，仅 1 次请求
retrySeen.length = 0;
retryMode = "always400";
const s6 = cfg.streamSimple(model, context, { apiKey: "vck_test" });
let err6: any;
for await (const ev of s6) {
  if (ev.type === "error") err6 = ev;
}
await s6.result();
assert.equal(retrySeen.length, 1, "400 不重试");
assert.match(err6.error.errorMessage, /FX gateway HTTP 400/, "400 消息直抛");

retryServer.close();

// ---- 7. 发送前 body 预算（1MiB 网关硬上限，2026-08-21 实测）----
// 直接构造超大 context（Pi 压缩不介入本测试，streamSimple 直发）→ 应被预算检查拦截
retrySeen.length = 0;
const s7 = cfg.streamSimple(
  model,
  normalizeContext({
    systemPrompt: "你是测试助手",
    messages: [{ role: "user", content: "x".repeat(2 * 1024 * 1024), timestamp: Date.now() }],
    tools: [],
  }),
  { apiKey: "vck_test" },
);
let err7: any;
for await (const ev of s7) {
  if (ev.type === "error") err7 = ev;
}
await s7.result();
assert.match(err7.error.errorMessage, /request too large/, "超大 body 被预算检查拦截");
assert.ok(err7.error.errorMessage.includes("上下文过大"), "错误信息含中文提示");
assert.equal(retrySeen.length, 0, "未发出任何请求（发送前拦截）");

// ---- 7b. 回归：body 预算错误能被 Pi 的 isContextOverflow 识别为“上下文溢出”，
// 并携带真实 model.id，从而触发 _checkCompaction 的 overflow 路径（compact-and-retry），
// 而不是直接终态失败。对应 fx-provider 两个修复：
//   (a) makeAssistant 的 model 字段填真实注册 model.id（非字面值 "fx"）
//   (b) body 预算错误文本按 Pi 的 OVERFLOW_PATTERNS 构造（exceeds the context window /
//       token limit exceeded）
const OVERFLOW_PATTERNS = [
  /prompt is too long/i,
  /request_too_large/i,
  /exceeds the context window/i,
  /exceeds.*maximum context length/i,
  /token limit exceeded/i,
  /too many tokens/i,
  /context[_ ]length[_ ]exceeded/i,
];
assert.ok(
  OVERFLOW_PATTERNS.some((p) => p.test(err7.error.errorMessage)),
  `body 预算错误应命中 Pi 的 overflow 模式之一，实际: ${err7.error.errorMessage}`,
);
assert.equal(err7.error.model, "zai/glm-5.2", "makeAssistant model 字段为真实注册 id（sameModel 判定需要）");
assert.equal(err7.error.provider, "fx", "provider 不变");
// 非 retryable transient 关键词（避免被错误归入重试而非压缩）
assert.ok(!/recovery exhausted|too many requests|^429|^503 service unavailable/i.test(err7.error.errorMessage), "不是 transient 重试类错误");

// ---- 7c. 回归（真实 Pi 判定）：用已安装 @earendil-works/pi-ai 的 isContextOverflow
// 直接验证最终 AssistantMessage 被识别为“上下文溢出”。这是最贴近生产行为的断言：
// Pi 的 _checkCompaction 正是用这个函数决定 overflow 压缩路径。只要这里返回 true，
// 自动 compact-and-retry 就会触发，body 预算 / 413 不再直接终态失败。
const { isContextOverflow } = await import("@earendil-works/pi-ai");
assert.equal(
  isContextOverflow(err7.error, 256_000),
  true,
  "Pi 的 isContextOverflow 应将 body 预算错误识别为上下文溢出 → 触发自动压缩",
);

console.log("✅ fx-provider smoke test passed (byte-level + stream translation)");
server.close();
process.exit(0);

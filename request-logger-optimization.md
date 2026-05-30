# request-logger 优化：TUI 非 200 错误提示

> 基于 pi-mono 源码分析实现。
> 原始文件：`~/.pi/agent/extensions/request-logger.ts`

## 原理

pi 的 provider 请求链路：

```
session.prompt()
  → agent harness → streamFunction
    → onPayload 回调 → before_provider_request 事件
    → SDK 内部调用 fetch()  ← request-logger 拦截器在此
      → 底层 fetch → HTTP 响应返回
      → 拦截器读取 body（非 2xx 克隆并读取）→ 缓存到 _lastErrorBody
      → 拦截器返回 response 给 SDK
    → onResponse 回调 → after_provider_response 事件
      → handler 读取 _lastErrorBody → ctx.ui.notify() 显示 TUI 错误
```

关键：fetch 拦截器的 body 读取发生在 `after_provider_response` 事件之前，所以 body 已经缓存好了。

## 改动内容

| 场景 | 触发点 | TUI 显示 |
|------|--------|---------|
| **429 限流**（opencode.ai） | fetch 拦截器（改写前） | `🚫 Provider rate-limited (HTTP 429)` |
| **非 2xx 响应** | `after_provider_response` 事件 | `HTTP 400: <error.message from JSON body>` |
| **网络错误** | fetch 拦截器 catch 块 | `🌐 Network error: <message>` |

`formatErrorForTui()` 自动从 JSON body 提取 `error.message` / `error` / `message` 字段，截断 200 字符，脱敏 API key。

## 涉及的 pi API

```typescript
// after_provider_response 事件
// 由 sdk.ts → runner.emit() 触发，handler 拿到 (event, ctx)
pi.on("after_provider_response", (event, ctx) => {
  event.status   // HTTP status code
  event.headers  // Record<string, string>
  ctx.ui.notify(msg, "error")  // TUI 显示红色 Error: ... 消息
});

// ctx.ui.notify 内部调用链
// runner.createContext() → ctx.ui = runner.uiContext
// uiContext.notify(msg, type) → showExtensionNotify(msg, type)
// → type === "error" ? showError(msg)
//   → chatContainer.addChild(Text(fg("error", `Error: ${msg}`)))
```

## 相关源码位置

- `packages/coding-agent/src/core/extensions/types.ts` — 事件类型定义（L612-619）
- `packages/coding-agent/src/core/extensions/runner.ts` — `emit()` (L681)、`createContext()` (L573)、`emitBeforeProviderRequest()` (L890)
- `packages/coding-agent/src/core/sdk.ts` — `onPayload` / `onResponse` 回调注册（L360-373）
- `packages/agent/src/harness/agent-harness.ts` — `onResponse` 触发 `after_provider_response`（L376）
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` — `showError()` (L3577)、`showExtensionNotify()` (L2262)

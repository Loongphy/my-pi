# Trae Work Provider (Pi 插件)

把 Windows 端 **Trae Work (TRAE SOLO CN)** 的内置 LLM API 作为 Pi 的 Provider 使用。
协议细节见同目录 [`TRAE-WORK-API-ANALYSIS.md`](./TRAE-WORK-API-ANALYSIS.md)。

## 文件

| 文件 | 说明 |
|---|---|
| `trae-work-provider.ts` | Pi Provider 插件（自定义 streamSimple，直连 Trae 网关，AES-GCM 加密） |
| `token_bridge.py` | token 自动刷新桥（hook 运行中的 Trae 抓最新 `x-ide-token`） |
| `refresh_token.py` | 手动刷新脚本（副本在 `/root/trae-work-re/scripts/`） |
| `TRAE-WORK-API-ANALYSIS.md` | 完整的协议逆向分析报告 |

## 安装

1. `/root/.pi/agent/extensions/package.json` 的 `pi.extensions` 列表已包含
   `"./trae-work-provider/trae-work-provider.ts"`。
2. 传输依赖 playwright 已装在 `/root/.pi/agent/extensions/node_modules/`（浏览器在
   `~/.cache/ms-playwright`）。若换机，需 `cd /root/.pi/agent/extensions && npm i playwright`。
3. 重启 Pi（或 `/reload`）生效。

## 认证（auth.json，推荐）

**token 放 pi 官方凭据文件 `/root/.pi/agent/auth.json`**，插件通过 pi 的 credential 机制
自动读取（`options.apiKey`），**无需设置环境变量**，`/reload` 后即可在 TUI 中直接使用：

```json
{
  "trae-work": {
    "type": "api_key",
    "key": "<最新 JWT>"
  }
}
```

### token 更新流程（每次刷新后必做）

Trae 的 JWT 会轮换（payload 相同但签名不同），旧签名可能 401 `{"code":1001}`。
刷新后同步到 auth.json：

```bash
# 1) 抓最新 token（需 Windows 侧 Trae 运行 + frida-server，且 Trae 里发过一条消息）
python3 /root/trae-work-re/scripts/refresh_token.py    # 写入 captures/trae_token.txt
# 或启动常驻桥自动抓：
nohup python3 /root/trae-work-re/scripts/token_bridge.py >> /tmp/token_bridge.log 2>&1 &

# 2) 同步到 auth.json（captures 文件 → trae-work.key）
python3 - <<'EOF'
import json
tok = open("/root/trae-work-re/captures/trae_token.txt").read().strip()
p = "/root/.pi/agent/auth.json"
d = json.load(open(p))
d.setdefault("trae-work", {})["key"] = tok
json.dump(d, open(p, "w"), indent=2, ensure_ascii=False)
print("auth.json trae-work.key updated:", len(tok), "chars")
EOF

# 3) pi 里 /reload 即可生效
```

### token 优先级（插件内 resolveToken）

`auth.json（options.apiKey）→ TRAE_IDE_TOKEN env → token 桥（127.0.0.1:18790）`

- exp 剩余 >6h：直接用，不刷新
- exp ≤6h 或缺失：自动调 token 桥刷新（需桥 + frida-server + Trae 运行）；失败则报错提示手动刷新
- ⚠️ 签名轮换但 exp 未到（401 code 1001）插件不会自动重试，需按上面流程刷新并更新 auth.json

## 环境变量（可选，覆盖 auth.json）

| 变量 | 说明 | 默认 |
|---|---|---|
| `TRAE_IDE_TOKEN` | 覆盖 auth.json 的 JWT（一般不需要） | auth.json |
| `TRAE_DEVICE_ID` | 设备 ID | `539197102372180` |
| `TRAE_MACHINE_ID` | 机器 ID | `7dc0e358...` |
| `TRAE_USER_ID` | 用户 ID | `2099393389932944` |
| `TRAE_AGENT_TYPE` | agent 类型 | `solo_agent_lite` |
| `TRAE_NO_BROWSER` | `"1"` 时用 Node fetch 传输（跳过 Chromium） | 使用 Chromium |
| `TRAE_CONTEXT_WINDOW` | 声明给 Pi 的上下文窗口（token）；客户端实测三模型均为 936000 | `936000` |
| `TRAE_MAX_TOKENS` | 声明给 Pi 的最大输出 token（客户端实测三模型均为 64000） | `64000` |
| `TRAE_IDLE_TIMEOUT` | SSE 空闲超时 ms（两次数据包间隔；页面级，Chromium 节流下不一定触发） | `120000` |
| `TRAE_TOTAL_TIMEOUT` | SSE 总时长超时 ms（排队/悬挂超过即中断，Node 侧强制，可靠） | `180000` |
| `TRAE_FRONTIER_ID` | batchInsert 请求的 frontier id（客户端实测值，暂未启用注册链路） | `327022454708278869` |
| `TRAE_WORKSPACE` | 告诉 Trae 模型的“当前工作目录”（会写进环境描述；应指向 Pi 的实际工作目录，保证 read/bash 相对路径一致） | `/root` |
| `TRAE_OS_VERSION` | 覆盖注入给 Trae 的操作系统描述（默认已改写成 Linux，避免模型输出 PowerShell 语法） | `WSL2 (Ubuntu)` |

## 长对话（多轮历史）

- **无条件支持**：每次请求都把此前全部轮次（用户/助手文本）拼进 `user_input` 发送，模型一定看得到
  历史（无开关、无判定——长对话是插件的默认能力）。验证（2026-08-18，Auto 模式 9 轮）：
  R1 留信息「天空是蓝色的，大海也是。」→ 7 轮无关闲聊 → R9 精确复述；密钥类信息同样可回
  忆（模型安全策略可能拒答「密钥/敏感信息」，属模型行为）。
- **服务端不认直连的 `messages[]`**（客户端式全量消息数组被静默忽略，history 事件只有当前消息），
  `conversation_id` 复用 + `history_id_list` 只对服务端存储生效（直连会话无存储）。客户端真正的
  多轮记忆链路 = `batchInsert` 注册消息到服务端存储（明文可达业务层，但需「真实会话」，直连报
  `chat session not found`），插件因此用拼历史保证上下文。

## 排队状态（实时可见）

- SSE 流式改造：页面内增量解析事件并实时回传 Node（`exposeFunction`），`queue_begin` 事件立即
  转化为 Pi 的 thinking 块（思考折叠区），实时显示**排队位置**：
  `服务端排队中（第 1203 位），请稍候…`（服务端持续推送位置更新 1203→1201→1193…，实时刷新）。
- 修复（2026-08-18）：流必须在任何 thinking/text 增量**之前**先发 `start` 事件，否则 Pi 的
  agent-loop 会丢弃 `start` 前的增量，导致 TUI 一直只显示 spinner 而看不到排队状态；现在请求发出前即推 `start`，并在 `onQueue` 里加安全兜底。
- `queue_begin` data 实测：`{"position":1230,"message":"Too many current requests...","queue_id":"..."}`。
- 排队/悬挂不超过 `TRAE_TOTAL_TIMEOUT`（默认 180s），超时自动中断并提示改用 Auto 模式避开高峰。

## 工具调用 / 自动连续（2026-08-18 客户端实测实现）

Trae Work 的 `create_agent_task` **本来就有原生工具调用**（请求带 `available_tool_list` + 工作区环境即可启用）：

1. **请求**：客户端真实结构——`available_tool_list`（**已精简为映射覆盖的 ~20 个工具**：RunCommand/Read/Write/
   Edit/SearchCodebase/Grep/ListDir/LS/Glob 等，去掉了 Exec/浏览器/WebFetch/AskUserQuestion，避免服务端注入
   Exec 组、模型调用无法映射的工具）、`render_context.variables`（含 `workspace_folder`/环境，缺了模型只会拿到
   Task/Schedule）、`mode_type: 2`、`history_id_list` 累积。
   - 实测：精简列表 HTTP 200 无报错，模型只调用列表内工具（RunCommand/Grep/LS/Read）；不含 Exec 时
     `tool_cache_data` 不再注入 Exec 组，模型直接用 RunCommand/Read，反而更干净。
2. **响应**：SSE 出现 `event: tool_call`（`toolcall_id`/`tool_name`/`arguments`，完整参数在 `history` 事件的
   assistant `tool_calls` 里），随后 `turn_completion` 的 `task_completion: false`。
3. **执行**：插件把 `tool_call` 转成 Pi 的 `toolcall_*` 事件，映射是**自适应**的（`mapTraeToolCall`）：
   - `RunCommand→bash`、`Read/ViewFile→read`、`Write→write`、`Edit→edit`、`SearchCodebase→grep`、`ListDir→ls`；
   - 若目标 Pi 工具在当前会话未启用（默认只开 read/bash/edit/write，常没有 grep/ls），**自动回退成 bash 子命令**：
     `SearchCodebase/Grep → bash: rg -n …`、`ListDir/LS → bash: ls -la …`、`Read → bash: cat …`、`Glob → bash: find …`；
   - 仍无法映射的（浏览器系列/Exec/WebFetch…）保留原名让 Pi 报错回传，模型会换工具。
4. **环境改写**：注入给 Trae 的环境描述已从 Windows/PowerShell 改写成 Linux bash（`TRAE_WORKSPACE`/`TRAE_OS_VERSION`
   可调），避免模型输出 `Get-ChildItem`/`Get-Location` 等 PowerShell 语法（Pi 的 bash 在 WSL 执行会报 command not found）。
5. **续流**：下一轮插件调用 `POST /api/agent/v3/commit_toolcall_result`（`conversation_id`+`task_id`+
   `agent_run_id`+`toolcall_id`+`toolcall_resp`+`toolcall_status`），其 SSE 响应直接是续流——
   若还有工具调用则继续循环，否则返回最终 `thought` 文本 + `task_completion: true`。

已验证（DeepSeek-V4-Flash-Official 真实网关）：`create → tool_call(RunCommand pwd) → commit → 最终文本`。
请求结构/`commit` 结构均来自客户端 frida 抓包（`/root/trae-work-re/captures` 与抓包记录）。

## 传输层

- 默认 **Playwright Chromium**（与应用 Cronet 同源指纹；按需启动、用后即关，避免拖住进程退出）。
  浏览器路径一次拉完整响应体后统一 `parseSSE` 解析（2026-08-18 修复：旧的流式 chunk 回调
  `__traeChunk` 从未定义导致"no text output"，已移除）。
- `TRAE_NO_BROWSER=1` 回退 Node fetch（依赖无、启动更快）。

## 使用

```bash
pi --provider trae-work --model glm-5.3 "你的问题"
# 模型：glm-5.3（GLM-5.3）/ DeepSeek-V4-Flash-Official（DeepSeek-V4-Flash 正式版）/ qwen3.8-max（Qwen3.8-Max）
# 全部为客户端实测真实 config_name，大小写敏感；Qwen 1.50x 较贵，默认建议用 DeepSeek（0.08x）
```

## 协议要点（已实测验证）

- 端点：`POST https://trae-api-cn.mchost.guru/api/agent/v3/create_agent_task`（SSE 流式）
- **请求体必须 AES-256-GCM 加密**（明文被网关拒绝）：
  - `salt=8B随机` → 头 `x-request-pin: hex(salt)`
  - `ts=unix秒` → 头 `x-requested-at: ts`（同时是 GCM AAD）
  - `key = BASE_KEY ⊕ salt`（前 8 字节 XOR），`BASE_KEY = 6195f24c...16b955`
  - `body = base64(nonce[12] ‖ AES-GCM(key, nonce, plaintext, aad=ts) ‖ tag[16])`
- 版本头：`x-ide-version / app-version: 0.1.47`，`x-ide-version-code / x-app-version-code: 20260806`

## 使用状态（2026-08-18 复核更新）

- ✅ **对话可用**：新会话 + 空 history 即可，每轮完整回答；Chromium 与 fetch 双路径均通（4 个模型全部实测）
- ✅ 文本输出在 `thought.thought` 字段（兼容 `output.response`；兑底 `reasoning_content`）
- ✅ **auth.json 认证**：不设任何 env 即可用
- ✅ **token 用量回传**：解析 SSE `token_usage`，Pi 里可见真实 input/output token
- ⚠️ 多轮：复用 conversation_id + 空 history（无上下文记忆）；带上下文多轮需 `history_id_list`（实测可部分生效，未作为正式特性）
- ✅ **token 自动刷新**：插件检测到过期/快过期时自动调 `token_bridge.py`（hook 应用抓最新 JWT）
- ⚠️ 兜底：桥不可用时手动 `python3 scripts/refresh_token.py`（需在 Trae 发一条消息触发），再同步 auth.json

### 上下文窗口：168K 的来历 & 1M 适配（2026-08-18）

- **168000 不是臆测**：来自 2026-08-08 抓包留存的平台**模型配置 API 响应**
  （`captures/trae_request_body_130000.json` 中的 `config_info_list` → `model_detail_list[].prompt_max_tokens = 168000`；
  平台对 Doubao-Seed-2.1-Pro/Turbo 的 `__dev`/`__max` 变体声明一致，`max_tokens = 32000`）。
  模型选择器元数据即来自该接口（`display_name`、`model_capability: reasoning_model`、多模态标记等）。
  **没有独立的公开元数据端点**——探测 `/api/agent/v3/model_list`、`/api/solo_hub/v1/models`、
  `/api/agent/v3/model_configs` 等均 404；该配置随应用内部 RPC 下发，只能抓包留存。
- **1M 适配依据（客户端实测补充）**：2026-08-18 客户端明文抓包（AhaNet_fetch 参数内存）证实
  `create_agent_task` 每消息 `model_info.prompt_max_tokens = 936000`（GLM-5.3 / DeepSeek-V4-Flash-正式版 /
  Qwen3.8-Max 一致，Max 开关前后不变）——**客户端实际声明的上下文 ≈0.936M**，168000 已过时；
  且网关实测不拦截超长输入（100 万字符 ≈25 万 token 正常应答）。故插件默认 `contextWindow = 936_000`，
  可由 `TRAE_CONTEXT_WINDOW` 覆盖。输出上限同理：客户端实测 `max_tokens = 64000`（老 API 的 32000 已过时）。

### 推理等级：不支持选择（含 max）

- 四个模型均为**原生推理模型**（`model_capability: reasoning_model`；thought 事件流式返回 `reasoning_content`），
  插件已如实标记 `reasoning: true`。
- 协议中**没有任何推理等级/effort 参数**（所有抓包请求体、模型 extra_config 均无）；
  应用里的 `__max` 变体（`Doubao-Seed-2.1-Pro__max`）在网关侧**不存在**：
  `config_name=...__max` → 4001 `config item is empty`；`model_name=...__max` → 被静默回退到 `__dev`。
- 结论：**不支持 max 推理等级**，也无法选择任何推理强度；思考量由服务端默认决定。
- **客户端“Max”标签实测**（2026-08-18）：UI 的 Max = `persist_meta.smart_selection.strategy`
  （`manual` ↔ `max`，用户在模型选择器 hover 模型的二级选项中开关），随 user_message_context 发送，
  **config_name 与 prompt_max_tokens 均不变**；协议依旧无任何推理等级字段。

### “no text output” 修复说明（2026-08-18 04:20 已修 + 本次加固）

- 根因：旧版 Chromium 流式路径依赖页面里从未定义的 `__traeChunk` 回调 → 文本为空 → 报错。
- **运行中的 Pi 若在该修复之前启动，内存里仍是旧代码**——`/reload` 或重启 Pi 才会生效。
- 本次加固：
  1. 空输出时自动用**新会话重试一次**（服务端偶发空响应）；
  2. `reasoning_content` 作为最后兑底（模型只吐推理没吐最终文本时不会白屏）；
  3. 仍失败时错误信息附带**实际事件序列**（可诊断）；
  4. 修正后所有模型均可正常对话（Doubao-Seed-2.1-Pro/Turbo、kimi-k2.6、DeepSeek-V4-Flash、glm-5.2 本轮实测通过）。

## 风险提示

将 IDE 登录态当作 API 使用违反 Trae 服务条款，可能限流/封号；请仅用于本人账号、本地、低频率场景。

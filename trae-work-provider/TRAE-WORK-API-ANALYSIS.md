# Trae Work API 逆向分析记录

> 结论性记录（2026-08-09 实测确认）。完整流程见 /root/trae-work-re/PROVIDER-FLOW.md。

## 端点
- 对话：`POST https://trae-api-cn.mchost.guru/api/agent/v3/create_agent_task`（SSE）
- 会话列表：`GET /api/solo_hub/v1/conversations`
- 消息注册：`POST /api/solo_hub/v1/conversations/messages/batchInsert`（需 frontier 连接，未用）

## 加密协议（100% 验证）
```
BASE_KEY = 6195f24ca4d430f8a4833de7db8dac37d148a084e7464a351ffa68585c16b955
salt=8B随机 → x-request-pin: hex(salt)；ts=unix秒 → x-requested-at: ts（=GCM AAD）
key = BASE_KEY ⊕ salt(前8B)；body = base64(nonce[12]+AES-GCM(key,nonce,plaintext,AAD=ts)+tag[16])
```
验证：Frida 抓 seal 六元组 + 网络层 body/pin/ts → 本地解密真实密文 → 明文完整还原。

## 认证
- `x-ide-token: <JWT>`。**1001 = token 失效/不匹配**（应用轮换 JWT，payload 相同的新旧签名并存）。
- 刷新：refresh_token.py（hook `Cronet_UrlRequestParams_request_headers_add` 提取）。

## 对话要点
- 新会话：conversation_id = hex(unix秒)+随机16hex（24hex）；history_id_list = []（避开 2001）
- SSE 事件：task_created → model_config → tool_cache_data → history → thought(×N) → token_usage → required_context → agent_status → turn_completion
- **文本输出 = thought 事件的 thought 字段**（solo_agent_lite）；output.response 仅部分情况；
  推理过程在 thought 事件的 reasoning_content 字段（原生推理模型）
- **token 用量 = token_usage 事件**（prompt_tokens / completion_tokens / reasoning_tokens）

## 模型元数据（上下文窗口来源，2026-08-18 确认）
- 平台模型配置以 `{"request_pin":[],"data":{"config_info_list":[...]}}` 随内部 RPC 下发
  （2026-08-08 抓包留存于 captures/trae_request_body_130000.json，截断于 128K）。
  **无独立公开元数据端点**：探测 `/api/agent/v3/model_list`、`/api/solo_hub/v1/models`、
  `/api/agent/v3/model_configs`、`/api/agent/v3/configs` 等均 404。
- 已知 config：`Doubao-Seed-2.1-Pro`（display Seed-2.1-Pro）与 `Doubao-Seed-2.1-Turbo`，
  均 `model_capability: reasoning_model`、`multimodal: true`、`max_turn: 500`；
  `model_detail_list` 含 `__dev` 与 `__max` 两个变体：**prompt_max_tokens=168000（两者一致）**、
  max_tokens=32000、large_prompt_max_tokens=null（无独立大上下文档位）。
- **168000 即插件旧值来源**；实测网关不强制该预算：2026-08-18 以 1,000,024 字符
  （≈25 万 token）输入请求 → HTTP 200 且正常应答 → 插件默认 contextWindow=1M。
- **max 变体不可用**：`config_name=[...]__max` → 4001 "config item is empty"；
  `model_name=[...]__max` 被网关静默回退 `__dev`；协议无任何推理等级/effort 参数。

## 客户端实测：三个目标模型真实请求体（2026-08-18，客户端 1.107.1）

抓包方法：frida hook `aha_net.dll` 的 `AhaNet_fetch`/`AhaNet_WsClient_send`，**请求体明文直接
在参数内存中**（`args[0]/args[4]` 指针扫描命中 `config_name`）——无需解密。
`solo_agent_lite` 对话、`agent_process_support=v3`、`chat_process_version=v2`。

| 展示名（选择器） | config_name / model_name（客户端真实发送） | event |
|---|---|---|
| GLM-5.3（专属补贴 0.40x） | `glm-5.3`（小写） | GLM_OK 正常回复 |
| DeepSeek-V4-Flash 正式版（0.08x） | `DeepSeek-V4-Flash-Official`（大小写敏感，无 __dev 后缀） | OK 正常回复 |
| Qwen3.8-Max（1.50x） | `qwen3.8-max`（小写；大写/错拼 → 4001） | QWEN_OK 正常回复 |

每消息 `user_message_context.model_info` 三模型一致：
- `prompt_max_tokens: 936000`（≈0.936M 上下文——客户端真实声明值，非老 API 的 168000）
- `max_tokens: 64000`（输出上限）
- `is_preset: true`、`config_source: 1`、`max_turn: 500`、`multimodal: false`
- **无任何推理等级 / effort / thinking level 字段**
- UI 的 "Max" 标签 = `persist_meta.smart_selection.strategy`：
  用户在选择器 hover 模型的二级选项中开/关 → `manual` ↔ `max`（Qwen 实测 manual→max）；
  该字段在请求体中随 user_message_context 发送，config_name 不变、prompt_max_tokens 不变。

选择器内置 17 个模型：Auto Mode / Seed-2.1-Pro/Turbo / Seed-Code / GLM-5.3/5.2/5.1/5 /
DeepSeek-V4-Pro(正式版) / DeepSeek-V4-Flash(正式版) / Kimi-K3 / Kimi-K2.7-Code / Kimi-K2.6 /
MiniMax-M3 / Qwen3.8-Max / Qwen3.7-Plus。

## 多轮（2026-08-18 补充实测）
- **服务端不认直连的 `messages[]`**：客户端式全量消息数组（含 user_message_context/query）被静默忽略——
  SSE `history` 事件的 `raw_messages` 里只有当前消息。客户端新式请求体的 messages 是「本地全量同步」，
  服务端 prompt 构建只认 **服务端存储**（`conversation_id` 维度）。
- `history_id_list=[上一轮 history_data.history_id]`：只对**服务端有存储的会话**生效；直连新会话存储为空，
  恢复出空上下文（“没有秘密词”）。
- 客户端多轮记忆闭环 = **batchInsert**（`POST /api/solo_hub/v1/conversations/messages/batchInsert`，
  turn 结束后注册消息到存储）：明文请求可达业务层（400 `chat session not found` 说明会话必须先存在），
  加密路径解密乱码（`invalid character` 类错误，密钥/协议与 create 不同）；会话创建 API 未找到
  （前端本地生成 id）。
- **落地方案**：插件无条件把历史拼进 `user_input`（长对话默认能力，无开关）。验证（9 轮）：
  R1「天空是蓝色的，大海也是。」→ 7 轮闲聊 → R9 精确复述；密钥类亦可回忆（拒答属模型安全策略）。
- **排队事件（queue_begin）**：data 实测 `{"position":1230,"message":"Too many current requests. Your queue
  position is 1230...","queue_id":"..."}`；SSE 流式改造（页面 `exposeFunction` 实时回传）后 queue_begin
  转 thinking 块实时显示位置，服务端持续推送位置更新（1230→1221→…）。
- **Auto 模式要点**：`config_name/model_name` 传空 + `mode_type: 1`（否则 4001
  `no user prompt template found for v3 agent type`）＋ `message_source/session_type/available_plugins/connector_list/cached_tool_groups`。

## 网络架构
- ai-agent(Rust) 加密 → IPC → aha_net(Go 业务层) → **sscronet.dll(Cronet) 实际传输**
- TLS/HTTP2 指纹 = Cronet(BoringSSL, Chromium 107)。**指纹一致必须复用 sscronet.dll**。
- HTTP 入口导出：AhaNet_fetch；WS：AhaNet_WsClient_send（frontier.zijieapi.com，仅心跳）

## 环境事实（0.1.47）
x-app-id=6eefa01c-1036-4c7e-9ca5-d891f63bfcd8；version-code=20260806；
device_id=539197102372180；machine_id=7dc0e358b8089946fbb9d059570b29517cad334ed3126a0f6c2fa4f1a0514bbd；
user_id=2099393389932944；frontier 曾抓：frontier_id=325536183455021796、access_key=0021be1d54363beaeb31798c832306d3

## 风险
违反 ToS；仅本人账号/本地/低频；token 每次刷新；不重放/不高频。

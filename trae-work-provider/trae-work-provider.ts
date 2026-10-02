/**
 * Trae Work Provider — 将 Windows 端 Trae Work CN 的内置 LLM API 作为 Pi 的 Provider。
 *
 * 协议（2026-08-09 Frida 抓包 + 解密验证）：
 *   - 端点：POST https://trae-api-cn.mchost.guru/api/agent/v3/create_agent_task（SSE 流式）
 *   - 认证：x-ide-token: <JWT>（**必须最新**，应用轮换 JWT，旧 token 必 1001）
 *   - 请求体：AES-256-GCM 加密（明文被网关拒绝）：
 *       salt=8B随机 → x-request-pin: hex(salt)；ts=unix秒 → x-requested-at: ts（=GCM AAD）
 *       key = BASE_KEY ⊕ salt(前8B)；body = base64(nonce[12]+AES-GCM(...)+tag[16])
 *   - 文本输出：SSE `thought` 事件的 `thought` 字段（solo_agent_lite）
 *
 * 传输层：Playwright Chromium（BoringSSL，与应用 Cronet 同源，指纹远优于 Node OpenSSL）。
 * 新会话 + 空 history_id_list 即可对话（多轮复用会话无上下文记忆）。
 *
 * 上下文窗口（2026-08-18 复核）：
 *   - 平台模型配置 API（config_info_list → model_detail_list[].prompt_max_tokens）声明
 *     Doubao-Seed-2.1 系列 = 168000（2026-08-08 抓包留存，见 TRAE-WORK-API-ANALYSIS.md）；
 *     插件旧值 168000 即来源于此，非臆测。
 *   - 实测网关不强制 168K：1,000,024 字符（≈25 万 token）输入返回 200 + 正常回答。
 *   - 用户确认底层模型可扩展到 1M → 默认 contextWindow = 1_000_000，可用
 *     TRAE_CONTEXT_WINDOW 覆盖（配小值如 168000 可还原为平台声明值）。
 *
 * 推理等级（2026-08-18 实测）：
 *   - 全部模型为原生 reasoning_model（thought 事件流式返回 reasoning_content）。
 *   - 协议中没有任何推理等级/effort 参数；应用里的 `__max` 变体在网关侧不存在：
 *     config_name=...__max 报 4001 "config item is empty"，model_name=...__max 被静默
 *     回退到 __dev。→ 不支持选择 max 推理等级（也不支持任何等级选择）。
 *
 * 配置（环境变量）：
 *   TRAE_IDE_TOKEN   必填：最新 JWT（scripts/refresh_token.py 抓取）
 *   TRAE_DEVICE_ID / TRAE_MACHINE_ID / TRAE_USER_ID  可选，默认本机已知值
 *   TRAE_AGENT_TYPE  可选，默认 solo_agent_lite
 *   TRAE_NO_BROWSER  "1" 时回退 Node fetch（无 Playwright 环境）
 *   TRAE_CONTEXT_WINDOW  可选，默认 1000000（token；平台声明值为 168000）
 *   TRAE_MAX_TOKENS     可选，默认 32000（平台 max_tokens）
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
  TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAssistantMessageEventStream,
  getCurrentTools,
  type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { createCipheriv, randomBytes, randomUUID } from "node:crypto";

export const TRAE_WORK_PROVIDER_ID = "trae-work";
const GATEWAY = env("TRAE_GATEWAY") || "https://trae-api-cn.mchost.guru";

// 会话链状态：最近一次成功轮次的 conversation_id + history_id（用于下一轮回填）
let lastTurnState: { conversationId: string; historyId: string | null } | null = null;
const BASE_KEY = Buffer.from("6195f24ca4d430f8a4833de7db8dac37d148a084e7464a351ffa68585c16b955", "hex");

// ---------------------------------------------------------------------------
// Playwright Chromium 传输层（懒加载，常驻）
// ---------------------------------------------------------------------------
// Playwright Chromium 传输层（按需启动、用后即关；避免常驻浏览器拖住 pi 进程退出）
// ---------------------------------------------------------------------------

/**
 * 用 Chromium 发请求；一次拉完整响应体后关闭浏览器。
 */
async function traeFetch(
  url: string,
  headers: Record<string, string>,
  body: string,
  signal?: AbortSignal,
  onEvent?: (ev: { event: string; data: string }) => void,
): Promise<{ status: number; body: string }> {
  const pw = require("playwright");
  const browser = await pw.chromium.launch({
    headless: true,
    args: ["--disable-web-security", "--disable-features=IsolateOrigins,site-per-process", "--disable-background-timer-throttling"],
  });
  try {
    const page = await browser.newPage();
    await page.goto("https://example.com").catch(() => {});
    // 流式暴露：页面把解析好的完整 SSE 事件实时回传（排队状态/推理内容即时可见）
    await page.exposeFunction("__traeOnEvent", (evJson: string) => {
      try {
        const ev = JSON.parse(evJson);
        onEvent?.(ev);
      } catch {
        /* 忽略坏帧 */
      }
    });
    const onAbort = () => { /* 页面 fetch 不支持直接中断；保持连接直至读完 */ };
    signal?.addEventListener("abort", onAbort);
    const totalMs = Number(process.env.TRAE_TOTAL_TIMEOUT || 180000);
    try {
      // Node 侧总时长兜底（页面 timer 在 Chromium 后台节流下不可靠，排队超长时主动中断）
      let evalResult: { status: number; body: string } | null = null;
      let totalTimer: NodeJS.Timeout | undefined;
      const evalP = page.evaluate(
        async (args: { url: string; headers: Record<string, string>; body: string; idleMs: number }) => {
          const { url, headers, body, idleMs } = args;
          const resp = await fetch(url, { method: "POST", headers, body });
          const reader = resp.body!.getReader();
          const decoder = new TextDecoder();
          const win = window as any;
          let all = "";
          let total = "";
          let packet = "";
          for (;;) {
            // 空闲超时（首字节也覆盖）：排队/悬挂时不无限等待；任何进展都会重置计时
            const rd =
              idleMs <= 0
                ? reader.read()
                : Promise.race([
                    reader.read(),
                    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("trae idle timeout (服务端排队/繁忙，已自动中断；请稍后重试，或改用 Auto 模式避开高峰)" )), idleMs)),
                  ]);
            const { done, value } = await rd;
            if (done) break;
            all = decoder.decode(value, { stream: true });
            total += all;
            // 增量切分 SSE 事件（\n\n 分隔）并实时回传
            packet += all;
            packet = packet.replace(/\r\n/g, "\n");
            all = "";
            let idx: number;
            while ((idx = packet.indexOf("\n\n")) >= 0) {
              const block = packet.slice(0, idx);
              packet = packet.slice(idx + 2);
              let ev: string | null = null;
              let data = "";
              for (const line of block.split("\n")) {
                if (line.startsWith("event:")) ev = line.slice(6).trim();
                else if (line.startsWith("data:")) data += line.slice(5).trim();
              }
              if (ev) {
                try {
                  win.__traeOnEvent(JSON.stringify({ event: ev, data }));
                } catch {}
              }
            }
          }
          if (packet.trim()) {
            // 尾部残块（无 \n\n）：也回传保证完整
            let ev: string | null = null;
            let data = "";
            for (const line of packet.split("\n")) {
              if (line.startsWith("event:")) ev = line.slice(6).trim();
              else if (line.startsWith("data:")) data += line.slice(5).trim();
            }
            if (ev) {
              try {
                win.__traeOnEvent(JSON.stringify({ event: ev, data }));
              } catch {}
            }
          }
          return { status: resp.status, body: total };
        },
        { url, headers, body, idleMs: Number(process.env.TRAE_IDLE_TIMEOUT || 120000) },
      );
      // 总时长超时兜底：排队/悬挂超过限制即中断（页面 timer 在 Chromium 后台节流下不可靠）
      try {
        await Promise.race([
          evalP.then((r: { status: number; body: string }) => {
            evalResult = r;
          }),
          new Promise<never>((_, rej) => {
            totalTimer = setTimeout(
              () => rej(new Error(`trae total timeout (服务端排队/繁忙超过 ${Math.round(totalMs / 1000)}s，已自动中断；请稍后重试，或改用 Auto 模式避开高峰)`)),
              totalMs,
            );
          }),
        ]);
      } finally {
        if (totalTimer) clearTimeout(totalTimer);
      }
      return evalResult!;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

interface TraeUsage {
  input: number;
  output: number;
  reasoning: number;
  total: number;
}

function makeAssistant(text: string, stopReason: AssistantMessage["stopReason"] = "stop", errorMessage?: string, usage?: TraeUsage, reasoning?: string): AssistantMessage {
  const content: (TextContent | ThinkingContent)[] = [];
  if (reasoning) content.push({ type: "thinking", thinking: reasoning });
  content.push({ type: "text", text: text });
  return {
    role: "assistant",
    content,
    api: "trae-work",
    provider: TRAE_WORK_PROVIDER_ID,
    model: "trae-work",
    usage: {
      input: usage?.input ?? 0,
      output: usage?.output ?? 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: usage?.total ?? 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}

/** 用给定 content 数组构造 assistant 消息（支持 thinking/text/toolCall 混排）。 */
function makeMessage(
  content: (TextContent | ThinkingContent | ToolCall)[],
  stopReason: AssistantMessage["stopReason"] = "stop",
  errorMessage?: string,
  usage?: TraeUsage,
): AssistantMessage {
  return {
    role: "assistant",
    content: content.map((b) => ({ ...b })),
    api: "trae-work",
    provider: TRAE_WORK_PROVIDER_ID,
    model: "trae-work",
    usage: {
      input: usage?.input ?? 0,
      output: usage?.output ?? 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: usage?.total ?? 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}

/** 从任意 content 数组抽取纯文本（toolCall 显示为“调用工具”）。 */
function contentText(content: Message["content"]): string {
  const parts: string[] = [];
  for (const c of Array.isArray(content) ? content : []) {
    if (typeof c === "string") parts.push(c);
    else if (c && c.type === "text") parts.push(c.text);
    else if (c && c.type === "thinking") parts.push(c.thinking);
    else if (c && c.type === "toolCall") parts.push(`[调用工具 ${c.name}]`);
  }
  return parts.join("\n").trim();
}

function env(name: string): string {
  return process.env[name]?.trim() ?? "";
}

// ---- token 生命周期管理 ----
const TOKEN_BRIDGE = "http://127.0.0.1:18790";

function tokenExpiry(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return typeof payload?.exp === "number" ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/** 通过 token 桥刷新（抓应用最新 x-ide-token）。成功返回新 token，失败返回 null。 */
async function refreshTokenViaBridge(waitSec = 120): Promise<string | null> {
  try {
    const resp = await fetch(`${TOKEN_BRIDGE}/refresh?wait=${waitSec}`, { method: "POST", signal: AbortSignal.timeout((waitSec + 15) * 1000) });
    const d = (await resp.json()) as { ok?: boolean; token?: string; error?: string };
    if (d?.ok && d.token) return d.token;
    return null;
  } catch {
    return null;
  }
}

/** 获取有效 token：优先 auth.json（options.apiKey）/ 环境变量；过期/快过期时尝试自动刷新（桥）。 */
async function resolveToken(currentToken = ""): Promise<{ token: string; note?: string }> {
  let token = currentToken || env("TRAE_IDE_TOKEN") || "";
  if (token) {
    const exp = tokenExpiry(token);
    // 剩余 > 6 小时：直接用
    if (exp && exp - Date.now() > 6 * 3600 * 1000) return { token };
    // 已过期或快过期：尝试自动刷新
    const fresh = await refreshTokenViaBridge();
    if (fresh) {
      process.env.TRAE_IDE_TOKEN = fresh;
      return { token: fresh, note: "auto-refreshed" };
    }
    return {
      token,
      note: "Token expired and auto-refresh failed (make sure Trae is running, or send a message in Trae and retry; you can also run scripts/refresh_token.py manually, then update auth.json)",
    };
  }
  // 无 token（auth.json/env 都没有）：尝试从桥拿
  try {
    const resp = await fetch(`${TOKEN_BRIDGE}/token`);
    const d = (await resp.json()) as { ok?: boolean; token?: string };
    if (d?.ok && d.token) {
      process.env.TRAE_IDE_TOKEN = d.token;
      return { token: d.token, note: "loaded from bridge" };
    }
  } catch {
    /* bridge 不可用 */
  }
  // 最后尝试刷新
  const fresh = await refreshTokenViaBridge();
  if (fresh) {
    process.env.TRAE_IDE_TOKEN = fresh;
    return { token: fresh, note: "auto-refreshed" };
  }
  throw new Error(
    "No Trae token available. Put a fresh JWT in /root/.pi/agent/auth.json under \"trae-work\".key " +
    "(token comes from scripts/refresh_token.py or token_bridge.py), or set TRAE_IDE_TOKEN, " +
    "or make sure token_bridge.py is running (python3 scripts/token_bridge.py)",
  );
}

interface Identity {
  userId: string;
  deviceId: string;
  machineId: string;
  token: string;
}

function resolveIdentity(token: string): Identity {
  return {
    userId: env("TRAE_USER_ID") || "2099393389932944",
    deviceId: env("TRAE_DEVICE_ID") || "539197102372180",
    machineId:
      env("TRAE_MACHINE_ID") ||
      "7dc0e358b8089946fbb9d059570b29517cad334ed3126a0f6c2fa4f1a0514bbd",
    token,
  };
}

function traeId(): string {
  return Math.floor(Date.now() / 1000).toString(16).padStart(8, "0") + randomBytes(8).toString("hex");
}

// ---------------------------------------------------------------------------
// 加密
// ---------------------------------------------------------------------------

function encryptBody(plaintext: string): { body: string; pin: string; ts: string } {
  const salt = randomBytes(8);
  const key = Buffer.from(BASE_KEY);
  for (let i = 0; i < 8; i++) key[i] ^= salt[i];
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(ts));
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final(), cipher.getAuthTag()]);
  return { body: Buffer.concat([nonce, ct]).toString("base64"), pin: salt.toString("hex"), ts };
}

const TRAE_RENDER_VARIABLES_TEMPLATE: Record<string, unknown> = {"agent_name": "SOLO Code", "agent_type": "solo_agent_lite", "enable_parallel_tool_calling": null, "is_in_chat_mode": null, "is_in_plan_v2": true, "finish_tool_name": "finish", "response_can_be_text": false, "native_function_call": null, "is_auto_mode": null, "powered_by": null, "date": "2026-08-19", "is_solo_mode": true, "is_scheduled_task": null, "user_timezone": "Asia/Shanghai", "workspace_folder": "C:\\Users\\Loong\\AppData\\Roaming\\TRAE SOLO CN\\ModularData\\ai-agent\\work-mode-projects\\6a8398788bf9cd78271fbe17", "workspace_folders": "C:\\Users\\Loong\\AppData\\Roaming\\TRAE SOLO CN\\ModularData\\ai-agent\\work-mode-projects\\6a8398788bf9cd78271fbe17", "workspace_rule": "", "global_rule": "", "left_turns": null, "text_to_image_url": "https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image", "enable_image_to_image": true, "enable_multi_agent_reader": null, "sub_agents": null, "parent_agent_instruction": null, "user_auto_run_prompt": null, "custom_agent_prompt": null, "is_use_npmmirror": "true", "system_type": "Windows", "locale": "zh-cn", "environment_context": "", "language_settings": "zh-cn", "os_version": "Windows 11 Pro", "available_commands": null, "blacklist_commands": "groupadd, groupdel, groupmod, ifdown, ifup, killall, lvremove, mount, passwd, pkill, pvremove, reboot, route, service, shutdown, su, sysctl, systemctl, umount, useradd, userdel, usermod, vgremove", "actived_environments": null, "supported_environments": null, "init_env_enabled": null, "has_terminal_info": null, "max_terminals_count": null, "available_terminals_count": null, "available_terminals": null, "terminal_shell_type": null, "project_memento": null, "project_memento_cut_length": null, "project_memento_origin_length": null, "project_memento_cut": null, "refresh_project_memento_mode": null, "shallow_memento_enabled": null, "memory_info": null, "project_chat_memory_folder": null, "chat_memory_folder": null, "project_id_for_chat_memory": null, "enable_chat_memory_with_history": null, "auto_review_enabled": null, "core_memory_enabled": null, "core_memories": null, "enable_todo_list": true, "empty_todo_list": true, "is_user_clear_todo_list": null, "is_not_updated_todo_list_recently": null, "current_time": "20260819 01:01:56, Wednesday, UTC+8", "current_filename": null, "brand": "TRAE SOLO", "mask_brand": null, "hash_workspace": null, "hash_code": null, "hash_file": null, "hash_folder": null, "is_command": false, "identifier": null, "is_inline_chat": false, "badge_clickable": true, "workspace_path": "C:\\Users\\Loong\\AppData\\Roaming\\TRAE SOLO CN\\ModularData\\ai-agent\\work-mode-projects\\6a8398788bf9cd78271fbe17", "file_path": null, "is_workspace_folder_changed": false, "is_worktree": false, "home_dir": "C:\\Users\\Loong", "unique_user_id": "539197102372180", "workspace_id": "57b436b4d58281c67f8f094565e41e02", "user_data_dir": "c:\\Users\\Loong\\.trae-cn", "skills_dir": null, "vm_session_base_dir": null, "work_dir": null, "upload_dir": null, "design_libraries_dir": null, "design_command_context": null, "refactor_mode": null, "refactor_custom_preference": null, "enable_terminal_tool": null, "enable_plan_mode": null, "enable_dynamic_ui": true, "language": null, "user_message_simplify": null, "use_session_context": null, "disable_prompt_selected_code": false, "selected_code": null, "channel": null, "comment_style": null, "is_line_comment": null, "raw_input": "运行 pwd 命令并输出结果", "input": "运行 pwd 命令并输出结果", "doc_type": null, "merging_process": null, "merge_source_branch": null, "merge_target_branch": null, "merge_changed_files": null, "merge_conflict_files": null, "sandbox_mode_enabled": "true", "sandbox_filesystem_config": "{\"writableDirectories\":[\"C:\\\\Users\\\\Loong\\\\AppData\\\\Roaming\\\\TRAE SOLO CN\\\\ModularData\\\\ai-agent\\\\work-mode-projects\\\\6a8398788bf9cd78271fbe17\",\"C:\\\\Users\\\\Loong\\\\.trae-cn\\\\memory\",\"c:\\\\Users\\\\Loong\\\\.trae-cn\\\\memory\",\"C:\\\\Users\\\\Loong\\\\.trae-cn\\\\builtin\\\\work\",\"c:\\\\Users\\\\Loong\\\\.trae-cn\\\\builtin\\\\work\",\"C:\\\\Users\\\\Loong\\\\AppData\\\\Roaming\\\\TRAE SOLO CN\\\\ModularData\\\\ai-agent\\\\hooks_env\",\"C:\\\\Users\\\\Loong\\\\AppData\\\\Roaming\\\\TRAE SOLO CN\\\\ModularData\\\\ai-agent\\\\vm\\\\tools\",\"C:\\\\Users\\\\Loong\\\\Library\\\\Caches\",\"C:\\\\Users\\\\Loong\\\\.cache\",\"C:\\\\Users\\\\Loong\\\\.local\\\\lib\",\"C:\\\\Users\\\\Loong\\\\.local\\\\bin\",\"C:\\\\Users\\\\Loong\\\\.local\\\\share\",\"C:\\\\Users\\\\Loong\\\\go\",\"C:\\\\Users\\\\Loong\\\\.gvm\",\"C:\\\\Users\\\\Loong\\\\Library\\\\Application Support\\\\go\",\"C:\\\\Users\\\\Loong\\\\.local\\\\share\\\\go\",\"C:\\\\Users\\\\Loong\\\\.m2\",\"C:\\\\Users\\\\Loong\\\\.gradle\",\"C:\\\\Users\\\\Loong\\\\.sdkman\",\"C:\\\\Users\\\\Loong\\\\miniconda3\",\"C:\\\\Users\\\\Loong\\\\.conda\",\"C:\\\\Users\\\\Loong\\\\.pyenv\",\"C:\\\\Users\\\\Loong\\\\Library\\\\Python\",\"C:\\\\Users\\\\Loong\\\\.npm\",\"C:\\\\Users\\\\Loong\\\\Library\\\\pnpm\",\"C:\\\\Users\\\\Loong\\\\.fnm\",\"C:\\\\Users\\\\Loong\\\\.nvm\",\"C:\\\\Users\\\\Loong\\\\.rustup\",\"C:\\\\Users\\\\Loong\\\\.cargo\",\"C:\\\\Users\\\\Loong\\\\.cmake\",\"C:\\\\Users\\\\Loong\\\\.llvm\",\"C:\\\\Users\\\\Loong\\\\.bazel\",\"C:\\\\Users\\\\Loong\\\\.gitlog\",\"C:\\\\Users\\\\Loong\\\\.docker\",\"C:\\\\Users\\\\Loong\\\\Library\\\\Logs\",\"C:\\\\Users\\\\Loong\\\\fvm\",\"C:\\\\Users\\\\Loong\\\\.swiftpm\",\"C:\\\\Users\\\\Loong\\\\.android\",\"C:\\\\Users\\\\Loong\\\\.oracle_jre_usage\",\"C:\\\\Users\\\\Loong\\\\.dart-tool\",\"C:\\\\Users\\\\Loong\\\\.pub-cache\",\"C:\\\\Users\\\\Loong\\\\Library\\\\flutter\",\"C:\\\\Users\\\\Loong\\\\Library\\\\Developer\\\\Xcode\",\"C:\\\\Users\\\\Loong\\\\.yarn\",\"C:\\\\Users\\\\Loong\\\\.foundry\",\"C:\\\\Users\\\\Loong\\\\.asdf\",\"C:\\\\Users\\\\Loong\\\\.jenv\",\"C:\\\\Users\\\\Loong\\\\.gem\",\"C:\\\\Users\\\\Loong\\\\.rvm\",\"C:\\\\Users\\\\Loong\\\\.rbenv\",\"C:\\\\Users\\\\Loong\\\\.bundle\",\"C:\\\\Users\\\\Loong\\\\.dotnet\",\"C:\\\\Users\\\\Loong\\\\.nuget\",\"C:\\\\Users\\\\Loong\\\\.sbt\",\"C:\\\\Users\\\\Loong\\\\.ivy2\",\"C:\\\\Users\\\\Loong\\\\.coursier\",\"C:\\\\Users\\\\Loong\\\\.hawtjni\",\"C:\\\\Users\\\\Loong\\\\.local\\\\state\\\\pnpm\",\"C:\\\\Users\\\\Loong\\\\.local\\\\state\\\\fnm_multishells\",\"C:\\\\Users\\\\Loong\\\\.webx\",\"C:\\\\Users\\\\Loong\\\\.bun\",\"C:\\\\Users\\\\Loong\\\\.bash_history\",\"C:\\\\Users\\\\Loong\\\\AppData\\\\Local\\\\go-build\",\"C:\\\\Users\\\\Loong\\\\AppData\\\\Local\\\\pip\",\"C:\\\\Users\\\\Loong\\\\AppData\\\\Roaming\\\\go\",\"C:\\\\Users\\\\Loong\\\\AppData\\\\Local\\\\conda\",\"C:\\\\Users\\\\Loong\\\\AppData\\\\Local\\\\uv\",\"C:\\\\Users\\\\Loong\\\\AppData\\\\Roaming\\\\uv\",\"C:\\\\Users\\\\Loong\\\\miniforge3\",\"C:\\\\Users\\\\Loong\\\\AppData\\\\Local\\\\npm-cache\",\"C:\\\\Users\\\\Loong\\\\AppData\\\\Local\\\\pnpm\",\"C:\\\\Users\\\\Loong\\\\AppData\\\\Local\\\\Yarn\",\"C:\\\\Users\\\\Loong\\\\AppData\\\\Local\\\\fnm_multishells\",\"C:\\\\Users\\\\Loong\\\\AppData\\\\Local\\\\Microsoft\\\\VSApplicationInsights\",\"C:\\\\Users\\\\Loong\\\\AppData\\\\Local\\\\Microsoft\\\\Windows\\\\INetCache\",\"C:\\\\ProgramData\\\\Microsoft\\\\NetFramework\\\\BreadcrumbStore\",\"C:\\\\Users\\\\Loong\\\\AppData\\\\Local\\\\NuGet\",\"C:\\\\Users\\\\Loong\\\\.templateengine\",\"C:\\\\Users\\\\Loong\\\\.matplotlib\",\"C:\\\\Users\\\\Loong\\\\AppData\\\\Local\\\\Microsoft\\\\PowerShell\",\"C:\\\\Users\\\\Loong\\\\AppData\\\\Local\\\\Microsoft\\\\Windows\\\\PowerShell\",\"C:\\\\Users\\\\Loong\\\\AppData\\\\Roaming\\\\.dart-tool\",\"C:\\\\Users\\\\Loong\\\\AppData\\\\Roaming\\\\.flutter\",\"C:\\\\Users\\\\Loong\\\\AppData\\\\Local\\\\Temp\",\"C:\\\\Users\\\\Loong\\\\AppData\\\\LocalLow\\\\Temp\",\"C:\\\\Users\\\\Loong\\\\.Trash\"],\"readOnlyDirectories\":[\"C:\\\\Users\\\\Loong\\\\AppData\\\\Roaming\\\\TRAE SOLO CN\\\\ModularData\\\\ai-agent\\\\work-mode-projects\\\\6a8398788bf9cd78271fbe17\\\\.vscode\"]}", "sandbox_network_config": null, "approvals_reviewer": "user", "ralph_loop_context": null, "goal_context": null, "wiki_repo_meta_info": null, "wiki_repo_id": null, "wiki_commit_id": null, "wiki_session_id": null, "current_commit_id": null, "diff_file_list": null, "diff_patch_path": null, "can_generate_workflow_in_main_process": null};

const TRAE_AVAILABLE_TOOL_LIST: string[] = [
  // 精简列表：只保留我们能映射到 Pi 工具的工具，去掉 Exec/浏览器/WebFetch/AskUserQuestion 等，
  // 避免服务端注入 Exec 组（“默认执行方式”）和模型调用无法映射的工具
  "RunCommand", "Read", "ReadFile", "ViewFile", "ViewFiles",
  "Write", "WriteFile", "CreateFile",
  "Edit", "EditFile", "UpdateFile", "EditFileFastApply", "SearchReplace",
  "SearchCodebase", "FileSearch", "SearchByRegex", "Grep",
  "ListDir", "LS", "Glob",
];

// ---------------------------------------------------------------------------
// 请求头（0.1.51，全部来自 Frida 抓取的真实值）
// ---------------------------------------------------------------------------

function buildHeaders(id: Identity, encrypted: { pin: string; ts: string }, refererUrl?: string): Record<string, string> {
  const rid = randomUUID();
  const tid = rid.replace(/-/g, "");
  return {
    accept: "*/*",
    "accept-encoding": "gzip, deflate, br, zstd",
    "accept-language": "zh-CN",
    "content-type": "application/json",
    referer: refererUrl ?? `${GATEWAY}/api/agent/v3/create_agent_task`,
    "request-traffic-type": "prod",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "no-cors",
    "sec-fetch-site": "none",
    "user-agent": "TraeClient/TTNet",
    "app-version": "0.1.51",
    "x-ahanet-timeout": "86400",
    "x-app-id": "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8",
    "x-app-version": "default",
    "x-app-version-code": "20260806",
    "x-bridge-transport": "aha",
    "x-custom-trace-id": tid,
    "x-device-brand": "MS-7C94",
    "x-device-cpu": "AMD",
    "x-device-id": id.deviceId,
    "x-device-type": "windows",
    "x-flow-traceparent": `04-${tid}-${randomUUID().replace(/-/g, "").slice(0, 16)}-01`,
    "x-ide-token": id.token,
    "x-ide-version": "0.1.51",
    "x-ide-version-code": "20260806",
    "x-ide-version-type": "stable",
    "x-machine-id": id.machineId,
    "x-os-version": "Windows 11 Pro",
    "package-type": "stable_cn",
    "x-request-pin": encrypted.pin,
    "x-requested-at": encrypted.ts,
    "x-request-id": `req_${rid}`,
    "x-trae-request-id": rid,
    "x-ttnet-bypass-decompression": "1",
    "x-net-sdk-domain-dispatch": "1",
    "x-ttnet-bypass-cookie": "0",
    "x-lscbd-aid": "787976",
    "x-lscbd-platform": "windows",
    "privacy_mode": "disabled",
  };
}

// ---------------------------------------------------------------------------
// SSE 解析（Node 侧解析完整响应）
// ---------------------------------------------------------------------------

function parseSSE(text: string): { event: string; data: string }[] {
  const events: { event: string; data: string }[] = [];
  let buf = text.replace(/\r\n/g, "\n");
  let idx: number;
  while ((idx = buf.indexOf("\n\n")) >= 0) {
    const raw = buf.slice(0, idx);
    buf = buf.slice(idx + 2);
    let event = "message";
    const dataLines: string[] = [];
    for (const line of raw.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length) events.push({ event, data: dataLines.join("\n") });
  }
  return events;
}

// ---------------------------------------------------------------------------
// streamSimple 用的小工具
// ---------------------------------------------------------------------------

function extractUserText(msg: Message): string {
  if (msg.role !== "user") return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((p) => (typeof p === "string" ? p : p.type === "text" ? p.text : ""))
      .join("");
  }
  return "";
}

// ---------------------------------------------------------------------------
// create_agent_task / commit_toolcall_result（客户端真实结构，支持工具调用）
// ---------------------------------------------------------------------------

function buildCreateBody(
  model: string,
  userInput: string,
  id: Identity,
  agentType: string,
  convState: { conversationId: string; historyIdList: string[] },
): string {
  const useAuto = model === "auto";
  const now = new Date();
  const curTime =
    now.toLocaleString("en-GB", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "long",
    }).replace(/,/g, "") + ", UTC+8";
  // Pi 侧实际执行工具的环境是 WSL/Linux bash（不是客户端抓包里的 Windows/PowerShell），
  // 所以把注入给 Trae 的环境描述改写成 Linux，否则模型会输出 PowerShell 语法（Get-ChildItem/Get-Location…）
  const workspace = env("TRAE_WORKSPACE") || "/root";
  const rv: Record<string, unknown> = {
    ...TRAE_RENDER_VARIABLES_TEMPLATE,
    input: userInput,
    raw_input: userInput,
    current_time: curTime,
    date: now.toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" }),
    os_version: env("TRAE_OS_VERSION") || "WSL2 (Ubuntu)",
    system_type: "Linux",
    terminal_shell_type: "bash",
    workspace_folder: workspace,
    workspace_folders: workspace,
    workspace_path: workspace,
    work_dir: workspace,
    home_dir: "/root",
    user_data_dir: "/root",
    skills_dir: null,
    sandbox_filesystem_config: null,
    sandbox_network_config: null,
    available_terminals: null,
    available_terminals_count: 0,
    max_terminals_count: 5,
    has_terminal_info: true,
    actived_environments: null,
    supported_environments: null,
    init_env_enabled: null,
    is_use_npmmirror: "false",
    locale: "zh-cn",
  };
  const body: Record<string, unknown> = {
    agent_id: null, tunnel_id: null, is_custom_model: false, provider: "",
    conversation_id: convState.conversationId, session_id: traeId(),
    plugin_channel: null, user_id: id.userId, device_id: id.deviceId,
    agent_type: agentType, config_name: useAuto ? "" : model, model_name: useAuto ? "" : model,
    ide_version: "0.1.51", config_source: 1,
    user_input: { id: traeId(), messages: [{ type: "text", text_content: userInput }] },
    history_id_list: convState.historyIdList, missing_history: null,
    available_tool_list: TRAE_AVAILABLE_TOOL_LIST, mcp_tool_name: {}, mcp_tool_list: [],
    render_context: { variables: JSON.stringify(rv) }, request_seq: 1, queue_id: null,
    custom_agent_list: [], agent_version: "v3", ab_info: null, mode_type: 2,
    custom_subagent_info: {},
    extra_config: { disable_parallel_agent: false, enable_todo_list: true, enable_core_memory: false,
      enable_init_command_user_config: false, enable_chat_memory_user_config: false,
      disable_exit_plan_mode_tool: true, visible_session_ids: null, hooks_configured: false },
    skill_list: [], skill_list_changed: false, agent_dsl: null, agent_static_dsl_name: "",
    access_type: 1, is_remote_req: false, mcp_folder_base_path: "",
    enable_decouple_model_extra_config: true, history_message_limit: 600,
    function: agentType, raw_rules: [],
    message_source: "manual", session_type: "side_chat", feishu_authorization_service_mode: "connector",
    is_im_group_chat: false,
    available_plugins: [
      { plugin_id: "trae-remote-official:browser", registry: "trae-remote-official",
        name: "trae-remote-official:browser", origin_plugin_name: "browser",
        display_name: "浏览器控制", description: "AI-driven built-in browser automation.",
        path: "c:\\Users\\Loong\\.trae-cn\\plugins\\trae-remote-official:browser",
        enabled: true, version: "0.0.1", builtin: true, is_browser_plugin: true },
    ],
    connector_list: [
      { name: "trae-remote-official:lark::feishu",
        description: "Feishu/Lark workflows for messaging, documents, spreadsheets, calendar, tasks, meetings, and enterprise collaboration.",
        status: "unauthorized" },
    ],
    cached_tool_groups: { [model]: ["integrated_code_mode", "integrated_goal"] },
    persist_meta: { smart_selection: { strategy: "max", fallback_to_advance_model: null, entitlement_id: null } },
  };
  if (useAuto) {
    body.mode_type = 1;
    body.cached_tool_groups = { "Doubao-Seed-Code": ["integrated_browser"] };
  }
  if (env("TRAE_DEBUG_BODY") === "1") {
    console.warn(`[trae-work] BODY ${JSON.stringify(body).slice(0, 3000)}`);
  }
  return JSON.stringify(body);
}

interface TraeToolCallResult {
  toolcallId: string;
  toolcallName: string;
  resp: string;
  status: "success" | "error";
}

function buildCommitBody(
  conversationId: string,
  taskId: string,
  agentRunId: string,
  results: TraeToolCallResult[],
): string {
  return JSON.stringify({
    conversation_id: conversationId,
    task_id: taskId,
    user_id: "2099393389932944",
    toolcall_results: results.map((r) => ({
      agent_run_id: agentRunId,
      toolcall_id: r.toolcallId,
      toolcall_name: r.toolcallName,
      toolcall_resp: r.resp,
      toolcall_status: r.status,
      toolcall_error_message: r.status === "error" ? r.resp : "",
      is_truncated: null,
    })),
    extra_context: null,
    request_seq: 1,
    queue_id: null,
    access_type: 1,
    is_remote_req: false,
  });
}

interface TraeToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

interface TraeResponse {
  text: string;
  reasoning: string;
  usage: TraeUsage;
  seenEvents: string[];
  toolCalls: TraeToolCall[];
  historyIdList: string[];
  conversationId: string;
  taskId: string | null;
  agentRunId: string | null;
  taskComplete: boolean;
  apiError?: string;
}

function parseTraeResponse(responseText: string, onQueue?: (q: { phase: "waiting" | "running"; raw: string }) => void): TraeResponse {
  const out: TraeResponse = {
    text: "",
    reasoning: "",
    usage: { input: 0, output: 0, reasoning: 0, total: 0 },
    seenEvents: [],
    toolCalls: [],
    historyIdList: [],
    conversationId: "",
    taskId: null,
    agentRunId: null,
    taskComplete: false,
  };
  const events = parseSSE(responseText);
  for (const ev of events) {
    out.seenEvents.push(ev.event);
    if (ev.event === "queue_begin" || ev.event === "request_wait_in_queue") {
      onQueue?.({ phase: "waiting", raw: ev.data });
    } else if (ev.event === "queue_end") {
      onQueue?.({ phase: "running", raw: ev.data });
    } else if (ev.event === "task_created") {
      try {
        const o = JSON.parse(ev.data);
        if (o?.task_id) out.taskId = String(o.task_id);
        if (o?.agent_run_id) out.agentRunId = String(o.agent_run_id);
      } catch { /* 忽略 */ }
    } else if (ev.event === "history") {
      try {
        let o: any = JSON.parse(ev.data);
        if (typeof o === "string") o = JSON.parse(o);
        const hd = o?.history_data;
        const hid = hd?.history_id;
        if (hid) out.historyIdList.push(String(hid));
        if (hd?.conversation_id) out.conversationId = String(hd.conversation_id);
        if (o?.task_id) out.taskId = String(o.task_id);
        if (o?.agent_run_id) out.agentRunId = String(o.agent_run_id);
        // 权威工具调用（完整参数）在 history 的 assistant tool_calls 里
        if (hd?.messages) {
          const m = typeof hd.messages === "string" ? JSON.parse(hd.messages) : hd.messages;
          for (const rm of m?.raw_messages || []) {
            if (rm.role === "assistant" && Array.isArray(rm.tool_calls)) {
              for (const tc of rm.tool_calls) {
                const fn = tc?.function_call || {};
                if (fn.name) {
                  let args: unknown = fn.arguments;
                  if (typeof args === "string") {
                    try { args = JSON.parse(args); } catch { /* 保持字符串 */ }
                  }
                  const id = tc?.id || fn.id;
                  if (id && typeof fn.name === "string") {
                    out.toolCalls.push({ id: String(id), name: String(fn.name), arguments: (args && typeof args === "object" ? args : {}) as Record<string, any> });
                  }
                }
              }
            }
          }
        }
        if (env("TRAE_DEBUG_HISTORY") === "1") {
          console.warn(`[trae-work] history ev hid=${hid} msgs=${JSON.stringify(hd?.messages).slice(0, 2200)}`);
        }
      } catch {
        /* 单条解析失败忽略 */
      }
    } else if (ev.event === "thought" || ev.event === "output") {
      try {
        const o = JSON.parse(ev.data);
        if (o.thought) out.text += o.thought;
        else if (o.response) out.text += o.response;
        if (o.reasoning_content) out.reasoning += o.reasoning_content;
      } catch {
        /* 单条事件解析失败不影响其它事件 */
      }
    } else if (ev.event === "error") {
      let o: any;
      try { o = JSON.parse(ev.data); } catch { continue; }
      if (o?.code === 1001) throw new Error("Trae auth failed (1001): token expired, refresh with refresh_token.py");
      out.apiError = `Trae API error: ${o?.message || ev.data.slice(0, 200)}`;
      if (o?.message) console.warn(`[trae-work] api error detail: ${o.message}`);
    } else if (ev.event === "token_usage") {
      try {
        const u = JSON.parse(ev.data);
        out.usage = {
          input: u.prompt_tokens || 0,
          output: u.completion_tokens || 0,
          reasoning: u.reasoning_tokens || 0,
          total: u.total_tokens || 0,
        };
      } catch { /* 忽略 */ }
    } else if (ev.event === "turn_completion") {
      try {
        const o = JSON.parse(ev.data);
        if (o?.agent_run_id) out.agentRunId = String(o.agent_run_id);
        if (o?.task_id) out.taskId = String(o.task_id);
        out.taskComplete = o?.task_completion === true;
      } catch { /* 忽略 */ }
    }
  }
  // 兑底：只返回了推理内容时当文本返回
  if (!out.text && out.reasoning) out.text = out.reasoning;
  return out;
}

/** 发一个加密 POST（create/commit），返回 SSE 全文。 */
async function postTrae(
  url: string,
  id: Identity,
  plaintext: string,
  signal?: AbortSignal,
  onQueue?: (q: { phase: "waiting" | "running"; raw: string }) => void,
): Promise<{ status: number; responseText: string }> {
  const encrypted = encryptBody(plaintext);
  const headers = buildHeaders(id, encrypted, url);
  if (env("TRAE_NO_BROWSER") !== "1") {
    const resp = await traeFetch(url, headers, encrypted.body, signal, (ev) => {
      if (ev.event === "queue_begin" || ev.event === "request_wait_in_queue") onQueue?.({ phase: "waiting", raw: ev.data });
      else if (ev.event === "queue_end") onQueue?.({ phase: "running", raw: ev.data });
    });
    return { status: resp.status, responseText: resp.body };
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const resp = await fetch(url, { method: "POST", headers, body: encrypted.body, signal: controller.signal });
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let packet = "";
    let responseText = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      responseText += chunk;
      packet += chunk;
      packet = packet.replace(/\r\n/g, "\n");
      let idx: number;
      while ((idx = packet.indexOf("\n\n")) >= 0) {
        const block = packet.slice(0, idx);
        packet = packet.slice(idx + 2);
        let ev: string | null = null;
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) ev = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (ev === "queue_begin" || ev === "request_wait_in_queue") onQueue?.({ phase: "waiting", raw: data });
        else if (ev === "queue_end") onQueue?.({ phase: "running", raw: data });
      }
    }
    responseText += decoder.decode();
    return { status: resp.status, responseText };
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

async function runTraeCreate(
  modelId: string,
  userInput: string,
  id: Identity,
  agentType: string,
  signal: AbortSignal | undefined,
  convState: { conversationId: string; historyIdList: string[] },
  onQueue?: (q: { phase: "waiting" | "running"; raw: string }) => void,
): Promise<TraeResponse> {
  const plaintext = buildCreateBody(modelId, userInput, id, agentType, convState);
  const { status, responseText } = await postTrae(`${GATEWAY}/api/agent/v3/create_agent_task`, id, plaintext, signal, onQueue);
  if (status !== 200) throw new Error(`Trae HTTP ${status}: ${responseText.slice(0, 200)}`);
  return parseTraeResponse(responseText, onQueue);
}

async function runTraeCommit(
  convState: { conversationId: string; taskId: string; agentRunId: string },
  results: TraeToolCallResult[],
  id: Identity,
  signal: AbortSignal | undefined,
  onQueue?: (q: { phase: "waiting" | "running"; raw: string }) => void,
): Promise<TraeResponse> {
  const plaintext = buildCommitBody(convState.conversationId, convState.taskId, convState.agentRunId, results);
  const { status, responseText } = await postTrae(`${GATEWAY}/api/agent/v3/commit_toolcall_result`, id, plaintext, signal, onQueue);
  if (status !== 200) throw new Error(`Trae HTTP ${status}: ${responseText.slice(0, 200)}`);
  return parseTraeResponse(responseText, onQueue);
}

/** shell 单引号转义 */
function shQuote(s: unknown): string {
  const str = String(s ?? "");
  return `'${str.replace(/'/g, "'\\''")}'`;
}

/**
 * Trae 工具名 → Pi 工具名/参数映射。
 * 优先映射到 Pi 原生工具（read/bash/write/edit/grep/ls）；
 * 若该工具在 Pi 当前会话未启用（不在当前工具集里，如默认只开 read/bash/edit/write），
 * 则回退成 bash 子命令（rg/ls/cat…），保证模型能真正执行而不是收到 “Tool not found”。
 */
function mapTraeToolCall(tc: TraeToolCall, available: Set<string>): { name: string; arguments: Record<string, any> } {
  const a = tc.arguments || {};
  const has = (n: string) => available.has(n);
  const path = a.path ?? a.file_path ?? a.file ?? ".";
  switch (tc.name) {
    case "RunCommand":
      return { name: "bash", arguments: { command: a.command ?? a.cmd ?? "", timeout: a.timeout ?? undefined } };
    case "ReadFile":
    case "ViewFile":
    case "ViewFiles":
    case "Read":
      if (has("read")) return { name: "read", arguments: { path, offset: a.offset, limit: a.limit } };
      if (has("bash")) return { name: "bash", arguments: { command: `cat ${shQuote(path)}` } };
      return { name: tc.name, arguments: a };
    case "WriteFile":
    case "CreateFile":
    case "Write":
      if (has("write")) return { name: "write", arguments: { path, content: a.content ?? a.text ?? "" } };
      if (has("bash")) {
        const content = String(a.content ?? a.text ?? "");
        return { name: "bash", arguments: { command: `cat > ${shQuote(path)} <<'TRAE_EOF'\n${content}\nTRAE_EOF` } };
      }
      return { name: tc.name, arguments: a };
    case "EditFile":
    case "UpdateFile":
    case "EditFileFastApply":
    case "Edit":
    case "SearchReplace":
      if (has("edit")) {
        return { name: "edit", arguments: { path, content: a.content ?? a.new_content ?? a.newText ?? "", oldText: a.old_content ?? a.old_text ?? a.oldText } };
      }
      return { name: tc.name, arguments: a };
    case "SearchCodebase":
    case "FileSearch":
    case "SearchByRegex":
    case "Grep": {
      const pattern = a.query ?? a.pattern ?? a.regex ?? "";
      if (has("grep")) return { name: "grep", arguments: { pattern, path } };
      if (has("bash")) {
        const pathArg = (a.path ?? a.file_path) ? ` ${shQuote(path)}` : "";
        return { name: "bash", arguments: { command: `rg -n --no-heading ${shQuote(pattern)}${pathArg} 2>/dev/null || grep -rn ${shQuote(pattern)}${pathArg} 2>/dev/null | head -200` } };
      }
      return { name: tc.name, arguments: a };
    }
    case "ListDir":
    case "LS":
      if (has("ls")) return { name: "ls", arguments: { path } };
      if (has("bash")) return { name: "bash", arguments: { command: `ls -la ${shQuote(path)}` } };
      return { name: tc.name, arguments: a };
    case "Glob":
      if (has("bash")) return { name: "bash", arguments: { command: `find . -path ${shQuote(a.pattern ?? "*")} -print 2>/dev/null | head -200` } };
      return { name: tc.name, arguments: a };
    default:
      return { name: tc.name, arguments: a };
  }
}

// ---------------------------------------------------------------------------
// 会话状态：create/commit 工具循环 + 跨轮会话
// ---------------------------------------------------------------------------

interface TraeSessionState {
  conversationId: string;
  sessionId: string;
  historyIdList: string[];
  taskId: string | null;
  agentRunId: string | null;
  awaitingCommit: boolean;
  emittedToolCalls: Map<string, string>; // Pi toolcall id -> Trae tool_name
}

let traeSession: TraeSessionState | null = null;

function newSessionState(): TraeSessionState {
  return {
    conversationId: traeId(),
    sessionId: traeId(),
    historyIdList: [],
    taskId: null,
    agentRunId: null,
    awaitingCommit: false,
    emittedToolCalls: new Map(),
  };
}

function updateSessionFromResponse(s: TraeSessionState, r: TraeResponse): void {
  for (const hid of r.historyIdList) {
    if (!s.historyIdList.includes(hid)) s.historyIdList.push(hid);
  }
  if (r.conversationId) s.conversationId = r.conversationId;
  if (r.taskId) s.taskId = r.taskId;
  if (r.agentRunId) s.agentRunId = r.agentRunId;
}

function streamTraeChat(
  model: Model<string>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  (async () => {
    try {
      // 认证优先级：auth.json（options.apiKey）→ TRAE_IDE_TOKEN env → token 桥
      const resolved = await resolveToken(options?.apiKey || env("TRAE_IDE_TOKEN") || "");
      const token = resolved.token;
      if (resolved.note) console.warn(`[trae-work] ${resolved.note}`);
      if (!token) throw new Error("Missing Trae token (check /root/.pi/agent/auth.json \"trae-work\".key, or run refresh_token.py / token_bridge.py)");
      const id = resolveIdentity(token);
      const agentType = env("TRAE_AGENT_TYPE") || "solo_agent_lite";

      // 排队状态实时可见（thinking 折叠区）：queue 事件 -> thinking 文本
      let streamStarted = false;
      const startStream = () => {
        if (streamStarted) return;
        streamStarted = true;
        // Pi 事件流约定：start 必须先于任何 thinking/text/toolcall 增量，否则 agent-loop 会丢弃
        stream.push({ type: "start", partial: makeAssistant("") });
      };
      let queueNotice = "";
      let queueLines: string[] = [];
      let queueNotified = false;
      let queueEndNotified = false;
      const onQueue = (q: { phase: "waiting" | "running"; raw: string }) => {
        if (!streamStarted) startStream();
        if (q.phase === "waiting") {
          if (env("TRAE_DEBUG_HISTORY") === "1") console.warn(`[trae-work] queue_begin raw=${q.raw.slice(0, 300)}`);
          let pos = "";
          try {
            const o = JSON.parse(q.raw);
            pos = String(o?.queue_position ?? o?.position ?? o?.index ?? o?.data?.queue_position ?? o?.data?.position ?? "") || "";
          } catch { /* 结构未知则通用文案 */ }
          const text = pos ? `服务端排队中（第 ${pos} 位），请稍候…` : `服务端排队中，请稍候…`;
          if (!queueNotified) {
            queueNotified = true;
            queueNotice = text;
            queueLines = [text];
            try {
              stream.push({ type: "thinking_start", contentIndex: 0, partial: makeAssistant("", undefined, undefined, undefined, queueNotice) });
              stream.push({ type: "thinking_delta", contentIndex: 0, delta: queueNotice, partial: makeAssistant("", undefined, undefined, undefined, queueNotice) });
            } catch { /* 事件流已结束则忽略 */ }
          } else if (text !== queueNotice) {
            queueNotice = text;
            queueLines.push(text);
            const fullQueue = queueLines.join("\n");
            try {
              stream.push({ type: "thinking_delta", contentIndex: 0, delta: `\n${text}`, partial: makeAssistant("", undefined, undefined, undefined, fullQueue) });
            } catch { /* 忽略 */ }
          }
        } else {
          if (queueNotified && !queueEndNotified) {
            queueEndNotified = true;
            queueLines.push("已开始执行");
            const done = queueLines.join("\n");
            try {
              stream.push({ type: "thinking_delta", contentIndex: 0, delta: "已开始执行\n", partial: makeAssistant("", undefined, undefined, undefined, done) });
            } catch { /* 忽略 */ }
          }
        }
      };
      // 必须先发 start：让 Pi 建立 assistant 消息上下文
      startStream();

      // 判断本调用：提交上一轮的工具执行结果（context 末尾是 toolResult 且等待提交）
      const lastMsg = context.messages[context.messages.length - 1];
      const isCommitTurn = !!traeSession?.awaitingCommit && lastMsg?.role === "toolResult";

      let resp: TraeResponse;
      if (isCommitTurn && traeSession) {
        const results: TraeToolCallResult[] = [];
        for (const m of context.messages) {
          if (m.role !== "toolResult") continue;
          const traeName = traeSession.emittedToolCalls.get(m.toolCallId) ?? m.toolName;
          const text = contentText(m.content);
          results.push({
            toolcallId: m.toolCallId,
            toolcallName: traeName,
            resp: text || (m.isError ? "工具执行失败" : ""),
            status: m.isError ? "error" : "success",
          });
        }
        if (results.length === 0) throw new Error("Trae 工具结果缺失（没有收到 Pi 的工具执行结果）");
        if (!traeSession.taskId || !traeSession.agentRunId) throw new Error("Trae 会话状态缺失（taskId/agentRunId）");
        resp = await runTraeCommit(
          { conversationId: traeSession.conversationId, taskId: traeSession.taskId, agentRunId: traeSession.agentRunId },
          results,
          id,
          options?.signal,
          onQueue,
        );
        traeSession.emittedToolCalls.clear();
      } else {
        const userMessages = context.messages.filter((m) => m.role === "user");
        const lastUser = userMessages[userMessages.length - 1];
        const userInput = extractUserText(lastUser ?? ({ role: "user", content: "" } as Message));
        if (!userInput.trim()) throw new Error("empty user message");
        // 新用户轮次：复用已完成会话（conversation + history），或开新会话
        if (!traeSession || traeSession.awaitingCommit) traeSession = newSessionState();
        resp = await runTraeCreate(
          model.id,
          userInput,
          id,
          agentType,
          options?.signal,
          { conversationId: traeSession.conversationId, historyIdList: traeSession.historyIdList },
          onQueue,
        );
      }
      updateSessionFromResponse(traeSession, resp);
      if (resp.apiError) throw new Error(resp.apiError);

      // 工具调用：转成 Pi 的 toolcall 事件，等待 Pi 执行后下一轮 commit
      if (resp.toolCalls.length) {
        traeSession.awaitingCommit = true;
        // Pi 当前实际启用的工具集合（默认只有 read/bash/edit/write，可能没 grep/ls）
        const availablePiTools = new Set(getCurrentTools(context.messages).map((t) => t.name));
        const piCalls = resp.toolCalls.map((tc) => {
          const mapped = mapTraeToolCall(tc, availablePiTools);
          traeSession.emittedToolCalls.set(tc.id, tc.name);
          return { id: tc.id, name: mapped.name, arguments: mapped.arguments };
        });
        emitTraeMessage(stream, resp, piCalls, { queueNotified, queueEndNotified, queueLines, queueNotice, startStream });
        return;
      }

      traeSession.awaitingCommit = false;
      if (!resp.text) {
        const uniq = [...new Set(resp.seenEvents)].join(",");
        throw new Error(`Trae task returned no text output (events: ${uniq || "none"})`);
      }
      emitTraeMessage(stream, resp, [], { queueNotified, queueEndNotified, queueLines, queueNotice, startStream });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stream.push({ type: "error", reason: "error", error: makeAssistant(`trae-work error: ${msg}`, "error", msg) });
      stream.end(makeAssistant(`trae-work error: ${msg}`, "error", msg));
    }
  })();
  return stream;
}

interface EmitOptions {
  queueNotified: boolean;
  queueEndNotified: boolean;
  queueLines: string[];
  queueNotice: string;
  startStream: () => void;
}

/** 把 Trae 响应转成 Pi 事件流：start → thinking → text → toolcall → end */
function emitTraeMessage(
  stream: AssistantMessageEventStream,
  resp: TraeResponse,
  piCalls: { id: string; name: string; arguments: Record<string, any> }[],
  opts: EmitOptions,
): void {
  const hasReasoning = !!resp.reasoning;
  let queueBlock = "";
  if (opts.queueNotified) {
    queueBlock = opts.queueLines.length ? opts.queueLines.join("\n") : opts.queueNotice;
    if (!opts.queueEndNotified) queueBlock += "\n已开始执行";
  }
  const finalThinking = (queueBlock ? queueBlock + "\n" : "") + (resp.reasoning || "");

  const thinkIdx = hasReasoning || opts.queueNotified ? 0 : -1;
  const content: (TextContent | ThinkingContent | ToolCall)[] = [];
  if (thinkIdx >= 0) content[thinkIdx] = { type: "thinking", thinking: finalThinking || "" };
  let cursor = thinkIdx >= 0 ? 1 : 0;
  const textIdx = resp.text ? cursor++ : -1;
  if (textIdx >= 0) content[textIdx] = { type: "text", text: resp.text };
  const toolIdxs: number[] = [];
  for (const c of piCalls) {
    toolIdxs.push(cursor);
    content[cursor++] = { type: "toolCall", id: c.id, name: c.name, arguments: c.arguments };
  }
  const stopReason: AssistantMessage["stopReason"] = piCalls.length ? "toolUse" : "stop";
  const mk = (blocks: typeof content, reason: AssistantMessage["stopReason"] = stopReason) =>
    makeMessage(blocks, reason, undefined, resp.usage);
  const full = mk(content);

  if (thinkIdx >= 0) {
    if (!opts.queueNotified) {
      stream.push({ type: "thinking_start", contentIndex: thinkIdx, partial: mk(content) });
      stream.push({ type: "thinking_delta", contentIndex: thinkIdx, delta: finalThinking || "", partial: mk(content) });
    } else {
      if (!opts.queueEndNotified) {
        stream.push({ type: "thinking_delta", contentIndex: thinkIdx, delta: "已开始执行\n", partial: mk(content) });
      }
      if (resp.reasoning) {
        stream.push({ type: "thinking_delta", contentIndex: thinkIdx, delta: resp.reasoning, partial: mk(content) });
      }
    }
    stream.push({ type: "thinking_end", contentIndex: thinkIdx, content: finalThinking || " ", partial: mk(content) });
  }
  if (textIdx >= 0) {
    stream.push({ type: "text_start", contentIndex: textIdx, partial: mk(content) });
    stream.push({ type: "text_delta", contentIndex: textIdx, delta: resp.text, partial: mk(content) });
    stream.push({ type: "text_end", contentIndex: textIdx, content: resp.text, partial: mk(content) });
  }
  for (const i of toolIdxs) {
    const tc = content[i] as ToolCall;
    const argsJson = JSON.stringify(tc.arguments);
    const startContent = content.map((b) => (b === content[i] ? { ...b, arguments: {} } : b));
    stream.push({ type: "toolcall_start", contentIndex: i, partial: mk(startContent) });
    stream.push({ type: "toolcall_delta", contentIndex: i, delta: argsJson, partial: mk(content) });
    stream.push({ type: "toolcall_end", contentIndex: i, toolCall: tc, partial: mk(content) });
  }
  stream.end(full);
}

// 模型目录（2026-08-18 客户端实测：AhaNet_fetch 明文抓包 create_agent_task 请求体）
//
// 三个模型均为 Trae Work 客户端内置模型（is_preset=true, config_source=1），
// config_name / model_name 为客户端真实发送的配置名（本插件直发同样名称）：
//   - GLM-5.3（专属补贴 0.40x）        → "glm-5.3"（小写）
//   - DeepSeek-V4-Flash 正式版（0.08x）→ "DeepSeek-V4-Flash-Official"（大小写敏感）
//   - Qwen3.8-Max（1.50x）            → "qwen3.8-max"（小写；拼错/大小写不对会 4001）
//
// 客户端请求体 model_info（三模型一致，Max 开关前后不变）：
//   - prompt_max_tokens: 936000（≈0.936M 上下文，非平台老配置 API 的 168000）
//   - max_tokens: 64000（输出上限；平台老配置 API 的 32000 已过时）
//   - 无任何推理等级/effort 字段；UI 的 "Max" = persist_meta.smart_selection.strategy
//     （manual ↔ max），是客户端的智能选择策略，协议层不发送推理等级参数。
// 网关实测不强制 936K——输入更宽松，故 contextWindow 默认 936_000（TRAE_CONTEXT_WINDOW 可覆盖）。
// ---------------------------------------------------------------------------

const TRAE_CONTEXT_WINDOW = Number(env("TRAE_CONTEXT_WINDOW")) || 936_000;
const TRAE_MAX_TOKENS = Number(env("TRAE_MAX_TOKENS")) || 64000;

// 思考等级：Trae 协议无推理等级；唯一档位 = smart_selection.strategy "max"，
// 故只开放 max，其余等级置 null（Pi 会隐藏/跳过）。
const THINKING_MAP_MAX = {
  off: null,
  minimal: null,
  low: null,
  medium: null,
  high: null,
  xhigh: null,
  max: "max",
} as const;

const TRAE_MODELS = [
  {
    id: "glm-5.3",
    name: "GLM 5.3 (Trae Work)",
    reasoning: true,
    thinkingLevelMap: THINKING_MAP_MAX,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: TRAE_CONTEXT_WINDOW,
    maxTokens: TRAE_MAX_TOKENS,
  },
  {
    id: "DeepSeek-V4-Flash-Official",
    name: "DeepSeek V4 Flash 正式版 (Trae Work)",
    reasoning: true,
    thinkingLevelMap: THINKING_MAP_MAX,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: TRAE_CONTEXT_WINDOW,
    maxTokens: TRAE_MAX_TOKENS,
  },
  {
    id: "qwen3.8-max",
    name: "Qwen3.8 Max (Trae Work)",
    reasoning: true,
    thinkingLevelMap: THINKING_MAP_MAX,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: TRAE_CONTEXT_WINDOW,
    maxTokens: TRAE_MAX_TOKENS,
  },
];

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

export default function traeWorkExtension(pi: ExtensionAPI): void {
  pi.registerProvider(TRAE_WORK_PROVIDER_ID, {
    name: "Trae Work (Built-in LLM)",
    baseUrl: GATEWAY,
    api: "trae-work",
    apiKey: "$TRAE_IDE_TOKEN",
    streamSimple: streamTraeChat as (model: Model<string>, context: TranscriptContext, options?: SimpleStreamOptions) => AssistantMessageEventStream,
    models: TRAE_MODELS,
  });
}

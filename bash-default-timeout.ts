/**
 * Bash Default Timeout Extension v2
 *
 * 强制给 bash/powershell 工具添加默认 60s 超时。
 * - 模型未传 timeout -> 自动补 60s 并 kill
 * - 已传则保留原值
 * - TUI 上也会显示 (timeout 60s)，解决“补丁在渲染之后”导致不显示的问题
 *
 * 安装位置: ~/.pi/agent/extensions/bash-default-timeout.ts
 * 生效: 重启 pi 或在 TUI 输入 /reload
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, createPowerShellToolDefinition } from "@earendil-works/pi-coding-agent";

const DEFAULT_TIMEOUT_SECONDS = 60;

export default function (pi: ExtensionAPI) {
  // 1) 兜底：通过 tool_call 直接改参数，保证执行时有 timeout（对所有注册的工具生效）
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash" && event.toolName !== "powershell") return;
    const input = event.input as { timeout?: number };
    if (input.timeout == null) {
      input.timeout = DEFAULT_TIMEOUT_SECONDS;
    }
  });

  // 2) 修复 TUI 显示：覆盖内置工具的 renderCall/execute，让未传 timeout 时也显示 60s
  //    原理：TUI 的 ToolExecutionComponent 在 tool_execution_start（早于 tool_call）时就渲染了，
  //    那时 args 还是原始值。直接改 input 无法回溯更新 UI，只能让 renderCall 在渲染时默认显示 60。
  const cwd = process.cwd();
  const defs = [createBashToolDefinition(cwd), createPowerShellToolDefinition(cwd)];

  for (const def of defs) {
    const origExecute = def.execute.bind(def);
    const origRenderCall = def.renderCall?.bind(def);

    pi.registerTool({
      ...def,
      // 执行层再兜一次，防止绕过 tool_call 的路径
      execute: async (toolCallId, params: any, signal, onUpdate, ctx) => {
        if (params.timeout == null) params.timeout = DEFAULT_TIMEOUT_SECONDS;
        return origExecute(toolCallId, params, signal, onUpdate, ctx as any);
      },
      // 渲染层：未传时按 60 显示
      renderCall: origRenderCall
        ? (((args: any, theme: any, context: any) => {
            const patched = { ...args, timeout: args.timeout ?? DEFAULT_TIMEOUT_SECONDS };
            return origRenderCall(patched, theme, context);
          }) as any)
        : undefined,
    });
  }
}

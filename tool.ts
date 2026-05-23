/**
 * 替换 bash 工具描述中的 (ls, grep, find, etc.) 为 (ls, rg for text search, fd for file search, etc.)
 *
 * 安装: cp tool.ts ~/.pi/agent/extensions/tool.ts
 * 然后重启 pi 或 /reload
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    const prompt = event.systemPrompt.replace(
      "Execute bash commands (ls, grep, find, etc.)",
      "Execute bash commands (ls, rg for text search, fd for file search, etc.)",
    );

    if (prompt !== event.systemPrompt) {
      return { systemPrompt: prompt };
    }
  });
}

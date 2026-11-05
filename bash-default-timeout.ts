/**
 * Bash Default Timeout Extension v3
 *
 * pi 的 bash / powershell 工具**没有**默认超时：schema 原文是
 * `Timeout in seconds (optional, no default timeout)`，而 `resolveTimeoutMs(undefined)`
 * 返回 undefined，一个 timer 都不会 arm。模型漏传 timeout，命令就把这次 tool call
 * 无限期挂住，除了 Esc 没有恢复路径。
 *
 * 这层兜底补三件事：
 *
 * 1. **缺失 → 注入默认值**：60s；`install` / `build` / `test` 这类已知长命令给
 *    600s，免得把 `npm install`、`cargo build` 砍在自己手里。
 * 2. **单位纠偏**：模型常按毫秒传。pi 的上限是 2^31-1 ms ≈ 24.8 天，所以
 *    `timeout: 180000` 不是 3 分钟，是 **50 小时**（earendil-works/pi#9785、
 *    #8857）。这里把「> 3600 且是 1000 的整数倍」的值当毫秒换算，再把结果夹到
 *    PI_BASH_MAX_TIMEOUT_SECONDS：宁可早超时（结果里写明秒数，模型能重试），
 *    也不要静默挂几小时。`PI_BASH_NO_MS_HEURISTIC=1` 可关掉这套猜测。
 * 3. **提示对齐**：内置文案写着 "no default timeout"，模型读到的规则和实际行为
 *    相反，会自己乱传值。所以改写参数的 description 并追加一条 prompt guideline。
 *
 * TUI 的 `(timeout 60s)` 只能靠覆盖 `renderCall` 补：pi 在 `tool_execution_start`
 * 就渲染这次调用了，那是 `tool_call` 之前，直接改 input 追不回已经画出来的帧。
 *
 * 作用范围：`tool_call` 钩子覆盖所有路径（含 codemode / 子代理的 nested 调用，
 * 它们走同一条 beforeToolCall）。用户自己敲的 `!command` 走 user_bash，不经过
 * bash 工具，不会被这个插件砍掉。
 *
 * 安装位置: ~/.pi/agent/extensions/bash-default-timeout.ts
 * 生效: 重启 pi 或在 TUI 输入 /reload
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, createPowerShellToolDefinition } from "@earendil-works/pi-coding-agent";

const SHELL_TOOL_NAMES = new Set(["bash", "powershell"]);

// ── 策略（可用环境变量覆盖） ────────────────────────────────────────────────

function readPositiveIntEnv(name: string, fallback: number): number {
	const raw = process.env[name]?.trim();
	if (!raw) return fallback;
	const value = Number(raw);
	return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

/** 模型没传 timeout 时的兜底秒数。 */
const DEFAULT_TIMEOUT_SECONDS = readPositiveIntEnv("PI_BASH_TIMEOUT_SECONDS", 60);
/** 已知长命令（安装依赖、编译、跑测试）的兜底秒数。 */
const LONG_TIMEOUT_SECONDS = Math.max(
	readPositiveIntEnv("PI_BASH_LONG_TIMEOUT_SECONDS", 600),
	DEFAULT_TIMEOUT_SECONDS,
);
/** 任何来源的 timeout 都不会超过这个上限，防止「毫秒当秒」变成几小时的静默等待。 */
const MAX_TIMEOUT_SECONDS = Math.max(
	readPositiveIntEnv("PI_BASH_MAX_TIMEOUT_SECONDS", 7200),
	LONG_TIMEOUT_SECONDS,
);
/**
 * 超过这个秒数、且是 1000 整数倍的值，几乎一定是毫秒（`5000`、`180000`、`300000`）。
 * 刻意要 1 小时以上的调用会传 3600 这种非整数倍写法，不受影响。
 */
const MILLISECOND_SUSPICION_SECONDS = 3600;
const MILLISECOND_HEURISTIC = !process.env.PI_BASH_NO_MS_HEURISTIC;

/**
 * 那些「正常也要跑几分钟」的命令。命中就走 LONG_TIMEOUT_SECONDS。
 * 故意不匹配 `npm run dev` 这类常驻进程：它们本来就该在默认值上被砍。
 */
const LONG_RUNNING_COMMAND = new RegExp(
	[
		String.raw`\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|ci|add|update|create)\b`,
		String.raw`\b(?:pip3?|uv|poetry|pipx)\s+(?:install|sync|lock|add)\b`,
		String.raw`\b(?:cargo|go|mvn|gradlew|gradle|dotnet|make|cmake|ninja|meson)\b`,
		String.raw`\b(?:tsc|tsdown|vite|webpack|esbuild|rollup|turbo|nx)\b`,
		String.raw`\b(?:pytest|tox|nox|jest|vitest|playwright|cypress)\b`,
		String.raw`\bdocker\s+(?:build|pull|compose)\b`,
		String.raw`\bgit\s+(?:clone|fetch|pull|submodule)\b`,
		String.raw`\b(?:apt|apt-get|dnf|yum|brew|pacman|apk)\s+(?:install|upgrade)\b`,
	].join("|"),
	"i",
);

function defaultTimeoutSeconds(command: unknown): number {
	if (typeof command === "string" && LONG_RUNNING_COMMAND.test(command)) {
		return LONG_TIMEOUT_SECONDS;
	}
	return DEFAULT_TIMEOUT_SECONDS;
}

/**
 * 把任意来源的 `timeout` 归一成一个「本次调用真正会生效」的秒数。
 * 幂等：对已经归一过的值再跑一次结果不变（renderCall 每帧都会调它）。
 */
export function resolveShellTimeout(timeout: unknown, command: unknown): number {
	let seconds = typeof timeout === "number" && Number.isFinite(timeout) ? timeout : Number.NaN;
	if (!Number.isFinite(seconds) || seconds <= 0) {
		return defaultTimeoutSeconds(command);
	}
	if (MILLISECOND_HEURISTIC && seconds > MILLISECOND_SUSPICION_SECONDS && seconds % 1000 === 0) {
		seconds /= 1000;
	}
	return Math.min(Math.max(Math.round(seconds), 1), MAX_TIMEOUT_SECONDS);
}

// ── schema 文案 ─────────────────────────────────────────────────────────────

const TIMEOUT_DESCRIPTION =
	`Timeout in seconds. Omitted means ${DEFAULT_TIMEOUT_SECONDS}s ` +
	`(${LONG_TIMEOUT_SECONDS}s for installs, builds and test runs); ` +
	`capped at ${MAX_TIMEOUT_SECONDS}s. Values above ${MILLISECOND_SUSPICION_SECONDS} that are ` +
	"multiples of 1000 are read as milliseconds. Set a larger value for commands you know run long.";

type MutableSchema = { properties?: Record<string, Record<string, unknown>> };

/** 只改 `timeout` 的描述，其余 schema 原样保留（含 required 等字段）。 */
function withTimeoutDescription<T>(parameters: T): T {
	const schema = parameters as MutableSchema;
	const timeout = schema?.properties?.timeout;
	if (!timeout) return parameters;
	return {
		...schema,
		properties: { ...schema.properties, timeout: { ...timeout, description: TIMEOUT_DESCRIPTION } },
	} as unknown as T;
}

// ── 工具包装 ───────────────────────────────────────────────────────────────

const TIMEOUT_GUIDELINE =
	`Shell commands always have a deadline: an omitted timeout means ${DEFAULT_TIMEOUT_SECONDS}s ` +
	`(${LONG_TIMEOUT_SECONDS}s for installs, builds, test runs), capped at ${MAX_TIMEOUT_SECONDS}s. ` +
	"Pass an explicit timeout in seconds for commands that legitimately run longer.";

function patchTool<T extends ToolDefinition<any, any, any>>(def: T): T {
	const origExecute = def.execute.bind(def);
	const origRenderCall = def.renderCall?.bind(def);

	return {
		...def,
		parameters: withTimeoutDescription(def.parameters),
		promptGuidelines: [...(def.promptGuidelines ?? []), TIMEOUT_GUIDELINE],
		// 执行层兜一次（tool_call 已经改过，这里是幂等的二次保险）。
		execute: (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) => {
			params.timeout = resolveShellTimeout(params?.timeout, params?.command);
			return origExecute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall: origRenderCall
			? (args: any, theme: any, context: any) =>
					origRenderCall(
						{ ...args, timeout: resolveShellTimeout(args?.timeout, args?.command) },
						theme,
						context,
					)
			: undefined,
	} as T;
}

export default function (pi: ExtensionAPI) {
	// 1) 强制注入：所有路径（含 nested / codemode）都会经过这里。
	pi.on("tool_call", async (event) => {
		if (!SHELL_TOOL_NAMES.has(event.toolName)) return;
		const input = event.input as { command?: unknown; timeout?: unknown };
		input.timeout = resolveShellTimeout(input.timeout, input.command);
	});

	// 2) 覆盖内置定义：改 schema 文案 + 让 TUI 立刻显示将生效的超时。
	//    powershell 只在 Windows 注册——在 Linux/macOS 上注册它会把一个本不该出现的
	//    工具塞进模型的可调用列表。
	const cwd = process.cwd();
	const definitions: ToolDefinition<any, any, any>[] = [patchTool(createBashToolDefinition(cwd))];
	if (process.platform === "win32") {
		definitions.push(patchTool(createPowerShellToolDefinition(cwd)));
	}
	for (const definition of definitions) {
		pi.registerTool(definition);
	}
}

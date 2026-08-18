/**
 *   对话首轮（会话的第一个 agent run）：system prompt 只保留 RL 训练句
 *     「You are a helpful software engineer assistant.」——身份/规则/技能引导
 *     全部不注入；工具面收窄为 pi 内置的 read + bash 两个工具，模型以
 *     「读文件 + 跑命令」的 RL 形状建立对任务的感知与计划（think-act 中
 *     的 think 段）。
 *
 *   首轮用户输入在 input 层被 transform：推理格式锚点「Reasoning in
 *   English starts with 'we need'.」直接把此追加到输入文本末尾，作为
 *   这条用户消息的一部分——TUI 显示、会话持久化、LLM 上下文三处天然
 *   一致，无需任何特殊渲染或判断。
 *
 *   首轮模型一旦有正文输出或工具调用（message_start / tool_execution_start），
 *   system prompt 与工具面立即恢复默认（完整工具目录），模型进入正常执行
 *   阶段（act 段）——不等下一条 user message。
 *
 * ── 为什么在 agent-loop 层做（不在 before_provider_request 层）─────────────
 *   payload 层改写只对走标准 SDK 的调用生效；自定义 provider / 直连
 *   streamSimple 的调用无法拦截，行为不一致。本插件只使用 coding-agent 的
 *   扩展 API（before_agent_start / setActiveTools / getActiveTools），在
 *   agent 状态层面控制 systemPrompt 与 tools——任何 provider（含自定义）
 *   的调用都看到同一套 agent 状态，拦截点对所有调用一致。
 *
 * ── 状态语义（对话首轮，与模型切换的边界）────────────────────────────────
 *   判定权威信号 =「会话中是否已有 assistant 消息」（对话是否已进行过），
 *   每次 run 前用会话历史实时校正，内存 stage 只作中间态记账：
 *
 *   stage 0 → 对话首轮（无任何 assistant 历史）：仅当当前模型为目标模型
 *             才 bare（RL 句 + 工具收窄 read/bash）；模型不匹配则不动，
 *             留待下次 run 的历史校正推进。
 *   stage 1 → 首轮已 bare：**不等下一条 user message**——首轮 assistant 一有
 *             正文输出或工具调用（message_start / tool_execution_start）就
 *             立即恢复。pi 0.84.2 的 setActiveTools 会无条件重建 base prompt
 *             并写回 agent.state（无 override 锁），因此一次调用即同时恢复
 *             完整 system prompt 与完整工具；对 run 内下一次 LLM 调用
 *             （如 tool 执行完后的继续调用）即生效。
 *   stage 2 → 不再干预。
 *
 *   切换模型等场景：只要会话已产生过 assistant 消息（无论哪个模型产生
 *   的），一律视为非对话首轮 → stage 2，之后切到目标模型也不会误 bare。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// RL 训练接口的原始身份句
const RL_SYSTEM_PROMPT = "You are a helpful software engineer assistant.";

// 首轮工具面：仅 pi 内置的 read + bash（RL 形状：读文件 + 跑命令）
const FIRST_TURN_TOOLS = ["read", "bash"];

// 注入文本：推理格式锚点（英文、'we need' 开头）。通过 input 事件
// transform 直接 append 到首个用户输入末尾，作为普通 user 消息的一部分
// （TUI 显示、持久化、LLM 上下文一致，无特殊样式、无额外判定）。
const FIRST_TURN_INJECTION = "Reasoning in English starts with 'we need'.";

// 注入文本与用户输入的段落分隔
const INJECTION_SEPARATOR = "\n\n";

// ── 目标模型：id 中包含 deepseek-v4-flash / deepseek-v4-pro（忽略大小写，前后不
//    限）——如 deepseek-v4-flash、DeepSeek-V4-PRO-xxx、my-deepseek-v4-flash 均命中──

const TARGET_MODEL_SUBSTRINGS = ["deepseek-v4-flash", "deepseek-v4-pro"];

function isTargetModel(modelId: string): boolean {
	const id = modelId.toLowerCase();
	return TARGET_MODEL_SUBSTRINGS.some((s) => id.includes(s));
}

// ── 会话状态 ────────────────────────────────────────────────────────────────

// stage per session: 0=对话首轮待定 1=已 bare（次轮恢复） 2=完成/跳过
const stages = new Map<string, number>();
// 首轮收窄前的完整工具名快照（次轮原样恢复）
const savedTools = new Map<string, string[]>();

function sessionIdOf(ctx: ExtensionContext): string {
	try {
		return ctx.sessionManager.getSessionId() ?? "?";
	} catch {
		return "?";
	}
}

/** 会话历史里是否已有 assistant 消息（对话首轮的权威判定信号）。 */
function hasAssistantHistory(ctx: ExtensionContext): boolean {
	try {
		const entries = ctx.sessionManager.getEntries();
		return entries.some(
			(e) => e.type === "message" && (e as { message?: { role?: string } }).message?.role === "assistant",
		);
	} catch {
		return false;
	}
}

export default function (pi: ExtensionAPI) {
	// ── 会话生命周期：初始化 stage（此后每轮 run 前仍会实时校正）───────────

	pi.on("session_start", async (_event, ctx) => {
		const sid = sessionIdOf(ctx);
		// 恢复的既有会话（有 assistant 历史）不 bare——上下文已完整
		stages.set(sid, hasAssistantHistory(ctx) ? 2 : 0);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const sid = sessionIdOf(ctx);
		stages.delete(sid);
		savedTools.delete(sid);
	});

	// ── 注入：首个用户输入直接 transform 进消息本体 ────────────────
	// 守卫与 bare 相同的首轮条件（stage 0 + 无 assistant 历史 + 目标模型）；
	// 返回 transform 后文本（原输入 + 推理格式锚点），runner 会把 transform
	// 结果作为正式用户消息——TUI/持久化/LLM 上下文三处天然一致。
	// 注：slash 命令（/...）在 input 事件之前被拦截，不会被污染；
	//   steer/followUp 等流式追加输入时 stage 已推进（≠0），不会重复注入。

	pi.on("input", async (event, ctx) => {
		const sid = sessionIdOf(ctx);
		if (stages.get(sid) !== 0) return undefined;
		if (hasAssistantHistory(ctx)) return undefined;
		const modelId = ctx.model?.id ?? "";
		if (!isTargetModel(modelId)) return undefined;
		return {
			action: "transform",
			text: event.text + INJECTION_SEPARATOR + FIRST_TURN_INJECTION,
		};
	});

	// ── 核心：每轮 agent run 开始前（用户输入触发，含重放/多会话）──────────

	pi.on("before_agent_start", async (_event, ctx) => {
		const sid = sessionIdOf(ctx);

		// ── 权威校正（每次 run 都做）：以会话历史的 assistant 消息为准 ──
		// 只校正两种情形，中间态 stage 1（已 bare、等待次轮恢复）必须保留：
		//   1. map 无记录（/reload 后 session_start 未重放）→ 按历史初始化；
		//   2. stage 0 但会话已有 assistant 历史（此前其他模型的对话已进行，
		//      或首轮发生在模型不匹配期间）→ 非对话首轮，推进到完成态，
		//      防止切到目标模型后误 bare。
		const hasHistory = hasAssistantHistory(ctx);
		let stage = stages.get(sid);
		if (stage === undefined) {
			stage = hasHistory ? 2 : 0;
			stages.set(sid, stage);
		} else if (stage === 0 && hasHistory) {
			stage = 2;
			stages.set(sid, stage);
		}

		if (stage === 0) {
			// ── 对话首轮：仅目标模型 bare ──
			// 模型不匹配 → 不干预（stage 保持 0；若该模型先产生了对话，
			// 下一次 run 的历史校正会自动推进到 stage 2，之后切到目标
			// 模型也不会误触）
			const modelId = ctx.model?.id ?? "";
			if (!isTargetModel(modelId)) return undefined;

			// 完整工具列表快照备份，然后收窄为 read + bash
			savedTools.set(sid, pi.getActiveTools());
			pi.setActiveTools(FIRST_TURN_TOOLS);
			stages.set(sid, 1);
			// system prompt 替换为 RL 训练句（推理格式锚点已在 input 层
			// 作为用户消息的一部分注入）
			return {
				systemPrompt: RL_SYSTEM_PROMPT,
			};
		}

		if (stage === 1) {
			// ── 次轮兜底恢复（正常路径已由 message_start / tool_execution_start
			//    提前完成；此处仅防极端情况下 stage 1 残留到下一次 user message）──
			// systemPrompt 不返回 → runner 自动恢复 base prompt；
			// setActiveTools 内部已按恢复后的工具集重建 base prompt。
			const tools = savedTools.get(sid);
			if (tools) pi.setActiveTools(tools);
			savedTools.delete(sid);
			stages.set(sid, 2);
			return undefined;
		}

		// stage 2：本轮及之后不再干预
		return undefined;
	});

	// ── 提前恢复：首轮 assistant 一有正文输出或工具调用，立即恢复 ──
	// 完整 system prompt + 完整工具。pi 0.84.2 的 setActiveTools 会无条件
	// 重建 base prompt 并写回 agent.state（无 override 锁），所以一次调用
	// 即同时恢复两者；本次 LLM 调用的 tools 已 snapshot，恢复对 run 内
	// **下一次**调用（如 tool 执行完后的继续调用）生效，无需等下一轮
	// user message。

	const restoreFullSetup = (sid: string): void => {
		// 只处理已 bare 的中间态（stage 1）；事件可能在任意轮触发
		if (stages.get(sid) !== 1) return;
		const tools = savedTools.get(sid);
		if (!tools) return;
		pi.setActiveTools(tools);
		savedTools.delete(sid);
		stages.set(sid, 2);
	};

	pi.on("message_start", async (event, ctx) => {
		// assistant 消息开始输出（正文或 tool_calls 都属于）
		if (event.message.role !== "assistant") return;
		restoreFullSetup(sessionIdOf(ctx));
	});

	pi.on("tool_execution_start", async (_event, ctx) => {
		// 工具开始执行的兜底触发点（与 message_start 幂等，双保险）
		restoreFullSetup(sessionIdOf(ctx));
	});
}
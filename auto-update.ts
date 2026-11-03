/**
 * Auto Update Extensions — 插件自动更新（子进程 / shell 模式）
 *
 * 设计目标：自动更新绝不能碰 TUI 的渲染与输入。
 *
 * 旧实现直接在 pi 进程里调用 DefaultPackageManager.update()。npm 在 TUI 里
 * 通过 stderr 直接写终端（pi 只在 takeover 时重定向了 stdout），会打乱 TUI
 * 的 diff 渲染；同时 npm install 与当前进程里的扩展共享 node_modules，
 * 更新过程中的卡顿/文件替换都会影响正在使用的会话。
 *
 * 现在改成和用户在 composer 里输入 `! pi update --extensions` 等价的模式：
 *   - 检查更新仍然用只读的 checkForAvailableUpdates()（纯异步，无 UI 写入）
 *   - 真正更新时 fork 一个独立的 `pi update ...` 子进程，stdout/stderr 走管道，
 *     绝不写终端，也绝不碰 editor/composer
 *   - 子进程结束后，把结果作为一条 custom entry 追加到聊天区（不进入 LLM 上下文）
 *
 * 行为：
 *   启动时（session_start, reason="startup"，仅 TUI）延迟数秒静默检查；
 *   有更新 → 后台执行 `pi update --extensions`，完成后在聊天区输出结果；
 *   无更新/检查失败 → 完全静默（与内置横幅检查的 catch 行为一致）。
 *
 * 手动命令：
 *   /ext-update            检查并更新所有扩展包
 *   /ext-update <source>   只更新指定包（等价于 `! pi update --extension <source>`）
 *
 * 配置（环境变量）：
 *   PI_AUTO_UPDATE_EXTENSIONS = update | check | off   默认 update
 *     update  检查到更新后自动安装（默认）
 *     check   只提醒，不自动安装
 *     off     完全禁用（自动检查；/ext-update 手动触发仍可用）
 *   PI_OFFLINE=1 时跳过（与内置更新检查行为一致）。
 *
 * 跨实例安全：~/.pi/agent/tmp/ext-update.lock 文件锁，防止多个 pi 实例
 * 同时启动更新子进程。锁超过 10 分钟视为残留，自动接管。
 */

import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import {
	DefaultPackageManager,
	getAgentDir,
	getPackageDir,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const ENTRY_TYPE = "ext-update-result";
const STATUS_KEY = "ext-update";
const LOCK_DIR = join(getAgentDir(), "tmp");
const LOCK_FILE = join(LOCK_DIR, "ext-update.lock");
const LOCK_STALE_MS = 10 * 60 * 1000;
const CHECK_TIMEOUT_MS = 30_000;
const UPDATE_TIMEOUT_MS = 10 * 60 * 1000;
const UPDATE_MAX_BUFFER = 8 * 1024 * 1024;
/** custom entry 里保留的输出上限，避免把整个 npm log 写进会话文件 */
const OUTPUT_LIMIT = 8_000;
/** 自动检查的延迟：让 pi 内置的更新横幅先出现，并错开启动时的网络高峰 */
const AUTO_DELAY_MS = 5_000;
/** 通过 cmd.exe fallback 调用时，拒绝可能被 shell 解释的 source */
const WINDOWS_SHELL_UNSAFE = /[&|<>^"\r\n%]/;

/** PackageUpdate 结构（pi 未从入口导出该类型，这里按结构声明） */
interface PkgUpdate {
	source: string;
	displayName: string;
	type: "npm" | "git";
	scope: "user" | "project";
}

/** 追加到聊天区的更新结果（custom entry，不进入 LLM 上下文） */
interface ExtUpdateResult {
	ok: boolean;
	command: string;
	packages: string[];
	output: string;
	error?: string;
	at: number;
}

interface PiInvocation {
	command: string;
	args: string[];
	/** command 是 cmd.exe 时，额外参数要按 shell 语义做安全性检查 */
	shell: boolean;
}

type AutoMode = "off" | "check" | "update";

function autoMode(): AutoMode {
	const v = (process.env.PI_AUTO_UPDATE_EXTENSIONS ?? "").trim().toLowerCase();
	if (v === "off" || v === "check" || v === "update") return v;
	return "update";
}

/** 与 pi 内置检查一致：只有 1/true/yes 才算离线 */
function isOffline(): boolean {
	const v = (process.env.PI_OFFLINE ?? "").trim().toLowerCase();
	return v === "1" || v === "true" || v === "yes";
}

// ---------------------------------------------------------------------------
// 跨进程文件锁（best-effort）
// ---------------------------------------------------------------------------

let lockToken = "";

function acquireLock(): boolean {
	try {
		mkdirSync(LOCK_DIR, { recursive: true, mode: 0o700 });
	} catch {
		/* ignore */
	}
	lockToken = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	try {
		const fd = openSync(LOCK_FILE, "wx");
		writeSync(fd, lockToken);
		closeSync(fd);
		return true;
	} catch {
		// 已被占用：检查是否为残留锁
		try {
			if (Date.now() - statSync(LOCK_FILE).mtimeMs > LOCK_STALE_MS) {
				// 原子接管：先改名再重建，避免与其它实例同时抢
				const stolen = `${LOCK_FILE}.${Date.now()}`;
				try {
					renameSync(LOCK_FILE, stolen);
					rmSync(stolen, { force: true });
				} catch {
					return false;
				}
				return acquireLock();
			}
		} catch {
			return acquireLock(); // 锁刚被释放，重试
		}
		return false;
	}
}

function releaseLock(): void {
	if (!lockToken) return;
	try {
		if (readFileSync(LOCK_FILE, "utf8") === lockToken) unlinkSync(LOCK_FILE);
	} catch {
		/* 已不存在 */
	}
	lockToken = "";
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const t = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
		p.then(
			(v) => {
				clearTimeout(t);
				resolve(v);
			},
			(e) => {
				clearTimeout(t);
				reject(e instanceof Error ? e : new Error(String(e)));
			},
		);
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function firstLine(text: string): string {
	return (
		text
			.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
			.split("\n")
			.map((line) => line.trim())
			.find(Boolean) ?? ""
	);
}

function stripAnsi(text: string): string {
	// CSI 序列 + 常见 OSC 序列（npm/pnpm 的进度条、超链接等）
	return text
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
		.replace(/\r/g, "");
}

function capOutput(output: string): string {
	return output.length > OUTPUT_LIMIT ? `…\n${output.slice(-OUTPUT_LIMIT)}` : output;
}

/**
 * 解析“当前正在运行的 pi”的 CLI 入口，避免依赖 PATH 中的 shim
 * （dev build、`pi-test.sh`、被覆盖的全局安装等情况都能跑对版本）。
 *
 * - npm/pnpm/bun 安装：node/bun + <packageDir>/dist/bundle/cli.js（cli.js fallback）
 * - Bun/Node 单文件可执行程序：直接执行 process.execPath
 * - 其它/源码运行：退回 PATH 里的 `pi`（Windows 走 cmd.exe）
 */
function resolvePiInvocation(): PiInvocation {
	const exe = process.execPath;

	const features = process.features as { sea?: boolean };
	if (features.sea === true) {
		return { command: exe, args: [], shell: false };
	}

	try {
		const packageDir = getPackageDir();
		const isBunRuntime = Boolean((process.versions as Record<string, string | undefined>).bun);
		// Bun 单文件构建：资源就在可执行文件旁边。
		if (isBunRuntime && resolvePath(packageDir) === resolvePath(dirname(exe))) {
			return { command: exe, args: [], shell: false };
		}
		for (const relative of ["dist/bundle/cli.js", "dist/cli.js"]) {
			const cli = join(packageDir, relative);
			if (existsSync(cli)) return { command: exe, args: [cli], shell: false };
		}
	} catch {
		// getPackageDir() 在异常安装布局下可能抛错，走 PATH fallback
	}

	if (process.platform === "win32") {
		return { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", "pi"], shell: true };
	}
	return { command: "pi", args: [], shell: false };
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let busy = false;
	let autoTimer: ReturnType<typeof setTimeout> | undefined;

	/**
	 * True while `ctx` still belongs to the live extension runtime. pi's ctx getters (cwd, hasUI, ui, ...)
	 * throw after the session was disposed or replaced, and a delayed auto-check can outlive its session
	 * (print mode exits, `/new`, fork), so probe instead of letting the getter throw.
	 */
	function isLive(ctx: ExtensionContext | undefined): ctx is ExtensionContext {
		if (!ctx) return false;
		try {
			void ctx.hasUI;
			return true;
		} catch {
			return false;
		}
	}

	function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
		if (!isLive(ctx) || !ctx.hasUI) return;
		try {
			ctx.ui.notify(message, type);
		} catch {
			/* runtime gone: nobody left to notify */
		}
	}

	/** 只改 footer 的 status 行，不碰 editor/composer */
	function setStatus(ctx: ExtensionContext, text: string | undefined): void {
		if (!isLive(ctx) || !ctx.hasUI) return;
		try {
			ctx.ui.setStatus(STATUS_KEY, text);
		} catch {
			/* runtime gone */
		}
	}

	/** 把更新结果追加为 custom entry：显示在聊天区，不进入 LLM 上下文 */
	function appendResult(ctx: ExtensionContext, data: ExtUpdateResult): void {
		if (!isLive(ctx)) return;
		try {
			pi.appendEntry<ExtUpdateResult>(ENTRY_TYPE, data);
		} catch {
			/* runtime gone */
		}
	}

	/** 与 InteractiveMode / `pi update --extensions` 相同的包管理器配置（只用于只读检查） */
	function makePackageManager(ctx: ExtensionContext): DefaultPackageManager {
		return new DefaultPackageManager({
			cwd: ctx.cwd,
			agentDir: getAgentDir(),
			settingsManager: SettingsManager.create(ctx.cwd),
		});
	}

	async function checkForUpdates(ctx: ExtensionContext): Promise<PkgUpdate[]> {
		if (!isLive(ctx)) return [];
		return withTimeout(makePackageManager(ctx).checkForAvailableUpdates(), CHECK_TIMEOUT_MS, "update check");
	}

	/**
	 * 真正执行更新：fork 一个独立的 pi 进程（等价于 `! pi update ...`）。
	 * 输出通过管道捕获，绝不写终端，也不读写 editor。
	 */
	async function runUpdateCommand(
		ctx: ExtensionContext,
		updateArgs: string[],
		displayCommand: string,
		packages: string[],
		options: { status: boolean },
	): Promise<void> {
		const invocation = resolvePiInvocation();
		const sourceArg = updateArgs[0] === "--extension" ? updateArgs[1] : undefined;
		if (invocation.shell && sourceArg && WINDOWS_SHELL_UNSAFE.test(sourceArg)) {
			const message = `unsafe package source for cmd.exe: ${sourceArg}`;
			appendResult(ctx, { ok: false, command: displayCommand, packages, output: "", error: message, at: Date.now() });
			notify(ctx, `ext-update failed: ${message}`, "error");
			return;
		}

		if (options.status) setStatus(ctx, `ext-update: running ${displayCommand}…`);

		let result: Awaited<ReturnType<typeof pi.exec>>;
		try {
			result = await pi.exec(invocation.command, [...invocation.args, "update", ...updateArgs], {
				cwd: ctx.cwd,
				timeout: UPDATE_TIMEOUT_MS,
				maxBuffer: UPDATE_MAX_BUFFER,
			});
		} catch (error) {
			const message = errorMessage(error);
			appendResult(ctx, { ok: false, command: displayCommand, packages, output: "", error: message, at: Date.now() });
			notify(ctx, `ext-update failed: ${message}`, "warning");
			return;
		}

		const output = capOutput(stripAnsi([result.stdout, result.stderr].filter(Boolean).join("\n")).trim());
		const ok = result.code === 0 && !result.killed;
		const error = ok
			? undefined
			: firstLine(result.stderr) || firstLine(result.stdout) || `pi update exited with code ${result.code}`;

		appendResult(ctx, { ok, command: displayCommand, packages, output, error, at: Date.now() });
		if (!ok) notify(ctx, `ext-update failed: ${error}`, "warning");
	}

	/** 启动后的静默检查：无更新或检查失败都不产生任何输出 */
	async function autoRun(ctx: ExtensionContext, install: boolean): Promise<void> {
		if (!isLive(ctx) || busy) return;
		busy = true;
		try {
			if (!acquireLock()) return;

			let updates: PkgUpdate[];
			try {
				updates = await checkForUpdates(ctx);
			} catch {
				// 自动模式与 pi 内置检查一致：检查失败保持静默
				return;
			}

			if (!isLive(ctx) || updates.length === 0) return;
			const names = updates.map((u) => u.displayName);

			if (!install) {
				notify(ctx, `Extension updates available: ${names.join(", ")} — run /ext-update`, "info");
				return;
			}

			// 静默运行；完成后由 custom entry 输出结果
			await runUpdateCommand(ctx, ["--extensions"], "pi update --extensions", names, { status: false });
		} finally {
			releaseLock();
			busy = false;
		}
	}

	/** 手动 /ext-update：footer status 显示进度，结果写入聊天区 */
	async function manualRun(ctx: ExtensionContext, source?: string): Promise<void> {
		if (!isLive(ctx)) return;
		if (busy) {
			notify(ctx, "ext-update: already running…", "info");
			return;
		}

		busy = true;
		try {
			if (!acquireLock()) {
				notify(ctx, "ext-update: another pi instance is updating extensions; skipped.", "warning");
				return;
			}

			if (source) {
				await runUpdateCommand(
					ctx,
					["--extension", source],
					`pi update --extension ${source}`,
					[source],
					{ status: true },
				);
				return;
			}

			setStatus(ctx, "ext-update: checking for extension updates…");
			let updates: PkgUpdate[];
			try {
				updates = await checkForUpdates(ctx);
			} catch (error) {
				notify(ctx, `ext-update: check failed: ${errorMessage(error)}`, "warning");
				return;
			}

			if (!isLive(ctx)) return;
			if (updates.length === 0) {
				notify(ctx, "ext-update: all extension packages are up to date.", "info");
				return;
			}

			const names = updates.map((u) => u.displayName);
			await runUpdateCommand(ctx, ["--extensions"], "pi update --extensions", names, { status: true });
		} finally {
			setStatus(ctx, undefined);
			releaseLock();
			busy = false;
		}
	}

	// -- 结果渲染：等价于 shell mode 里的一小段命令输出 -------------------------

	pi.registerEntryRenderer<ExtUpdateResult>(ENTRY_TYPE, (entry, { expanded }, theme) => {
		const data = entry.data;
		if (!data) return undefined;

		const title = data.ok ? "Extension packages updated" : "Extension update failed";
		const header = data.ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
		const packageList = data.packages.length > 0 ? `: ${data.packages.join(", ")}` : "";

		const lines = [
			`${header} ${theme.bold(title)}${theme.fg("muted", packageList)}`,
			theme.fg("dim", `$ ${data.command}`),
		];
		if (data.error && !data.output.includes(data.error)) lines.push(theme.fg("error", data.error));

		const output = data.output.trim();
		if (output) {
			const all = output.split("\n");
			const shown = expanded ? all : all.slice(-6);
			if (!expanded && all.length > shown.length) lines.push(theme.fg("dim", "… (expand to see full output)"));
			lines.push(theme.fg("muted", shown.join("\n")));
		}

		if (data.ok) lines.push(theme.fg("dim", "Run /reload or restart pi to load the new versions."));

		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(lines.join("\n"), 0, 0));
		return box;
	});

	// -- 启动：仅 TUI 自动检查，更新在子进程里静默执行 -------------------------

	pi.on("session_start", (event, ctx) => {
		if (autoTimer) {
			clearTimeout(autoTimer);
			autoTimer = undefined;
		}
		if (event.reason !== "startup") return;
		if (ctx.mode !== "tui") return;
		if (isOffline()) return;
		const mode = autoMode();
		if (mode === "off") return;

		// 延迟触发：让 pi 内置的更新检查/横幅先跑，错开启动高峰；不阻塞启动。
		autoTimer = setTimeout(() => {
			autoTimer = undefined;
			void autoRun(ctx, mode === "update");
		}, AUTO_DELAY_MS);
		autoTimer.unref?.();
	});

	pi.on("session_shutdown", () => {
		// 只清自己的定时器；已经启动的更新子进程会继续跑完（与 shell mode 一致）。
		if (autoTimer) {
			clearTimeout(autoTimer);
			autoTimer = undefined;
		}
	});

	// -- 手动命令 -----------------------------------------------------------

	pi.registerCommand("ext-update", {
		description: "Update extension packages now (usage: /ext-update [package])",
		handler: async (args, ctx) => {
			const source = args.trim() || undefined;
			await manualRun(ctx, source);
		},
	});
}

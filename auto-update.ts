/**
 * Auto Update — pi 本体 + 插件自动更新（子进程 / shell 模式）
 *
 * 设计目标：自动更新绝不能碰 TUI 的渲染与输入。
 *
 * 旧实现直接在 pi 进程里调用 DefaultPackageManager.update()。npm 在 TUI 里
 * 通过 stderr 直接写终端（pi 只在 takeover 时重定向了 stdout），会打乱 TUI
 * 的 diff 渲染；同时 npm install 与当前进程里的扩展共享 node_modules，
 * 更新过程中的卡顿/文件替换都会影响正在使用的会话。
 *
 * 现在改成和用户在 composer 里输入 `! pi update [--all|--extensions]` 等价的模式：
 *   - 检查更新仍然用只读的 checkForAvailableUpdates()（纯异步，无 UI 写入）
 *   - 真正更新时 fork 一个独立的 `pi update ...` 子进程，stdout/stderr 走管道，
 *     绝不写终端，也绝不碰 editor/composer
 *   - 子进程结束后，把结果作为一条 custom entry 追加到聊天区（不进入 LLM 上下文）
 *
 * 行为：
 *   启动时（session_start, reason="startup"，仅 TUI）延迟数秒静默检查；
 *   有更新 → 后台执行 `pi update` / `pi update --extensions` / `pi update --all`，
 *   完成后在聊天区输出结果；无更新/检查失败 → 完全静默（与内置横幅检查的 catch 行为一致）。
 *
 * 检查什么：
 *   1. pi 本体（`Update Available` 横幅同源：https://pi.dev/api/latest-version，
 *      `VERSION` 来自宿主包）。装了本体需要重启 pi 才生效。
 *   2. 扩展包/本地包（`DefaultPackageManager.checkForAvailableUpdates()`）。
 *   装完本体要重启 pi 才会用上新版本（旧安装目录被替换，本进程里已经加载的模块
 *   还是旧的；没加载过的懒加载模块可能因为目录没了而失败）。
 *
 * 手动命令：
 *   /ext-update            检查并更新 pi 本体 + 所有扩展包
 *   /ext-update <source>   只更新指定包（等价于 `! pi update --extension <source>`）
 *
 * 配置（环境变量）：
 *   PI_AUTO_UPDATE_EXTENSIONS = update | check | off   默认 update
 *     update  检查到更新后自动安装（默认）
 *     check   只提醒，不自动安装
 *     off     不检查扩展包（/ext-update 手动触发仍可用）
 *   PI_AUTO_UPDATE_PI = update | check | off           默认 update
 *     同上，控制 pi 本体；check 只提醒，off 完全不查本体
 *   PI_OFFLINE 非空 / PI_SKIP_VERSION_CHECK 时跳过（与内置检查行为一致）。
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
	VERSION,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { formatUserAgent } from "@earendil-works/pi-ai";
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

/**
 * `PackageUpdate` 结构。pi 入口只导出 `DefaultPackageManager` 而不导出这个类型，
 * 所以从方法返回值推导，pi 增字段时自动跟随（不再手写结构副本）。
 */
type PkgUpdate = Awaited<ReturnType<DefaultPackageManager["checkForAvailableUpdates"]>>[number];

/**
 * 追加到聊天区的更新结果（custom entry，不进入 LLM 上下文）。
 * 只有「刚跑的命令 + 子进程输出」——更新了什么由 pi 自己的输出说明。
 */
interface ExtUpdateResult {
	command: string;
	output: string;
	error?: string;
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

/**
 * 与 pi 启动时的两个内置检查一致：`PI_OFFLINE` **非空即跳过**（InteractiveMode 里是
 * `if (!process.env.PI_OFFLINE) { …check… }`；`DefaultPackageManager.isOfflineModeEnabled()`
 * 那个 1/true/yes 的严格版只管**安装**，这里拦住的是检查）。
 */
function isOffline(): boolean {
	return Boolean(process.env.PI_OFFLINE);
}

/**
 * pi 本体的自动更新策略（`PI_AUTO_UPDATE_PI`）：
 *   update  检测到新版本就装（默认，等价于帮你敲 `pi update`）
 *   check   只提醒，不自动装
 *   off     完全不检测 pi 本体（只保留扩展包更新）
 */
function piAutoMode(): AutoMode {
	const v = (process.env.PI_AUTO_UPDATE_PI ?? "").trim().toLowerCase();
	if (v === "off" || v === "check" || v === "update") return v;
	return "update";
}

// ---------------------------------------------------------------------------
// pi 本体更新检查（`Update Available` 横幅那件事）
// ---------------------------------------------------------------------------

/** 与 pi 内置检查同一个端点（`utils/version-check.ts` 里未从包入口导出）。 */
const PI_VERSION_URL = "https://pi.dev/api/latest-version";
const PI_CHECK_TIMEOUT_MS = 10_000;

interface PiRelease {
	version: string;
	packageName?: string;
}

/** 已检测到的本体更新：`current → release.version` */
interface PiUpdate {
	current: string;
	release: PiRelease;
}

interface ParsedVersion {
	parts: [number, number, number];
	/** 预发布后缀（`1.5.1-beta.2` 的 `beta.2`）；无则为空 */
	pre: string;
}

/** @internal 导出仅供 `npm test` 使用，pi 只读 default 导出。 */
export function parseVersion(value: string): ParsedVersion | undefined {
	const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
	if (!match) return undefined;
	return {
		parts: [Number(match[1]), Number(match[2]), Number(match[3])],
		pre: match[4] ?? "",
	};
}

/** 语义化版本比较；无法解析时一律「不算新」，宁漏报不误报。 */
/** @internal 导出仅供 `npm test` 使用。 */
export function isNewerVersion(candidate: string, current: string): boolean {
	const a = parseVersion(candidate);
	const b = parseVersion(current);
	if (!a || !b) return false;
	for (let i = 0; i < 3; i++) {
		if (a.parts[i] !== b.parts[i]) return a.parts[i] > b.parts[i];
	}
	// 主版本相同：`1.5.1` 比 `1.5.1-beta` 新
	if (a.pre === b.pre) return false;
	if (!a.pre) return true;
	if (!b.pre) return false;
	return a.pre > b.pre;
}

/**
 * 查询 pi 本体是否有新版本（与内置横幅同源）。
 * 离线 / PI_SKIP_VERSION_CHECK / 网络失败 → undefined（静默）。
 */
/** @internal 导出仅供 `npm test` 使用。 */
export async function checkForPiUpdate(): Promise<PiUpdate | undefined> {
	if (isOffline()) return undefined;
	if (process.env.PI_SKIP_VERSION_CHECK) return undefined;

	try {
		const response = await fetch(PI_VERSION_URL, {
			headers: { accept: "application/json", "User-Agent": formatUserAgent({ userAgent: "detailed", version: VERSION }) },
			signal: AbortSignal.timeout(PI_CHECK_TIMEOUT_MS),
		});
		if (!response.ok) return undefined;

		const data = (await response.json()) as { version?: unknown; packageName?: unknown };
		const version = typeof data.version === "string" ? data.version.trim() : "";
		if (!version || !isNewerVersion(version, VERSION)) return undefined;

		const packageName =
			typeof data.packageName === "string" && data.packageName.trim() ? data.packageName.trim() : undefined;
		return { current: VERSION, release: { version, ...(packageName ? { packageName } : {}) } };
	} catch {
		// 与内置检查一致：查不到就当作没有更新
		return undefined;
	}
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
		options: { status: boolean },
	): Promise<void> {
		const invocation = resolvePiInvocation();
		const sourceArg = updateArgs[0] === "--extension" ? updateArgs[1] : undefined;
		if (invocation.shell && sourceArg && WINDOWS_SHELL_UNSAFE.test(sourceArg)) {
			const message = `unsafe package source for cmd.exe: ${sourceArg}`;
			appendResult(ctx, { command: displayCommand, output: "", error: message });
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
			appendResult(ctx, { command: displayCommand, output: "", error: message });
			notify(ctx, `ext-update failed: ${message}`, "warning");
			return;
		}

		const joined = stripAnsi([result.stdout, result.stderr].filter(Boolean).join("\n")).trim();
		// pi.exec() 在输出超过 maxBuffer 时置 truncated:true 并让 code 非 0；
		// 不标出来会被误读成普通的更新失败。
		const output = capOutput(
			result.truncated ? `[output truncated at ${UPDATE_MAX_BUFFER / (1024 * 1024)} MiB]\n${joined}` : joined,
		);
		const ok = result.code === 0 && !result.killed;
		const error = ok
			? undefined
			: firstLine(result.stderr) || firstLine(result.stdout) || `pi update exited with code ${result.code}`;

		appendResult(ctx, { command: displayCommand, output, error });
		if (!ok) notify(ctx, `ext-update failed: ${error}`, "warning");
	}

	/** 启动后的静默检查：无更新或检查失败都不产生任何输出 */
	async function autoRun(ctx: ExtensionContext): Promise<void> {
		if (!isLive(ctx) || busy) return;
		const piMode = piAutoMode();
		const extMode = autoMode();
		if (piMode === "off" && extMode === "off") return;

		busy = true;
		try {
			if (!acquireLock()) return;

			const piUpdate = piMode === "off" ? undefined : await checkForPiUpdate();
			const updates = extMode === "off" ? [] : await checkForUpdates(ctx).catch(() => [] as PkgUpdate[]);

			if (!isLive(ctx) || (!piUpdate && updates.length === 0)) return;
			const names = updates.map((u) => u.displayName);

			// 本体与包各自看自己的开关；`pi update` 只是在子进程里装包，跟当前会话忙不忙无关。
			const installPi = Boolean(piUpdate) && piMode === "update";
			const installExt = extMode === "update" && updates.length > 0;

			if (installPi || installExt) {
				const args = installPi && installExt ? ["--all"] : installPi ? [] : ["--extensions"];
				// 静默运行；输出作为一条 custom entry 贴在聊天区，内容全来自 pi 自己
				await runUpdateCommand(ctx, args, ["pi", "update", ...args].join(" "), { status: false });
				return;
			}

			// check 模式只提醒
			if (piUpdate && !installPi) {
				notify(
					ctx,
					`pi ${piUpdate.release.version} available (running ${piUpdate.current}) — run pi update`,
					"info",
				);
			}
			if (updates.length > 0 && !installExt) {
				notify(ctx, `Extension updates available: ${names.join(", ")} — run /ext-update`, "info");
			}
		} finally {
			releaseLock();
			busy = false;
		}
	}

	/** 手动 /ext-update：footer status 显示进度，结果写入聊天区；默认同时检查 pi 本体 */
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
				await runUpdateCommand(ctx, ["--extension", source], `pi update --extension ${source}`, {
					status: true,
				});
				return;
			}

			setStatus(ctx, "ext-update: checking for updates…");
			const piMode = piAutoMode();
			let piUpdate: PiUpdate | undefined;
			let updates: PkgUpdate[];
			try {
				[piUpdate, updates] = await Promise.all([
					piMode === "off" ? Promise.resolve(undefined) : checkForPiUpdate(),
					checkForUpdates(ctx),
				]);
			} catch (error) {
				notify(ctx, `ext-update: check failed: ${errorMessage(error)}`, "warning");
				return;
			}

			if (!isLive(ctx)) return;
			if (!piUpdate && updates.length === 0) {
				notify(ctx, `ext-update: pi ${VERSION} and all extension packages are up to date.`, "info");
				return;
			}

			// 手动触发时用户已明确要求更新：本体有更新就用 --all，只装本体用默认，只装包用 --extensions。
			const args = piUpdate && updates.length > 0 ? ["--all"] : piUpdate ? [] : ["--extensions"];
			await runUpdateCommand(ctx, args, ["pi", "update", ...args].join(" "), { status: true });
		} finally {
			setStatus(ctx, undefined);
			releaseLock();
			busy = false;
		}
	}

	// -- 结果渲染：就是一段 shell 输出，不另造标题/横幅 ------------------------

	pi.registerEntryRenderer<ExtUpdateResult>(ENTRY_TYPE, (entry, { expanded }, theme) => {
		const data = entry.data;
		if (!data) return undefined;

		// 「更新了什么」全由 pi 自己写在输出里（`Updated pi from X to Y` /
		// `Updated N packages:` / `... is already up to date`），这里只是把它当成
		// 一段命令输出摆出来：`$ 命令` + 子进程 stdout/stderr，Ctrl+O 展开全文。
		const lines = [theme.fg("dim", `$ ${data.command}`)];
		if (data.error && !data.output.includes(data.error)) lines.push(theme.fg("error", data.error));

		const output = data.output.trim();
		if (output) {
			const all = output.split("\n");
			const shown = expanded ? all : all.slice(-6);
			if (!expanded && all.length > shown.length) lines.push(theme.fg("dim", "… (expand to see full output)"));
			lines.push(theme.fg("muted", shown.join("\n")));
		}

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
		if (autoMode() === "off" && piAutoMode() === "off") return;

		// 延迟触发：让 pi 内置的更新检查/横幅先跑，错开启动高峰；不阻塞启动。
		autoTimer = setTimeout(() => {
			autoTimer = undefined;
			void autoRun(ctx);
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
		description: "Update pi itself and extension packages now (usage: /ext-update [package])",
		handler: async (args, ctx) => {
			const source = args.trim() || undefined;
			await manualRun(ctx, source);
		},
	});
}

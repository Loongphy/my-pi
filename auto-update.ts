/**
 * Auto Update Extensions — 插件自动更新
 *
 * 每次启动新的 Pi 实例（session_start, reason="startup"）时：
 *   1. 延迟数秒（避开 pi 自身的启动检查高峰，让内置 "Package Updates Available"
 *      横幅先出现），然后静默运行与内置横幅完全相同的检查
 *      （DefaultPackageManager.checkForAvailableUpdates()）。
 *   2. 无更新 → 什么都不显示、什么都不做。
 *      有更新 → 这正是内置横幅会出现的那一条件成立：静默自动更新
 *      （与 `pi update --extensions` 相同的逻辑，不显示进度、不提醒）。
 *      新代码在下次 /reload 或重启 pi 后生效。
 *   3. 自动检查失败保持静默（与 pi 内置检查 catch 后返回 [] 的行为一致）；
 *      只有更新本身失败才 notify warning（否则会误以为已是最新）。
 *
 * 手动命令（主动触发，全程显示进度）：
 *   /ext-update            立即检查并更新所有扩展包
 *   /ext-update <source>   只更新指定包（如 /ext-update @narumitw/pi-btw）
 *
 * 配置（环境变量）：
 *   PI_AUTO_UPDATE_EXTENSIONS = update | check | off   默认 update
 *     update  检查到更新后自动安装（默认）
 *     check   只提醒，不自动安装
 *     off     完全禁用（自动检查；/ext-update 手动触发仍可用）
 *   PI_OFFLINE=1 时跳过（与内置更新检查行为一致）。
 *
 * 跨实例安全：~/.pi/agent/tmp/ext-update.lock 文件锁，防止多个 pi 实例
 * 同时对同一个 npm 安装根目录（~/.pi/agent/npm）并发执行 npm install。
 * 锁超过 10 分钟视为残留，自动接管。
 */

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	DefaultPackageManager,
	getAgentDir,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
	type ProgressEvent,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const WIDGET_KEY = "ext-update";
const LOCK_DIR = join(getAgentDir(), "tmp");
const LOCK_FILE = join(LOCK_DIR, "ext-update.lock");
const LOCK_STALE_MS = 10 * 60 * 1000;
const CHECK_TIMEOUT_MS = 30_000;
const WIDGET_HIDE_MS = 10_000;
/** 自动检查的延迟：让 pi 内置的更新横幅先出现，并错开启动时的网络高峰 */
const AUTO_DELAY_MS = 5_000;

/** PackageUpdate 结构（pi 未从入口导出该类型，这里按结构声明） */
interface PkgUpdate {
	source: string;
	displayName: string;
	type: "npm" | "git";
	scope: "user" | "project";
}

type AutoMode = "off" | "check" | "update";

function autoMode(): AutoMode {
	const v = (process.env.PI_AUTO_UPDATE_EXTENSIONS ?? "").trim().toLowerCase();
	if (v === "off" || v === "check" || v === "update") return v;
	return "update";
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

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let currentCtx: ExtensionContext | undefined;
	let busy = false;
	let hideTimer: ReturnType<typeof setTimeout> | undefined;
	let autoTimer: ReturnType<typeof setTimeout> | undefined;
	let renderSeq = 0;

	/**
	 * True while `ctx` still belongs to the live extension runtime. pi's ctx getters (cwd, hasUI, ui, ...)
	 * throw after the session was disposed or replaced, and a delayed auto-check can outlive its session
	 * (print mode exits, `/new`, fork), so probe instead of letting the getter throw: the stale error used
	 * to escape `runOnce`'s catch through notify() and crash pi.
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

	function widget(lines: string[] | undefined, autoHideMs = 0): void {
		const ctx = currentCtx;
		if (!isLive(ctx) || !ctx.hasUI) return;
		renderSeq++;
		try {
			ctx.ui.setWidget(WIDGET_KEY, lines);
		} catch {
			return; // stale between the probe and the call
		}
		if (hideTimer) {
			clearTimeout(hideTimer);
			hideTimer = undefined;
		}
		if (lines && autoHideMs > 0) {
			const seq = renderSeq;
			hideTimer = setTimeout(() => {
				if (seq !== renderSeq || !isLive(ctx) || !ctx.hasUI) return;
				try {
					ctx.ui.setWidget(WIDGET_KEY, undefined);
				} catch {
					/* runtime gone: nothing left to clear */
				}
			}, autoHideMs);
		}
	}

	function notify(message: string, type: "info" | "warning" | "error" = "info"): void {
		const ctx = currentCtx;
		if (!isLive(ctx) || !ctx.hasUI) return;
		try {
			ctx.ui.notify(message, type);
		} catch {
			/* runtime gone: nobody left to notify */
		}
	}

	/** 与 InteractiveMode / `pi update --extensions` 相同的包管理器配置 */
	function makePackageManager(ctx: ExtensionContext): DefaultPackageManager {
		return new DefaultPackageManager({
			cwd: ctx.cwd,
			agentDir: getAgentDir(),
			settingsManager: SettingsManager.create(ctx.cwd),
		});
	}

	/**
	 * 检查并（可选）更新扩展包。
	 * verbose=true（手动 /ext-update）全程显示进度，包括“已最新”；
	 * verbose=false（自动）完全静默：无更新或检查失败时不出现在何输出。
	 */
	async function runOnce(
		ctx: ExtensionContext,
		doInstall: boolean,
		verbose: boolean,
		source?: string,
	): Promise<void> {
		// A delayed auto-check can fire after its session was replaced or disposed; every ctx access
		// below (ctx.cwd in makePackageManager, ctx.ui in widget/notify) would throw.
		if (!isLive(ctx)) return;
		if (busy) {
			if (verbose) notify("ext-update: already running…", "info");
			return;
		}
		currentCtx = ctx;
		busy = true;
		try {
			if (!acquireLock()) {
				if (verbose) {
					widget(["⏸ ext-update: skipped — another pi instance is updating extensions"], WIDGET_HIDE_MS);
				}
				return;
			}

			const pm = makePackageManager(ctx);

			if (source) {
				// 手动更新单个包：直接更新（pm.update 内部会先核对 registry 是否有新版本）
				widget([`⟳ ext-update: updating ${source}…`]);
				pm.setProgressCallback((ev) => widget(progressLines(ev)));
				try {
					await pm.update(source);
					widget([`✓ ext-update: ${source} updated — /reload or restart to apply`], WIDGET_HIDE_MS);
					notify(`ext-update: ${source} updated. Run /reload or restart pi to load the new version.`, "info");
				} finally {
					pm.setProgressCallback(undefined);
				}
				return;
			}

			if (verbose) widget(["⟳ ext-update: checking for extension updates…"]);
			let updates: PkgUpdate[];
			try {
				updates = await withTimeout(pm.checkForAvailableUpdates(), CHECK_TIMEOUT_MS, "update check");
			} catch (e) {
				// 自动模式与 pi 内置检查一致：检查失败保持静默
				if (verbose) widget([`✗ ext-update: ${(e as Error).message}`], WIDGET_HIDE_MS);
				return;
			}

			if (updates.length === 0) {
				if (verbose) widget(["✓ ext-update: all extension packages up to date"], WIDGET_HIDE_MS);
				return;
			}

			const names = updates.map((u) => u.displayName);

			if (!doInstall) {
				notify(
					`Extension updates available: ${names.join(", ")} — run /ext-update or pi update --extensions`,
					"info",
				);
				widget([`⇡ ext-update: ${names.length} update(s) available: ${names.join(", ")}`], WIDGET_HIDE_MS);
				return;
			}

			if (verbose) {
				widget([`⟳ ext-update: updating ${names.length} package(s): ${names.join(", ")}…`]);
				pm.setProgressCallback((ev) => widget(progressLines(ev)));
			}
			try {
				await pm.update();
			} finally {
				if (verbose) pm.setProgressCallback(undefined);
			}
			if (verbose) {
				widget([`✓ ext-update: updated ${names.join(", ")} — /reload or restart to apply`], WIDGET_HIDE_MS);
				notify(
					`ext-update: updated ${names.join(", ")}. Run /reload or restart pi to load the new versions.`,
					"info",
				);
			}
			// 静默模式（自动）：更新过程与结果都不显示，新代码在下次 /reload 或重启后生效
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			// 更新失败必须让人知道（否则会误以为已是最新）；widget 进度仅限手动模式
			if (verbose) widget([`✗ ext-update failed: ${msg}`], WIDGET_HIDE_MS);
			notify(`ext-update failed: ${msg}`, "warning");
		} finally {
			releaseLock();
			busy = false;
		}
	}

	function progressLines(ev: ProgressEvent): string[] {
		const head = "⟳ ext-update:";
		if (ev.type === "complete") return [`${head} ${ev.action} ${ev.source} done`];
		if (ev.type === "error") return [`${head} ✗ ${ev.action} ${ev.source}: ${ev.message ?? "error"}`];
		return [`${head} ${ev.action} ${ev.source}…`, ev.message ?? ""].filter(Boolean);
	}

	// -- 启动：静默检查，只在“内置横幅会出现”的那个条件成立时才出现并更新 ---

	pi.on("session_start", (event, ctx) => {
		currentCtx = ctx;
		if (autoTimer) {
			clearTimeout(autoTimer);
			autoTimer = undefined;
		}
		if (event.reason !== "startup") return;
		if (process.env.PI_OFFLINE) return;
		const mode = autoMode();
		if (mode === "off") return;
		// 延迟触发：让 pi 内置的更新检查/横幅先跑，错开启动高峰；不阻塞启动，也不阻止退出
		autoTimer = setTimeout(() => {
			autoTimer = undefined;
			void runOnce(ctx, mode === "update", false);
		}, AUTO_DELAY_MS);
		autoTimer.unref?.();
	});

	pi.on("session_shutdown", () => {
		// Drop the delayed check and the captured ctx: both belong to the session that is going away.
		if (autoTimer) {
			clearTimeout(autoTimer);
			autoTimer = undefined;
		}
		if (hideTimer) {
			clearTimeout(hideTimer);
			hideTimer = undefined;
		}
		currentCtx = undefined;
	});

	// -- 手动命令 -----------------------------------------------------------

	pi.registerCommand("ext-update", {
		description: "Update extension packages now (usage: /ext-update [package])",
		handler: async (args, ctx) => {
			const source = args.trim() || undefined;
			await runOnce(ctx, true, true, source);
		},
	});
}

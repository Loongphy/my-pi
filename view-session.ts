import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import { existsSync, watch, statSync } from "node:fs";
import { join, basename } from "node:path";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";

// 配置
const PORT = 8090; // 可以修改为其他端口
const SCRIPT_PATH = "/root/.agents/skills/session-viewer/scripts/session-viewer.ts";
const OUTPUT_DIR = "/tmp";

// 服务器状态
let server: Server | null = null;
let currentSessionFile: string | null = null;
let currentHtmlFile: string | null = null;
let watcher: ReturnType<typeof watch> | null = null;
let clients: ServerResponse[] = []; // SSE 客户端列表

// 生成 HTML 文件
function generateHtml(sessionFile: string): string {
  const outputFile = join(OUTPUT_DIR, `session-${basename(sessionFile, '.jsonl')}.html`);
  try {
    const command = `node "${SCRIPT_PATH}" "${sessionFile}" --out "${outputFile}"`;
    execSync(command, { stdio: "pipe" });
    return outputFile;
  } catch (error) {
    console.error("Failed to generate HTML:", error);
    throw error;
  }
}

// 通知所有 SSE 客户端
function notifyClients() {
  const data = JSON.stringify({ type: "update", timestamp: Date.now() });
  clients.forEach(client => {
    client.write(`data: ${data}\n\n`);
  });
}

// 处理 SSE 请求
function handleSSE(req: IncomingMessage, res: ServerResponse) {
  if (req.url === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    // 发送初始事件
    res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
    clients.push(res);
    req.on("close", () => {
      clients = clients.filter(c => c !== res);
    });
    return true;
  }
  return false;
}

// 处理 HTML 请求
function handleHTML(req: IncomingMessage, res: ServerResponse) {
  if (req.url === "/" || req.url === "/index.html") {
    if (currentHtmlFile && existsSync(currentHtmlFile)) {
      const html = require("node:fs").readFileSync(currentHtmlFile, "utf-8");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("No session HTML generated yet");
    }
    return true;
  }
  return false;
}

// 启动 HTTP 服务器
function startServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (server) {
      resolve();
      return;
    }

    server = createServer((req, res) => {
      // 处理 CORS 预检请求
      if (req.method === "OPTIONS") {
        res.writeHead(200, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return;
      }

      // 尝试处理 SSE
      if (handleSSE(req, res)) return;
      // 尝试处理 HTML
      if (handleHTML(req, res)) return;
      // 其他请求
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(`Port ${PORT} is already in use`);
        reject(new Error(`Port ${PORT} is already in use`));
      } else {
        reject(err);
      }
    });

    server.listen(PORT, () => {
      console.log(`Session viewer server running at http://localhost:${PORT}`);
      resolve();
    });
  });
}

// 设置文件监视器
function setupWatcher(sessionFile: string) {
  if (watcher) {
    watcher.close();
  }

  try {
    watcher = watch(sessionFile, (eventType) => {
      if (eventType === "change") {
        console.log("Session file changed, regenerating HTML...");
        try {
          currentHtmlFile = generateHtml(sessionFile);
          notifyClients();
        } catch (error) {
          console.error("Failed to regenerate HTML:", error);
        }
      }
    });
    console.log(`Watching session file: ${sessionFile}`);
  } catch (error) {
    console.error("Failed to setup file watcher:", error);
  }
}

// 停止服务器
function stopServer() {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (server) {
    server.close();
    server = null;
  }
  clients = [];
  currentSessionFile = null;
  currentHtmlFile = null;
}

// 扩展主函数
export default function (pi: ExtensionAPI) {
  // 注册命令
  pi.registerCommand("view-session", {
    description: "Start real-time session viewer server",
    handler: async (args, ctx) => {
      try {
        // 获取当前会话文件
        const sessionFile = ctx.sessionManager.getSessionFile();
        if (!sessionFile) {
          ctx.ui.notify("No session file found (ephemeral session?)", "error");
          return;
        }

        // 检查会话文件是否存在
        if (!existsSync(sessionFile)) {
          ctx.ui.notify(`Session file not found: ${sessionFile}`, "error");
          return;
        }

        // 检查 session-viewer 脚本是否存在
        if (!existsSync(SCRIPT_PATH)) {
          ctx.ui.notify("session-viewer script not found", "error");
          return;
        }

        // 如果服务器已经在运行，但会话文件不同，需要更新
        if (server && currentSessionFile !== sessionFile) {
          ctx.ui.notify("Switching to new session file...", "info");
          stopServer();
        }

        // 启动服务器（如果尚未运行）
        if (!server) {
          await startServer();
          ctx.ui.notify(`Server started at http://localhost:${PORT}`, "info");
        }

        // 生成初始 HTML
        currentHtmlFile = generateHtml(sessionFile);
        currentSessionFile = sessionFile;

        // 设置文件监视器
        setupWatcher(sessionFile);

        // 尝试打开浏览器
        let opened = false;
        try {
          execSync(`xdg-open "http://localhost:${PORT}"`, { stdio: "ignore" });
          opened = true;
        } catch {
          try {
            execSync(`open "http://localhost:${PORT}"`, { stdio: "ignore" });
            opened = true;
          } catch {
            // 忽略错误
          }
        }

        if (opened) {
          ctx.ui.notify("Opened browser to real-time session viewer", "info");
        } else {
          ctx.ui.notify(`Open http://localhost:${PORT} in your browser`, "info");
        }

        ctx.ui.notify("Real-time updates enabled. Use /view-session:stop to stop server.", "info");

      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Error: ${message}`, "error");
      }
    },
  });

  // 注册停止命令
  pi.registerCommand("view-session:stop", {
    description: "Stop the session viewer server",
    handler: async (args, ctx) => {
      if (server) {
        stopServer();
        ctx.ui.notify("Session viewer server stopped", "info");
      } else {
        ctx.ui.notify("No server running", "info");
      }
    },
  });

  // 注册状态命令
  pi.registerCommand("view-session:status", {
    description: "Show session viewer server status",
    handler: async (args, ctx) => {
      if (server) {
        ctx.ui.notify(`Server running at http://localhost:${PORT}`, "info");
        ctx.ui.notify(`Watching: ${currentSessionFile}`, "info");
        ctx.ui.notify(`Clients connected: ${clients.length}`, "info");
      } else {
        ctx.ui.notify("Server not running", "info");
      }
    },
  });

  // 监听会话关闭事件，清理资源
  pi.on("session_shutdown", async (event, ctx) => {
    stopServer();
  });
}
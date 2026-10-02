#!/usr/bin/env python3
"""
token_bridge.py — Trae Work token 自动刷新桥（WSL 常驻）

为 Pi 插件提供：
  GET  /token          读取当前保存的 token（含 exp 解析）
  POST /refresh        挂 frida hook 抓最新 x-ide-token（等应用请求 ≤ wait 秒）
  GET  /status         frida-server / 网络服务状态

原理：hook 网络服务进程的 Cronet_UrlRequestParams_request_headers_add，
任何请求（含应用定时请求）都会带 x-ide-token，抓到即保存（覆盖旧值）。
"""
import json
import os
import time
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOKEN_PATH = os.path.join(BASE_DIR, "captures", "trae_token.txt")
PORT = 18790

# 全局状态
state = {
    "token": None,          # 最新抓到的 token
    "token_time": 0,
    "frida_ok": False,
    "net_pid": None,
    "hook_active": False,
    "last_error": "",
}

def load_token():
    try:
        with open(TOKEN_PATH) as f:
            return f.read().strip()
    except Exception:
        return None

def token_exp(token):
    try:
        import base64
        parts = token.split(".")
        pad = parts[1] + "=" * (-len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(pad))
        return payload.get("exp", 0)
    except Exception:
        return 0

def save_token(tok):
    with open(TOKEN_PATH, "w") as f:
        f.write(tok)
    state["token"] = tok
    state["token_time"] = time.time()

def find_net_service(dev):
    """找网络服务进程（加载 sscronet.dll 的 TRAE 进程）"""
    for p in dev.enumerate_processes():
        if "TRAE SOLO CN" not in p.name:
            continue
        try:
            s = dev.attach(p.pid)
            out = []
            sc = s.create_script("send(Process.findModuleByName('sscronet.dll') ? 'yes' : 'no');")
            sc.on("message", lambda m, d: out.append(m.get("payload") if isinstance(m, dict) else None))
            sc.load()
            time.sleep(0.2)
            s.detach()
            if out and out[0] == "yes":
                return p.pid
        except Exception:
            continue
    return None

JS_HOOK = r"""
var m = Process.findModuleByName('sscronet.dll');
var exps = {};
m.enumerateExports().forEach(function(e){ exps[e.name] = e.address; });
function cstr(p) { try { return p.readUtf8String(); } catch(e) { return null; } }
if (exps['Cronet_UrlRequestParams_request_headers_add']) {
    Interceptor.attach(exps['Cronet_UrlRequestParams_request_headers_add'], {
        onEnter: function(args) {
            try {
                var h = args[1];
                var key = cstr(h);
                if (!key) return;
                var val = null;
                try { val = cstr(h.add(0x18).readPointer()); } catch(e) {}
                if (key === 'x-ide-token' && val) {
                    send('TOKEN ' + val);
                }
            } catch(e) {}
        }
    });
}
send('READY');
"""

def refresh_once(wait_seconds=120):
    """挂 hook 等待抓 token。返回 (ok, token, error)"""
    if state["hook_active"]:
        return (True, state["token"], None)  # 已有活跃 hook，等它抓到
    try:
        import frida
        dev = frida.get_device_manager().add_remote_device("127.0.0.1:27042")
        # 快速检查 frida 可用
        dev.enumerate_processes()
    except Exception as e:
        state["last_error"] = "frida-server 不可用: %s" % str(e)[:120]
        return (False, None, state["last_error"])

    import frida
    try:
        dev = frida.get_device_manager().add_remote_device("127.0.0.1:27042")
        net_pid = find_net_service(dev)
        if not net_pid:
            state["last_error"] = "未找到网络服务进程（Trae 未运行？）"
            return (False, None, state["last_error"])
        state["net_pid"] = net_pid
        session = dev.attach(net_pid)
        script = session.create_script(JS_HOOK)
        got = []

        def on_msg(m, d):
            p = m.get("payload") if isinstance(m, dict) else None
            if isinstance(p, str) and p.startswith("TOKEN "):
                got.append(p[6:])
        script.on("message", on_msg)
        script.load()
        state["hook_active"] = True

        t0 = time.time()
        while time.time() - t0 < wait_seconds and not got:
            time.sleep(0.5)
        session.detach()
        state["hook_active"] = False

        if got:
            tok = got[-1].strip()
            save_token(tok)
            return (True, tok, None)
        state["last_error"] = "等待 %d 秒未捕获到请求（应用无网络活动）——请在 Trae 里发一条消息" % wait_seconds
        return (False, None, state["last_error"])
    except Exception as e:
        state["last_error"] = str(e)[:200]
        return (False, None, state["last_error"])

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/status":
            tok = state["token"] or load_token()
            self._json({
                "ok": True,
                "frida": state["frida_ok"],
                "net_pid": state["net_pid"],
                "hook_active": state["hook_active"],
                "token": bool(tok),
                "token_exp": token_exp(tok) if tok else 0,
                "last_error": state["last_error"],
            })
        elif path == "/token":
            tok = state["token"] or load_token()
            if tok:
                self._json({"ok": True, "token": tok, "exp": token_exp(tok)})
            else:
                self._json({"ok": False, "error": "no token saved"})
        elif path == "/refresh":
            # 解析 wait 参数
            wait = 120
            try:
                qs = self.path.split("?", 1)[1]
                for kv in qs.split("&"):
                    if kv.startswith("wait="):
                        wait = min(int(kv[5:]), 300)
            except Exception:
                pass
            ok, tok, err = refresh_once(wait)
            if ok and tok:
                self._json({"ok": True, "token": tok, "exp": token_exp(tok)})
            else:
                self._json({"ok": False, "error": err or "refresh failed"})
        else:
            self._json({"ok": False, "error": "unknown path"}, 404)

    def do_POST(self):
        if self.path.split("?")[0] == "/refresh":
            ok, tok, err = refresh_once(120)
            if ok and tok:
                self._json({"ok": True, "token": tok, "exp": token_exp(tok)})
            else:
                self._json({"ok": False, "error": err or "refresh failed"})
        else:
            self._json({"ok": False, "error": "unknown path"}, 404)

if __name__ == "__main__":
    # 启动时加载已有 token
    tok = load_token()
    if tok:
        state["token"] = tok
    print("token_bridge on %d (token: %s)" % (PORT, "yes" if tok else "no"), flush=True)
    # 后台线程定期保持 frida 状态检查（不自动 hook，避免持续注入）
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    server.serve_forever()

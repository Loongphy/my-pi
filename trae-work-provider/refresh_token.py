#!/usr/bin/env python3
"""
refresh_token.py — 从运行中的 Trae Work 抓取最新 x-ide-token（JWT）

原理：hook 网络服务进程的 Cronet_UrlRequestParams_request_headers_add，
等待下一个 create_agent_task 请求（用户需发一条消息触发），
提取其 x-ide-token 保存到 captures/trae_token.txt。

用法：
  python3 scripts/refresh_token.py            # 抓 token 保存
  python3 scripts/refresh_token.py --test     # 抓 token 并立即测试 create_agent_task
"""
import frida, time, sys, os, re, json, base64

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOKEN_PATH = os.path.join(BASE_DIR, "captures", "trae_token.txt")

def find_ai_agent(dev):
    for p in dev.enumerate_processes():
        if 'TRAE SOLO CN' not in p.name:
            continue
        try:
            s = dev.attach(p.pid)
            out = []
            sc = s.create_script("send(Process.findModuleByName('ai_agent.dll') ? 'yes' : 'no');")
            sc.on("message", lambda m, d: out.append(m.get("payload") if isinstance(m, dict) else None))
            sc.load(); time.sleep(0.5); s.detach()
            if out and out[0] == 'yes':
                return p.pid
        except Exception:
            continue
    return None

def find_net_service(dev):
    for p in dev.enumerate_processes():
        if 'TRAE SOLO CN' not in p.name:
            continue
        try:
            s = dev.attach(p.pid)
            out = []
            sc = s.create_script("send(Process.findModuleByName('sscronet.dll') ? 'yes' : 'no');")
            sc.on("message", lambda m, d: out.append(m.get("payload") if isinstance(m, dict) else None))
            sc.load(); time.sleep(0.5); s.detach()
            if out and out[0] == 'yes':
                return p.pid
        except Exception:
            continue
    return None

JS = r"""
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
                // value 在 +0x18 指针（std::string 布局）
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

def grab_token(timeout=300):
    dev = frida.get_device_manager().add_remote_device("127.0.0.1:27042")
    net_pid = find_net_service(dev)
    if not net_pid:
        print("[FAIL] 未找到网络服务进程（确认 Trae Work 在运行）")
        return None
    print(f"[INFO] 网络服务 PID={net_pid}，等待 create_agent_task 请求（请在 Trae 里发一条消息）...")
    session = dev.attach(net_pid)
    script = session.create_script(JS)
    result = []
    def on_msg(msg, data):
        p = msg.get("payload") if isinstance(msg, dict) else None
        if isinstance(p, str) and p.startswith("TOKEN "):
            result.append(p[6:])
    script.on("message", on_msg)
    script.load()
    t0 = time.time()
    while time.time() - t0 < timeout and not result:
        time.sleep(1)
    session.detach()
    if not result:
        print("[FAIL] 超时未捕获到 x-ide-token（请在 Trae Work 里发一条消息触发请求）")
        return None
    tok = result[0].strip()
    with open(TOKEN_PATH, "w") as f:
        f.write(tok)
    # 打印 token 信息
    try:
        parts = tok.split(".")
        pad = parts[1] + "=" * (-len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(pad))
        print(f"[OK] token 已保存 ({len(tok)}B) exp={payload.get('exp')} source={payload.get('data',{}).get('source')}")
    except Exception:
        print(f"[OK] token 已保存 ({len(tok)}B)")
    return tok

if __name__ == "__main__":
    tok = grab_token()
    if tok and "--test" in sys.argv:
        import subprocess
        print("[TEST] 运行 create_agent_task 测试...")
        r = subprocess.run(["node", os.path.join(BASE_DIR, "tests", "test_v47.js")],
                           capture_output=True, text=True, timeout=30)
        print(r.stdout[-500:])
        if r.returncode != 0:
            print(r.stderr[-300:])

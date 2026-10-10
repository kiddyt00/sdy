#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""barcode-demo 本地联调服务器（python3 标准库，零依赖）
- 静态托管 barcode-demo 目录：打开 http://127.0.0.1:8900 即演示页
- 转发 /barcode?code=xxx 到阿里云市场网关（getBarcode?Code=xxx）：注入 APPCODE，规避浏览器 CORS 与密钥泄漏
用法：
    python3 proxy.py
配置（appcode.txt 放本目录，两行）：
    第一行：阿里云市场 APPCODE
    第二行：云市场分配的真实网关完整地址（形如 https://xxx.market.alicloudapi.com/getBarcode）
也支持环境变量 BARCODE_APPCODE / BARCODE_GATEWAY（appcode.txt 存在时优先于环境变量）。
"""
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

PORT = int(os.environ.get("BARCODE_PORT", "8900"))
ROOT = os.path.dirname(os.path.abspath(__file__))


def load_config():
    appcode = os.environ.get("BARCODE_APPCODE", "")
    gateway = os.environ.get("BARCODE_GATEWAY", "")
    cfg = os.path.join(ROOT, "appcode.txt")
    if os.path.exists(cfg):
        lines = [ln.strip() for ln in open(cfg, encoding="utf-8") if ln.strip()]
        if lines:
            appcode = lines[0]
        if len(lines) > 1:
            gateway = lines[1]
    return appcode, gateway


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        self.appcode, self.gateway = load_config()
        super().__init__(*a, directory=ROOT, **kw)

    def do_GET(self):
        if self.path.startswith("/barcode"):
            self.forward()
        else:
            super().do_GET()

    def forward(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        code = (q.get("code") or q.get("Code") or [""])[0]
        if not self.appcode:
            self.send_json({"code": -1, "msg": "未配置 APPCODE（appcode.txt 第一行或环境变量 BARCODE_APPCODE）"}, 400)
            return
        if not self.gateway or "<market-gateway>" in self.gateway:
            self.send_json({"code": -1, "msg": "未配置网关地址（appcode.txt 第二行或环境变量 BARCODE_GATEWAY）"}, 400)
            return
        sep = "&" if "?" in self.gateway else "?"
        url = self.gateway.rstrip("/") + sep + "Code=" + urllib.parse.quote(code)
        req = urllib.request.Request(url, headers={"Authorization": "APPCODE " + self.appcode})
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                body = resp.read().decode("utf-8", "replace")
                self.send_json(json.loads(body))
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:300]
            self.send_json({"code": e.code, "msg": "网关错误 HTTP %s" % e.code, "detail": detail}, e.code)
        except Exception as e:  # noqa: BLE001
            self.send_json({"code": -1, "msg": "转发失败: %s" % e}, 502)

    def send_json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):  # 静默访问日志
        pass


if __name__ == "__main__":
    appcode, gateway = load_config()
    print("barcode-demo 本地服务器: http://127.0.0.1:%d/" % PORT)
    print("APPCODE 已配置: %s" % ("是" if appcode else "否（请在 appcode.txt 第一行填写）"))
    print("网关地址: %s" % (gateway or "未配置（请在 appcode.txt 第二行填写）"))
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()

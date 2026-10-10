#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""将本地文件导入为腾讯文档在线文档（Open API v2 导入流程）。
用法: push_tencent_docs.py <文件路径> [文档标题]
流程: 预导入(获取COS上传地址) -> PUT上传COS -> 异步导入 -> 轮询导入进度 -> 输出文档链接
凭证从 .tencent_docs_cred.json 读取（600 权限）。
"""
import hashlib, json, os, sys, time, urllib.parse, urllib.request
from datetime import datetime, timezone

import sync_docs_lib

BASE = "https://docs.qq.com"
CRED = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".tencent_docs_cred.json")
HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(HERE, ".tencent_docs_state.json")


def state_paths(stem):
    """按文档 stem 隔离状态文件，支持多文档并存。"""
    return os.path.join(HERE, f".tencent_docs_last_push.{stem}.txt")

def load_cred():
    with open(CRED, "r", encoding="utf-8") as f:
        return json.load(f)

def req(path, method="GET", body=None, headers=None, timeout=30):
    url = BASE + path
    data = None
    if body is not None:
        data = urllib.parse.urlencode(body).encode("utf-8")
    h = {"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"}
    if headers:
        h.update(headers)
    r = urllib.request.Request(url, data=data, headers=h, method=method)
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))

def put_cos(put_url, file_path, custom_headers):
    with open(file_path, "rb") as f:
        data = f.read()
    h = dict(custom_headers or {})
    r = urllib.request.Request(put_url, data=data, headers=h, method="PUT")
    with urllib.request.urlopen(r, timeout=60) as resp:
        return resp.status

def main():
    if len(sys.argv) < 2:
        print("用法: push_tencent_docs.py <文件路径> [文档标题]")
        sys.exit(1)
    file_path = sys.argv[1]
    title = sys.argv[2] if len(sys.argv) > 2 else os.path.basename(file_path)
    stem = os.path.splitext(os.path.basename(file_path))[0]
    LAST_PUSH = state_paths(stem)
    cred = load_cred()
    hdr = {
        "Access-Token": cred["access_token"],
        "Client-Id": cred["client_id"],
        "Open-Id": cred["open_id"],
    }
    md5 = hashlib.md5(open(file_path, "rb").read()).hexdigest()
    size = os.path.getsize(file_path)

    # 1) 预导入
    d = req("/openapi/drive/v2/files/upload", "POST",
            {"fileMD5": md5, "fileName": os.path.basename(file_path), "fileSize": size}, hdr)
    if d.get("ret") != 0:
        print("预导入失败:", d)
        sys.exit(2)
    cos = d["data"]
    print("1/4 预导入 OK, COSFileKey =", cos["COSFileKey"])

    # 2) 上传到 COS
    status = put_cos(cos["COSPutURL"], file_path, cos.get("CustomHeader"))
    print("2/4 COS 上传 OK, HTTP", status)

    # 3) 异步导入（fileName 需带支持的后缀，如 .docx）
    ext = os.path.splitext(file_path)[1] or ".docx"
    import_name = title if title.endswith(ext) else title + ext
    d = req("/openapi/drive/v2/files/async-import", "POST",
            {"fileMD5": md5, "fileName": import_name, "COSFileKey": cos["COSFileKey"]}, hdr)
    if d.get("ret") != 0:
        print("异步导入失败:", d)
        sys.exit(3)
    pq = d["data"]["progressQueryID"]
    print("3/4 异步导入已提交, progressQueryID 有效10分钟")

    # 4) 轮询进度
    deadline = time.time() + 120
    while time.time() < deadline:
        time.sleep(2)
        d = req("/openapi/drive/v2/files/import-progress?progressQueryID=" + urllib.parse.quote(pq), headers=hdr)
        if d.get("ret") != 0:
            print("进度查询失败:", d)
            sys.exit(4)
        data = d.get("data", {})
        prog = data.get("progress", 0)
        print("   进度:", prog, "%", "|", data.get("title", ""))
        if prog == 100:
            print("4/4 导入完成!")
            print("fileID :", data.get("ID"))
            print("title  :", data.get("title"))
            print("type   :", data.get("type"))
            print("url    :", data.get("url"))
            # 记录状态：按文档 stem 隔离，多文档并存互不覆盖
            state = {
                "fileID": data.get("ID"),
                "url": data.get("url"),
                "title": data.get("title"),
                "pushed_docx": os.path.abspath(file_path),
                "pushed_at": datetime.now(timezone.utc).isoformat(),
            }
            docs = {"docs": {}}
            if os.path.exists(STATE):
                try:
                    docs = json.load(open(STATE, encoding="utf-8"))
                    if "docs" not in docs:
                        docs = {"docs": docs}  # 迁移旧单文档格式
                except Exception:
                    docs = {"docs": {}}
            docs["docs"][stem] = state
            with open(STATE, "w", encoding="utf-8") as f:
                json.dump(docs, f, ensure_ascii=False, indent=2)
            lines = sync_docs_lib.docx_text_lines(file_path)
            with open(LAST_PUSH, "w", encoding="utf-8") as f:
                f.write("\n".join(lines))
            print(f"状态已写入 .tencent_docs_state.json[docs.{stem}] / {os.path.basename(LAST_PUSH)}")
            return data
    print("导入超时(120s)，可稍后用 progressQueryID 再查:", pq)
    sys.exit(5)

if __name__ == "__main__":
    main()

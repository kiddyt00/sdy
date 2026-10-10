#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""设置腾讯文档分享权限（Open API v2）。

端点（文档: docs.qq.com/open/document/app/openapi/v2/file/files/permission/set.html）:
    PATCH https://docs.qq.com/openapi/drive/v2/files/{fileID}/permission
    Content-Type: application/x-www-form-urlencoded
    Headers: Access-Token / Client-Id / Open-Id
    Body: policy=private|members|publicRead|publicWrite, copyEnabled, readerCommentEnabled
    需 scope.drive.file.permission
响应: {"ret":0,"msg":"Succeed"}

用法:
    .venv/bin/python3 set_tencent_permission.py <fileID> [policy]   # 默认 publicWrite
    .venv/bin/python3 set_tencent_permission.py --last <stem> [policy]  # 从 state 按 stem 取 fileID
"""
import json
import sys
import urllib.parse
import urllib.request

CRED = "/home/kiddyt00/GolandProjects/sdy/.tencent_docs_cred.json"
STATE = "/home/kiddyt00/GolandProjects/sdy/.tencent_docs_state.json"
URL = "https://docs.qq.com/openapi/drive/v2/files/{fid}/permission"


def main():
    args = sys.argv[1:]
    if not args:
        print("用法: set_tencent_permission.py <fileID> [policy] | --last <stem> [policy]")
        sys.exit(2)
    if args[0] == "--last":
        stem = args[1]
        policy = args[2] if len(args) > 2 else "publicWrite"
        with open(STATE, encoding="utf-8") as f:
            state = json.load(f)
        fid = state["docs"][stem]["fileID"]
    else:
        fid = args[0]
        policy = args[1] if len(args) > 1 else "publicWrite"
    with open(CRED, encoding="utf-8") as f:
        cred = json.load(f)

    body = urllib.parse.urlencode({
        "policy": policy,
        "copyEnabled": "true",
        "readerCommentEnabled": "true",
    }).encode()
    req = urllib.request.Request(URL.format(fid=fid), data=body, method="PATCH")
    req.add_header("Access-Token", cred["access_token"])
    req.add_header("Client-Id", cred["client_id"])
    req.add_header("Open-Id", cred["open_id"])
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    req.add_header("Accept", "application/json")
    with urllib.request.urlopen(req, timeout=15) as resp:
        result = json.loads(resp.read().decode("utf-8"))
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0 if result.get("ret") == 0 else 1)


if __name__ == "__main__":
    main()

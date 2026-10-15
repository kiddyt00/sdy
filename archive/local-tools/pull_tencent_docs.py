# -*- coding: utf-8 -*-
"""从腾讯文档拉取在线文档（导出为 docx）并与「上次推送快照」比对。

用法:
    python pull_tencent_docs.py [--fileID FILEID] [--out OUT.docx]

默认 fileID 取自 .tencent_docs_state.json 的 fileID（当前在线文档）。
流程: async-export -> export-progress(轮询) -> 下载 docx -> 提取文本
      -> 与 .tencent_docs_last_push.txt 比对 -> 输出差异报告。
"""
import argparse
import difflib
import json
import os
import sys
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CRED = os.path.join(HERE, '.tencent_docs_cred.json')
STATE = os.path.join(HERE, '.tencent_docs_state.json')
MAIN_STEM = '独立小程序商城可行性分析与架构方案'
DEFAULT_OUT = os.path.join(HERE, '在线文档拉取.docx')

import sync_docs_lib  # noqa: E402


def api(url, method='GET', data=None):
    cred = json.load(open(CRED, encoding='utf-8'))
    h = {
        'Access-Token': cred['access_token'],
        'Client-Id': cred['client_id'],
        'Open-Id': cred['open_id'],
        'Accept': 'application/json',
    }
    body = urllib.parse.urlencode(data).encode() if data else None
    req = urllib.request.Request(url, data=body, headers=h, method=method)
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read().decode())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--fileID')
    ap.add_argument('--stem', default=MAIN_STEM, help='文档标识（默认主方案文档）')
    ap.add_argument('--out', default=DEFAULT_OUT)
    args = ap.parse_args()

    LAST_PUSH = os.path.join(HERE, f'.tencent_docs_last_push.{args.stem}.txt')

    if args.fileID:
        fid = args.fileID
    elif os.path.exists(STATE):
        docs = json.load(open(STATE, encoding='utf-8')).get('docs', {})
        entry = docs.get(args.stem)
        if not entry:
            print(f'状态文件中无文档 [{args.stem}]，请先推送该文档或用 --fileID 指定')
            sys.exit(2)
        fid = entry['fileID']
    else:
        print('未提供 --fileID 且无 .tencent_docs_state.json')
        sys.exit(2)

    base = 'https://docs.qq.com/openapi/drive/v2/files/' + urllib.parse.quote(fid, safe='$')

    print(f'1/3 发起导出 fileID={fid}')
    r = api(base + '/async-export', 'POST', {'exportType': 'doc'})
    op = r['data']['operationID']

    print('2/3 轮询导出进度')
    url = None
    for _ in range(15):
        time.sleep(2)
        rp = api(base + '/export-progress?operationID=' + urllib.parse.quote(op))
        p = rp['data']['progress']
        print(f'    进度 {p}%')
        if p == 100:
            url = rp['data']['url']
            break
    if not url:
        print('导出超时，请稍后重试（注意：导出每用户每天限 9 次）')
        sys.exit(1)

    print(f'3/3 下载 docx -> {args.out}')
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=90) as r:
        data = r.read()
    open(args.out, 'wb').write(data)

    pulled = sync_docs_lib.docx_text_lines(args.out)
    print(f'在线文档文本行数: {len(pulled)}')

    if os.path.exists(LAST_PUSH):
        pushed = open(LAST_PUSH, encoding='utf-8').read().split('\n')
        pushed = [ln for ln in pushed if ln.strip()]
    else:
        pushed = []
        print('无上次推送快照（.tencent_docs_last_push.txt），仅拉取不做比对。')

    sm = difflib.SequenceMatcher(None, pushed, pulled)
    changed = 0
    samples = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag != 'equal':
            changed += 1
            for k in range(j1, j2):
                samples.append('+ ' + pulled[k][:120])
            for k in range(i1, i2):
                samples.append('- ' + pushed[k][:120])
    print(f'与上次推送比对: {changed} 处差异')
    if changed:
        print('--- 差异样例（前 20 行）---')
        for s in samples[:20]:
            print('   ', s)
        print('>>> 在线文档存在外部修改，需先合并进本地 HTML 再编辑！')
    else:
        print('>>> 在线内容与上次推送一致，可放心编辑本地文档。')

    # 记录本次拉取文本快照（供追溯）
    open(os.path.join(HERE, '.tencent_docs_last_pull.txt'), 'w', encoding='utf-8').write('\n'.join(pulled))


if __name__ == '__main__':
    main()

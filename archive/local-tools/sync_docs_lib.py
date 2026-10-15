# -*- coding: utf-8 -*-
"""腾讯文档 <-> 本地 docx 文本同步共用库。

docx 文本提取：按 body 中块（段落/表格）顺序输出归一化行文本，
供「拉取在线文档 vs 上次推送快照」比对使用。
"""
import hashlib
import re

import docx as python_docx  # python-docx 1.2.0
from docx.table import Table
from docx.text.paragraph import Paragraph


def _norm(seg):
    """折叠空白，去掉首尾空格。"""
    return re.sub(r'\\s+', ' ', seg).strip()


def docx_text_lines(path):
    """按文档顺序提取 docx 的文本行（归一化后），供双向比对。

    段落 -> 按换行拆成多行（每行折叠空白）；
    表格 -> 每行一行，单元格用 ' | ' 连接，前缀 ▮ 标识表格行。
    归一化可消除「本地生成 docx 用段内换行、腾讯导出用独立段落」造成的格式噪音。
    """
    d = python_docx.Document(path)
    lines = []
    body = d.element.body
    for child in body.iterchildren():
        tag = child.tag
        if tag.endswith('}p'):
            for seg in Paragraph(child, d).text.split('\n'):
                t = _norm(seg)
                if t:
                    lines.append(t)
        elif tag.endswith('}tbl'):
            tbl = Table(child, d)
            for row in tbl.rows:
                cells = []
                for c in row.cells:
                    t = _norm(c.text.replace('\n', ' '))
                    if t:
                        cells.append(t)
                if cells:
                    lines.append('▮ ' + ' | '.join(cells))
    return lines


def text_md5(text):
    return hashlib.md5(text.encode('utf-8')).hexdigest()

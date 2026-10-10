#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""将 HTML 方案文档转换为 .docx（可编辑）与 .md（可导入协作文档）。
用法: convert_html.py [输入.html]
默认处理主方案文档；输出与输入同名的 .docx / .md。
用 lxml 解析，分别用 python-docx / markdown 文本两个发射器输出。"""
import re
import sys
import os
from lxml import html as LH
from docx import Document
from docx.shared import Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

SRC = "/home/kiddyt00/GolandProjects/sdy/独立小程序商城可行性分析与架构方案.html"
if len(sys.argv) > 1:
    SRC = sys.argv[1]
SRC = os.path.abspath(SRC)
STEM = os.path.splitext(SRC)[0]
OUT_DOCX = STEM + ".docx"
OUT_MD = STEM + ".md"

tree = LH.parse(SRC)
root = tree.getroot()
body = root.find("body")
if body is None:
    body = root

def divs_with_class(el, token):
    return [e for e in el.iter("div") if token in (e.get("class") or "").split()]

def div_with_class(el, token):
    return next((e for e in el.iter("div") if token in (e.get("class") or "").split()), None)

COLOR_MAP = {"y": "B45309", "b": "1D4ED8", "g": "15803D", "r": "DC2626"}
CALL_FILL = {"blue": "E8F1FB", "green": "EAF7EC", "": "FBF3E4", "green2": "EAF7EC"}

# ---------------- shared text walkers ----------------

def walk_nodes(el):
    """yield (text, fmt) where fmt is a dict with bold/color/url."""
    tag = el.tag
    if tag is None or not isinstance(tag, str):
        if el.text:
            yield (el.text, {})
        return
    if tag == "comment" or tag in ("style", "script"):
        return
    if el.text:
        yield (el.text, {})
    for child in el:
        f = {}
        t = child.tag
        if t == "strong" or t == "b":
            f["bold"] = True
        elif t == "span":
            cls = child.get("class", "")
            if cls in COLOR_MAP:
                f["color"] = COLOR_MAP[cls]
            if cls == "hl":
                f["bold"] = True
        elif t == "a":
            f["url"] = child.get("href", "")
        for t2, f2 in walk_nodes(child):
            if f2.get("bold"):
                f["bold"] = True
            if f2.get("color"):
                f["color"] = f2["color"]
            f2["url"] = f2.get("url") or f.get("url")
            yield (t2, f2)
        if child.tail:
            yield (child.tail, {})

def plain_text(el):
    """无格式纯文本（用于标题）。"""
    parts = []
    for t, _ in walk_nodes(el):
        parts.append(t)
    s = "".join(parts)
    s = re.sub(r"\s+", " ", s).strip()
    return s

# ---------------- markdown emitter ----------------

MD = []
def md_emit(text, level=None, kind=None):
    if level:
        MD.append("#" * level + " " + text)
    elif kind == "bullet":
        MD.append("- " + text)
    elif kind == "num":
        MD.append("1. " + text)
    elif kind == "quote":
        MD.append("> " + text)
    else:
        MD.append(text)

def md_inline(el):
    out = []
    for t, f in walk_nodes(el):
        t = t.replace("|", "\\|")
        if f.get("url"):
            t = "[%s](%s)" % (t.strip(), f["url"])
        if f.get("bold"):
            t = "**%s**" % t
        out.append(t)
    return re.sub(r"\s+", " ", "".join(out)).strip()

def md_heading_text(el):
    t = plain_text(el)
    if re.match(r"^\d+(?:\.\d+)*\s", t):
        return t
    return re.sub(r"^(\d+(?:\.\d+)*)", r"\1 ", t)

def md_table(el):
    rows = []
    for tr in el.findall(".//tr"):
        cells = []
        for cell in tr.findall("./th") + tr.findall("./td"):
            cells.append(md_inline(cell).strip())
        rows.append(cells)
    if not rows:
        return
    MD.append("")
    MD.append("| " + " | ".join(rows[0]) + " |")
    MD.append("| " + " | ".join(["---"] * len(rows[0])) + " |")
    for r in rows[1:]:
        MD.append("| " + " | ".join(r) + " |")
    MD.append("")

def md_handle(el, in_hero=False):
    tag = el.tag
    if not isinstance(tag, str):
        return
    if tag == "comment" or tag in ("style", "script"):
        return
    cls = el.get("class", "")
    if tag == "header" and "hero" in cls:
        for c in el:
            md_handle(c, in_hero=True)
        return
    if tag == "nav":
        return
    if tag == "section":
        for c in el:
            md_handle(c)
        return
    if tag == "h1":
        md_emit(plain_text(el), level=1)
        return
    if tag == "h2":
        md_emit(md_heading_text(el), level=2)
        return
    if tag == "h3":
        md_emit(md_heading_text(el), level=3)
        return
    if tag == "h4":
        md_emit(md_heading_text(el), level=4)
        return
    if tag == "table":
        md_table(el)
        return
    if tag == "ul" or tag == "ol":
        for li in el.findall("li"):
            md_handle_list_item(li, tag == "ol")
        return
    if tag == "p":
        if el.get("class") == "big":
            MD.append("")
            md_emit("**" + md_inline(el) + "**")
        else:
            md_emit(md_inline(el))
        return
    if tag == "div":
        if "flow" in cls:
            MD.append("")
            md_emit(md_inline(el), kind="quote")
            return
        if "callout" in cls:
            MD.append("")
            md_emit(md_inline(el), kind="quote")
            return
        if "concl" in cls:
            MD.append("")
            for c in el:
                md_handle(c)
            return
        if "arch" in cls or "layer" in cls:
            md_handle_arch(el)
            return
        if "timeline" in cls:
            for item in divs_with_class(el, "tl-item"):
                flag = div_with_class(item, "tl-flag")
                body_el = div_with_class(item, "tl-body")
                MD.append("")
                md_emit("**" + plain_text(flag) + "**")
                for c in body_el:
                    md_handle(c)
            return
        if "risk" in cls:
            rt = div_with_class(el, "rt")
            if rt is not None:
                MD.append("")
                md_emit("**" + md_inline(rt) + "**")
            for p in el.findall("./p"):
                md_emit(md_inline(p))
            return
        if "center" in cls:
            md_emit(md_inline(el))
            return
        if "verdict" in cls:
            MD.append("")
            md_emit(md_inline(el))
            return
        for c in el:
            md_handle(c)
        return
    for c in el:
        md_handle(c)

def md_handle_list_item(li, numbered):
    """处理 <li>：直接文本 + 子 ul/ol 嵌套缩进，其余内联。"""
    text_parts = []
    def collect(el):
        for child in el:
            if child.tag in ("ul", "ol"):
                continue
            text_parts.append(md_inline(child))
            collect(child)
    if li.text:
        text_parts.append(li.text)
    collect(li)
    lead = "".join(text_parts).strip()
    if lead:
        md_emit(lead, kind="num" if numbered else "bullet")
    for child in li:
        if child.tag in ("ul", "ol"):
            for sub in child.findall("li"):
                md_handle_list_item(sub, child.tag == "ol")

def md_handle_arch(el):
    layers = divs_with_class(el, "layer")
    if not layers and "layer" in el.get("class", ""):
        layers = [el]
    for layer in layers:
        lname = div_with_class(layer, "lname")
        MD.append("")
        md_emit("**" + plain_text(lname) + "**" if lname is not None else "")
        for box in divs_with_class(layer, "box"):
            t = div_with_class(box, "t")
            d = div_with_class(box, "d")
            label = plain_text(t) if t is not None else ""
            desc = plain_text(d) if d is not None else ""
            md_emit(("**%s**" % label + ("：" + desc if desc else "")), kind="bullet")

for el in body:
    md_handle(el)

MD_TEXT = "\n\n".join(x for x in MD if x)
with open(OUT_MD, "w", encoding="utf-8") as f:
    f.write(MD_TEXT + "\n")
print("MD written:", OUT_MD, len(MD_TEXT), "chars")

# ---------------- docx emitter ----------------

doc = Document()
normal = doc.styles["Normal"]
normal.font.name = "Microsoft YaHei"
normal.font.size = Pt(10.5)
normal.element.rPr.rFonts.set(qn("w:eastAsia"), "Microsoft YaHei")
for lvl, sz in (("Heading 1", 16), ("Heading 2", 13), ("Heading 3", 12), ("Heading 4", 11)):
    st = doc.styles[lvl]
    st.font.name = "Microsoft YaHei"
    st.font.size = Pt(sz)
    st.font.color.rgb = RGBColor(0x1F, 0x29, 0x37)
    st.element.rPr.rFonts.set(qn("w:eastAsia"), "Microsoft YaHei")

def add_shading(p, fill):
    pPr = p._p.get_or_add_pPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:fill"), fill)
    pPr.append(shd)

def add_runs(p, el):
    for t, f in walk_nodes(el):
        if f.get("url") and t.strip():
            p.add_run(t.strip() + " ")
            r = p.add_run("（" + f["url"] + "）")
            r.font.color.rgb = RGBColor(0x6B, 0x72, 0x80)
            r.font.size = Pt(9)
            continue
        r = p.add_run(t)
        if f.get("bold"):
            r.bold = True
        if f.get("color"):
            r.font.color.rgb = RGBColor.from_string(f["color"])

def dx_handle(el, in_hero=False):
    tag = el.tag
    if not isinstance(tag, str):
        return
    if tag == "comment" or tag in ("style", "script"):
        return
    cls = el.get("class", "")
    if tag == "header" and "hero" in cls:
        for c in el:
            dx_handle(c, in_hero=True)
        return
    if tag == "nav":
        return
    if tag == "section":
        for c in el:
            dx_handle(c)
        return
    if tag == "h1":
        if in_hero:
            p = doc.add_heading("", level=0)
            add_runs(p, el)
        else:
            p = doc.add_heading(plain_text(el), level=0)
        return
    if tag == "h2":
        p = doc.add_heading("", level=1)
        add_runs(p, el)
        return
    if tag == "h3":
        p = doc.add_heading("", level=2)
        add_runs(p, el)
        return
    if tag == "h4":
        p = doc.add_heading("", level=3)
        add_runs(p, el)
        return
    if tag == "table":
        rows = []
        for tr in el.findall(".//tr"):
            rows.append(tr.findall("./th") + tr.findall("./td"))
        if not rows:
            return
        ncol = max(len(r) for r in rows)
        tbl = doc.add_table(rows=len(rows), cols=ncol)
        tbl.style = "Table Grid"
        for i, r in enumerate(rows):
            for j in range(ncol):
                cell = tbl.cell(i, j)
                cell.paragraphs[0].text = ""
                if j < len(r):
                    add_runs(cell.paragraphs[0], r[j])
                if i == 0:
                    set_cell_bg(cell, "E5E7EB")
                    for run in cell.paragraphs[0].runs:
                        run.bold = True
        doc.add_paragraph()
        return
    if tag == "ul" or tag == "ol":
        for li in el.findall("li"):
            dx_list_item(li, tag == "ol")
        return
    if tag == "p":
        if el.get("class") == "big":
            p = doc.add_paragraph()
            add_runs(p, el)
            for run in p.runs:
                run.bold = True
                run.font.size = Pt(12)
        elif el.get("class") == "center":
            p = doc.add_paragraph()
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            add_runs(p, el)
        else:
            p = doc.add_paragraph()
            add_runs(p, el)
        return
    if tag == "div":
        if "flow" in cls:
            p = doc.add_paragraph()
            add_shading(p, "F8FAFC")
            add_runs(p, el)
            return
        if "callout" in cls:
            p = doc.add_paragraph()
            fill = CALL_FILL.get("blue" if "blue" in cls else "green" if "green" in cls else "")
            add_shading(p, fill)
            add_runs(p, el)
            return
        if "concl" in cls:
            p = doc.add_paragraph()
            add_shading(p, "F0FDF4")
            for c in el:
                dx_handle(c)
            return
        if "arch" in cls or "layer" in cls:
            dx_arch(el)
            return
        if "timeline" in cls:
            for item in divs_with_class(el, "tl-item"):
                flag = div_with_class(item, "tl-flag")
                body_el = div_with_class(item, "tl-body")
                if flag is not None:
                    p = doc.add_heading("", level=3)
                    add_runs(p, flag)
                if body_el is not None:
                    for c in body_el:
                        dx_handle(c)
            return
        if "risk" in cls:
            rt = div_with_class(el, "rt")
            if rt is not None:
                p = doc.add_paragraph()
                add_shading(p, "FEF3C7" if "risk h" in cls else "FFFBEB")
                add_runs(p, rt)
                for run in p.runs:
                    run.bold = True
            for p_el in el.findall("./p"):
                p = doc.add_paragraph()
                add_runs(p, p_el)
            return
        if "center" in cls:
            p = doc.add_paragraph()
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            add_runs(p, el)
            return
        if "verdict" in cls:
            p = doc.add_paragraph()
            add_shading(p, "EFF6FF")
            add_runs(p, el)
            return
        if "badges" in cls:
            p = doc.add_paragraph()
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            add_runs(p, el)
            return
        for c in el:
            dx_handle(c)
        return
    for c in el:
        dx_handle(c)

def dx_list_item(li, numbered):
    style = "List Number" if numbered else "List Bullet"
    p = doc.add_paragraph(style=style)
    if li.text and li.text.strip():
        p.add_run(li.text.strip())
    def collect(el):
        for child in el:
            if child.tag in ("ul", "ol"):
                continue
            add_runs(p, child)
            collect(child)
    collect(li)
    for child in li:
        if child.tag in ("ul", "ol"):
            for sub in child.findall("li"):
                dx_list_item(sub, child.tag == "ol")

def dx_arch(el):
    layers = divs_with_class(el, "layer")
    if not layers and "layer" in el.get("class", ""):
        layers = [el]
    for layer in layers:
        lname = div_with_class(layer, "lname")
        if lname is not None:
            p = doc.add_paragraph()
            add_runs(p, lname)
            for run in p.runs:
                run.bold = True
        for box in divs_with_class(layer, "box"):
            t = div_with_class(box, "t")
            d = div_with_class(box, "d")
            p = doc.add_paragraph(style="List Bullet")
            if t is not None:
                r = p.add_run(plain_text(t))
                r.bold = True
                if d is not None:
                    p.add_run("：" + plain_text(d))
            elif d is not None:
                p.add_run(plain_text(d))

def set_cell_bg(cell, fill):
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:fill"), fill)
    tcPr.append(shd)

for el in body:
    dx_handle(el)

doc.save(OUT_DOCX)
print("DOCX written:", OUT_DOCX)

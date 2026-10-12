#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""演示数据灌库脚本（幂等；只用于「打开界面能看到真实内容」，正式开张前清库重建）

用法：
    python3 deploy/seed-demo.py http://<生产地址或本机 127.0.0.1:8093> [--force-orders]

做什么：
    1) upsert 14 款商品：覆盖「正常价 / 批发 / 缺参考价 / 低库存 / 缺货」五种状态，
       并给演示款挂上仓库自带的 SVG 商品图（web/assets/demo/*.svg）；
    2) 补 3 条收货地址簿（已存在同手机号同地址则跳过）；
    3) 库里没有订单时（或加 --force-orders）造 6 张订单并把状态推到
       已完成 / 待自提(ready) / 配送中 / 待备货 / 已取消，用于验证报表与流转。
    4) 打印一份核对摘要（商品数 / 订单数 / 营业额等）。

为什么单独留一个脚本：上一轮演示数据是手敲 curl 灌的，没有任何可复现来源，
生产库一旦被误删就只能靠记忆重建。数据要能一键再来一遍。
"""
import json
import sys
import urllib.error
import urllib.request

# (code, name, brand, spec, category, unit, costPrice, salePrice, refPrice, stock, isWholesale)
PRODUCTS = [
    ("6901234567892", "可口可乐", "可口可乐", "330ml 罐装", "饮料", "罐", 1.8, 2.5, 0, 120, False),
    ("6902083881234", "农夫山泉", "农夫山泉", "550ml", "饮料", "瓶", 1.1, 1.8, 0, 200, False),
    ("6921168509256", "心相印抽纸", "心相印", "3层100抽", "纸品", "包", 3.2, 4.5, 0, 60, False),
    ("6925303725941", "旺旺雪饼", "旺旺", "84g", "休闲零食", "袋", 3.0, 4.5, 0, 40, False),
    ("6901001100113", "青岛啤酒", "青岛", "500ml 罐", "酒水", "罐", 4.2, 6.0, 0, 90, False),
    ("6907992751797", "伊利纯牛奶", "伊利", "250ml", "乳饮", "盒", 2.6, 3.5, 0, 80, False),
    # ↓ 带参考价（价格防线会真的拦）：售价必须 ≤ 参考价 × 95%
    ("6928804011154", "康师傅冰红茶", "康师傅", "500ml", "饮料", "瓶", 2.6, 3.5, 3.8, 60, False),
    ("6934665090018", "蒙牛纯甄酸奶", "蒙牛", "200g", "乳饮", "盒", 3.4, 4.5, 5.0, 36, False),
    ("6902265114369", "海天金标生抽", "海天", "500ml", "调味", "瓶", 6.8, 8.5, 9.0, 18, False),
    ("6902088707050", "金龙鱼调和油", "金龙鱼", "900ml", "粮油", "瓶", 27.0, 32.0, 34.0, 9, False),
    ("6921168509263", "心相印抽纸 10 包装", "心相印", "3层100抽×10", "纸品", "提", 30.0, 36.0, 38.0, 12, False),
    ("6920202888883", "红牛维生素功能饮料", "红牛", "250ml", "饮料", "罐", 4.9, 6.0, 6.5, 9, False),
    ("6901234567001", "五粮春", "五粮春", "500ml", "酒水", "瓶", 76.0, 88.0, 95.0, 6, True),   # 批发
    ("6925303725942", "旺旺雪饼 84g（缺货）", "旺旺", "84g", "休闲零食", "袋", 3.0, 4.5, 4.8, 0, False),
]

# 演示商品图（仓库内自带 SVG，随静态目录一起部署，不依赖外网图床）
IMAGES = {
    "可口可乐": "assets/demo/kele.svg",
    "青岛啤酒": "assets/demo/qingdao.svg",
    "红牛维生素功能饮料": "assets/demo/hongniu.svg",
    "五粮春": "assets/demo/wuliangchun.svg",
    "旺旺雪饼": "assets/demo/wangwang.svg",
    "旺旺雪饼 84g（缺货）": "assets/demo/wangwang.svg",
}

# (phone, contact, address, isDefault)
ADDRESSES = [
    ("13800001111", "王阿姨", "幸福路 1 号 3 单元 501", True),
    ("13900002222", "李叔", "建设街 22 号 1 单元 102", False),
    ("13700003333", "张婶", "光明巷 8 号", False),
]

# (name, phone, address, deliveryType, [(商品名, 数量)], 目标状态链)
ORDERS = [
    ("王阿姨", "13800001111", "幸福路 1 号 3 单元 501", "delivery", [("青岛啤酒", 4)], ["delivering", "done"]),
    ("王阿姨", "13800001111", "幸福路 1 号 3 单元 501", "delivery", [("伊利纯牛奶", 6), ("心相印抽纸", 2)], ["cancelled"]),
    ("王阿姨", "13800001111", "幸福路 1 号 3 单元 501", "delivery", [("金龙鱼调和油", 1), ("蒙牛纯甄酸奶", 6)], ["ready"]),
    ("李叔", "13900002222", "建设街 22 号 1 单元 102", "pickup", [("红牛维生素功能饮料", 4), ("康师傅冰红茶", 6), ("蒙牛纯甄酸奶", 6)], ["delivering"]),
    ("张婶", "13700003333", "光明巷 8 号", "delivery", [("伊利纯牛奶", 4)], []),
    ("老陈", "13600004444", "", "pickup", [("红牛维生素功能饮料", 4)], []),
]


def call(base, method, path, body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            raw = res.read().decode("utf-8")
            return res.status, (json.loads(raw) if raw.strip() else {})
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"error": raw}


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    base = sys.argv[1].rstrip("/")
    force_orders = "--force-orders" in sys.argv

    # 1) 商品
    ok = 0
    for (code, name, brand, spec, cat, unit, cost, sale, ref, stock, whole) in PRODUCTS:
        st, body = call(base, "POST", "/api/products", {
            "code": code, "name": name, "brand": brand, "spec": spec, "category": cat,
            "unit": unit, "costPrice": cost, "salePrice": sale, "refPrice": ref,
            "stock": stock, "isWholesale": whole, "img": IMAGES.get(name, ""),
        })
        if 200 <= st < 300:
            ok += 1
        else:
            print("  ⚠️ 商品 %s(%s) 被拒：%s" % (name, code, body.get("error")))
    print("✅ 商品 upsert：%d/%d" % (ok, len(PRODUCTS)))

    st, plist = call(base, "GET", "/api/products")
    products = plist.get("items", []) if isinstance(plist, dict) else []
    by_name = {}
    for p in products:
        by_name.setdefault(p["name"], p)
    print("   库里现有商品：%d 款" % len(products))

    # 2) 地址簿
    added = 0
    for (phone, contact, addr, is_default) in ADDRESSES:
        st, cur = call(base, "GET", "/api/addresses?phone=" + phone)
        exist = [a for a in (cur.get("items") or []) if a.get("address") == addr]
        if exist:
            continue
        st, body = call(base, "POST", "/api/addresses", {
            "id": 0, "phone": phone, "contact": contact, "address": addr, "isDefault": is_default,
        })
        if 200 <= st < 300:
            added += 1
        else:
            print("  ⚠️ 地址 %s 失败：%s" % (addr, body.get("error")))
    print("✅ 地址簿新增：%d 条" % added)

    # 3) 订单
    st, olist = call(base, "GET", "/api/orders")
    orders = olist.get("items", []) if isinstance(olist, dict) else []
    if orders and not force_orders:
        print("ℹ️ 库里已有 %d 张订单，跳过造单（要重造请加 --force-orders）" % len(orders))
    else:
        made = 0
        for (name, phone, addr, dtype, items, flow) in ORDERS:
            lines = []
            for (pname, qty) in items:
                p = by_name.get(pname)
                if not p:
                    print("  ⚠️ 找不到商品 %s，跳过该单" % pname)
                    lines = []
                    break
                lines.append({"code": p["code"], "qty": qty})
            if not lines:
                continue
            st, body = call(base, "POST", "/api/orders", {
                "customerName": name, "phone": phone, "address": addr,
                "deliveryType": dtype, "items": lines,
            })
            if not (200 <= st < 300):
                print("  ⚠️ 下单失败（%s）：%s" % (name, body.get("error")))
                continue
            oid = body.get("id")
            for to in flow:  # 按状态机逐级推进：pending → delivering/ready → done / cancelled
                st2, b2 = call(base, "POST", "/api/orders/%s/advance" % oid, {"to": to})
                if not (200 <= st2 < 300):
                    print("  ⚠️ 订单 %s 推进到 %s 失败：%s" % (oid, to, b2.get("error")))
            made += 1
        print("✅ 订单新增：%d 张" % made)

    # 4) 核对摘要
    st, olist = call(base, "GET", "/api/orders")
    orders = olist.get("items", []) if isinstance(olist, dict) else []
    live = [o for o in orders if o.get("status") != "cancelled"]
    rev = sum(o.get("total", 0) for o in live)
    goods = sum(o.get("subtotal", 0) for o in live)
    fee = sum(o.get("deliveryFee", 0) for o in live)
    qty = sum(i.get("qty", 0) for o in live for i in (o.get("items") or []))
    print("\n📊 核对摘要")
    print("   商品 %d 款 / 订单 %d 张（其中取消 %d）" % (len(products), len(orders), len(orders) - len(live)))
    print("   营业额 ¥%.2f / 商品金额 ¥%.2f / 配送费 ¥%.2f / 售出 %g 件" % (rev, goods, fee, qty))
    print("   客单价 ¥%.2f" % (rev / len(live) if live else 0))
    for o in orders:
        print("   %-22s %-10s ¥%-7.2f %s" % (o["id"], o["status"], o.get("total", 0), o.get("customerName", "")))
    return 0


if __name__ == "__main__":
    sys.exit(main())

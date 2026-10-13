#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""演示数据灌库脚本（幂等；只用于「打开界面能看到真实内容」，正式开张前清库重建）

用法：
    python3 deploy/seed-demo.py http://<生产地址或本机 127.0.0.1:8093> [--force-orders]

做什么：
    1) upsert 14 款商品：覆盖「正常价 / 批发 / 缺参考价 / 低库存 / 缺货」五种状态，
       并给演示款挂上仓库自带的 SVG 商品图（web/assets/demo/*.svg）；
       其中 7 款顺带写上批发价（WHOLESALE 表），演示「按顾客等级看价」；
    1.5) 登记 2 位顾客等级（王阿姨=批发 / 李叔=白名单），手机号即身份（D24）；
    2) 补 3 条收货地址簿（已存在同手机号同地址则跳过）；
    3) 库里没有订单时（或加 --force-orders）造 6 张订单并把状态推到
       已完成 / 待自提(ready) / 配送中 / 待备货 / 已取消，用于验证报表与流转。
    3.5) 库存审计 / 配送员 / 门店抬头（D25，原本只存在浏览器 localStorage）：
       没有流水时补 3 笔（入库 / 改数 / 盘点，带 reason + by）；
       配送员名单为空时补 4 位；门店抬头仍是默认「家庭超市」时改成演示店名。
       这三样都是「只在空/默认时填」，重复执行不会覆盖你改过的值。
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

# 批发价（任务池⑦ / D24）：0 或不在表里 = 没设批发价（批发客户也按零售价）
# 整箱/整提/酒水这类「成箱拿货」的商品最适合设批发价，演示时一眼能看出差别。
WHOLESALE = {
    "可口可乐": 2.2,
    "农夫山泉": 1.6,
    "青岛啤酒": 5.4,
    "红牛维生素功能饮料": 5.4,
    "五粮春": 78.0,
    "心相印抽纸 10 包装": 32.0,
    "金龙鱼调和油": 29.0,
}

# 顾客等级（D24）：手机号即身份，零售 / 批发 / 白名单（价格口径真源在服务端）
#   (phone, name, tier)
CUSTOMER_TIERS = [
    ("13800001111", "王阿姨", "wholesale"),
    ("13900002222", "李叔", "vip"),
]

# (phone, contact, address, isDefault)
ADDRESSES = [
    ("13800001111", "王阿姨", "幸福路 1 号 3 单元 501", True),
    ("13900002222", "李叔", "建设街 22 号 1 单元 102", False),
    ("13700003333", "张婶", "光明巷 8 号", False),
]

# 配送员名单（D25，落库到 courier 表）：后端首次启动也会自己种子这 4 位，这里只是兜底
SEED_COURIERS = [
    ("老张", "13800005001"),
    ("小李", "13800005002"),
    ("阿强", "13800005003"),
    ("小美", "13800005004"),
]

# 门店抬头（D25，落库到 setting 表）：只在库里还是默认「家庭超市」时写入
STORE = {
    "name": "小邻里超市",
    "phone": "0591-88888888",
    "address": "福建省福州市水东洋便利店",
    "footer": "谢谢惠顾，欢迎再来！",
}

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
            "wholesalePrice": WHOLESALE.get(name, 0),   # 不带就会被后端的 excluded.wholesale_price 清零
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
    print("   库里现有商品：%d 款（带批发价 %d 款）"
          % (len(products), len([p for p in products if (p.get("wholesalePrice") or 0) > 0])))

    # 1.5) 顾客等级（D24）：登记 2 位批发/白名单客户，方便演示「按等级看价」
    tiers = 0
    for (phone, name, tier) in CUSTOMER_TIERS:
        st, body = call(base, "POST", "/api/customers/tier",
                        {"phone": phone, "name": name, "tier": tier})
        if 200 <= st < 300:
            tiers += 1
        else:
            print("  ⚠️ 顾客等级 %s(%s) 失败：%s" % (name, phone, body.get("error")))
    ids = {}
    for (phone, name, tier) in CUSTOMER_TIERS:
        st, one = call(base, "GET", "/api/customers")
        for c in (one.get("items") or []):
            if c.get("phone") == phone:
                ids[phone] = c
    print("✅ 顾客等级已设置：%d 位（%s）"
          % (tiers, "、".join("%s=%s" % (p, (ids.get(p) or {}).get("tier", "?")) for (p, _n, _t) in CUSTOMER_TIERS)))

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

    # 3.5) 库存审计 / 配送员 / 门店抬头（D25）：把原本只活在浏览器 localStorage 的三样搬进库
    st, slog = call(base, "GET", "/api/stocklog?limit=500")
    log_total = slog.get("total") or 0
    if log_total == 0:
        coke = by_name.get("可口可乐")
        if not coke:
            print("  ⚠️ 找不到可口可乐，跳过库存流水演示")
        else:
            code = coke["code"]
            for (kind, qty, reason, by) in [
                ("stock_in", 24, "到货入库（整箱）", "老板"),
                ("adjust", -2, "破损报废", "店员小王"),
            ]:
                st, body = call(base, "POST", "/api/stock/change",
                                {"code": code, "kind": kind, "qty": qty, "reason": reason, "by": by})
                if not (200 <= st < 300):
                    print("  ⚠️ 库存流水（%s）失败：%s" % (kind, body.get("error")))
            st, one = call(base, "GET", "/api/products?keyword=" + code)
            cur = ((one.get("items") or [{}])[0]).get("stock", 0)
            st, body = call(base, "POST", "/api/stock/change",
                            {"code": code, "kind": "stock_take", "qty": cur,
                             "reason": "月底盘点校准", "by": "老板"})
            if not (200 <= st < 300):
                print("  ⚠️ 库存盘点失败：%s" % body.get("error"))
            st, slog = call(base, "GET", "/api/stocklog?limit=500")
            log_total = slog.get("total") or 0
    else:
        print("ℹ️ 库里已有 %d 条库存流水，跳过造流水" % log_total)
    latest = (slog.get("items") or [{}])[0]
    print("✅ 库存流水：%d 条（最新：%s %s %s，%s）"
          % (log_total, latest.get("kind", "-"), latest.get("name", "-"),
             ("%+g" % latest.get("delta", 0)), latest.get("reason", "")))

    st, couriers = call(base, "GET", "/api/couriers")
    cur_couriers = couriers.get("items") or []
    if not cur_couriers:
        for (cname, cphone) in SEED_COURIERS:
            st, body = call(base, "POST", "/api/couriers", {"name": cname, "phone": cphone})
            if not (200 <= st < 300):
                print("  ⚠️ 配送员 %s 失败：%s" % (cname, body.get("error")))
        st, couriers = call(base, "GET", "/api/couriers")
        cur_couriers = couriers.get("items") or []
    print("✅ 配送员：%d 位（%s）"
          % (len(cur_couriers), "、".join(c.get("name", "") for c in cur_couriers)))

    st, store = call(base, "GET", "/api/settings")
    if (store.get("name") or "").strip() in ("", "家庭超市"):
        st, body = call(base, "POST", "/api/settings", STORE)
        if 200 <= st < 300:
            store = body
        else:
            print("  ⚠️ 门店抬头保存失败：%s" % body.get("error"))
    else:
        print("ℹ️ 门店抬头已是「%s」，保留不改" % store.get("name"))
    print("✅ 门店抬头：%s（%s，页脚：%s）"
          % (store.get("name", ""), store.get("phone", ""), store.get("footer", "")))

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
    st, custs = call(base, "GET", "/api/customers")
    cust_items = custs.get("items", []) if isinstance(custs, dict) else []
    print("   顾客 %d 位（批发 / 白名单 %d 位）" % (len(cust_items), len([c for c in cust_items if c.get("tier") in ("wholesale", "vip")])))
    print("   带批发价商品 %d 款" % len([p for p in products if (p.get("wholesalePrice") or 0) > 0]))
    print("   库存流水 %d 条 / 配送员 %d 位 / 门店抬头 %s"
          % (log_total, len(cur_couriers), store.get("name", "")))
    for o in orders:
        print("   %-22s %-10s ¥%-7.2f %s" % (o["id"], o["status"], o.get("total", 0), o.get("customerName", "")))
    return 0


if __name__ == "__main__":
    sys.exit(main())

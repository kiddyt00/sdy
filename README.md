# 独立小程序商城（sdy）

自营微信小程序商城项目：商品、价格、库存、订单、配送、顾客全部自管理，完全独立于牵牛花中台，仅保留**月度 CSV 库存同步**。

> 当前阶段：方案与决策已沉淀，进入「页面展示优先」开发（M1.1 顾客端商城 demo 进行中）。

## 文档

| 文件 | 说明 |
| --- | --- |
| `独立小程序商城可行性分析与架构方案.html` | 总体架构方案（13 章，含双库设计 §2.7） |
| `细节讨论记录.html` | 逐轮讨论记录与决策汇总（D1–D8） |
| `开发计划.html` | M0–M6 里程碑路线图（页面优先策略） |
| `README.md` | 本文件 |

腾讯在线文档版由 `push_tencent_docs.py` 推送，推送后必须执行 `set_tencent_permission.py` 设置公开链接权限。

## 目录结构

```
sdy/
├── barcode-demo/          # 条码双库 demo（扫码台/商品库/条码库/扫码日志/设置）
├── mall-demo/             # 顾客端商城 demo（M1.1 已完成：首页/详情/购物车/结算/我的订单）
├── *.py                   # 腾讯文档同步/转换/权限工具链
├── 开发计划.html           # 开发计划
├── 细节讨论记录.html       # 讨论与决策
└── 独立小程序商城可行性分析与架构方案.html
```

## 关键决策速览（详见细节讨论记录）

- **D6 双库设计**：`barcode_lib` 字典层（永久缓存，任何扫码先命中）＋ `product` 档案层（价格/库存等经营数据）。云端仅双库未命中时调用；配额按 **HTTP 200 计**（查无 status 400 也计），非 200 不计。
- **D7 扫码设备**：先不买扫码枪，手机摄像头（wx.scanCode）验证流程后再购无线 2D 枪（仓库主力）。
- **D8 扫码只读**：扫码只做识别/建档/查询，**不改库存**；库存一律手动调整（入库单录入、盘点差异、直接改数）。
- **红线**：敏感信息绝不上库（.gitignore + 三层扫描）；建档必须人工确认；价格与库存永不自动填云端值；腾讯文档推送前必须拉取比对、保留外部修改。

## 运行方式

### barcode-demo（条码 demo）
- **离线演示**：直接用浏览器打开 `barcode-demo/index.html`（Mock 数据）。
- **局域网**：`python3 -m http.server 8900` 后访问。
- **真实阿里云 API**：`barcode-demo/appcode.txt` 配置 APPCODE 与网关（已被 .gitignore 排除），运行 `python3 proxy.py`；详见 `barcode-demo/README.md`。

### 腾讯文档推送
```bash
.venv/bin/python3 convert_html.py 细节讨论记录.html        # → docx/md
.venv/bin/python3 push_tencent_docs.py 细节讨论记录.docx   # → 在线文档（新链接）
.venv/bin/python3 set_tencent_permission.py --last 细节讨论记录  # 设 publicWrite
```

## 开发计划

见 [开发计划.html](开发计划.html)：M0 基建已完成；M1 页面展示层（顾客端商城 → 管理端 → 扫码体验）当前执行；随后 M2 规则数据 → M3 牵牛花同步 → M4 后端 → M5 小程序化 → M6 上线验证。依赖用户事项（牵牛花导出能力、小程序账号/商户号、配送 API 权限）见计划「依赖用户的事项」一节。

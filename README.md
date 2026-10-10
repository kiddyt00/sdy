# 独立小程序商城（sdy）

自营微信小程序商城项目：商品、价格、库存、订单、配送、顾客全部自管理，完全独立于牵牛花中台，仅保留**月度 CSV 库存同步**。

> 当前阶段：**M1 页面展示层 + M2 规则数据层 + M3 同步工具**已完成并测试；**M4 后端服务（Go）主体已落地**（数据层/规则/条码解析链/HTTP API + 20 个单测 + 端到端冒烟 + Docker 蓝绿部署件），剩余前端接后端与生产上线。

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
├── barcode-demo/          # 条码双库 demo（扫码台[扫码枪HID+摄像头扫一扫]/商品库/条码库/扫码日志/设置）
├── mall-demo/             # 商城 demo（顾客端 5 页面 + 管理端 admin.html + 价格规则 tab）
├── sync-demo/             # 牵牛花 CSV 对账（sync-csv.js 引擎 + sync.html 工作台 + 导出确认清单）
├── server/                # Go 后端（cmd/server + internal/store|pricing|barcode + Dockerfile + smoke.sh）
├── deploy/                # 部署件（deploy.sh / rolling-update.sh / 主机 Nginx 模板）
├── docker-compose.yml     # 蓝绿 api-a(8093) / api-b(8094) 编排
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

### mall-demo / sync-demo（商城、管理端、对账工作台）
```bash
cd mall-demo && python3 -m http.server 8910     # 商城 http://127.0.0.1:8910/mall.html
                                                 # 管理端 /admin.html；对账台见 sync-demo/sync.html
node mall-demo/test-mall.js && node mall-demo/test-pricing.js && node mall-demo/test-admin.js
node barcode-demo/test-core.js && node sync-demo/test-sync.js
```
三个 demo 共用同源 localStorage 商品库 `bd_products`，需用同一个 http 端口打开才能互相看到数据。

### server（Go 后端）
```bash
cd server
go test ./...            # 20 个单测（条码解析链/熔断、价格规则、状态机、事务扣库存）
./smoke.sh               # 起真实服务跑 HTTP 全流程（下单→扣库存→状态流转→取消回补）
go run ./cmd/server      # 默认 http://127.0.0.1:8093；STATIC_DIR=.. 可同时托管仓库里的演示页
```
接口清单、环境变量与部署步骤见 [server/README.md](server/README.md)。

### 腾讯文档推送
```bash
.venv/bin/python3 convert_html.py 细节讨论记录.html        # → docx/md
.venv/bin/python3 push_tencent_docs.py 细节讨论记录.docx   # → 在线文档（新链接）
.venv/bin/python3 set_tencent_permission.py --last 细节讨论记录  # 设 publicWrite
```

## 开发计划

见 [开发计划.html](开发计划.html)：M0 基建、**M1 页面展示层（顾客端商城 → 管理端 → 扫码体验）、M2 规则数据层（价格规则服务）、M3 同步工具（对账引擎 + 工作台）均已完成并测试**；**M4 后端服务进行中**（**Go 1.24 + SQLite**，`modernc.org/sqlite` 纯 Go 驱动，`CGO_ENABLED=0` 静态单文件）：数据层六表（product/barcode_lib/customer/orders/order_item/sync_batch）、价格与配送规则、条码解析链（本地优先 + 配额熔断）、HTTP API（商品/订单/条码/比价）、Docker 蓝绿部署件均已就绪；剩余「前端接后端 + 生产域名上线」→ M5 小程序化 → M6 上线验证。依赖用户事项（牵牛花导出字段确认、**生产域名 + ICP 备案**、小程序账号/商户号、配送 API 权限）见计划「依赖用户的事项」一节。

## 部署（M4，已勘察）

- **生产服务器**：Ubuntu / 4 核 / 3.7G 内存 / 40G 盘 / Docker 29 + Compose v5（IP 与登录凭证只记本地 `.server_cred.md`，公开文档不披露）。
- **范式**：参照同机 `yiguan` 项目——Docker Compose + 蓝绿 A/B 双实例 + 主机级 Nginx(80/443) 反代；镜像拉取走国内代理 `docker.1ms.run/library`。
- **端口约定**：后端 `api-a` → `127.0.0.1:8093`、`api-b` → `127.0.0.1:8094`（蓝绿池，不对外直连）；**已占用端口必须避开**：22/53/80/443/8081/8082（同机还有其他服务在跑）。
- **部署命令**：`cp .env.example .env`（填 APPCODE）→ `./deploy/deploy.sh` → 首次上线按 `deploy/host-nginx.conf` 配主机 Nginx；日常更新 `./deploy/rolling-update.sh` 逐台重启不停服。
- 服务器凭证与详细勘察记录只存本地 `.server_cred.md`（已 gitignore，绝不入库）。

## 协作约定（家里 / 公司两地开发）

- **开工先同步**：`git status` 确认无未提交改动后 `git pull`，避免覆盖另一端的工作。
- **收工必推送**：本轮改动 commit + push 到 `github.com/kiddyt00/sdy`（main），保证云端代码最新。
- **敏感信息绝不入库**：推送前三层扫描（工作区 / 暂存区 / 已提交历史）。

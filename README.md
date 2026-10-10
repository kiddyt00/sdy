# 独立小程序商城（sdy）

自营微信小程序商城项目：商品、价格、库存、订单、配送、顾客全部自管理，完全独立于牵牛花中台，仅保留**月度 CSV 库存同步**。

> 当前阶段：**M0–M4 已完成并测试**；**M5 小程序化按用户要求暂缓**（骨架已写完并归档到 `archive/miniprogram/`，随时可续），重心回到 **Web 端商城**。
>
> **第 9 轮（Web 端现代化改造 + 仓库清理）已完成**：
> - 仓库清理：`mall-demo/` → **`web/`**、`mall.html` → **`index.html`**，小程序进 `archive/`，无用产物删除；
> - 新增设计系统 `web/assets/theme.css`（浅色 + 绿色品牌 + 圆角卡片 + 阴影 + 三档响应式），顾客端与管理端全面重做：
>   - 顾客端 `web/index.html`：品牌头 + 搜索 + 扫码找货 + 分类 chips + 商品网格 + 购物车抽屉 + 结算弹窗 + 我的订单；
>   - 管理端 `web/admin.html`：深色侧边栏 6 视图——总览 KPI / 订单 / 库存（入库·改数·盘点三操作）/ 价格防护 / 顾客档案 / 系统；
> - **首次用真实 Chrome（CDP）＋ 真后端跑通端到端**，并因此抓到并修掉一个真 bug：`web/mall-admin.js` 与 `mall.js` 顶层 `const Mall` 重名，classic script 直接 `SyntaxError`，导致**浏览器里 `Admin` 从来就是 undefined**（旧页面同样坏，fake-DOM 测试掩盖了它）。
> - 回归：Go 21 单测 + gofmt/vet、web 5 套（44/28/32/35/21）、barcode 4 套（7 组/55/28/34）、sync 62、小程序归档套件 62/47 全绿。
> - 剩余：M6 部署上线（需已备案域名）、M5 小程序化（暂缓）、微信支付/配送 API（依赖账号与资质）。

## 文档

| 文件 | 说明 |
| --- | --- |
| `独立小程序商城可行性分析与架构方案.html` | 总体架构方案（13 章，含双库设计 §2.7） |
| `细节讨论记录.html` | 逐轮讨论记录与决策汇总（D1–D13） |
| `开发计划.html` | M0–M6 里程碑路线图（页面优先策略） |
| `README.md` | 本文件 |

腾讯在线文档版由 `push_tencent_docs.py` 推送，推送后必须执行 `set_tencent_permission.py` 设置公开链接权限。

## 目录结构

```
sdy/
├── web/                   # 商城 Web 端（顾客端 index.html + 管理端 admin.html + assets/theme.css 设计系统）
│   ├── index.html         # 顾客端：商城首页/分类/搜索/扫码/购物车/结算/我的订单
│   ├── admin.html         # 管理端：总览 KPI/订单/库存/价格防护/顾客档案/系统
│   ├── assets/theme.css   # 共用设计系统（令牌 + 组件类 + 三档响应式）
│   ├── mall.js            # 商城领域逻辑（商品/购物车/订单/配送规则）
│   ├── mall-admin.js      # 管理端领域逻辑（库存流水/盘点/配送员/顾客档案）
│   ├── pricing.js         # 价格防护规则
│   └── sdy-api.js         # 后端数据通道（在线=服务端真源，离线=本地演示）
├── barcode-demo/          # 条码双库 demo（扫码台[摄像头/扫码枪]/商品库/条码库/扫码日志 + bd-api.js 后端通道）
├── sync-demo/             # 牵牛花 CSV 对账（sync-csv.js 引擎 + sync.html 工作台 + 导出确认清单）
├── server/                # Go 后端（cmd/server + internal/store|pricing|barcode + Dockerfile + smoke.sh）
├── deploy/                # 部署件（deploy.sh / rolling-update.sh / 主机 Nginx 模板）
├── archive/miniprogram/   # M5 微信小程序骨架（暂缓，保留可续：app.json + utils + 4 页 + 2 套测试）
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
- **D14 Web 端优先（第 9 轮）**：先做 Web 端商城、小程序暂缓归档；两个页面统一走 `web/assets/theme.css` 设计系统；**新增/改页面必须额外补一层「真实浏览器加载期异常检查」（Chrome CDP，脚本见 `.agent_rules.md` 第 13 条）**——classic script 之间共享全局词法环境，顶层 `const` 重名会让整个脚本静默失效（fake-DOM 测试发现不了）。
- **红线**：敏感信息绝不上库（.gitignore + 三层扫描）；建档必须人工确认；价格与库存永不自动填云端值；腾讯文档推送前必须拉取比对、保留外部修改。

## 运行方式

### barcode-demo（条码 demo · 扫码台）
- **离线演示**：直接用浏览器打开 `barcode-demo/index.html`（Mock 数据）。
- **接 Go 后端**（推荐，等同于商城的方式 B）：`cd server && STATIC_DIR=.. go run ./cmd/server` → 打开 http://127.0.0.1:8093/barcode-demo/
  顶部胶囊 **🟢 后端已连接**＝解析链与建档都在服务端执行（APPCODE 只在服务端环境变量）；**🟡 本地演示**＝后端不在，退回浏览器演示。
- **局域网**：`python3 -m http.server 8900` 后访问。
- **真实阿里云 API**：`barcode-demo/appcode.txt` 配置 APPCODE 与网关（已被 .gitignore 排除），运行 `python3 proxy.py`；详见 `barcode-demo/README.md`。

### web / sync-demo（商城顾客端、管理端、对账工作台）
```bash
# 方式 A：纯前端本地演示（无后端）
cd web && python3 -m http.server 8910     # 顾客端 http://127.0.0.1:8910/index.html
                                          # 管理端 /admin.html；对账台见 sync-demo/sync.html

# 方式 B：接后端（推荐，规则与账目由服务端执行）
cd server && STATIC_DIR=.. go run ./cmd/server   # 顾客端 http://127.0.0.1:8093/ ；管理端 /admin.html

# 测试
node web/test-mall.js && node web/test-pricing.js && node web/test-admin.js
node web/test-sdy-api.js && node web/test-page-boot.js   # 数据通道 + 页面启动冒烟（假 DOM）
node web/test-integration.js                     # 真 fetch → 真后端（需先起后端，未探测到则自动跳过）
node barcode-demo/test-core.js                   # 扫码台核心链路（7 组）
node barcode-demo/test-api.js                    # 扫码台后端通道（55 项）
node barcode-demo/test-page-boot.js              # 扫码台页面启动冒烟（28 项）
node barcode-demo/test-integration.js            # 扫码台 → 真后端（34 项，需先起后端）
node sync-demo/test-sync.js
node archive/miniprogram/test-api.js             # 小程序（归档）：utils 通道 62 项
node archive/miniprogram/test-pages.js           # 小程序（归档）：页面 47 项
```
页面打开时顶部胶囊显示 **🟢 后端已连接** / **🟡 本地演示**：探不到后端自动降级，同一套页面代码。两个 demo 共用同源 localStorage 商品库 `bd_products`，需用同一个 http 端口打开才能互相看到数据。
> 联调测试已做到**与库状态无关**（可反复跑同一个库）：库存只比对基线、商品条数用「至少 6 条」、建档用时间戳条码。

### server（Go 后端）
```bash
cd server
go test ./...            # 21 个单测（条码解析链/熔断、价格规则、状态机、事务扣库存）
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

见 [开发计划.html](开发计划.html)：M0 基建、**M1 页面展示层（顾客端商城 → 管理端 → 扫码体验）、M2 规则数据层（价格规则服务）、M3 同步工具（对账引擎 + 工作台）、M4 后端服务均已完成并测试**；**M4 = Go 1.24 + SQLite**（`modernc.org/sqlite` 纯 Go 驱动，`CGO_ENABLED=0` 静态单文件）：数据层六表（product/barcode_lib/customer/orders/order_item/sync_batch）、价格与配送规则、条码解析链（本地优先 + 配额熔断）、HTTP API（商品/订单/条码/比价）、Docker 蓝绿部署件，**且前端页面已接入后端**（`web/sdy-api.js`：后端为真源、规则只在服务端执行、离线自动降级）。**第 9 轮把页面层现代化重做并清理仓库，小程序化（M5）暂缓归档**。剩余「部署到生产服务器」属 M6，需**已备案域名**。依赖用户事项（牵牛花导出字段确认、**生产域名 + ICP 备案**、小程序账号/商户号、配送 API 权限）见计划「依赖用户的事项」一节。

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

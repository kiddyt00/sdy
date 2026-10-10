# sdy · 家庭超市自营商城

四人家庭超市的**自营商城**：商品、价格、库存、订单、配送、顾客全部自己管，完全独立于牵牛花中台，只保留**月度 CSV 库存对账**。

- **为什么做**：牵牛花抽成与账期不可控、顾客数据沉淀在平台侧；自建后佣金归零、顾客可私域运营，前台价格与配送规则由自己定。
- **卖给谁**：门店周边固定客群（熟客 + 微信群），MVP 范围限**常温 + 酒水**。
- **形态**：以 **Web 端商城**为主（手机浏览器即可下单，无需下载），微信小程序是后续阶段（见下）。

## 当前状态

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| M0 | 项目基建（目录/规范/双端同步约定） | ✅ 完成 |
| M1 | 页面展示层（顾客端 → 管理端 → 扫码体验） | ✅ 完成 |
| M2 | 规则与数据（价格防护、配送规则、种子数据） | ✅ 完成 |
| M3 | 牵牛花月度 CSV 对账工具 | ✅ 完成 |
| M4 | Go 后端服务（数据层 / 规则 / 条码链 / HTTP API / 部署件） | ✅ 完成，本地联调通过 |
| M5 | 微信小程序化 | ⏸ 暂缓，骨架归档在 `archive/miniprogram/`（可续） |
| M5′ | **Web 端商城现代化 + 功能实现** | 🔄 进行中（任务池 8 项已完成 3 项） |
| M6 | 部署上线验证 | ⬜ 未开始（需已备案域名） |

> ⏸ **本机开发已暂停（2026-10-10）**：进度与待办已全部同步到仓库，续做请看下方「下一步（待续）」与 [`开发计划.html`](开发计划.html) 的任务池。

**M5′ 任务池进度**：①商品建档/编辑/删除 ✅ ②订单打印/小票 ✅ ③顾客端收货地址簿 ✅ ④销售报表/日报 ⬜ ⑤批量改价 ⬜ ⑥商品图片与分类管理 ⬜ ⑦批发价与顾客等级 ⬜ ⑧上线部署验证 ⬜。

**现在就能用**：起后端后，顾客端 `http://127.0.0.1:8093/` 可浏览商品、加购、下单、看我的订单，并维护**收货地址簿**（下单自动带出默认地址、改门牌顺手存新地址）；管理端 `/admin.html` 可看 KPI、流转订单、**给订单打小票 / 批量打印待备货小票**、入库/改数/盘点、**建档/编辑/删除商品档案（带比价防线校验）**、跑价格防护、维护顾客档案。前端与后端数据打通（`web/sdy-api.js` 为唯一通道），后端不在时自动降级为本地演示模式。

**为什么先 Web 后小程序**（用户决定）：Web 端零门槛、当天能上线、功能可以立刻试；小程序要账号 + 商户号（1–2 周审批）且审核周期不可控，先把业务跑通再包壳。

## 目录结构

```
sdy/
├── web/                    # 商城 Web 端（唯一在用的前端）
│   ├── index.html          #   顾客端：首页/分类/搜索/扫码找货/购物车/结算(常用地址带出)/我的订单/收货地址簿
│   ├── admin.html          #   管理端：总览 KPI/订单(含小票打印)/库存/商品档案(建档·编辑·删除)/价格防护/顾客/系统
│   ├── assets/theme.css    #   共用设计系统（令牌 + 组件类 + 三档响应式）
│   ├── mall.js             #   领域逻辑：商品/购物车/订单/配送规则/收货地址簿（全局 Mall）
│   ├── mall-admin.js       #   后台逻辑：库存流水/盘点/商品档案 CRUD/配送员/顾客档案/小票模型（全局 Admin）
│   ├── pricing.js          #   价格防护规则（全局 Pricing）
│   ├── sdy-api.js          #   后端通道：在线=服务端真源，离线=本地演示（全局 SdyApi）
│   └── test-*.js           #   6 套前端测试（见「测试矩阵」）
├── server/                 # Go 后端（cmd/server + internal/{store,pricing,barcode} + Dockerfile + smoke.sh）
├── barcode-demo/           # 条码双库工具：扫码台（摄像头）+ 商品库/条码库/扫码日志
├── sync-demo/              # 牵牛花月度 CSV 对账引擎 + 工作台 + 导出字段确认清单
├── deploy/                 # 部署件：deploy.sh / rolling-update.sh / 主机 Nginx 模板
├── archive/miniprogram/    # M5 微信小程序骨架（暂缓，未删除：app.json + utils + 4 页 + 2 套测试）
├── docker-compose.yml      # 蓝绿 api-a(8093) / api-b(8094)
├── *.py                    # 腾讯文档工具链：pull / convert_html / push / set_permission
├── 开发计划.html            # 路线图与里程碑状态（唯一「计划」入口）
├── 细节讨论记录.html        # 决策台账 D1–D18 + 逐轮记录
└── 独立小程序商城可行性分析与架构方案.html   # 架构与实现现状（可行性、成本、设计）
```

## 快速开始

```bash
# ① 纯前端演示（无后端，数据在浏览器 localStorage）
cd web && python3 -m http.server 8910        # 顾客端 /index.html，管理端 /admin.html

# ② 接后端（推荐：规则与账目由服务端执行，前端只做展示）
cd server && STATIC_DIR=.. go run ./cmd/server   # 顾客端 http://127.0.0.1:8093/ ，管理端 /admin.html

# ③ Go 工具链不在默认 PATH 时，先导出（本机路径）
export GOROOT=$PWD/.tools/go-sdk/go
export PATH=$GOROOT/bin:$PATH
export GOPATH=$PWD/.tools/gopath GOMODCACHE=$PWD/.tools/gopath/pkg/mod
export GOCACHE=$PWD/.tools/gocache GOPROXY=https://goproxy.cn,direct
export CGO_ENABLED=0 GOFLAGS=-mod=mod
```

页面顶部胶囊显示 **🟢 后端已连接** / **🟡 本地演示**，同一套页面代码在两种模式下都能用。商城页面与扫码台共用同源 localStorage 商品库 `bd_products`，要用**同一个端口**打开才能互相看到数据。

## 测试矩阵

| 模块 | 命令 | 用例数 | 需要后端 |
| --- | --- | --- | --- |
| Web 领域逻辑 | `node web/test-mall.js` | 73 | 否 |
| 价格规则 | `node web/test-pricing.js` | 28 | 否 |
| 后台逻辑 | `node web/test-admin.js` | 98 | 否 |
| 后端通道降级 | `node web/test-sdy-api.js` | 56 | 否 |
| 页面启动冒烟（假 DOM） | `node web/test-page-boot.js` | 95 | 否 |
| 前后端联调 | `node web/test-integration.js` | 17 | 是（`SDY_API_BASE`） |
| 条码核心链路 | `node barcode-demo/test-core.js` | 7 组 | 否 |
| 条码后端通道 | `node barcode-demo/test-api.js` | 55 | 否 |
| 扫码台启动冒烟 | `node barcode-demo/test-page-boot.js` | 28 | 否 |
| 扫码台联调 | `node barcode-demo/test-integration.js` | 34 | 是 |
| 对账引擎 | `node sync-demo/test-sync.js` | 62 | 否 |
| 小程序（归档） | `node archive/miniprogram/test-api.js` / `test-pages.js` / `test-integration.js` | 62 / 47 / 21 | 最后一个需要 |
| 后端 | `cd server && go test ./...`（+ `gofmt`/`go vet`/`./smoke.sh`） | 29 | 自起服务 |

约定：
- 联调测试做到**与库状态无关**（库存只比基线、商品条数用「至少 N 条」、建档用时间戳条码），可反复跑同一个库。
- **改任何页面后必须补一层真实浏览器检查**（`node /tmp/cdp-errors.js <url>`）：classic script 之间共享全局词法环境，顶层 `const` 重名会让整个脚本静默失效，而假 DOM 测试发现不了（详见 `.agent_rules.md` 第 13 条）。本模型读不了截图，UI 验收一律用 CDP 取数值证据。

## 架构与关键约定

- **D6 双库条码**：`barcode_lib` 字典层（永久缓存，扫码先命中）＋ `product` 档案层（价格/库存等经营数据）；云端只在双库都未命中时调用，配额按 HTTP 200 计，连续失败触发当日熔断。
- **D8 扫码只读**：扫码只做识别/建档/查询，**不改库存**；库存一律手动调整（入库单、盘点差异、直接改数）。
- **价格防护**：零售价必须 ≤ 牵牛花参考价 −5%（`round2(ref*0.95)`），批发/白名单豁免。
- **商品档案**：建档/编辑由服务端校验（条码与名称必填、价格与库存非负、比价防线超价即 400），**编辑表单不改库存**（`stock` 不传即保留原值）；删除要求库存为 0 且无进行中订单，删档**保留条码字典层**（D6）。
- **配送规则**：自提 0 元；配送满 30 元免运费，否则 3 元。
- **订单小票**：`Admin.buildReceipt(order)` 是**只读投影**（不改订单/库存/价格），纯前端 `@media print` 打印，无打印库依赖；抬头（店名/电话/地址/票尾）存本地 `mall_store`，不上后端；配送单印地址与配送员，自提单印「到店自提」，已取消订单盖「作废」。
- **D18 收货地址簿**：按手机号维护常用地址（Go 端 `customer_address` 表 + `/api/addresses`；离线走 `localStorage.mall_addresses`），默认地址在结算时自动带出；**订单里的地址是下单当时的快照，改地址簿不影响历史订单**；下单时若地址与带出的那条完全一致就不重复写，改了内容则存成**新的一条**（绝不覆盖已有地址，要改已有地址走「地址簿管理」的编辑）；删掉默认地址时由最早的一条顶为默认。
- **D12 单一真源**：前端不直连数据库、不持有任何密钥，所有请求走 `web/sdy-api.js`；服务端是规则与账目的唯一真源，冲突（409）原样呈现。
- **技术栈**：后端 Go 1.24 + 标准库 `net/http` + `modernc.org/sqlite`（纯 Go，`CGO_ENABLED=0` 静态单文件）；前端纯 HTML/JS + 一个共享 CSS，**无构建步骤、无 npm 依赖**。
- **红线**：敏感信息绝不上库（IP/凭证/APPCODE 只存本地且已 gitignore）；建档必须人工确认；价格与库存永不自动填云端值；对账以本地实物库存为准、牵牛花为单据权威。

## 下一步（待续）

**代码侧（按任务池顺序，一次一轮，每轮都补测试 + 真浏览器验收）**：

| # | 任务 | 要点 |
| --- | --- | --- |
| ④ | 销售报表 / 日报 | 按日/周聚合订单：营业额、单量、客单价、商品销量 Top、配送费；数据来自本地订单表，只读投影，可导 CSV |
| ⑤ | 批量改价 | 按分类/选中商品批量调价，**必须过比价防线**（超价即拦截并列出违规项），改价写审计流水 |
| ⑥ | 商品图片与分类管理 | 后台上传/替换商品图（本地静态目录）、分类的增删改与排序；图片不依赖外部 CDN |
| ⑦ | 批发价与顾客等级 | 顾客等级（散客/熟客/批发）与批发价、白名单豁免比价防线；结算按等级取价 |
| ⑧ | 上线部署验证 | 生产机 Docker 蓝绿 + 主机 Nginx + HTTPS，冒烟与回滚演练（M6） |

**需要用户推进（我做不了的部分）**：

- **域名 + ICP 备案**：M6 上线的前置条件（没有备案域名，80/443 无法对外提供 HTTPS）。
- **牵牛花导出字段确认**（行动项 0，`sync-demo/牵牛花导出确认清单.html`）：对账引擎从未用真实导出文件验证过，需要一份真样例。
- **微信小程序账号 + 商户号**（若要走小程序与微信支付，审批约 1–2 周；是否新开商户号待定）。
- **未决产品问题**：入库场景范围（D1）、无条码商品策略（D2）、批次效期（D3）、入库单据完整度（D4）、多单位换算（D5）；批发电子发票 / 储值 / 生鲜属于 P1+ 待议。

## 部署（M6）

- 范式和端口见 [deploy/](deploy/)：Docker Compose 蓝绿 A/B + 主机 Nginx(80/443)，后端 `api-a`→`127.0.0.1:8093`、`api-b`→`127.0.0.1:8094`，不对外直连；**避开同机已占用端口** 22/53/80/443/8081/8082。
- 流程：`cp .env.example .env`（填 APPCODE）→ `./deploy/deploy.sh` → 首次按 `deploy/host-nginx.conf` 配主机 Nginx；日常更新 `./deploy/rolling-update.sh` 逐台重启不停服。
- 服务器地址与登录凭证只存本地 `.server_cred.md`（已 gitignore，公开仓库绝不出现）。

## 文档

| 文件 | 说明 |
| --- | --- |
| [`开发计划.html`](开发计划.html) | 里程碑路线图、当前重心、依赖用户推进的事项 |
| [`细节讨论记录.html`](细节讨论记录.html) | 决策台账 D1–D18 + 逐轮讨论记录 |
| [`独立小程序商城可行性分析与架构方案.html`](独立小程序商城可行性分析与架构方案.html) | 可行性分析、成本、架构与实现现状 |
| [`web/README.md`](web/README.md) | 商城 Web 端（顾客端 + 管理端） |
| [`server/README.md`](server/README.md) | Go 后端：接口、环境变量、测试 |
| [`barcode-demo/README.md`](barcode-demo/README.md) | 条码双库与扫码台 |
| [`sync-demo/README.md`](sync-demo/README.md) | 牵牛花 CSV 对账 |
| [`.agent_rules.md`](.agent_rules.md) | 协作与工程规则（含页面验收、进程/端口卫生） |

三份 HTML 与腾讯在线文档同步，**每次改动都要走完整流水线**（顺序不可颠倒，否则会覆盖对方在线修改）：

```bash
.venv/bin/python3 pull_tencent_docs.py --stem 开发计划         # 1 先拉取比对
#   …编辑本地 HTML…（若在线有他人修改，先合并再编辑）
.venv/bin/python3 convert_html.py 开发计划.html                # 2 转 docx/md
.venv/bin/python3 push_tencent_docs.py 开发计划.docx           # 3 推送（每次生成新链接）
.venv/bin/python3 set_tencent_permission.py --last 开发计划    # 4 设为公开可编辑
```

## 协作约定（家里 / 公司两地开发）

- **开工先同步**：`git pull --rebase`，确认无残留改动再动手，避免覆盖另一端的提交。
- **收工必推送**：每轮改动 commit + push 到 `github.com/kiddyt00/sdy`（main），保证云端代码最新。
- **敏感信息绝不入库**：推送前三层扫描（工作区 / 暂存区 / 已提交历史）；本仓库是 **public**，IP、口令、APPCODE、腾讯文档凭据一律只留本地。
- 本仓库产物约定：`*.docx` 与腾讯文档转换出的 `*.md` 属本地产物，已在 `.gitignore`。

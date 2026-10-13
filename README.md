# sdy · 家庭超市自营商城

四人家庭超市的**自营商城**：商品、价格、库存、订单、配送、顾客全部自己管，完全独立于牵牛花中台，只保留**月度 CSV 库存对账**。

- **为什么做**：牵牛花抽成与账期不可控、顾客数据沉淀在平台侧；自建后佣金归零、顾客可私域运营，前台价格与配送规则由自己定。
- **卖给谁**：门店周边固定客群（熟客 + 微信群），MVP 范围限**常温 + 酒水**。
- **形态**：以 **Web 端商城**为主（手机浏览器即可下单，无需下载），**微信小程序线已启动**（骨架恢复为 `miniprogram/`，业务与后端完全复用，见 `miniprogram/README.md`）。

## 当前状态

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| M0 | 项目基建（目录/规范/双端同步约定） | ✅ 完成 |
| M1 | 页面展示层（顾客端 → 管理端 → 扫码体验） | ✅ 完成 |
| M2 | 规则与数据（价格防护、配送规则、种子数据） | ✅ 完成 |
| M3 | 牵牛花月度 CSV 对账工具 | ✅ 完成 |
| M4 | Go 后端服务（数据层 / 规则 / 条码链 / HTTP API / 部署件） | ✅ 完成，本地联调通过 |
| M5 | 微信小程序化 | 🚧 **已启动（第 21 轮起）**：骨架由归档恢复为 `miniprogram/`，主题/配置/扫码已改造完成并测试通过；等已备案域名 + AppID 接后台配置与微信支付 |
| M5′ | **Web 端商城现代化 + 功能实现** | 🔄 进行中（任务池 8 项已完成 7 项） |
| M6 | 部署上线验证 | 🔄 已上生产（Docker 蓝绿 + 主机 Nginx「IP 直连」入口），管理端走干净地址 `/admin`；域名 + 备案后补 HTTPS |

> 📌 **节奏**：第 13 轮后曾在 2026-10-10 本机暂停并全量同步仓库；2026-10-12 用户要求「继续开发」，已陆续完成任务池第 4 项「销售报表 / 日报」与**第 5 项「批量改价 / 批量操作」**；**第 16 轮按用户要求先把项目部署到生产服务器**，可打开真实界面边看边提优化；**第 17 轮**据用户提问补了管理端干净地址 `/admin`（D22）、演示数据一键灌库脚本 `deploy/seed-demo.py`，并修掉一次「rsync 误删生产库」的事故；**第 18 轮**完成任务池第 ⑥ 项「商品图片与分类管理」——商品图（本地 `web/assets/demo/*.svg` 演示图，不依赖外部 CDN）、**商品上下架（含批量上下架，新增 `product.on_sale` 字段与 D23 口径）**、分类计数与改名/合并，全部已上生产；**第 19 轮**完成任务池第 ⑦ 项「批发价与顾客等级」（新增 `product.wholesale_price` 与 `customer.tier`、**价格口径真源挪到服务端**，见 D24）；**第 20 轮**：不在任务池 8 项内的一轮加固——**D25「消灭 localStorage 单点」**，把原先只活在浏览器 `localStorage` 的四样东西落进后端库（库存流水 / 配送员名单 / 门店抬头 / 顾客备注），库存变更收成唯一入口 `store.ChangeStock`（**改库存与写流水同一事务**、失败不留痕、流水只留最近 500 条），新增 `POST /api/stock/change`、`GET /api/stocklog`、`GET|POST /api/couriers`、`GET|POST /api/settings`、`POST /api/customers/note`；生产 CDP 真浏览器写库时发现并修掉「浏览器顶层 `const` 不在 `window` 上 → 在线改库存页面不同步」的缺陷；**第 21 轮**启动小程序线：小程序注册已完成（主体：海宁啥都有网络科技有限公司，小额打款验证通过），骨架由归档恢复为正式目录 `miniprogram/`，主题色对齐 `#16a34a`、新增唯一域名配置点 `utils/config.js`、新增只读扫码找货 `wx.scanCode` + `api.resolveBarcode`（D8 只读），三套测试 73 / 57 / 24 项全绿；**下一步只等已备案 HTTPS 域名 + AppID**（见 `小程序开发引导.html`）。续做请看下方「下一步（待续）」与 [`开发计划.html`](开发计划.html) 的任务池。

**M5′ 任务池进度**：①商品建档/编辑/删除 ✅ ②订单打印/小票 ✅ ③顾客端收货地址簿 ✅ ④销售报表/日报 ✅ ⑤批量改价/批量操作 ✅ ⑥商品图片与分类管理（含上下架）✅ ⑦批发价与顾客等级 ✅（第 19 轮，D24） ⑧上线部署验证 ⬜（生产已上线，域名 + 备案后做正式验证）；**第 20 轮另补一轮加固（不在 8 项内）：D25「消灭 localStorage 单点」——库存流水 / 配送员名单 / 门店抬头 / 顾客备注落进后端库**。

**现在就能用**：起后端后，顾客端 `http://127.0.0.1:8093/` 可浏览商品、加购、下单、看我的订单，并维护**收货地址簿**（下单自动带出默认地址、改门牌顺手存新地址）；管理端 `/admin`（旧 `/admin.html` 仍可用）可看 KPI、流转订单、**给订单打小票 / 批量打印待备货小票**、入库/改数/盘点、**建档/编辑/删除商品档案（带比价防线校验）**、**勾选一批商品批量改价 / 批量改分类 / 批量改批发标记（改价逐款过比价防线）**、跑价格防护、维护顾客档案，以及**看销售报表 / 日报**（今天/昨天/近 7 天/近 30 天/本月/全部，日柱状图 + 热销 TOP + 环比，一键复制或打印日报）；**顾客端有「💰 我的价格」**——填一次手机号就按顾客等级（零售 / 批发 / 白名单）显示对应价格（批发价划线原价），管理端可给商品设批发价、给顾客改等级（D24）。前端与后端数据打通（`web/sdy-api.js` 为唯一通道），后端不在时自动降级为本地演示模式；**库存每一次入库 / 改数 / 盘点都会写后端审计流水**（谁、何时、为什么、前后多少），管理端库存页直接读它（第 20 轮 / D25）。

**为什么先 Web 后小程序**（用户决定）：Web 端零门槛、当天能上线、功能可以立刻试；小程序要账号 + 商户号（1–2 周审批）且审核周期不可控，先把业务跑通再包壳。

## 目录结构

```
sdy/
├── web/                    # 商城 Web 端（唯一在用的前端）
│   ├── index.html          #   顾客端：首页/分类/搜索/扫码找货/购物车/结算(常用地址带出)/我的订单/收货地址簿
│   ├── admin.html          #   管理端：总览 KPI/销售报表/订单(含小票打印)/库存/商品档案(建档·编辑·删除·商品图·上下架)/价格防护/顾客/系统（服务端另有 /admin 干净地址）
│   ├── assets/theme.css    #   共用设计系统（令牌 + 组件类 + 三档响应式）
│   ├── assets/demo/*.svg   #   演示商品图（仓库自带，随静态目录部署，不依赖外网图床）
│   ├── mall.js             #   领域逻辑：商品/购物车/订单/配送规则/收货地址簿（全局 Mall）
│   ├── mall-admin.js       #   后台逻辑：库存流水/盘点/商品档案 CRUD/配送员/顾客档案/小票模型/报表日报模型（全局 Admin）
│   ├── pricing.js          #   价格防护规则（全局 Pricing）
│   ├── sdy-api.js          #   后端通道：在线=服务端真源，离线=本地演示（全局 SdyApi）
│   └── test-*.js           #   6 套前端测试（见「测试矩阵」）
├── server/                 # Go 后端（cmd/server + internal/{store,pricing,barcode} + Dockerfile + smoke.sh）
├── barcode-demo/           # 条码双库工具：扫码台（摄像头）+ 商品库/条码库/扫码日志
├── sync-demo/              # 牵牛花月度 CSV 对账引擎 + 工作台 + 导出字段确认清单
├── deploy/                 # 部署件：deploy.sh / rolling-update.sh / seed-demo.py（演示数据一键灌库）/ 主机 Nginx 模板
├── miniprogram/            # 微信小程序端（M5 已启动：app.json + utils{config,api,rules,store} + 4 页 + 3 套测试）
├── 小程序开发引导.html      # 小程序上线引导（配置项、回传清单、常见坑）
├── docker-compose.yml      # 蓝绿 api-a(8093) / api-b(8094)
├── *.py                    # 腾讯文档工具链：pull / convert_html / push / set_permission
├── 开发计划.html            # 路线图与里程碑状态（唯一「计划」入口）
├── 细节讨论记录.html        # 决策台账 D1–D25 + 逐轮记录
└── 独立小程序商城可行性分析与架构方案.html   # 架构与实现现状（可行性、成本、设计）
```

## 快速开始

```bash
# ① 纯前端演示（无后端，数据在浏览器 localStorage）
cd web && python3 -m http.server 8910        # 顾客端 /index.html，管理端 /admin.html

# ② 接后端（推荐：规则与账目由服务端执行，前端只做展示）
cd server && STATIC_DIR=.. go run ./cmd/server   # 顾客端 http://127.0.0.1:8093/ ，管理端 /admin（旧 /admin.html 仍可用）

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
| Web 领域逻辑 | `node web/test-mall.js` | 88 | 否 |
| 价格规则 | `node web/test-pricing.js` | 42 | 否 |
| 后台逻辑 | `node web/test-admin.js` | 206 | 否 |
| 后端通道降级 | `node web/test-sdy-api.js` | 117 | 否 |
| 页面启动冒烟（假 DOM） | `node web/test-page-boot.js` | 211 | 否 |
| 前后端联调 | `node web/test-integration.js` | 50 | 是（`SDY_API_BASE`） |
| 条码核心链路 | `node barcode-demo/test-core.js` | 7 组 | 否 |
| 条码后端通道 | `node barcode-demo/test-api.js` | 55 | 否 |
| 扫码台启动冒烟 | `node barcode-demo/test-page-boot.js` | 28 | 否 |
| 扫码台联调 | `node barcode-demo/test-integration.js` | 34 | 是 |
| 对账引擎 | `node sync-demo/test-sync.js` | 62 | 否 |
| 小程序 | `node miniprogram/test-api.js` / `test-pages.js` / `test-integration.js` | 73 / 57 / 24 | 最后一个需要 |
| 后端 | `cd server && go test ./...`（+ `gofmt`/`go vet`/`./smoke.sh`） | 42（store 24 / cmd-server 9 / barcode 6 / pricing 5） | 自起服务 |

约定：
- 联调测试做到**与库状态无关**（库存只比基线、商品条数用「至少 N 条」、建档用时间戳条码），可反复跑同一个库。
- **改任何页面后必须补一层真实浏览器检查**（`node /tmp/cdp-errors.js <url>`）：classic script 之间共享全局词法环境，顶层 `const` 重名会让整个脚本静默失效，而假 DOM 测试发现不了（详见 `.agent_rules.md` 第 13 条）。本模型读不了截图，UI 验收一律用 CDP 取数值证据。

## 架构与关键约定

- **D6 双库条码**：`barcode_lib` 字典层（永久缓存，扫码先命中）＋ `product` 档案层（价格/库存等经营数据）；云端只在双库都未命中时调用，配额按 HTTP 200 计，连续失败触发当日熔断。
- **D8 扫码只读**：扫码只做识别/建档/查询，**不改库存**；库存一律手动调整（入库单、盘点差异、直接改数）。
- **价格防护**：零售价必须 ≤ 牵牛花参考价 −5%（`round2(ref*0.95)`），批发/白名单豁免。
- **商品档案**：建档/编辑由服务端校验（条码与名称必填、价格与库存非负、比价防线超价即 400），**编辑表单不改库存**（`stock` 不传即保留原值）；删除要求库存为 0 且无进行中订单，删档**保留条码字典层**（D6）。
- **配送规则**：自提 0 元；配送满 30 元免运费，否则 3 元。
- **订单小票**：`Admin.buildReceipt(order)` 是**只读投影**（不改订单/库存/价格），纯前端 `@media print` 打印，无打印库依赖；抬头（店名/电话/地址/票尾）第 20 轮起存后端 `setting`（`/api/settings`，离线时回退本地 `mall_store`），默认值「家庭超市」；配送单印地址与配送员，自提单印「到店自提」，已取消订单盖「作废」。
- **D18 收货地址簿**：按手机号维护常用地址（Go 端 `customer_address` 表 + `/api/addresses`；离线走 `localStorage.mall_addresses`），默认地址在结算时自动带出；**订单里的地址是下单当时的快照，改地址簿不影响历史订单**；下单时若地址与带出的那条完全一致就不重复写，改了内容则存成**新的一条**（绝不覆盖已有地址，要改已有地址走「地址簿管理」的编辑）；删掉默认地址时由最早的一条顶为默认。
- **D19 销售报表口径**：只统计**非取消订单**；营业额按**下单口径**（含未完成）并另拆「已完成 / 进行中」——家庭店要看「今天做了多少生意」，未交付的钱也要单独可见；商品金额取各单 `subtotal`（不含配送费），客单价 = 营业额 ÷ 单量；时间按本机时区的自然日切分，区间含首尾、零单日也占一格（柱状图横轴连续）；环比对**等长的上一个区间**（「全部」不比较）；实现是纯前端纯函数（`Admin.buildReport` / `Admin.reportText`），不加后端接口、离线也能出报表，日报可一键复制或按 72mm 打印。
- **D20 批量操作边界**：批量可改**售价 / 分类 / 批发标记**，**库存一律不动**（D16）；批量改价逐款过比价防线，**超线默认跳过并在预览里标红**，可点「按防线顶格」按 `round2(参考价×0.95)` 落价；批发商品与缺牵牛花参考价的商品跳过比价检查，但仍照常改价并记流水；写库前**逐款重读当前商品**再写，只覆盖要改的字段，避免拿过期快照盖掉别人刚改的分类/单位（第 18 轮补：每个 payload 都要带上 `img`，否则 `UpsertProduct` 的 `img=excluded.img` 会把已存图片抹成空串）；每款改动都单独记一条商品流水（原因写明规则，如「批量改价：+10%」）。第 18 轮商品表有了 `on_sale`（D23），批量上下架随之补上。
- **D21 生产部署口径**：**先上「IP 直连」HTTP 入口**（`deploy/host-nginx-ip.conf` 的 `server_name` 只写本机 IP），域名 + 备案到位后再切 `deploy/host-nginx.conf` 的域名 + TLS；因为按 Host 精确匹配，未知 Host 仍落同机 beian 的 default_server，**不影响 yiguan / beian 等既有站点**。容器以 `uid 10001(app)` 运行：宿主机 `data/` 必须 `chown 10001`（否则 SQLite 报 `unable to open database file: out of memory (14)`），`web/` 必须对 others 可读（本地仓库常见 600 权限会让容器 403 / 退化成目录列表），从本机 rsync 一律带 `--chmod=D755,F644`；`api-a`/`api-b` 两容器共享 `/data/sdy.db`（SQLite DSN 带 WAL + `busy_timeout(5000)`），日常更新走 `deploy/rolling-update.sh` 先 B 后 A 不停服；生产库里的演示数据（14 款商品 / 6 张订单 / 3 条地址）只用于「打开界面看效果」，正式开张前清库重建即可。
- **D22 管理端干净地址**：管理端对外统一走 `/admin`（Go 侧 `/admin` 直接吐 `admin.html`，`/admin/` 301 到 `/admin`），**旧 `/admin.html` 继续可用**，不让已收藏的链接失效。之所以带尾斜杠要重定向：`/admin` 不带尾斜杠时页面内的相对路径（`assets/theme.css`、`mall-admin.js`、`index.html`）仍以**根目录**为基准，而 `/admin/` 会把基准变成 `/admin/`，静态资源全部 404。不引入静态托管重写规则，Nginx 侧也不用改（`location /` 整站反代给 Go）。
- **D23 商品上下架口径（第 18 轮）**：上下架是**独立动作**，只改 `product.on_sale` 一个字段，走独立接口（`POST /api/products/onsale`，`{codes:[...], onSale:true|false}`）；**编辑商品档案不改上下架状态**（和「编辑不改库存」同理）；**下架只在顾客端生效**——档案、库存、历史订单、条码字典全都不动，顾客端列表里看不到、加购与直接打开详情都被拦住；服务端 JSON 一律下发不带 `omitempty` 的 `onSale`（缺字段视为上架，**只有明确的 `false` 才算下架**，老库/老前端不会因为多一个字段就集体消失）；`product` 新增 `on_sale INTEGER NOT NULL DEFAULT 1`，用 `ensureColumn` 幂等迁移（老库直接升，不用清库）。
- **D24 批发价与顾客等级（第 19 轮）**：顾客等级三档 `retail`（默认）/ `wholesale` / `vip` 白名单，存在 `customer.tier`，**手机号即身份**（延续 D18，系统仍然没有账号体系）；商品可设 `product.wholesale_price`（**0 = 未设**，就是「这货不批发」，批发客户也按零售价）。**有效价 = 非零售等级且批发价 > 0 ? 批发价 : 零售价**（一律 `round2`），**算价真源在服务端**：`GET /api/products?phone=` 由服务端按该手机号的等级算好 `price` 下发（**不带 `omitempty`**，页面只读它、不自己算），下单时 `CreateOrder` 用**同一个函数**再算一次，**前端传的价不参与**（同 D12）；离线本地演示模式退化为本地按等级算（口径与 Go 完全一致）。**批发价不参与零售比价防线**（比价只约束零售价，沿用商品维度 `isWholesale` 豁免）。**改等级只影响之后的单**——历史订单的价格是下单当时的快照，不会被动过。顾客端有「💰 我的价格」（填手机号存本地 `mall_my_phone`），批发客户看批发价并把原价划线、购物车行标「批发价」；管理端商品表单可填批发价（**高于零售价会被拦**）、商品表显示「批 ¥x.xx」、顾客视图可一键登记/改等级。`product.wholesale_price` 与 `customer.tier` 都用 `ensureColumn` 幂等迁移（老库直接升，不用清库）。
- **D25 消灭 localStorage 单点（第 20 轮）**：原先只活在浏览器 `localStorage` 的四样东西落进后端库——库存流水 `stock_log`、配送员名单 `courier`、门店抬头 `setting`、顾客备注与标签（复用 `customer.tags/note`）。**改库存只有一个入口 `store.ChangeStock(code, kind, qty, reason, by)`**（`kind` ∈ `stock_in` / `adjust` / `stock_take`），**改数与写流水在同一事务**、任何失败路径 `defer Rollback`——绝不允许「库存变了、没流水」（D8 既然定了库存手动调整，就必须有「谁在什么时候为什么改了多少」的审计；老接口 `POST /api/products/stock` 保留，内部折算成 `adjust` 且记 `reason="直接改数"`，同值不写流水）。流水**只留最近 500 条**（插入后同事务内裁剪），`GET /api/stocklog?limit=` 倒序返回。前端在线时**先写后端再刷本地**：`SdyApi.changeStock` 返回 `{ok, entry, stock}`，本地镜像一律用**服务端的 `after`** 对齐（`Admin.recordStockEntry`，按 `id` 幂等），后端拒绝就整笔中止并原样透出错误（D12），绝不「本地先改、后端后补」；盘点只在实盘数 ≠ 账面数时才发请求。配送员至少保留一位（`ErrConflict` → 409），门店抬头默认值与前端 `DEFAULT_STORE` 一致，顾客标签 ≤60 字、备注 ≤200 字，`/api/customers/tier`（等级）与 `/api/customers/note`（备注）职责分离。**踩坑**：浏览器里顶层 `const` 不是 `window` 的属性，`web/mall-admin.js` 必须显式 `window.Admin = Admin`，否则 `web/sdy-api.js` 的 `resolveAdmin()` 拿不到它、在线改库存会「服务端改了、页面没改」——这个缺陷 Node 单测（显式注入 `admin: Admin`）看不见，是**生产 CDP 真浏览器写库**（`stockAfter` 必须等于服务端 `after`）才暴露的。
- **D26 小程序端口径（第 21 轮）**：微信小程序线启动，`archive/miniprogram/` 恢复为正式目录 `miniprogram/`（**同一套后端与规则，不复制业务逻辑**）。三条口径：① **域名只有一个配置点**——`miniprogram/utils/config.js` 的 `PROD_BASE_URL`（`DEV_BASE_URL` 兜底，`api.js` 的 `DEFAULT_BASE` 只读它），上线要改的域名/接口地址永远不散落在页面里；② **小程序不存任何密钥**——AppID 属公开信息可入库，AppSecret / 商户号 / APIv3 密钥只进服务器 `.env`（延续 D13）；③ **扫码只读照旧（D8）**——`wx.scanCode` → `api.resolveBarcode(code)` → `GET /api/barcode/resolve`，只把结果填进搜索框筛商品，认不出的条码也原样填进去交老板人工看，**绝不自动加购、绝不改库存**。主题色与 Web 端统一 `#16a34a`。等已备案 HTTPS 域名 + AppID 到位后接后台配置与微信支付。
- **D12 单一真源**：前端不直连数据库、不持有任何密钥，所有请求走 `web/sdy-api.js`（小程序侧同理走 `miniprogram/utils/api.js`）；服务端是规则与账目的唯一真源，冲突（409）原样呈现。
- **技术栈**：后端 Go 1.24 + 标准库 `net/http` + `modernc.org/sqlite`（纯 Go，`CGO_ENABLED=0` 静态单文件）；前端纯 HTML/JS + 一个共享 CSS，**无构建步骤、无 npm 依赖**。
- **红线**：敏感信息绝不上库（IP/凭证/APPCODE 只存本地且已 gitignore）；建档必须人工确认；价格与库存永不自动填云端值；对账以本地实物库存为准、牵牛花为单据权威。

## 下一步（待续）

**代码侧（按任务池顺序，一次一轮，每轮都补测试 + 真浏览器验收）**：

| # | 任务 | 要点 |
| --- | --- | --- |
| ~~⑥~~ | ~~商品图片与分类管理~~ | ✅ **第 18 轮已交付**：商品图（`product.img`，管理端表单填图片地址 + 缩略图列，顾客端卡片/详情/购物车都渲染，空图回退分类 emoji）、分类计数与**改名/合并**（`chip-x`）、**单个 + 批量上下架**（D23）；演示图见 `web/assets/demo/*.svg` |
| ~~⑦~~ | ~~批发价与顾客等级~~ | ✅ **第 19 轮已交付**（D24）：`customer.tier`（零售/批发/白名单，手机号即身份）+ `product.wholesale_price`（0=未设）；**服务端按等级算价下发**（`GET /api/products?phone=` 的 `price`、下单 `CreateOrder` 同一函数，前端传价不参与）；批发价豁免零售比价防线；改等级只影响之后的单；顾客端「💰 我的价格」+ 划线原价 + 购物车「批发价」标，管理端商品批发价字段 + 顾客等级视图；接口 `GET /api/customers`、`POST /api/customers/tier` |
| ➕ | 消灭 localStorage 单点 | ✅ **第 20 轮已交付**（D25，任务池 8 项之外的一轮加固）：新增 `stock_log` / `courier` / `setting` 三张表 + 顾客备注落库；`store.ChangeStock` 唯一入口（改数与写流水同一事务、失败不留痕、流水留最近 500 条）；新增 `POST /api/stock/change`、`GET /api/stocklog`、`GET|POST /api/couriers`、`GET|POST /api/settings`、`POST /api/customers/note`；管理端库存页读后端审计流水、在线改数用服务端回执刷新本地镜像 |
| ⑧ | 上线部署验证 | 🔄 **已上生产**（Docker 蓝绿 + 主机 Nginx IP 直连入口 + 演示数据）；剩下：备案域名 + HTTPS、备份/回滚演练 |
| 🆕 | 小程序线（M5） | 🚧 **第 21 轮已启动**：骨架恢复为 `miniprogram/`、主题对齐 `#16a34a`、域名配置单点 `utils/config.js`、只读扫码找货 `wx.scanCode` + `api.resolveBarcode`，测试 73 / 57 / 24 全绿；**等已备案域名 + AppID** 后接后台配置 → 服务端 `POST /api/wx/login`（`code2Session`）→ 微信支付与订阅消息。引导见 [`小程序开发引导.html`](小程序开发引导.html)、清单见 [`miniprogram/README.md`](miniprogram/README.md) |

**需要用户推进（我做不了的部分）**：

- **备案域名（已确认有，只差告知我域名本身）**：HTTPS 入口与小程序「服务器域名」的前置条件。现在用 IP 走 HTTP 已能看界面/试用；**把域名发我 + 把 A 记录指向生产服务器**，我就能配 certbot 证书、切 `deploy/host-nginx.conf` 的域名 + TLS（回归任务池 ⑧ 的最后一环）。
- **牵牛花导出字段确认**（行动项 0，`sync-demo/牵牛花导出确认清单.html`）：对账引擎从未用真实导出文件验证过，需要一份真样例。
- **微信小程序账号 + 商户号**：账号**已注册并通过对公账户小额打款验证**（主体：海宁啥都有网络科技有限公司，2026-10-12），**待办**：主体信息审核放号 → 拿 **AppID**（`开发与服务 → 开发管理 → 开发设置 → AppID(小程序ID)`）→ **微信认证（支付前置，¥300/年）** → 申请/关联**微信支付商户号**（关联后不支持解绑，一个商户号最多关联 50 个 AppID）；AppSecret 与商户号只进服务器 `.env`。**已备案 HTTPS 域名**两者都要（小程序「服务器域名」只认 HTTPS + 已备案）。
- **未决产品问题**：入库场景范围（D1）、无条码商品策略（D2）、批次效期（D3）、入库单据完整度（D4）、多单位换算（D5）；批发电子发票 / 储值 / 生鲜属于 P1+ 待议。

## 部署（M6）

**当前状态（第 16–20 轮）**：已部署到生产服务器并**可外部访问**——Docker 蓝绿两个容器（`sdy-api-a`/`sdy-api-b`，宿主 `127.0.0.1:8093`/`8094`）已跑起来，主机 Nginx 上装了「IP 直连」入口：`http://<生产服务器IP>/` 是顾客端、`http://<生产服务器IP>/admin` 是管理端（旧 `/admin.html` 仍可用），`/api/` 由 Nginx 反代到蓝绿池；**生产服务器 IP 只存本地 `.server_cred.md`，公开仓库不出现**。演示数据用 `python3 deploy/seed-demo.py http://<地址>` 一键灌库（14 款商品 / 7 张订单（含 1 张已取消）/ 3 条地址簿，营业额 ¥205.00、客单价 ¥34.17、售出 36 件，其中 6 款商品带仓库自带的 `web/assets/demo/*.svg` 演示图、**7 款商品带批发价**，并登记 2 位顾客等级（`13800001111` 王阿姨=批发 / `13900002222` 李叔=白名单）；脚本幂等，可反复执行），打开即可看到 KPI、订单流转、小票、库存、报表、批量改价、商品图与上下架、**批发价与顾客等级**的真实效果——顾客端点顶部「💰 我的价格」填 `13800001111` 即可看到批发价与原价划线。第 20 轮又上线了 D25：库存页标题变成「最近 N 条（后端审计）」、每笔入库/改数/盘点都有流水（谁 / 何时 / 为什么 / 前后值），配送员名单与门店抬头也存服务端（`deploy/seed-demo.py` 会补 4 位配送员、门店抬头与 3 条演示流水）。

- 范式和端口见 [deploy/](deploy/)：Docker Compose 蓝绿 A/B + 主机 Nginx(80/443)，后端 `api-a`→`127.0.0.1:8093`、`api-b`→`127.0.0.1:8094`，不对外直连；**避开同机已占用端口** 22/53/80/443/8081/8082。
- 流程：rsync 同步（带 `--chmod=D755,F644`）→ `cp .env.example .env`（填 APPCODE）→ `./deploy/deploy.sh`（会自动 `chown` 数据目录、`chmod` 静态目录）→ 首次配主机 Nginx：域名 + TLS 用 `deploy/host-nginx.conf`，**备案前先用 IP 看界面**用 `deploy/host-nginx-ip.conf`；日常更新 `./deploy/rolling-update.sh` 逐台重启不停服；**只改前端时不必重启容器**——`./web:/app/web:ro` 是只读挂载，同步文件即生效。
- **⛔ rsync 禁止加 `--delete` / `--delete-excluded`**：服务器上的 `data/sdy.db`（真数据）与 `.env` 都不在仓库里，加了就会被同步删掉，容器随即报 `unable to open database file: out of memory (14)` 并无限重启（第 17 轮真实踩过一次：`api-a` 握着已删 inode 的旧库所以公网看着还在，`api-b` 反复重启、滚动更新中断）。恢复动作：`cp -n .env.example .env` → 填 `SDY_DOMAIN` → `mkdir -p data && chown -R 10001:10001 data` → `bash deploy/rolling-update.sh` → `python3 deploy/seed-demo.py http://<地址>` 重建演示数据。
- 服务器地址与登录凭证只存本地 `.server_cred.md`（已 gitignore，公开仓库绝不出现）。

## 文档

| 文件 | 说明 |
| --- | --- |
| [`开发计划.html`](开发计划.html) | 里程碑路线图、当前重心、依赖用户推进的事项 |
| [`细节讨论记录.html`](细节讨论记录.html) | 决策台账 D1–D25 + 逐轮讨论记录 |
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

# web · 商城 Web 端（顾客端 + 管理端）

四人家庭超市的**手机浏览器商城**：熟客扫码或点链接就能下单，家里人用同一个仓库里的管理端看库存、改价、处理订单——不需要装 App，也不需要小程序审核。

后端在线时，规则与账目全部由 Go 服务端执行；后端不在时自动降级为「本地演示」，只用浏览器 localStorage，页面照常能点。

## 文件清单

| 文件 | 职责 |
| --- | --- |
| `web/index.html` | 顾客端页面（471 行）：首页/分类/搜索/扫码找货/商品详情/购物车/结算/我的订单；UI 层只调用 `Mall` 与 `SdyApi`，不自己算价 |
| `web/admin.html` | 管理端页面（555 行）：经营总览 KPI / 订单处理 / 库存与流水 / 价格防护 / 顾客档案 / 系统与工具 |
| `web/assets/theme.css` | 共享设计系统（416 行）：设计令牌 + 组件类 + 三档响应式（断点 1080 / 900 / 640px） |
| `web/mall.js` | 领域逻辑（255 行，全局 `Mall`）：商品、购物车、订单、配送规则、localStorage 读写 |
| `web/mall-admin.js` | 后台逻辑（157 行，全局 `Admin`）：库存流水/入库/盘点、配送员派单、顾客档案聚合 |
| `web/pricing.js` | 价格与配送费规则（65 行，全局 `Pricing`）：价格防护、运费计算 |
| `web/sdy-api.js` | 后端连通层（316 行，全局 `SdyApi`）：唯一数据通道；在线走 HTTP，离线降级本地演示 |
| `web/test-*.js` | 6 套测试（见下），纯 Node 运行，无需浏览器 |

页面之间只靠相对路径互链（`index.html` ↔ `admin.html`，管理端系统页再链到 `../barcode-demo/`、`../sync-demo/`）。

## 本地运行

无构建步骤、无 npm 依赖，起一个静态服务就行。

### 方式 A：纯前端演示（无后端）

```bash
cd /home/kiddyt00/GolandProjects/sdy    # 注意：从仓库根起服务，不要 cd 进 web/
python3 -m http.server 8910
```

- 顾客端：<http://127.0.0.1:8910/web/index.html>
- 管理端：<http://127.0.0.1:8910/web/admin.html>

从**仓库根**起服务的原因：页面用 `../barcode-demo/`、`../sync-demo/` 互链，且四个模块共用同源 localStorage 商品库 `bd_products`。如果只 `cd web` 起服务，互相跳转会 404，也读不到扫码台的数据。

### 方式 B：接 Go 后端（推荐）

```bash
cd /home/kiddyt00/GolandProjects/sdy/server
STATIC_DIR=.. go run ./cmd/server          # 默认 ADDR=127.0.0.1:8093
```

- 顾客端：<http://127.0.0.1:8093/web/index.html>
- 管理端：<http://127.0.0.1:8093/web/admin.html>

（`STATIC_DIR` 是静态根目录，默认 `.` 只服务 `server/` 自己；指到 `..` 才能打开 `web/`、`barcode-demo/`、`sync-demo/` 的页面。）

Go 工具链不在默认 PATH 时，先导出环境（本机路径）：

```bash
export GOROOT=/home/kiddyt00/GolandProjects/sdy/.tools/go-sdk/go
export PATH=$GOROOT/bin:$PATH
export GOPATH=$PWD/.tools/gopath GOMODCACHE=$GOPATH/pkg/mod
export GOCACHE=$PWD/.tools/gocache GOPROXY=https://goproxy.cn,direct
export CGO_ENABLED=0 GOFLAGS=-mod=mod
```

### 指定后端地址

页面启动时探测一次 `/healthz`（**只探测一次，不轮询**），命中就是 `server` 模式，否则 `local` 模式。地址来源按优先级：

1. 代码里 `SdyApi.configure({ base })`（测试用）
2. `window.SDY_API_BASE`（可在页面 `<script>` 里注入）
3. `localStorage['sdy_api_base']`（管理端「系统与工具」页可直接填）
4. 空字符串 = 同源（用 8093 打开时就是同源）

顶部胶囊显示 **🟢 后端已连接** / **🟡 本地演示（离线可用）**，鼠标悬停看详情。

## 测试

```bash
cd /home/kiddyt00/GolandProjects/sdy
node web/test-mall.js          # 44 项
node web/test-pricing.js       # 28 项
node web/test-admin.js         # 32 项
node web/test-sdy-api.js       # 35 项
node web/test-page-boot.js     # 21 项
node web/test-integration.js   # 17 项（需后端在线）
```

| 测试 | 实测结果 | 覆盖什么 | 需要后端 |
| --- | --- | --- | --- |
| `web/test-mall.js` | 通过 44 项 / 失败 0 项 | 商品读写、购物车加/改/删、库存上限、下单扣库存、取消回补、状态机 | 否 |
| `web/test-pricing.js` | 通过 28 项 / 失败 0 项 | 配送费规则、价格防线、批发与无参考价豁免 | 否 |
| `web/test-admin.js` | 通过 32 项 / 失败 0 项 | 库存流水、入库/盘点校验、派单、顾客聚合（已取消订单不计营业额） | 否 |
| `web/test-sdy-api.js` | 通过 35 项 / 失败 0 项 | 地址优先级、超时、错误文案、在线/离线两套动作分流 | 否（注入假 fetch） |
| `web/test-page-boot.js` | 通过 21 项 / 失败 0 项 | 假 DOM 下页面脚本能加载、`Mall`/`Admin` 全局不冲突 | 否 |
| `web/test-integration.js` | 17 项（需后端在线；探测不到会自动跳过并 `exit 0`） | 真 fetch → 真后端：下单扣库存、运费、状态流转、非法流转 409、取消回补、比价巡检 | **是** |

联调测试的地址取 `SDY_API_BASE`（不设则默认 `http://127.0.0.1:8093`）：

```bash
cd server && STATIC_DIR=.. go run ./cmd/server     # 另开一个终端
cd /home/kiddyt00/GolandProjects/sdy
SDY_API_BASE=http://127.0.0.1:8093 node web/test-integration.js
```

测试环境：Node v24.11.1。所有用例都做到**与库状态无关**（库存只比基线、商品条数用「至少 N 条」），可反复跑同一个数据库。

> 改了任何页面后，除了跑上面的测试，还要补一层**真实浏览器检查**（classic script 共享全局词法环境，顶层 `const` 重名会让整个脚本静默失效，假 DOM 测试发现不了）。详见仓库根 `.agent_rules.md`。

## 设计要点与不变量

**数据与真源**

- **D12 单一真源**：页面不直连数据库、不持有任何密钥，全部请求走 `web/sdy-api.js`。服务端是规则与账目的唯一真源；服务端报错（如 409）**原样呈现给用户**，前端不自己改写结论。
- **在线/离线双模式**：`server` 模式下所有业务动作走后端接口（下单、流转、取消、改库存、建档、比价、条码解析）；`local` 模式下同一批动作落到 `Mall`/`Admin` 的本地实现。**同一套页面代码，两种模式都能用**。
- `server` 模式下前端只做展示与镜像：`SdyApi.sync()` 拉 `/api/products` 与 `/api/orders` 写回本地镜像，界面上看到的库存数字与后端一致。

**规则（前后端必须一致）**

- **配送规则**：自提 0 元；送货上门满 30 元免运费，否则 3 元（`DELIVERY_RULES = { pickupFee: 0, minFree: 30, fee: 3 }`）。
- **价格防护**：零售价 ≤ 牵牛花参考价 × 0.95（即 −5%），批发商品与无参考价（`refPrice <= 0`）自动跳过；同一套阈值也在后端 `internal/pricing` 里生效。
- **订单状态机**：`pending → delivering | ready → done`，且 `pending → cancelled`。`done`/`cancelled` 是终态，不允许再流转；非法流转服务端返回 409，前端照播后端文案。
- **下单与库存**：下单在一个事务里「校验 → 扣库存 → 写订单」，库存不足整单失败（不部分扣减）；取消订单**逐行回补库存**。本地模式同样是「先全量校验再扣减」。
- **D8 扫码只读**：顾客端「扫码找货」只做识别（先查本地商品档案，未建档再问后端解析链），**绝不改库存、不自动填价格**。

**约定与坑**

- **localStorage 键**：`bd_products`（商品库，与扫码台、对账工具**同源共用**）、`mall_cart`（购物车）、`mall_orders`（订单）、`mall_customer`（上次填写的收货信息）、`mall_couriers`（配送员名单）、`mall_stockLog`（库存流水，上限 500 条）、`mall_customers`（顾客备注）、`sdy_api_base`（后端地址）。
- **跨模块共用**：商城、扫码台、对账工作台必须用**同一个端口（同一源）**打开，才看到同一份 `bd_products`。
- **历史坑（已修，勿回退）**：`mall.js` 在浏览器里声明了顶层 `const Mall`，`mall-admin.js` 若再声明一个 `Mall` 会直接 `SyntaxError: Identifier 'Mall' has already been declared`，导致整个后台脚本静默失效。所以后台注入时用的是 `MallCore` 这个名字，别改回去。
- **库存页形态未定稿**：`web/mall-admin.js` 顶部注释写明库存页是**占位实现**（D1/D2/D4 待确认后可能调整），改动前先看 `../细节讨论记录.html`。
- **顾客端不做摄像头扫码**：顾客端只有扫码枪/手动输入（`扫码找货` 弹窗），摄像头那条路在扫码台里。
- 商品搜索：顾客端匹配 `名称 + 品牌 + 条码`；后端 `ListProducts` 的 `keyword` 只匹配 `名称 + 条码`（不含品牌）。两边口径不同，是已知差异。

## 相关文档

- [`../README.md`](../README.md) — 仓库总览、里程碑状态、测试矩阵
- [`../开发计划.html`](../开发计划.html) — 路线图与当前重心
- [`../细节讨论记录.html`](../细节讨论记录.html) — 决策台账 D1–D15（含库存页形态、扫码只读等）
- [`../独立小程序商城可行性分析与架构方案.html`](../独立小程序商城可行性分析与架构方案.html) — 架构与实现现状
- [`../server/README.md`](../server/README.md) — 后端接口、环境变量、测试
- [`../barcode-demo/README.md`](../barcode-demo/README.md) — 扫码台与双库解析链
- [`../sync-demo/README.md`](../sync-demo/README.md) — 牵牛花月度 CSV 对账
- [`../.agent_rules.md`](../.agent_rules.md) — 协作与工程规则（含页面验收、进程/端口卫生）

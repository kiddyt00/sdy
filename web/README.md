# 商城 Web 端（顾客端 + 管理端）

《开发计划》M1.1 顾客端商城 + M1.2 管理端扩展 + **M4 收尾（前端接后端）** + **第 9 轮现代化改造**：**首页 → 详情 → 购物车 → 结算 → 我的订单** 全流程可走通，管理端可管订单/库存/顾客。

> 目录已由 `mall-demo/` 改名为 **`web/`**，顾客端首屏由 `mall.html` 改名为 **`index.html`**（后端静态托管时 `http://127.0.0.1:8093/` 直接就是商城）。小程序端骨架按用户要求暂缓，归档在 `../archive/miniprogram/`。

## 运行

**方式 A：纯前端跑（无需后端，本地演示模式）**

```bash
cd web && python3 -m http.server 8910        # 或直接双击 index.html（file:// 亦可）
```

**方式 B：接上 Go 后端（推荐，规则与账目由服务端执行）**

```bash
cd ../server && STATIC_DIR=.. go run ./cmd/server     # 后端 127.0.0.1:8093
# 顾客端 http://127.0.0.1:8093/      管理端 http://127.0.0.1:8093/admin.html
```

两种方式页面都能用：顶部胶囊显示 **🟢 后端已连接** 或 **🟡 本地演示（离线可用）**，探测不到后端时自动退回本地演示，不需要改代码。

## 设计系统（第 9 轮新增）

两个页面共用 `assets/theme.css`，样式只有一处真源，页面内只留极少量局部微调：

- **令牌**：`--brand:#16a34a`（绿色）/ `--bg:#f4f6f8` / `--ink` 三级文字色 / 六组状态色（amber·blue·violet·green·red·slate，每组含 `-bg`/`-line`）/ 圆角 `--r-sm|r|r-lg|pill` / 三级阴影；
- **组件**：`.card`/`.panel`/`.kpis`/`.table`/`.badge.st-*`/`.btn(-primary|-ghost|-danger|-outline|-xs)`/`.field`+`.input|select|textarea`/`.chips`+`.chip.on`/`.drawer`/`.modal`/`.toast`/`.pill-mode(.on|.off)`；
- **顾客端**：`.shop-head`/`.hero`/`.cat-bar`/`.products`+`.pcard`/`.cartbar`/`.citem`+`.stepper`/`.deliv-opts`+`.dopt.on`/`.sum-line`；
- **管理端**：`.layout`+`.sidebar`(218px 深色)+`.content`+`.topbar`(sticky)+`.stkrow`/`.opgrid`/`.opline`/`.logline`/`.lgt`/`.custcard`；
- **响应式三档**：1080px（KPI 收列）、900px（侧栏转 off-canvas + 汉堡 `.side-toggle`）、640px（单列）。

## 页面与规则

| 页面 | 功能 |
| --- | --- |
| 首页 | 搜索（名称/品牌/条码）、分类筛选、商品卡片网格（售价/库存/加购）、扫码入口 |
| 详情 | 品牌/规格/条码/售价/库存、数量选择、加购（库存上限钳制） |
| 购物车 | 抽屉式：数量增减、行小计、合计、清空 |
| 结算 | 自提（免配送费）/ 配送（满 30 免、否则 3 元，占位规则）二选一；姓名/电话必填，配送需地址 |
| 我的订单 | 状态筛选；待备货→（配送中｜待自提）→已完成；待备货可取消（库存回补） |

核心规则（与《细节讨论记录》决策一致）：

- **下单扣库存、取消回补**；库存为 0 售罄禁购；订单级库存不足整单拦截
- **已备货不可取消**（状态机：`pending → delivering|ready → done`，取消仅限 `pending`）
- **扫码只读（D8）**：本 demo 不改库存，库存只随下单/取消变化，日常调整走管理端手动
- 与 barcode-demo **共用 `bd_products` 商品库**：扫码建档的商品在商城立即可售

## 管理端（M1.2）

| 页面 | 功能 |
| --- | --- |
| 总览 | 5 张 KPI（今日订单/待处理/今日营业额/库存预警/顾客档案）+ 最近订单 + 低库存透视 |
| 订单管理 | 状态筛选；配送单分配 4 人配送员（老张/小李/阿强/小美，可改名单）→ 待备货→配送中；确认完成；取消（回补库存）；自提单标记自提 |
| 库存管理 | 直接改数（±数量+原因）/ 入库单（数量+单号）/ 盘点（实盘校准）；每次变更自动记流水；**D8：扫码只读，这里是唯一改库存入口** |
| 价格防护 | 每个商品的牵牛花参考价与「防线上限（−5%）」对照，超价高亮；保存参考价写服务端，防线由服务端执行 |
| 顾客管理 | 订单自动按手机号聚合（订单数/累计消费/最近下单）；打标签（熟客/新客/普通/批发）+ 备注档案 |
| 系统 | 后端地址（可改可重连）、条码云端配置/熔断状态、清空本地演示数据 |

管理端逻辑在 `mall-admin.js`（与顾客端共用 `mall.js` 与 `bd_products` 商品库），测试见下。


## 接后端：`sdy-api.js`（M4 收尾）

页面与 Go 后端之间的唯一通道，**后端是真源，localStorage 只是镜像**：

- 启动时探测一次 `GET /healthz`（不轮询）：成功 → `server` 模式，拉商品与订单镜像；失败 → `local` 模式，纯本地演示照旧可用
- 顾客端下单、管理端改库存/改参考价、状态流转全部走 HTTP API，规则（运费、价格防线、库存、状态机）**只在服务端执行**，页面不再自己算
- 后端返回 409/400 时把服务端原话弹给用户（例如「库存不足：「可口可乐」仅剩 1 罐」），不会产生幽灵订单
- 地址可覆盖：`configure({base})` / `window.SDY_API_BASE` / `localStorage.sdy_api_base`，默认同源

对应服务端接口见 [server/README.md](../server/README.md)。

## 真实浏览器验收（第 9 轮新增，必做）

fake-DOM 冒烟测试**测不出** classic script 的加载期错误。两个页面共用的旧版 `mall-admin.js` 有顶层 `const Mall` 与 `mall.js` 重名，浏览器里直接 `SyntaxError: Identifier 'Mall' has already been declared`，整份脚本不执行、`Admin` 永远是 `undefined`——而 Node 里 `require('./mall.js')` 走的是另一条分支，测试全绿，这个 bug 藏了很久。**所以每次改页面都要在真实 Chrome 里跑一遍加载期异常检查**：

```bash
# 无头 Chrome + CDP：抓 exceptionThrown / console.error，并回读全局对象
node /tmp/cdp-errors.js http://127.0.0.1:8093/admin.html
# 期望：globals: {"Admin":"object","Mall":"object","Pricing":"object","SdyApi":"object"} + （无异常）
```

同一套 CDP 工具还能做布局体检（三档宽度下的实际列数/盒模型/横向溢出）与在线数据体检——本模型读不了截图，因此一律取数值证据。

## 测试

```bash
node test-mall.js         # 44 项：购物车合计/配送费规则/下单扣库存/取消回补/状态机/售罄
node test-pricing.js      # 28 项：配送费规则 + 比价防线（与后端同参数）
node test-admin.js        # 32 项：改数/入库/盘点/负库存拦截/配送员分配/顾客聚合/档案
node test-sdy-api.js      # 35 项：数据通道两条路径（假 fetch，不依赖后端）
node test-page-boot.js    # 21 项：假 DOM 真跑两个页面的内联脚本（离线/在线各一遍）
node test-integration.js  # 17 项：真 fetch → 真 Go 后端（需先起后端，未探测到则自动跳过）
```

## 数据

localStorage：`bd_products`（商品库，与 barcode-demo 共用）、`mall_cart`（购物车）、`mall_orders`（订单）。首次打开自动播种 6 个演示商品（与 barcode-demo 前 3 个一致）。

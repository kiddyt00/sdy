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
| M5 | 微信小程序化 | 🚧 **进行中（第 21 轮起）**：骨架恢复为 `miniprogram/`、主题/配置/只读扫码完成；AppID 与生产 HTTPS 域名就绪（第 22 轮）；**第 23 轮打通微信登录（D28）——`wx.login` → 服务端 `code2session` → `openid` 绑手机号档案，「我的」页可登录/退出并按等级看价，开发版 0.2.0 已上传**；**第 24 轮吸收开源商城 `EastWorld/wechat-app-mall` 重做界面：引入 `@vant/weapp 1.11.7`（本项目唯一获批的 npm 依赖，仅小程序端）、页面 4 → 10 页、浏览→详情→下单主链路打通，Web 端同步对齐，开发版 **0.3.0** 已上传**；**第 25 轮把登录与信息展示收敛（D31）——登录改微信官方「头像昵称填写能力」、不再绑手机号（手机号推后到下单时填并记住）、登录后不再显示登录按钮、修掉头像椭圆、顾客端「后端连接 / 后端已连接」全换小绿点，开发版 0.4.0 已上传**；剩微信支付与订阅消息（等微信认证 + 商户号） |
| M5′ | **Web 端商城现代化 + 功能实现** | 🔄 进行中（任务池 8 项已完成 7 项） |
| M6 | 部署上线验证 | ✅ **已完成（第 22 轮）**：Docker 蓝绿 + 主机 Nginx 域名入口 **`https://mall.shadouyou.cloud`**（acme.sh/ZeroSSL ECC 证书、80 自动 301、每日自动续期），管理端走干净地址 `/admin`；IP 直连 HTTP 入口保留为备用 |

> 📌 **节奏**：第 13 轮后曾在 2026-10-10 本机暂停并全量同步仓库；2026-10-12 用户要求「继续开发」，已陆续完成任务池第 4 项「销售报表 / 日报」与**第 5 项「批量改价 / 批量操作」**；**第 16 轮按用户要求先把项目部署到生产服务器**，可打开真实界面边看边提优化；**第 17 轮**据用户提问补了管理端干净地址 `/admin`（D22）、演示数据一键灌库脚本 `deploy/seed-demo.py`，并修掉一次「rsync 误删生产库」的事故；**第 18 轮**完成任务池第 ⑥ 项「商品图片与分类管理」——商品图（本地 `web/assets/demo/*.svg` 演示图，不依赖外部 CDN）、**商品上下架（含批量上下架，新增 `product.on_sale` 字段与 D23 口径）**、分类计数与改名/合并，全部已上生产；**第 19 轮**完成任务池第 ⑦ 项「批发价与顾客等级」（新增 `product.wholesale_price` 与 `customer.tier`、**价格口径真源挪到服务端**，见 D24）；**第 20 轮**：不在任务池 8 项内的一轮加固——**D25「消灭 localStorage 单点」**，把原先只活在浏览器 `localStorage` 的四样东西落进后端库（库存流水 / 配送员名单 / 门店抬头 / 顾客备注），库存变更收成唯一入口 `store.ChangeStock`（**改库存与写流水同一事务**、失败不留痕、流水只留最近 500 条），新增 `POST /api/stock/change`、`GET /api/stocklog`、`GET|POST /api/couriers`、`GET|POST /api/settings`、`POST /api/customers/note`；生产 CDP 真浏览器写库时发现并修掉「浏览器顶层 `const` 不在 `window` 上 → 在线改库存页面不同步」的缺陷；**第 21 轮**启动小程序线：小程序注册已完成（主体：海宁啥都有网络科技有限公司，小额打款验证通过），骨架由归档恢复为正式目录 `miniprogram/`，主题色对齐 `#16a34a`、新增唯一域名配置点 `utils/config.js`、新增只读扫码找货 `wx.scanCode` + `api.resolveBarcode`（D8 只读），三套测试 73 / 57 / 24 项全绿；**下一步只等已备案 HTTPS 域名 + AppID**（见 `小程序开发引导.html`）。**第 22 轮**：① 定清「线上超市该勾哪几个服务类目」并写进引导文档（生活服务→百货/超市/便利店 + 商家自营→食品/酒盐 + 按需初级食用农产品/美妆洗护）；② 归档营业执照信息，OCR 出来的统一社会信用代码含一位非法字符（`S`），按国标校验位算法修正为 `91330481MADQ66GM5E`；③ **微信凭证防误提交加固**——用户那两个文件名**没有前导点**（`cert.txt` / `private.wx….key`），而 `.gitignore` 里写的是带点版本，等于**根本没被忽略**，再跑一次例行 `git add -A` 就会把 AppSecret 推进公开仓库；已补齐规则并核实「从未提交过」；④ 把正式 AppID（公开信息）填进 `miniprogram/project.config.json`；⑤ **域名上线**：`mall.shadouyou.cloud` 用**本机既有 acme.sh**（不用 certbot，共用 webroot `/usr/share/nginx/html/beian`）签发 ZeroSSL ECC 证书 → 按 `deploy/host-nginx.conf` 装到生产 → HTTPS 前台 / `/admin` / `/api` 全 200、CDP 真浏览器 0 异常 0 坏请求、生产只读探针 14 商品 + 扫码只读通过；⑥ `miniprogram/utils/config.js` 的 `PROD_BASE_URL` 填上域名，小程序真机可直接连生产。**第 23 轮（2026-10-13）**：做**微信登录**（D28）——服务端 `wx.login`→`code2session`→`openid` 落 `wx_user`（`POST /api/wx/login`、`GET /api/wx/users`），`WX_APPID`/`WX_SECRET` 只进服务器 `.env` 与 compose（未配置时登录返 503、其它功能照常），小程序「我的」页登录/退出、登录后按服务端有效价看价、购物车重算；小程序测试 104 / 70 / 27、Go 46 全绿；生产滚动更新并验证微信侧链路（假 code 探针返回「微信登录码无效或已过期」），开发版 **0.2.0** 已上传。**第 24 轮（2026-10-13）**：按用户要求参考开源商城 `EastWorld/wechat-app-mall` **重做小程序界面并吸收其页面骨架**（决策 D30）——引入 `@vant/weapp 1.11.7`（本项目唯一被批准的 npm 依赖，**只在小程序端**，且因本机无微信开发者工具而手工入库 `miniprogram_npm/`），页面从 4 页扩到 **10 页**（新增商品详情 / 分类 / 搜索 / 订单详情 / 地址簿增删改，重做首页 / 购物车 / 订单列表 / 我的），打通**浏览→详情→下单主链路**（详情页「加入购物车 / 立即购买」、购物车多选+左滑删除+数量步进+地址簿回填、订单列表状态分页与「确认收货 / 取消 / 再来一单」）；**Web 端同步对齐**（详情弹窗「立即购买」临时单、订单卡状态文案与「确认收货」）；服务端新增 `GET /api/products/{code}`（只读详情，带 `?phone=` 算有效价）与 `GET /api/products/categories`；**门店品牌更名「小邻里超市 → 啥都有快送」（D29）**，生产库已生效。测试全绿：Go 48、小程序 104 / **131** / 50、Web 42 / 109 / 117 / 206 / 211，并对**生产公网地址**跑 CDP 真浏览器验收（0 异常 / 0 `console.error` / 0 横向溢出）。开发版 **0.3.0** 已上传。**第 25 轮（2026-10-13）**：按用户五条反馈收敛登录与信息展示（**D31**）——① 登录头像昵称改用微信官方能力（`<button open-type="chooseAvatar">` + `<input type="nickname">`；`wx.getUserProfile` 自 2022-10-25 起只给灰头像与「微信用户」，不能用），头像用 `wx.getFileSystemManager().saveFile` 落本机永久文件、并 `POST /api/wx/profile` 回传云地址；② **登录不再要手机号**（`wx.login` → `openid` 即登录，手机号推后到下单时填，填过一次由 `api.rememberPhone()` 记住——手机号仍是价格身份与地址簿钥匙，D24/D18 不变）；③ 登录后不再显示「微信一键登录」，改「微信头像昵称」卡；④ **修掉头像椭圆**（把原生 `button` 当圆形容器，默认 `padding`/行高/`::after` 把 128rpx 盒子撑成椭圆）；⑤ **顾客端不露开发信息**——「我的」页删掉「后端连接」一行、首页「后端已连接」徽标换成 9px 小圆点（Web 顾客端同步换点；管理端保留详细徽标，老板工具里连接状态有用）。服务端 `wx_user` 加 `avatar` 列（`ensureColumn` 幂等迁移）、`/api/wx/login` 的 `phone` 变可选、新增 `POST /api/wx/profile`（空值保留原值 / 昵称截 20 字 / 头像 ≤512 字）。测试 Go 48、小程序 104 / **140** / 50、Web 42 / 109 / 117 / 206 / **212** 全绿，生产已滚动更新并对公网跑 CDP 真浏览器验收（9px 绿点、0 开发字样、0 异常），开发版 **0.4.0** 已上传。续做请看下方「下一步（待续）」与 [`开发计划.html`](开发计划.html) 的任务池。

**M5′ 任务池进度**：①商品建档/编辑/删除 ✅ ②订单打印/小票 ✅ ③顾客端收货地址簿 ✅ ④销售报表/日报 ✅ ⑤批量改价/批量操作 ✅ ⑥商品图片与分类管理（含上下架）✅ ⑦批发价与顾客等级 ✅（第 19 轮，D24） ⑧上线部署验证 ✅（第 22 轮：生产 HTTPS 域名上线，前台 / 管理端 / API 全绿）；**第 20 轮另补一轮加固（不在 8 项内）：D25「消灭 localStorage 单点」——库存流水 / 配送员名单 / 门店抬头 / 顾客备注落进后端库**；**第 24 轮也不在 8 项内**：按用户要求参考开源商城 `wechat-app-mall` 重做小程序界面（D30 引入 `@vant/weapp`）+ Web 端对齐 + 品牌更名（D29）；**第 25 轮同样不在 8 项内**：登录与信息展示收敛（D31——《小程序登录获取头像昵称、登录后不再要手机号、修头像椭圆、顾客端只留小绿点）。

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
├── miniprogram/            # 微信小程序端（M5：app.json + utils{config,api,rules,store,tools.wxs} + 10 页 + @vant/weapp + 3 套测试）
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
| 页面启动冒烟（假 DOM） | `node web/test-page-boot.js` | 212 | 否 |
| 前后端联调 | `node web/test-integration.js` | 50 | 是（`SDY_API_BASE`） |
| 条码核心链路 | `node barcode-demo/test-core.js` | 7 组 | 否 |
| 条码后端通道 | `node barcode-demo/test-api.js` | 55 | 否 |
| 扫码台启动冒烟 | `node barcode-demo/test-page-boot.js` | 28 | 否 |
| 扫码台联调 | `node barcode-demo/test-integration.js` | 34 | 是 |
| 对账引擎 | `node sync-demo/test-sync.js` | 62 | 否 |
| 小程序 | `node miniprogram/test-api.js` / `test-pages.js` / `test-integration.js` | 104 / 144 / 50 | 最后一个需要 |
| 后端 | `cd server && go test ./...`（+ `gofmt`/`go vet`/`./smoke.sh`） | 46（store 25 / cmd-server 10 / barcode 6 / pricing 5） | 自起服务 |

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
- **D26 小程序端口径（第 21 轮）**：微信小程序线启动，`archive/miniprogram/` 恢复为正式目录 `miniprogram/`（**同一套后端与规则，不复制业务逻辑**）。三条口径：① **域名只有一个配置点**——`miniprogram/utils/config.js` 的 `PROD_BASE_URL`（`DEV_BASE_URL` 兜底，`api.js` 的 `DEFAULT_BASE` 只读它），上线要改的域名/接口地址永远不散落在页面里；② **小程序不存任何密钥**——AppID 属公开信息可入库，AppSecret / 商户号 / APIv3 密钥只进服务器 `.env`（延续 D13）；③ **扫码只读照旧（D8）**——`wx.scanCode` → `api.resolveBarcode(code)` → `GET /api/barcode/resolve`，只把结果填进搜索框筛商品，认不出的条码也原样填进去交老板人工看，**绝不自动加购、绝不改库存**。主题色与 Web 端统一 `#16a34a`。**AppID 与 HTTPS 域名均已到位（见 D27）**，下一步接微信登录（`POST /api/wx/login` → `code2session`）与微信支付。
- **D27 域名与证书口径（第 22 轮）**：生产域名 **`mall.shadouyou.cloud`**（A 记录指向生产公网 IP；沿用 `shadouyou.cloud` 的备案，子域名即可，真 IP 仍只存本地文件），顾客端 `https://mall.shadouyou.cloud/`、管理端 `/admin`，80 一律 301 到 HTTPS。**证书只用本机既有的 acme.sh**（v3.1.3，cron 每日 `--cron` 自动续期），**不装 certbot**：`--issue -d <域名> --webroot /usr/share/nginx/html/beian --keylength ec-256`（webroot 与同机其它站点共用），`--install-cert --ecc --fullchain-file /etc/nginx/conf.d/certs/<域名>.fullchain.pem --key-file /etc/nginx/conf.d/certs/<域名>.key --reloadcmd "systemctl reload nginx"`（key 一律 `chmod 600`，证书目录与本机其它站点一致）。**两条硬约束**：① 站点文件里的 `upstream` 名**不能与同机其它 nginx 文件重名**——`deploy/host-nginx-ip.conf` 已占用 `sdy_api`，域名站点必须用 `sdy_api_domain`，否则两个文件同时存在时 `nginx -t` 直接 `[emerg] duplicate upstream "sdy_api"`（第 22 轮真实踩到）；② **先 80 段、后 443 段的两步上线**——证书还没签发就把 443 段写进站点文件，`nginx -t` 会因为 `ssl_certificate` 文件不存在而失败，正确顺序是：装 80 段（含 `/.well-known/acme-challenge/`）→ reload → 签发 → 装证书 → 再补 443 段 → reload。微信侧「服务器域名 → request 合法域名」只能填这个 HTTPS 域名（不能是 IP、不能带端口）。
- **D28 微信登录口径（第 23 轮）**：小程序端**只有一次 `wx.login`**——拿到的 `code` 交给服务端 `POST /api/wx/login`，服务端用 `WX_APPID`/`WX_SECRET` 调 `sns/jscode2session` 换 `openid` 并落 `wx_user` 表；**`session_key` 只留服务端、不回传**，客户端要记住的只有 `openid` + 手机号。**手机号仍是价格身份**（`customer.tier`），openid 只回答「这台微信是谁」；**登录绝不提权**——顾客填手机号只是把 openid 绑到已有/新建的**零售档**顾客上，批发价与白名单只能老板在管理端改（D24 不变），绑定只在新档案姓名为空时补名、**绝不覆盖老板维护的姓名**，昵称超 20 字**截断不报错**（绝不让登录因为称呼太长失败）。**AppSecret 不出服务器**：只进 `.env`（`.env.example` 留空位）与 `docker-compose.yml` 两个服务的 `environment`；**没配**时 `/api/wx/login` 返 `503 微信登录未配置（服务端缺少 WX_APPID / WX_SECRET）`，其余接口完全不受影响（本机演示与未配密钥的环境照常跑）。小程序登录后商品列表带 `?onSale=1&phone=`，价格仍取服务端下发的有效价（保留零售价用于划线），退出登录同时清会话与价格缓存（`sdy_mp_session` / `sdy_mp_products`）。
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
| ⑧ | 上线部署验证 | ✅ **第 22 轮已完成**：生产 HTTPS 域名 **`https://mall.shadouyou.cloud`** 上线（acme.sh + ZeroSSL ECC 证书、80 自动 301、每日自动续期），顾客端 / `/admin` / `/api` 全 200、CDP 真浏览器 0 异常 0 坏请求；IP 直连 HTTP 入口保留作备用 |
| 🆕 | 小程序线（M5） | 🚧 **第 21 轮启动**：骨架恢复为 `miniprogram/`、主题对齐 `#16a34a`、域名配置单点 `utils/config.js`、只读扫码找货 `wx.scanCode` + `api.resolveBarcode` |
| ➕ | **微信登录（第 23 轮，D28）** | ✅ **已交付**：服务端 `POST /api/wx/login`（`code2session` → `openid` 落 `wx_user`）+ `GET /api/wx/users`；小程序「我的」页登录/退出、登录后按服务端有效价看价、购物车重算；`WX_APPID`/`WX_SECRET` 只进服务器 `.env`（未配置时登录返 503、其它功能照常）；生产已滚动更新并验证（假 code 探针返回「微信登录码无效或已过期」= AppSecret 与微信侧链路已通），**开发版 0.2.0 已上传**；测试 Go 46 / 小程序 104 / 70 / 27 全绿 |
| ➕ | **小程序界面重做 + 主链路（第 24 轮，D29/D30）** | ✅ **已交付**：参考开源商城 `EastWorld/wechat-app-mall` 吸收页面骨架（只吸交互，不吸它的 SaaS 后端、优惠券/拼团/分销等业务）；引入 **`@vant/weapp 1.11.7`**（本项目唯一获批的 npm 依赖，仅小程序端；本机无微信开发者工具 → 手工入库 `miniprogram_npm/`，配 `ignoreUploadUnusedFiles` 瘦身后整包 ~470 KB）；页面 4 → **10 页**（新增 商品详情 / 分类 / 搜索 / 订单详情 / 地址簿 list+edit，重做 首页 / 购物车 / 订单 / 我的）；**浏览→详情→下单**全链路（详情「加入购物车 / 立即购买」、购物车多选 + 左滑删除 + 步进 + 地址簿回填、订单列表按状态分页 + 确认收货/取消/再来一单）；**Web 端同步对齐**（详情弹窗「立即购买」临时单不污染购物车、订单卡状态文案 + 确认收货）；服务端新增 `GET /api/products/{code}`（只读详情 + `?phone=` 有效价）与 `GET /api/products/categories`；**品牌更名「小邻里超市 → 啥都有快送」**；测试 Go 48 / 小程序 104 / 131 / 50 / Web 42·109·117·206·211 全绿，生产公网 CDP 验收 0 异常，**开发版 0.3.0 已上传** |
| ➕ | **登录与信息展示收敛（第 25 轮，D31）** | ✅ **已交付**：① 登录改用微信官方「头像昵称填写能力」（`chooseAvatar` + `type="nickname"`），头像经 `wx.getFileSystemManager().saveFile` 落本机永久文件并 `POST /api/wx/profile` 回传云地址；② **登录不再绑手机号**——只走 `wx.login` → 服务端 `code2session` → `openid`，手机号推后到**下单时**填，填过一次由 `api.rememberPhone()` 记住（手机号仍是价格身份与地址簿钥匙，D24/D18 不变），地址簿三个接口改成「显式手机号优先、否则用记住的」；③ 登录后**不再显示「微信一键登录」按钮**，改「微信头像昵称」卡（换头像 / 改昵称 / 保存）；④ **修掉头像椭圆**（根因：原生 `button` 的默认 `padding` / 行高 / `::after` 把 128rpx 盒子撑成椭圆，重置 `padding:0;line-height:1;font-size:0;box-sizing:border-box` + `::after{border:none}`）；⑤ **顾客端不露开发信息**——小程序「我的」页删掉「后端连接」一行、首页徽标换 9px 小圆点（`sdot`），Web 顾客端同步换点（`dot-mode`，说明只留在 `title`；管理端保留详细徽标）；服务端 `wx_user` 加 `avatar` 列（`ensureColumn` 幂等迁移）、`/api/wx/login` 的 `phone` 变可选、新增 `POST /api/wx/profile`（空值保留原值 / 昵称截 20 字 / 头像 ≤512 字），`BindWxUser` 改 5 参；测试 Go 48 / 小程序 104 / **140** / 50 / Web 42 / 109 / 117 / 206 / **212** 全绿，生产 CDP 验收 0 异常，**开发版 0.4.0 已上传** |
| ➕ | 小程序线准备（第 22 轮） | ✅ **已完成**：① AppID（`wx3f2d2aa52660b80f`，公开信息）填进 `project.config.json`；② AppSecret / 代码上传密钥只存本地（`.wx_secret.env` / `.private.wx….key`），并补齐 `.gitignore` 与 `deploy/deploy.sh` 的 rsync 排除——**原先那两个文件名没有前导点、其实没被忽略，差点被提交进公开仓库**；③ 生产 HTTPS 域名上线；④ `utils/config.js` 的 `PROD_BASE_URL` 填域名；⑤ 服务类目选型写进 [`小程序开发引导.html`](小程序开发引导.html)。**待办（用户侧）**：小程序后台配「服务器域名」✅ 已配 → **微信认证 ¥300 已付款、审核中（2026-10-13）** → 关联商户号（未开始）；之后接 `POST /api/wx/pay`、`/api/wx/notify` 与订阅消息 |

**需要用户推进（我做不了的部分）**：

- ~~**备案域名**~~ ✅ **已完成（2026-10-13 第 22 轮）**：`mall.shadouyou.cloud` 已上线 HTTPS（acme.sh/ZeroSSL ECC、每日自动续期、80→301）。现在顾客端 = `https://mall.shadouyou.cloud/`、管理端 = `https://mall.shadouyou.cloud/admin`；生产 IP 仍只存本地 `.server_cred.md`。
- **牵牛花导出字段确认**（行动项 0，`sync-demo/牵牛花导出确认清单.html`）：对账引擎从未用真实导出文件验证过，需要一份真样例。
- **微信小程序账号 + 商户号**：账号**已注册并通过对公账户小额打款验证**（主体：海宁啥都有网络科技有限公司，2026-10-12），**AppID ✅ 已拿到**（`wx3f2d2aa52660b80f`，已填进 `miniprogram/project.config.json`；AppSecret 只存本地 `.wx_secret.env`，将来只写服务器 `.env`）。**进展（2026-10-13）**：① 服务器域名 → request 合法域名已填 `https://mall.shadouyou.cloud` ✅；② **微信认证 ¥300 已付款、审核中**；③ 关联**微信支付商户号**未开始（关联后不支持解绑，一个商户号最多关联 50 个 AppID；AppID 需已通过微信认证）。
- **未决产品问题**：入库场景范围（D1）、无条码商品策略（D2）、批次效期（D3）、入库单据完整度（D4）、多单位换算（D5）；批发电子发票 / 储值 / 生鲜属于 P1+ 待议。

## 部署（M6）

**当前状态（第 16–22 轮）**：已部署到生产服务器并**可外部访问**——Docker 蓝绿两个容器（`sdy-api-a`/`sdy-api-b`，宿主 `127.0.0.1:8093`/`8094`）已跑起来；**主入口是域名 + HTTPS：`https://mall.shadouyou.cloud/`（顾客端）、`https://mall.shadouyou.cloud/admin`（管理端）**，主机 Nginx 同时保留「IP 直连」HTTP 入口 `http://<生产服务器IP>/` 与 `http://<生产服务器IP>/admin`（旧 `/admin.html` 仍可用）作备用，`/api/` 由 Nginx 反代到蓝绿池；**生产服务器 IP 只存本地 `.server_cred.md`，公开仓库不出现**。演示数据用 `python3 deploy/seed-demo.py http://<地址>` 一键灌库（14 款商品 / 7 张订单（含 1 张已取消）/ 3 条地址簿，营业额 ¥205.00、客单价 ¥34.17、售出 36 件，其中 6 款商品带仓库自带的 `web/assets/demo/*.svg` 演示图、**7 款商品带批发价**，并登记 2 位顾客等级（`13800001111` 王阿姨=批发 / `13900002222` 李叔=白名单）；脚本幂等，可反复执行），打开即可看到 KPI、订单流转、小票、库存、报表、批量改价、商品图与上下架、**批发价与顾客等级**的真实效果——顾客端点顶部「💰 我的价格」填 `13800001111` 即可看到批发价与原价划线。第 20 轮又上线了 D25：库存页标题变成「最近 N 条（后端审计）」、每笔入库/改数/盘点都有流水（谁 / 何时 / 为什么 / 前后值），配送员名单与门店抬头也存服务端（`deploy/seed-demo.py` 会补 4 位配送员、门店抬头与 3 条演示流水）。

- 范式和端口见 [deploy/](deploy/)：Docker Compose 蓝绿 A/B + 主机 Nginx(80/443)，后端 `api-a`→`127.0.0.1:8093`、`api-b`→`127.0.0.1:8094`，不对外直连；**避开同机已占用端口** 22/53/80/443/8081/8082。主机 Nginx 上两个站点模板：`deploy/host-nginx.conf`（**域名 + HTTPS 主入口**，已用于 `mall.shadouyou.cloud`）与 `deploy/host-nginx-ip.conf`（IP 直连备用）；**两者的 `upstream` 名必须不同**（域名版 `sdy_api_domain`、IP 版 `sdy_api`），nginx 的 upstream 名是全局唯一的，同名会直接 `[emerg] duplicate upstream`。
- 流程：rsync 同步（带 `--chmod=D755,F644`）→ `cp .env.example .env`（填 APPCODE、`SDY_DOMAIN`）→ `./deploy/deploy.sh`（会自动 `chown` 数据目录、`chmod` 静态目录）→ 首次配主机 Nginx：照 `deploy/host-nginx.conf` 注释里的步骤做（**证书一律用本机 acme.sh，不装 certbot**：`--issue -d <域名> --webroot /usr/share/nginx/html/beian --keylength ec-256` → `--install-cert --ecc` 装到 `/etc/nginx/conf.d/certs/<域名>.fullchain.pem|.key` + `--reloadcmd "systemctl reload nginx"`；**先装 80 段、签发成功后再补 443 段**，否则 `ssl_certificate` 文件还不存在、`nginx -t` 会失败）；`mall.shadouyou.cloud` 已于 2026-10-13 按此上线，续期由 acme.sh 的每日 cron 自动完成。只需用 IP 看界面时用 `deploy/host-nginx-ip.conf`；日常更新 `./deploy/rolling-update.sh` 逐台重启不停服；**只改前端时不必重启容器**——`./web:/app/web:ro` 是只读挂载，同步文件即生效。
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

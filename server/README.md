# server · 商城后端（Go 1.24）

商城唯一的**服务端真源**：商品、库存、订单、配送费、价格防线、条码解析链都在这里执行，前端四个页面（`web/`、`barcode-demo/`、`sync-demo/`）只做展示。跑起来是**一个静态二进制**——纯标准库 `net/http` + `modernc.org/sqlite`（纯 Go 实现，`CGO_ENABLED=0`）。

这样做的原因：牵牛花抽成与账期不可控、顾客数据在平台侧；自建后佣金归零。规则集中在服务端，页面在探不到后端时自动降级为本地演示。

## 文件清单

| 文件 | 职责 |
| --- | --- |
| `server/cmd/server/main.go` | 进程入口（1327 行）：环境变量、建库与种子数据、路由表、CORS/日志中间件、超时与优雅退出、云端条码 HTTP 客户端、**员工接口与 `X-Staff-Token` 令牌鉴权（第 26 轮 D32）**、**第 27 轮起订单归属过滤 / 分页 / 下单幂等 / 地址钥匙 / `settings` 扩容 / `SEED_DEMO` 开关 / 管理端闸门（`adminGate` / `requireAdmin`）** |
| `server/cmd/server/identity.go` | **身份底座（第 27 轮新增，183 行）**：`identityOf` 身份解析优先级、`adminMarked`（`X-Admin: 1`）、`orderBelongsTo` 归属判定、`staffFromReq` 员工令牌、`addressAllowed` / `CheckAddressKey` 地址钥匙、`queryInt` / `queryOrHeader` |
| `server/cmd/server/adminauth.go` | **管理端鉴权（第 27 轮新增，160 行）**：`ADMIN_PASSWORD` + `sdy_admin` 签名 Cookie（HMAC-SHA256 + 常量时间比较）、`adminOK`（「谁是管理员」唯一真源）、`requireAdmin` / `adminGate`、`POST /api/admin/login` / `logout`；未设口令 = 灰度放行并 WARN 一次 |
| `server/cmd/server/main_test.go` | HTTP 层单测（992 行，12 个）：商品建档/编辑/删除全流程、库存语义、**商品上下架语义**、**收货地址簿全流程**、**管理端干净地址 `/admin`（含 `/admin/` 301）**、**批发价与顾客等级全流程**、**员工角色与扫码 HTTP 全流程 `TestStaffRoleAndScanHTTPFlow`（第 26 轮 D32，含「连扫三次库存不变」断言）**、CORS 预检 |
| `server/cmd/server/main_r27_test.go` | **第 27 轮 HTTP 契约单测（新增，12 个）**：`TestR27OrdersIdentity`、`TestR27OrderDetailOwnership`、`TestR27OrdersPagingAndTotal`、`TestR27AdvancePermission`、`TestR27CancelPermissionAndAudit`、`TestR27OrderCreateIdempotentHTTP`、`TestR27AddressKeyHTTP`、`TestR27SettingsDeliversRules`、`TestR27GrayChannelStillFiltersCustomers`、`TestR27AdminChannelOff`、**`TestR27AdminChannelOn`（抓出「带管理员 Cookie 就把顾客页当全店视角」的真 bug）**、`TestR27CORSAllowsIdentityHeaders` |
| `server/internal/store/store.go` | 数据层（2163 行）：7 张表、事务下单、状态机、库存回补、商品档案增删改校验、**微信用户角色与员工令牌（`role` / `staff_token` + `SetWxUserRole` / `RotateStaffToken` / `GetStaffByToken`，第 26 轮 D32）**、**商品上下架（`on_sale` + `ensureColumn` 幂等迁移）**、**批发价与顾客等级（`wholesale_price` / `customer.tier`）**、**收货地址簿（含 `address_key` 能力钥匙）**、条码字典、**第 27 轮：`ListOrdersFiltered`（归属 + 分页 + 真实 `total`）、`clientToken` 幂等与原子扣库存、`CancelOrder` 写 `stock_log`、`MinOrderGap`、`isDemo`** |
| `server/internal/store/store_test.go` | 数据层单测（1315 行，27 个，含第 26 轮 `TestWxUserRoleAndStaffToken`：角色合法性、设员工后按令牌取人、降回顾客清空令牌、令牌轮换与旧令牌失效） |
| `server/internal/store/store_r27_test.go` | **第 27 轮数据层单测（新增，10 个）**：`TestR27CreateOrderClientTokenIdempotent`、`TestR27CreateOrderMergesDuplicateCodes`、`TestR27CreateOrderAtomicRollback`、`TestR27CreateOrderMinOrder`、`TestR27CancelOrderWritesStockLog`、`TestR27CancelOrderDeletedProduct`、`TestR27OrderFilterPageAndTotal`、`TestR27AddressKey`、`TestR27ProductIsDemo`、`TestR27SettingsLowStockMinOrder` |
| `server/internal/pricing/pricing.go` | 价格与配送规则（197 行）：防线、运费、**顾客等级与有效价 `EffectivePrice`**、**第 27 轮：`Round2` 导出、`StatusText` 五档文案、未知配送方式按 delivery、`minFree<=0` 永不包邮、`MinOrderGap` 起送差**，与 `web/pricing.js` 语义一致 |
| `server/internal/pricing/pricing_test.go` | 规则单测（251 行，11 个，含第 27 轮 `Round2` / `StatusText` / 未知配送方式 / `minFree<=0` / `MinOrderGap` 边界） |
| `server/internal/barcode/barcode.go` | 条码解析链（143 行）：商品档案 → 本地字典 → 云端，含查无 TTL 与失败熔断 |
| `server/internal/barcode/barcode_test.go` | 解析链单测（187 行，6 个） |
| `server/smoke.sh` | 冒烟脚本（47 行）：起真服务跑一遍 HTTP 全流程 |
| `server/Dockerfile`、`server/go.mod`、`server/go.sum` | 构建与依赖（`go 1.24`，require `modernc.org/sqlite v1.27.0`） |
| `docker-compose.yml`、`deploy/`、`.env.example`（仓库根） | 蓝绿部署件 |

## 本地运行

```bash
cd /home/kiddyt00/GolandProjects/sdy/server
go run ./cmd/server
```

默认监听 `127.0.0.1:8093`，数据库落在 `server/data/sdy.db`（目录不存在会自动创建）。

### 同时用浏览器打开仓库里的页面

`STATIC_DIR` 是静态文件根目录，默认 `.`（只服务 `server/` 自己，打开就是文件列表）。两种用法各有取舍：

```bash
# ① 短路径：根路径直接是顾客端
STATIC_DIR=../web go run ./cmd/server
#   顾客端 http://127.0.0.1:8093/   管理端 http://127.0.0.1:8093/admin（干净地址；旧 /admin.html 仍可用）
#   代价：管理端「系统与工具」里指向 ../barcode-demo/、../sync-demo/ 的链接会 404

# ② 全仓库（推荐）：四个模块的页面都能打开，且同源共用 bd_products
STATIC_DIR=.. go run ./cmd/server
#   顾客端 http://127.0.0.1:8093/web/index.html
#   管理端 http://127.0.0.1:8093/web/admin.html
#   扫码台 http://127.0.0.1:8093/barcode-demo/index.html
#   对账   http://127.0.0.1:8093/sync-demo/sync.html
```

### 启用云端条码

```bash
BARCODE_APPCODE=你的AppCode go run ./cmd/server
```

APPCODE **只从环境变量读**，不写配置文件、不入库。不设就是纯本地模式：解析链前两层照常工作，云端那层返回 `cloud_error`（云端未配置），`/healthz` 里 `cloudConfigured: false`。

### Go 工具链不在默认 PATH 时

```bash
export GOROOT=/home/kiddyt00/GolandProjects/sdy/.tools/go-sdk/go
export PATH=$GOROOT/bin:$PATH
export GOPATH=$PWD/.tools/gopath GOMODCACHE=$GOPATH/pkg/mod
export GOCACHE=$PWD/.tools/gocache GOPROXY=https://goproxy.cn,direct
export CGO_ENABLED=0 GOFLAGS=-mod=mod
```

（本机实测 `go version go1.24.13 linux/amd64`。从 `server/` 目录执行时 `$PWD` 就是 `server/`，`GOPATH` 会指到 `server/.tools/`，与仓库根的导出方式不同——两种都能跑，别在同一终端混用。）

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ADDR` | `127.0.0.1:8093` | 监听地址（容器内用 `0.0.0.0:8080`） |
| `DB_PATH` | `data/sdy.db` | SQLite 文件路径；`:memory:` 可跑内存库（测试用） |
| `STATIC_DIR` | `.` | 静态文件根目录（页面托管，见上） |
| `BARCODE_APPCODE` | 空 | 云端条码 APPCODE；留空 = 纯本地模式 |
| `BARCODE_GATEWAY` | `https://gscode.market.alicloudapi.com/getBarcode` | 云端网关完整地址 |
| `WX_APPID` | 空 | 微信小程序 AppID（第 23 轮 D28；公开信息，`miniprogram/project.config.json` 里也有一份） |
| `WX_SECRET` | 空 | 微信小程序 AppSecret（**只在服务端**，绝不下发到前端/小程序、绝不入库）；与 `WX_APPID` 任一为空 = 微信登录关闭（`POST /api/wx/login` 返 `503`，其它功能不受影响） |
| `SEED_DEMO` | 空（**关**） | **第 27 轮新增**。只有显式设为 `1` 或 `true` 时，首次启动的空库才写入 6 个示例商品（都带 `isDemo: true`）；默认跳过并记一条日志 —— **生产库不会被演示数据污染**，生产灌演示数据走 `python3 deploy/seed-demo.py <地址>`。配送员种子（`seedCouriers`）不受它影响，仍由 `setting['seed:courier']` 控制「只种一次」 |
| `ADMIN_PASSWORD` | 空（**灰度**） | **第 27 轮新增**。管理端口令，只从环境变量读、绝不落库、绝不进日志（D13）。**不设 = 鉴权通道关闭**：所有管理接口照旧放行，启动时打一次 `[WARN] 未设置 ADMIN_PASSWORD：管理端鉴权处于关闭状态（管理接口一律放行）`。设置后管理接口要求 `sdy_admin` 签名 Cookie，未登录一律 `401 请先登录管理后台`。**第 27 轮生产故意不设**（`requireAdmin` 还不认员工令牌、后台也没有登录页，一开口令会把员工和老板一起锁在门外）——正式启用留第 30 轮 |

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/healthz` | 健康检查：`{ok, time, circuitOpen, cloudFails, cloudConfigured}` |
| POST | `/api/admin/login` | **管理端登录（第 27 轮新增，永远公开）**：`{password}`；`ADMIN_PASSWORD` 未设置 → `200 {ok:true, enabled:false}`（灰度档）；口令不对 → `401 管理口令不对`；成功 → 下发 `sdy_admin` Cookie（`HttpOnly` + `SameSite=Strict` + `Path=/` + 7 天 `MaxAge`，签名 `HMAC-SHA256(pw, "sdy-admin:"+过期时间戳)`）并回 `{ok:true, enabled:true, expiresAt}`；非 POST → `405` |
| POST | `/api/admin/logout` | **管理端退出（第 27 轮新增，永远公开）**：把 `sdy_admin` 置空（`MaxAge=-1`），回 `{ok:true}`；非 POST → `405` |
| GET | `/api/products?keyword=&category=&onSale=1&phone=` | 商品列表，返回 `{items, total, tier}`；`keyword` 匹配名称或条码，`category` 精确等值，`onSale=1` 只返回在售商品（顾客端用），按条码排序；每条**都带 `onSale` 字段**（不带 `omitempty`，缺字段视为上架）；**带 `phone=` 时按该手机号的顾客等级算好 `price` 下发**（D24：非零售等级且批发价 > 0 → 批发价，`tier` 在信封里，缺字段视为零售） |
| POST | `/api/products` | 建档/编辑商品（**自动写入条码字典层**）：服务端校验条码/名称必填、价格非负（**批发价非负且不得高于零售价**）、库存非负，并执行比价防线（超价 `400`，批发与无参考价豁免）；`stock` 字段**不传 = 不改库存**（编辑表单不改库存），传了才写；`wholesalePrice` 不传 = 清零（覆盖式 upsert，调用方必须带全）；成功返回保存后的商品，`syncStatus` 置 `pending` |
| POST | `/api/products/onsale` | 批量上下架（D23）：`{codes:[...], onSale:true\|false}`，只改 `product.on_sale` 一个字段，返回 `{ok, changed}`；**编辑档案走 `/api/products`、上下架走这里，两者互不影响**；下架只在顾客端生效（档案/库存/历史订单/条码字典都不动） |
| GET | `/api/products/{code}` | **商品详情（只读，第 24 轮新增）**：返回单个商品；带 `?phone=` 时按该手机号等级算好有效价（`p.Tier` + `p.Price`，规则同列表）；条码为空 → `400 缺少条码`，查不到 → `404 资源不存在: 商品 <code>`，非 GET 方法 → `405`（`/api/products/stock`、`/api/products/onsale` 是更精确的模式，仍优先匹配） |
| GET | `/api/products/categories?onSale=1` | **分类计数（只读，第 24 轮新增）**：`{items:[{name, count}], total}`；空 / 空白分类统一归 **`未分类`**（与 `web/mall-admin.js` / `web/sdy-api.js` 同口径）；排序按件数降序、同名升序；`onSale=1` 只统计在售；无数据返回**非 nil 空数组**；非 GET → `405` |
| DELETE | `/api/products/{code}` | 删除商品档案（任务池①）：库存必须为 0（否则 `409` 提示先盘点为 0）、没有进行中订单引用（否则 `409`）；删档**保留条码字典层记录**（D6 永久沉淀）；成功返回 `{ok:true, code}` |
| POST | `/api/products/stock` | 手动改库存 `{code, stock}`（D8：库存一律手动调整，扫码只读）；同时把 `syncStatus` 置为 `pending` |
| GET | `/api/addresses?phone=&key=` | 收货地址簿列表（D18；**第 27 轮加能力钥匙**）：默认地址排最前，其余按入库顺序；`phone` 为空返回 `400`。**顾客必须带 `phone` + `key`**（`key` 是首次写入地址时服务端生成的 32 位 hex，随 `POST` 响应 `{ok:true,key}` 下发，客户端存本地）；`key` 缺失或不匹配 → **静默空** `{items:[],total:0}`（不报错也不给数据）；员工 / 管理员按 `phone` 直查 |
| POST | `/api/addresses` | 新增/编辑收货地址 `{id, phone, contact, address, isDefault, key?}`：`id=0` 新增（**第一条自动成为默认**），带 `id` 则按 `id + phone` 更新（不存在返回 `404`）；`isDefault=true` 时摘掉同手机号其它条目的默认标记；**响应新增 `key`**（首次为该手机号建钥匙时下发，之后原样带回） |
| DELETE | `/api/addresses/{id}?phone=&key=` | 删除一条（不存在 `404`、编号非法 `400`）；**第 27 轮起必须 `phone` + `key`**（无钥匙或错钥匙 → `404 地址不存在`，不泄露存在性）；**删掉默认地址后由最早的一条顶为默认** |
| GET | `/api/customers` | 顾客列表（D24）：`{items:[{phone, name, tier, tags, note}], total}`，等级存 `customer.tier`（`retail` 默认 / `wholesale` / `vip`） |
| POST | `/api/customers/tier` | 登记 / 改顾客等级（D24）：`{phone, name, tier}`，`tier` 只接受 `retail` / `wholesale` / `vip`（非法或手机号为空 → `400 参数不合法: …`）；`name` 留空保留原名；**改等级只影响之后的单**，历史订单价格是下单当时快照 |
| POST | `/api/stock/change` | **库存变更唯一入口**（D25）：`{code, kind, qty, reason, by}`，`kind` ∈ `stock_in` / `adjust` / `stock_take`；**改库存与写 `stock_log` 在同一事务**（失败一律回滚，不留「改了库存没流水」），返回 `{ok, entry, stock}`（`stock` 就是 `entry.after`）；非法数量（入库 ≤0、改数 =0、盘点 <0、改完为负）→ `400`，商品不存在 → `404`，`kind` 不在三种之内 → `400` |
| GET | `/api/stocklog?limit=` | 库存审计流水（D25）：`{items, total}`，按 `id` 倒序，`limit` 缺省或超过 500 都按 **500** 封顶 |
| GET | `/api/couriers` | 配送员名单（D25）：`{items:[{name, phone}], total}`，只列 `active=1`，按 `sort` 排序 |
| POST | `/api/couriers` | 新增 / 修改配送员（D25）：`{name, phone, remove}`；姓名必填且 ≤12 字（否则 `400`）、改不存在的 → `404`、**删到只剩一位 → `409 至少要保留一位配送员`** |
| GET | `/api/settings` | 门店抬头 + 运营参数（D25；**第 27 轮扩容**）：`{name, phone, address, footer, lowStock, minOrder, deliveryFee, minFree}` —— 原四项默认「家庭超市」/「谢谢惠顾，欢迎再来！」（与前端 `DEFAULT_STORE` 一致）；**新增 `lowStock`（默认 5）、`minOrder`（默认 0 = 不限）、`deliveryFee`、`minFree`**，三端**删除硬编码 5**，低库存阈值与起送价一律走这里下发 |
| POST | `/api/settings` | 保存门店抬头与运营参数（D25；**第 27 轮扩容**）：店名必填 ≤20 字（否则 `400 请填写店名` / `400 店名不能超过 20 字`），票尾留空 → 回默认那句；**`lowStock` / `minOrder` 用指针区分「没传 = 保留现值」与「传 0 = 回落默认」**，先 `GetSettings` 再合并再 `SaveSettings` |
| POST | `/api/customers/note` | 顾客备注与标签（D25）：`{phone, name, tags, note}`，标签 ≤60 字、备注 ≤200 字（超长 `400`），姓名留空保留原名、**不碰等级**（等级走 `/api/customers/tier`） |
| GET | `/api/orders?status=&phone=&openid=&limit=&offset=` | 订单列表（**第 27 轮身份过滤 + 分页**）：先 `identityOf` 认人——员工/管理员看全量、否则按 `phone`（或 openid 解析出的手机号）**只回本人单**，都没身份 → `400 {"error":"缺少身份：顾客请带 openid/phone，员工请带 X-Staff-Token"}`；返回 `{items, total, limit, offset}`，**`total` 是符合条件总数**（不是本页条数），`limit` 默认 50 / 上限 200 |
| POST | `/api/orders` | 下单（事务内校验 → **原子扣库存** → 写订单，避免超卖），成功返回 `201`。**第 27 轮**：body 新增 `clientToken`——同 token 第二次返回**原单** + `duplicated:true` 且只扣一次库存；库存扣减用 `UPDATE product SET stock=stock-? WHERE code=? AND stock>=?`，任一行 0 行 → 整单回滚 `400 库存不足：<名称>（还剩 N 件）`；`goods < minOrder` → `400 还差 X 元起送` |
| GET | `/api/orders/{id}?phone=&openid=` | 订单详情（**第 27 轮归属校验**）：顾客身份与订单不匹配 → **`404 订单不存在`**（不泄露存在性）；员工/管理员放行 |
| POST | `/api/orders/{id}/advance` | 状态流转 `{to: delivering\|ready\|done\|cancelled}`（**第 27 轮收紧，优先用 `/cancel` 取消**）：**只有员工能推进**；唯一例外是**归属人自己 `to=done`**（确认收货）；否则 `403 只有店主可以推进订单状态` |
| POST | `/api/orders/{id}/cancel?phone=&openid=` | **取消订单（第 27 轮新增独立路由）**：按归属校验（不是我的单 → `404`，员工/管理员放行）；事务里**回补库存并写 `stock_log`**（`kind=cancel_return`、`reason=取消订单回补`、回填 `order_id`，`RowsAffected=0` 只记日志不失败），保证审计可追；重复取消不会二次回补 |
| GET | `/api/barcode/resolve?code=` | 条码解析链：商品档案 → 本地字典 → 云端；查到永久回填字典，查无标记 90 天，连续失败 5 次熔断当日 |
| GET | `/api/barcode/lib?limit=` | 条码字典层列表（默认 200 条，只读） |
| GET | `/api/pricing/check` | 比价防线巡检，返回 `{total, over, violations}` |
| POST | `/api/wx/login` | **微信登录唯一入口**（D28；第 25 轮 D31 起 `phone` 可选）：`{code, phone?, nickname?, avatar?}`；`code` 来自小程序 `wx.login`，服务端用 `WX_APPID`/`WX_SECRET` 调 `sns/jscode2session` 换 `openid`（**session_key 只留服务端、不回传**），把 openid 绑到手机号档案（`EnsureCustomer` 建档但**只补空姓名、不覆盖老板维护的姓名**，手机号必须 11 位且 1 开头）；**`phone` 不传也能登录**（第 25 轮 D31：手机号是价格身份与地址簿钥匙，推迟到下单时填；不传=保留原绑定，`name` 初值用微信昵称、只有已绑手机号且顾客档案有名字时才用档案名）；成功返回 `{ok, openid, bound, phone, name, nickname, avatar, tier}`；`code` 为空 → `400`，微信侧错误（code 失效 / AppSecret 不对 → `-10008` 一类）原文透出，服务端没配 `WX_APPID`/`WX_SECRET` → `503 微信登录未配置（服务端缺少 WX_APPID / WX_SECRET）`；**登录不提权**：新顾客一律零售档，批发/白名单只能老板在管理端改（D24）；**第 26 轮 D32 起 body 新增可选 `role`**：缺省是顾客，非法值 → `400 身份只能是 customer（顾客）或 staff（员工）`，**选了员工但后台没把这个微信号标成员工 → `403 这个微信号还不是员工，请让老板在管理后台把角色改成员工`**（客户端自己点不出权限）；响应新增 `role` / `wantRole`，**是员工就一律回 64 位 `staffToken`**（32 字节 `crypto/rand` → 64 位 hex，**每次员工登录轮换、旧令牌立刻失效**；即使这次选了顾客身份也回令牌，只为「我的」页一键进工作台方便，**不是提权**——员工本来就跟管理后台同权限） |
| POST | `/api/wx/profile` | **保存微信头像昵称**（第 25 轮 D31）：`{openid, nickname, avatar}`；**空值保留原值**（只换头像不清昵称），昵称截 20 rune、头像 ≤512 rune（超了报「头像地址过长」），openid 不存在 → `404 资源不存在`，缺 openid → `400 缺少 openid（先登录再保存头像昵称）`，非 POST → `405`；成功返回 `{ok, openid, nickname, avatar}` |
| GET | `/api/wx/users` | 已绑过的微信用户（只读；第 26 轮起也是 Web 管理端「用户角色」面板的数据源）：`{items:[{openid, unionid, phone, nickname, role, createdAt, updatedAt, lastLogin}], total}`；**不下发 `staff_token`**（令牌故意不进 `store.WxUser`，防止列表接口泄露） |
| POST | `/api/wx/role` | **设定微信用户角色（第 26 轮 D32，管理后台唯一入口）**：`{openid, role}`，`role` 只认 `customer` / `staff`（`store.ValidRole`，非法 → `400 角色只能是 customer（顾客）或 staff（员工）`），缺 openid → `400 缺少 openid（让对方先用小程序登录一次）`，未知 openid → `微信用户 <openid>（让它先用小程序登录一次）`；**改成顾客时 `staff_token` 一并清空**（令牌立刻失效），改员工后可让对方以员工身份重新登录拿新令牌 |
| GET | `/api/staff/overview` | **员工工作台聚合（第 26 轮 D32）**：请求头 `X-Staff-Token`（也接受 `?staff=` 兜底），失败一律 `401 员工身份已失效，请用员工身份重新登录`；返回 `stats{todayRevenue, todayOrders, pending, lowStockCount, products}` + `pendingOrders`（最多 5 条）+ `lowStockItems`（最多 5 条）+ `recent`（最近 5 条库存流水）；低库存阈值 **5**（与 Web 管理端同一口径） |
| GET | `/api/staff/scan?code=` | **员工扫码台查询（第 26 轮 D32）**：同样 `X-Staff-Token` 鉴权；命中已建档条码返回 `product`，未建档返回条码解析结果 `resolve`，并附该条码最近 5 条流水；**扫码绝不改库存（D8 不变量）**——入库 / 出库 / 盘点仍走既有的 `POST /api/stock/change` |
| GET | `/admin` | 管理端干净地址：直接把 `STATIC_DIR/admin.html` 吐出来；`/admin/` 带尾斜杠会 301 到 `/admin`（带斜杠时页面内相对路径基准变成 `/admin/`，`assets/theme.css` 等会 404）；旧 `/admin.html` 继续可用 |
| — | `/`（其余路径） | 静态文件（`STATIC_DIR`） |

**错误码**：`400` 参数不合法 / `404` 资源不存在 / `409` 库存不足或状态不允许流转 / `405` 方法不支持 / `500` 其他。领域错误到 HTTP 码的映射写在 `server/cmd/server/main.go:441` 的 `writeErr`，用 `errors.Is` 判断 `store.ErrBadInput` / `ErrNotFound` / `ErrStockLess` / `ErrConflict`。（`ErrBadInput` 的响应文案统一带「参数不合法: 」前缀，前端 `sdy-api.js` 原样透出，所以页面上看到的校验提示可能带这个前缀。）

所有接口都带 CORS（`Access-Control-Allow-Origin: *`），`OPTIONS` 直接返回 `204`，方便扫码台在别的端口调试。请求体上限 1 MiB（`http.MaxBytesReader`）。第 27 轮起 `Access-Control-Allow-Headers` 扩为 `Content-Type,X-Staff-Token,X-Openid,X-Phone,X-Admin`。

**身份解析优先级（第 27 轮 D33，唯一入口 `identityOf`，`server/cmd/server/identity.go`）**：

1. 有效 `X-Staff-Token`（也接受 `?staff=` 兜底）→ 员工，`Admin: true` + `Staff` + `OpenID` + `Phone`，**全量可见**；
2. **显式**管理端标记：`adminMarked(r)`（请求头 `X-Admin: 1`）**且** `adminEnabled()` 且 `adminOK(r)` → 管理员，即使同时带 `phone` 也按全量；
3. `openid`（`?openid=` 或 `X-Openid` 头）→ 服务端用 `wx_user.phone` 解析出手机号（认不到或没绑手机号就继续往下）；
4. `phone`（`?phone=` 或 `X-Phone` 头）→ Web 顾客兼容路径；
5. `!adminEnabled() && adminOK(r)` → 灰度放行（**必须排在顾客身份之后**：否则灰度默认时任何请求都算管理员，`?phone=B` 就能读到 A 的订单、地址钥匙形同虚设、无令牌也能推进订单 —— 第 27 轮验收实测）；
6. 都没有 → 视调用点返回 `400 缺少身份` 或 `404`。

`adminMarked` 的 `X-Admin: 1` **不是安全边界**（谁都能加这个头），安全边界始终是管理端 Cookie（`adminOK`）；它只用来把「同一浏览器里的管理后台」与「顾客页」区分开——**管理端 Cookie 与顾客页同域共用，早期实现「带了 Cookie 就按管理员身份」会把老板自己逛顾客页变成全店视角**（这是第 27 轮修掉的真 bug，回归测试 `TestR27AdminChannelOn`）。

## 测试

```bash
cd /home/kiddyt00/GolandProjects/sdy/server
go test ./... -count=1        # 78 个单测（第 27 轮实测）
./smoke.sh                    # 起真服务跑 HTTP 全流程
```

`go test ./...` 实测结果（全部 PASS）：

| 包 | 数量 | 用例 |
| --- | --- | --- |
| `server/internal/barcode` | 6 | `TestResolveProductFirst`、`TestResolveLibSecond`、`TestResolveCloudBackfill`、`TestResolveCloudNotFoundTTL`、`TestResolveCircuitBreaker`、`TestResolveEdgeCases` |
| `server/internal/pricing` | 11 | 第 26 轮 5 个（`TestDeliveryFee`、`TestDeliveryFeeCustomConfig`、`TestCheckRetailPrice`、`TestPricingCheck`、`TestEffectivePrice`）+ **第 27 轮 6 个（`Round2` 与 JS 同口径、`StatusText` 五档、未知配送方式按 delivery、`minFree<=0` 永不包邮、先 round2 再比门槛（29.995/29.994）、`MinOrderGap` 边界）** |
| `server/internal/store` | 37 | 第 26 轮 27 个（`TestUpsertAndGetProduct`、`TestListProductsFilter`、`TestSetStockMarksPending`、`TestCreateOrderPickup`、`TestCreateOrderDeliveryFee`、`TestCreateOrderValidation`、`TestCreateOrderInsufficientStock`、`TestAdvanceOrderStateMachine`、`TestCancelOrderRestoresStock`、`TestListOrdersAndCustomer`、`TestListLib`、`TestUpsertProductValidation`、`TestUpsertProductPriceGuard`、`TestDeleteProductGuard`、`TestAddressBook`、`TestProductOnSaleSemantics`、`TestOnSaleColumnMigration`、`TestCustomerTierWholesalePrice`、`TestTierColumnMigration`、`TestStockChangeAudit`、`TestStockLogCap`、`TestCouriersPersist`、`TestStoreSettings`、`TestCustomerNote`、`TestWxUserBind`、`TestListCategories`、`TestWxUserRoleAndStaffToken`）+ **第 27 轮 10 个（`TestR27CreateOrderClientTokenIdempotent`、`TestR27CreateOrderMergesDuplicateCodes`、`TestR27CreateOrderAtomicRollback`、`TestR27CreateOrderMinOrder`、`TestR27CancelOrderWritesStockLog`、`TestR27CancelOrderDeletedProduct`、`TestR27OrderFilterPageAndTotal`、`TestR27AddressKey`、`TestR27ProductIsDemo`、`TestR27SettingsLowStockMinOrder`）** |
| `server/cmd/server` | 24 | 第 26 轮 12 个（`TestProductHTTPFlow`、`TestProductStockSemantics`、`TestProductOnSaleHTTPFlow`、`TestAddressHTTPFlow`、`TestAdminCleanURL`、`TestHealthzAndOptions`、`TestCustomerTierHTTPFlow`、`TestStockChangeHTTPFlow`、`TestCourierSettingsNoteHTTPFlow`、`TestWxLoginHTTPFlow`、`TestProductDetailAndCategoriesHTTPFlow`、`TestStaffRoleAndScanHTTPFlow`）+ **第 27 轮 12 个（`TestR27OrdersIdentity`、`TestR27OrderDetailOwnership`、`TestR27OrdersPagingAndTotal`、`TestR27AdvancePermission`、`TestR27CancelPermissionAndAudit`、`TestR27OrderCreateIdempotentHTTP`、`TestR27AddressKeyHTTP`、`TestR27SettingsDeliversRules`、`TestR27GrayChannelStillFiltersCustomers`、`TestR27AdminChannelOff`、`TestR27AdminChannelOn`、`TestR27CORSAllowsIdentityHeaders`）** |

合计 **78 个单测**（第 26 轮 50 + 第 27 轮 28），本机实测 `go test ./... -count=1` 全部通过（各包耗时 cmd-server 0.641s / store 0.799s / barcode 0.075s / pricing 0.005s；`gofmt` 干净、`go vet ./...` 干净、`go build` 干净）。

**第 27 轮新增的端到端脚本**（都在 `deploy/`，与 Go 单测互补）：

- `deploy/accept-r27.js`：真后端契约验收，**通过 54 项 / 失败 0 项**（覆盖三端规则同判、空库不播种、订单归属、`advance` 权限、下单幂等、库存原子、取消回补流水、地址钥匙、`settings` 下发、灰度与管理端两种鉴权档）。它会打印一条 **警告（不是失败）**：灰度模式下无身份请求会被当管理端放行。
- `bash deploy/verify-all.sh`：三端全量验收（gofmt/vet/build + Go 单测 + 小程序三套 + Web 五套 + CDP），自起临时后端（`127.0.0.1:8093`）与假微信（`deploy/fake-wx.js`，`8097`）、临时库 `/tmp/sdy-verify.db`，结束自动清理；支持 `SKIP_CDP=1` / `SKIP_INTEGRATION=1`。**第 27 轮实测 17 行汇总全部 ✅**。

`./smoke.sh` 会 `go build` 一个临时二进制，用 `mktemp` 建临时库（**不碰 `server/data/sdy.db`**），起在 `127.0.0.1:8099`（`SMOKE_PORT` 可改，**默认不占用 8093**），轮询 `/healthz` 就绪后依次验证 8 项：健康检查 → 商品数 → 条码解析 → 下单 → 下单后库存 → 非法流转返回 409 → 取消回补库存 → 比价巡检，最后退出并清理进程与临时文件。实测输出以 `✅ 冒烟通过` 结束（下单示例：`6901234567892` 库存 120 → 118，取消后回到 120）。

静态检查：

```bash
gofmt -l ./cmd ./internal      # 无输出即合规
go vet ./...
```

本机实测：`gofmt -l ./cmd ./internal` 无输出、`go vet ./...` 无告警。

## 设计要点与不变量

**真源与规则**

- **规则只在服务端执行**：配送费、价格防线、库存扣减、订单状态机、条码解析链都由 Go 实现；前端不重复实现（只做展示与镜像）。本地演示模式是**降级兜底**，不是第二套规则。
- **订单状态机**：`pending → delivering | ready | cancelled`，`delivering | ready → done`，`done`/`cancelled` 是终态。非法流转返回 `409`，文案形如「状态不允许从「pending」变更为「done」」。
- **下单是一个事务**：校验配送方式/姓名手机/地址/购物车非空 → 逐行校验数量与库存 → 扣库存 → 写订单与订单项 → 沉淀顾客档案，全部在一个事务里，任一步失败整单回滚（**不会部分扣减**）。库存不足的错误文案是「仅剩 N」。
- **取消订单逐行回补库存**，并把回补过的商品 `sync_status` 置回 `pending`。
- **价格防线**：`salePrice ≤ round2(refPrice × 0.95)`；批发商品（`ExcludeWholesale: true`）与无参考价（`refPrice <= 0`）自动跳过。默认配置：自提 0 元、满 30 元免运费否则 3 元。
- **配送方式：入参严格、计费宽容（第 27 轮，刻意分层不是漏改）**：`store.CreateOrder` 只认 `pickup` / `delivery`（`delivery_type` 是落库枚举，脏值直接 `400`），而 `pricing.DeliveryFee` 对**未知配送方式不再报错、一律按 `delivery` 计费**——落库字段要拒脏数据，计费函数要对历史脏值与将来新增方式给出确定行为，两者目标不同，所以口径不同。同一条规则里 `MinFree` 改为**先 `round2(subtotal)` 再比较**（修掉 `29.995` 这类边界上「前端显示免运费、服务端仍收 3 元」的算错钱），且 `MinFree <= 0` 的新语义是**永不包邮**（不再被 `Normalize()` 强制改回 30）；未知 tier 也一律归 `retail`（`pricing.NormalizeTier`）。
- **商品档案校验**：`POST /api/products` 在 store 层校验条码/名称必填、价格非负、库存非负，并**在服务端执行比价防线**（`UpsertProduct` 内调 `pricing.CheckRetailPrice`，超价返回 `400`，批发与无参考价豁免）；缺省单位补「件」、分类补「未分类」。**`stock` 不传 = 保留原库存**（指针区分「没传」与「传 0」），保证管理端编辑表单不会误清库存。
- **删除商品档案**：`DeleteProduct` 先查在库量与进行中订单，再删行；**条码字典层（`barcode_lib`）不删**——D6 的永久沉淀，删档后扫码仍能识别。
- **D32 员工身份与员工扫码工作台（第 26 轮）**：① **小程序里只有两种角色**——`store.RoleCustomer = 'customer'`（默认）/ `store.RoleStaff = 'staff'`，`store.ValidRole(r)` 只认这两个小写值；`wx_user` 加 `role TEXT NOT NULL DEFAULT 'customer'` 与 `staff_token TEXT NOT NULL DEFAULT ''`，**都走 `ensureColumn` 幂等迁移**（老库直接升、不重建表）。② **角色只能由管理后台给**：`SetWxUserRole(openid, role)` 供 `POST /api/wx/role` 使用，未知 openid 报「微信用户 %s（让它先用小程序登录一次）」；**改成顾客时把 `staff_token` 一并清空**（`UPDATE ... SET role=?, staff_token=''`），改员工时不动旧令牌（对方重新登录即轮换）。③ **令牌与用户结构体分家**：`store.WxUser` **不带令牌字段**，`GET /api/wx/users` 不可能泄露令牌；`RotateStaffToken(openid)` 用 32 字节 `crypto/rand` → 64 位 hex 写回 `staff_token`，`GetStaffByToken(token)` 反查员工——**每次员工登录都轮换，旧令牌立刻失效**。④ **登录侧**：`POST /api/wx/login` 的 `role` 可选（缺省顾客，非法 400），**选了员工但后台没标成员工 → 403**「这个微信号还不是员工，请让老板在管理后台把角色改成员工」——「客户端自己点不出权限」是这一轮的硬口径；响应加 `role` / `wantRole`，**是员工就一律回 64 位 `staffToken`**（含这次选了顾客身份的情况，只为「我的」页一键进工作台方便，**不是提权**：员工与 Web 管理后台同权限）。⑤ **两个员工聚合接口用 `X-Staff-Token` 守**（也接受 `?staff=` 兜底，失败一律 `401 员工身份已失效，请用员工身份重新登录`）：`GET /api/staff/overview`（`stats` + 待处理前 5 + 低库存前 5（阈值 **5**，与 Web 管理端同口径）+ 最近 5 条流水）、`GET /api/staff/scan?code=`（命中返 `product`、未建档返 `resolve` + 该条码最近 5 条流水）；**扫码只读不变量不变（D8）**——入库 / 出库 / 盘点仍走 `POST /api/stock/change`，由小程序再点一下并二次确认。⑥ **员工是全权限**（能改价 / 删商品 / 改顾客等级），所以员工的写操作复用既有开放接口，**只有上面两个聚合接口带令牌**；**站点级管理端鉴权仍是遗留项**（管理端接口本身无鉴权，历史遗留，如实记）。⑦ **界面开关 ≠ 身份**：小程序 `setView('customer')` 只切回顾客版界面，服务端角色与令牌都还在；只有老板在后台把角色改回顾客，令牌才失效。
- **D33 身份底座、正确性收敛与管理端鉴权灰度（第 27 轮）**：这一轮不加功能，只把「会算错钱、会越权、会把失败当空数据」的地方一次修掉，代码拆成两个新文件 `identity.go`（身份解析 / 归属 / 地址钥匙）与 `adminauth.go`（管理端鉴权）。① **身份解析优先级**见上「身份解析优先级」一节，唯一入口 `identityOf`（**灰度放行必须排在顾客身份之后**，否则等于没有身份过滤）。② **那个真 bug**：管理端 Cookie 与顾客页同域共用，早期「带了管理员 Cookie 就按管理员身份」会把老板自己逛顾客页变成全店视角；修法是管理端身份**必须显式带 `X-Admin: 1`**（`adminMarked`），Web 端只在 `ordersAll === true` 时带它。③ **订单归属**：`ListOrdersFiltered` 返回 `(list, total, err)`，`total` 是符合条件总数（解决「total 只是本页条数」的老坑）；查/取消他人单 `404`；`advance` 非员工且非「归属人 + `to=done`」→ `403`；`CancelOrder` 在事务里回补库存并写 `stock_log`（`cancel_return`）。④ **下单幂等 + 原子扣库存 + 起送价**：`ErrDuplicated` → 按 `clientToken` 取回原单 `duplicated:true`；扣减 `WHERE stock>=?`；`ErrStockLess` 文案「库存不足：<名称>（还剩 N 件）」；`MinOrderGap` 起送差。⑤ **地址能力钥匙**：`EnsureAddressKey` / `CheckAddressKey`，`address_key` 列走 `ensureColumn` 幂等迁移；读静默空、删 `404`。⑥ **规则真源**：`Normalize()` 不再给 `MinFree` 兜底（`<=0` = 永不包邮）、未知配送方式按 delivery、先 `Round2` 再比门槛、未知 tier 归 retail、五档状态文案 `StatusText`。⑦ **`SEED_DEMO` 默认关**（示例商品带 `isDemo: true`）。⑧ **管理端鉴权灰度**：`adminOK` 是唯一真源（`requireAdmin` 与身份解析共用）；口令空 → WARN 一次并放行。⑨ **两处如实披露的缺口**：(a) 灰度档下无身份请求按管理端放行，R27 契约的「无身份→400」「无令牌 advance→403」只在通道开启时成立；(b) `requireAdmin` **不认员工令牌**、后台也没有登录页，所以第 27 轮生产**故意不设 `ADMIN_PASSWORD`**（一开口令会把员工与老板一起锁在门外）——正式启用要第 30 轮把「支持员工令牌」+「后台登录页 `#loginGate`」**一起**交付。
- **D31 登录与信息展示收敛（第 25 轮）**：① **登录不要手机号**——`/api/wx/login` 的 `phone` 变可选，不传就是「这台微信是谁」的登录，手机号推迟到下单时填（前端 `api.rememberPhone()` 记住）；**空 `phone` = 保留原绑定**（`phone = CASE WHEN excluded.phone<>'' THEN excluded.phone ELSE wx_user.phone END`），头像同理。② `wx_user` 加 `avatar TEXT NOT NULL DEFAULT ''`（走 `ensureColumn` 幂等迁移，线上库不用手工改表）。③ 新增 `POST /api/wx/profile`（`UpdateWxProfile`）：空值保留原值、昵称截 20 rune、头像 >512 rune 报「头像地址过长」。④ **头像不落服务端文件**——小程序 `chooseAvatar` 给的是临时本地路径，客户端用 `wx.getFileSystemManager().saveFile` 落永久文件，且**只有 http(s) 地址才回传**（`wxfile://` 存上去没意义）。⑤ **顾客端不露开发信息**：连接状态只留小圆点（Web 是 `.dot-mode`、小程序是 `.sdot`），**管理端保留详细徽标**。
- **D28 微信登录**：`wx.login` 的 `code` 只用于服务端换 `openid`（`sns/jscode2session`），**session_key 不出服务器**；`wx_user` 表存 `openid`/`unionid`/`phone`/`nickname`/`avatar`/时间戳（时间是 RFC3339 字符串），`BindWxUser` 对超长昵称**截断不报错**（绝不让登录因为昵称失败），`EnsureCustomer` 只在新名字为空时补名、**绝不覆盖老板维护的姓名**，`ValidPhone` 把坏手机号挡在登录之外。**登录不提权**：手机号仍是价格身份（`customer.tier`），新顾客一律零售档，批发价/白名单只能管理端改（D24 不变）；cookie 与 token 都不发，openid 就是客户端要记住的全部。未配置 `WX_APPID`/`WX_SECRET` 时接口返 `503` 且**其它接口完全不受影响**——所以本机演示与没配密钥的生产环境都能照常跑。
- **D18 收货地址簿**：`customer_address` 按手机号一档多条（`phone` 建索引），`ListAddresses/SaveAddress/GetAddress/DeleteAddress` 四个方法守住三条语义——第一条自动为默认、`isDefault=true` 时摘掉同号其它默认、删掉默认后由最早一条顶替；`SaveAddress` 不传 `isDefault` 时**不动原有默认标记**（避免改门牌丢默认），更新不存在的 `id` 返回 `404`。订单里存的仍是下单当时的地址快照，改地址簿不影响历史订单。
- **D23 商品上下架**：`product.on_sale INTEGER NOT NULL DEFAULT 1`，只为老库补的列走 `ensureColumn`（幂等：`PRAGMA table_info` 里没有才 `ALTER TABLE ADD COLUMN`），**升级不用清库**；`SetProductsOnSale(codes, on) (int, error)` 一条 `UPDATE ... WHERE code IN (...)`，返回真正改动的行数；`ListProducts(onSaleOnly=true)` 过滤在售；**`CreateOrder` 会拦下架商品**（即使前端被绕过），形成「顾客端不显示 + 下单端拦截」双保险；`onSale` 用**不带 `omitempty`** 的字段下发，缺字段一律视为上架（老库/老前端不会集体消失）。
- **上下架与建档是两条路**：`UpsertProduct`（`POST /api/products`）**不读写 `on_sale`**（保持原值），上下架只走 `POST /api/products/onsale`——「编辑不改库存」（D16）与「编辑不改上下架」（D23）是同一条原则的两个实例。
- **D24 批发价与顾客等级**：`product.wholesale_price REAL NOT NULL DEFAULT 0`（**0 = 未设**）与 `customer.tier TEXT NOT NULL DEFAULT 'retail'` 都走 `ensureColumn` 幂等迁移，升级不用清库；等级白名单只有 `retail` / `wholesale` / `vip`（`pricing.ValidTier`——空串也算合法并归一成零售，`pricing.NormalizeTier('') == "retail"`）。**有效价只有一条公式**：`pricing.EffectivePrice(tier, salePrice, wholesalePrice)` = 非零售等级（`pricing.IsWholesaleTier`：`wholesale` / `vip`）**且**批发价 > 0 ? `round2(wholesalePrice)` : `round2(salePrice)`——所以「批发价 = 0」就是「这货不批发」，批发客户仍按零售价。
- **D24 价格真源在服务端**：`GET /api/products?phone=` 用 `GetCustomerTier` 查等级、把算好的 `price` 下发给前端（信封里还带 `tier`，查不到手机号 → `retail`，`price` 不带 `omitempty`）；`CreateOrder` 在同一个事务里先 `SELECT tier FROM customer WHERE phone=?`（`ErrNoRows` → `retail`），再逐行 `SELECT name, sale_price, wholesale_price, stock, on_sale` 并用**同一个** `EffectivePrice` 算行价小计——**前端传的价格不参与结算**（与 D12「前端只经 `sdy-api.js`、规则只在服务端」同一条原则）。`SetCustomerTier(phone, name, tier)` 校验手机号非空 + 等级白名单（否则 `ErrBadInput`，文案「参数不合法: 顾客等级只能是 retail / wholesale / vip」），`name` 留空保留原名；`GetCustomerTier`/`GetCustomer`/`ListCustomers` 是只读口。**改等级只影响之后的单**：历史订单价格是下单当时的快照（同「地址快照」「小票只读投影」）。批发价**不参与零售比价防线**（防线守的是零售价，`ExcludeWholesale` 那一维不变）。
- **`wholesale_price` 与 `img` 一样是覆盖式**：`UpsertProduct` 的 `ON CONFLICT ... SET wholesale_price=excluded.wholesale_price`，调用方漏传即清零——`web/sdy-api.js` 的每个 upsert payload 与 `deploy/seed-demo.py` 都必须带 `wholesalePrice`（种子数据里 7 款商品带了批发价）。
- **D25 库存审计（第 20 轮）**：三张新表——`stock_log(id INTEGER PRIMARY KEY AUTOINCREMENT, at, ts, kind, code, name, unit, delta, before_qty, after_qty, reason, operator)`、`courier(name TEXT PRIMARY KEY, phone, sort, active)`、`setting(k TEXT PRIMARY KEY, v)`；`Open()` 末尾按 `setting` 里的 `seed:courier` 标记**只种一次**默认配送员（老张 / 小李 / 阿强 / 小美，事务 + `INSERT ... ON CONFLICT(name) DO NOTHING`，改过就不覆盖）。`ChangeStock` 是**唯一入口**：一个事务里 `SELECT name, unit, stock FROM product WHERE code=?` → 算 `after`（`stock_take` 直接用实盘数，其余 `before + qty`）→ `after < 0` 直接拒 → `UPDATE product SET stock=?, sync_status='pending', updated_at=?` → `INSERT INTO stock_log`（`delta = after - before`、`at` 用 UnixMilli、`ts` 用 RFC3339）→ 同事务裁剪**只留最近 500 条** → `Commit`；所有失败路径 `defer Rollback`，所以**不会出现「库存变了、没流水」**。`SetStock`（老接口）保留但折算成 `adjust` + `reason="直接改数"`，同值不写流水。`ListStockLog(limit)` 倒序（`limit ≤ 0` 或 `> 500` 都按 500）。
- **D25 门店抬头 / 配送员 / 顾客备注**：`GetSettings` / `SaveSettings` 用 `setting` 表的 `store.*` 前缀键（店名必填 ≤20 字、`footer` 留空回默认那句）；`SaveCourier(name, phone, remove)` 校验姓名必填 ≤12 字、删除用 `COUNT(*) <= 1` 拦「至少要保留一位配送员」（`ErrConflict` → `409`）、新增走 `sort = COALESCE(MAX(sort), -1) + 1` 且 `ON CONFLICT(name) DO UPDATE SET phone=excluded.phone, active=1`（软删再恢复）；`SetCustomerNote(phone, name, tags, note)` 只动备注与标签（`tags ≤ 60` / `note ≤ 200` rune、姓名留空保留原名、**不动 `tier`**）。

- **D8 扫码只读**：`/api/barcode/resolve` 只识别、不写价格库存；库存只能通过 `/api/products/stock` 手动改。
- **D6 双库**：建档（`POST /api/products`）会**顺带把条码写进字典层**（`source=product`），所以建过档的码永久走本地命中，不再花云端配额。字典层的命中计数不会被 upsert 重置。

**持久化与运行**

- SQLite 非内存库时统一追加 `?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)`；`:memory:` 时强制 `SetMaxOpenConns(1)`（否则每个连接会看到不同的内存库）。WAL 模式让容器里两个实例可以同时读写，写锁最多等 5 秒。
- 7 张表：`product`（含 `on_sale`（第 18 轮）与 `wholesale_price`（第 19 轮））、`barcode_lib`、`customer`（含 `tier`，第 19 轮）、`customer_address`（收货地址簿，D18）、`orders`、`order_item`、`sync_batch`。**`sync_batch`（对账批次）目前只有表和 store 方法，HTTP 层没有暴露接口**。加列一律走 `ensureColumn` 幂等迁移，不重建表。
- 首次启动且**库为空**时，**只有显式设置 `SEED_DEMO=1`（或 `true`）**才写入 6 个示例商品（可口可乐/农夫山泉/心相印抽纸/旺旺雪饼/青岛啤酒/伊利纯牛奶，`isDemo: true`）；不设则该步跳过并记一条日志，生产库不会被演示数据污染。条码、售价、库存与前端 `web/mall.js` 的种子一致，但**分类/规格等文案两边略有出入**（如心相印抽纸这里分类是「日用品」、前端写「纸品」；青岛啤酒这里规格是「330ml 罐装」、前端写「500ml 罐」）。配送员种子（`seedCouriers`）**不受 `SEED_DEMO` 影响**，仍由 `setting['seed:courier']` 标记控制「只种一次」。
- **站点级管理端鉴权（第 27 轮，第 26 轮⑥的遗留项「通道」已补，**正式启用留第 30 轮**）**：`ADMIN_PASSWORD` 未设置＝**通道关闭（灰度档）**，所有管理接口照旧放行并**只打一次 WARN**（灰度友好，老板不会被锁在门外）；设置后，管理接口要求 `HttpOnly` + `SameSite=Strict` 的签名 `sdy_admin` Cookie（`POST /api/admin/login` 换发，`crypto/hmac` + `SHA-256` + 过期时间戳，校验用 `hmac.Equal` 常量时间比较），未登录一律 `401 请先登录管理后台`。`/healthz`、`/api/admin/login|logout`、`/api/wx/*`、`/api/staff/*`、顾客端商品与 `/admin`（不含数据的登录壳）保持公开。**两处如实披露的缺口**：(a) 灰度档下**无身份请求按管理端放行**（能读全店订单、能推进/取消任意订单），所以 R27 契约的「无身份 → 400」「无令牌 advance → 403」**只在通道开启时成立**（`deploy/accept-r27.js` 会打印这条警告，不是失败）；(b) **`requireAdmin` 目前不认员工令牌**，而且后台还没有登录页 —— 一开口令会把员工（扫码入库 / 建档 / 上下架）和老板一起锁在门外，**所以第 27 轮生产故意不设 `ADMIN_PASSWORD`**，正式启用要在第 30 轮把「`requireAdmin` 支持员工令牌」与「后台登录页 `#loginGate`」**一起**交付，二者缺一不可。顾客端真实发的请求都带 openid/phone，所以「只看得到自己的单」「查他人单 404」在生产是真生效的。
- HTTP 超时：读头 5s、读 15s、写 30s、空闲 60s；收到 `SIGINT`/`SIGTERM` 后 `Shutdown` 最多 10s，**蓝绿滚动更新时不丢请求**。
- 日志中间件只记 `/api/` 前缀的请求（含耗时 ms），避免静态资源刷屏。
- 云端调用超时 8s；HTTP 非 200 视为失败（400 参数 / 401 鉴权 / 429 限流 / 5xx 故障），**返回 200 但查无内容不算失败**（记为「查无」并写 TTL）。连续失败到 `MaxFails: 5` 就熔断到当天 23:59:59，期间 `/api/barcode/resolve` 返回 `blocked`；`/healthz` 的 `circuitOpen`、`cloudFails` 供前端显示状态。
- **端口避让**：生产机已占用 `22/53/80/443/8081/8082`，本项目只用 `8093/8094`（`sdy-api-a`/`sdy-api-b`，不对宿主之外直连）。

**坑**

- `STATIC_DIR` 默认是 `.`（`server/` 目录），所以直接 `go run ./cmd/server` 后在浏览器打开根路径看到的是文件列表，不是商城——要看页面必须显式设 `STATIC_DIR`。
- 商品搜索的 `keyword` **只匹配名称和条码，不含品牌**；前端顾客端搜索框额外匹配了品牌，两边口径不同（已知差异）。
- `POST /api/products` 是**覆盖式 upsert**（`ON CONFLICT(code) DO UPDATE`），服务端**不会拦重复建档**；防重复的检查在前端：扫码台 `bd-api.js` 与管理端 `Admin.saveProduct({requireNew:true})`。**所以「编辑」和「重复建档」在后端是同一条接口**，管理端靠 `requireNew` 区分。
- **覆盖式 upsert 会连带覆盖 `img` 与 `wholesale_price`**：UPDATE 里有 `img = excluded.img`、`wholesale_price = excluded.wholesale_price`，所以**任何**调用方（前端批量改价/改分类/改批发标记/建档）都必须把这两个字段一起传上来，否则已存商品图会被抹成空串、批发价会被清零——第 18 轮（img）与第 19 轮（wholesale_price）各真实踩过一次，前端各 payload 已统一补 `img: p.img || ''` 与 `wholesalePrice`；`deploy/seed-demo.py` 的商品 payload 也带 `wholesalePrice`。`on_sale` 不在 UPDATE 列里，所以不会被 upsert 重置。

## 部署（M6，Docker 蓝绿）

```bash
cp .env.example .env         # 填 BARCODE_APPCODE 等（.env 不入库）
./deploy/deploy.sh           # 拉基础镜像 → compose 起 api-a / api-b
./deploy/rolling-update.sh   # 逐台重启，不停服
```

- 容器：`sdy-api-a` → 宿主 `127.0.0.1:8093`、`sdy-api-b` → 宿主 `127.0.0.1:8094`，都不对外直连
- 数据库：宿主 `./data/sdy.db` 挂载进容器（WAL，允许两实例读写）
- 主机 Nginx：模板 `deploy/host-nginx.conf`，80 → 443，`upstream sdy_api` 挂两台实例

服务器地址与登录凭证只存本地 `.server_cred.md`（已 gitignore，公开仓库绝不出现）。

## 相关文档

- [`../README.md`](../README.md) — 仓库总览、里程碑状态、测试矩阵
- [`../开发计划.html`](../开发计划.html) — 路线图（M4 后端、M6 部署）
- [`../细节讨论记录.html`](../细节讨论记录.html) — 决策台账（D6 双库、D8 扫码只读、D12 单一真源、D18 收货地址簿、D23 商品上下架、D24 批发价与顾客等级、D25 消灭 localStorage 单点与库存审计、D32 员工身份与员工扫码工作台、**D33 身份底座 / 正确性收敛 / 管理端鉴权灰度（第 27 轮）** 等）
- [`../独立小程序商城可行性分析与架构方案.html`](../独立小程序商城可行性分析与架构方案.html) — 架构与实现现状
- [`../web/README.md`](../web/README.md) — 商城 Web 端（`web/sdy-api.js` 是它的数据通道）
- [`../barcode-demo/README.md`](../barcode-demo/README.md) — 扫码台（`barcode-demo/bd-api.js` 是它的数据通道）
- [`../sync-demo/README.md`](../sync-demo/README.md) — 牵牛花月度 CSV 对账

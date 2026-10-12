# server · 商城后端（Go 1.24）

商城唯一的**服务端真源**：商品、库存、订单、配送费、价格防线、条码解析链都在这里执行，前端四个页面（`web/`、`barcode-demo/`、`sync-demo/`）只做展示。跑起来是**一个静态二进制**——纯标准库 `net/http` + `modernc.org/sqlite`（纯 Go 实现，`CGO_ENABLED=0`）。

这样做的原因：牵牛花抽成与账期不可控、顾客数据在平台侧；自建后佣金归零。规则集中在服务端，页面在探不到后端时自动降级为本地演示。

## 文件清单

| 文件 | 职责 |
| --- | --- |
| `server/cmd/server/main.go` | 进程入口（583 行）：环境变量、建库与种子数据、路由表、CORS/日志中间件、超时与优雅退出、云端条码 HTTP 客户端 |
| `server/cmd/server/main_test.go` | HTTP 层单测（453 行，7 个）：商品建档/编辑/删除全流程、库存语义、**商品上下架语义**、**收货地址簿全流程**、**管理端干净地址 `/admin`（含 `/admin/` 301）**、**批发价与顾客等级全流程**、CORS 预检 |
| `server/internal/store/store.go` | 数据层（1091 行）：7 张表、事务下单、状态机、库存回补、商品档案增删改校验、**商品上下架（`on_sale` + `ensureColumn` 幂等迁移）**、**批发价与顾客等级（`wholesale_price` / `customer.tier`）**、**收货地址簿**、条码字典 |
| `server/internal/store/store_test.go` | 数据层单测（813 行，19 个） |
| `server/internal/pricing/pricing.go` | 价格与配送规则（146 行）：防线、运费、**顾客等级与有效价 `EffectivePrice`**，与 `web/pricing.js` 语义一致 |
| `server/internal/pricing/pricing_test.go` | 规则单测（129 行，5 个） |
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

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/healthz` | 健康检查：`{ok, time, circuitOpen, cloudFails, cloudConfigured}` |
| GET | `/api/products?keyword=&category=&onSale=1&phone=` | 商品列表，返回 `{items, total, tier}`；`keyword` 匹配名称或条码，`category` 精确等值，`onSale=1` 只返回在售商品（顾客端用），按条码排序；每条**都带 `onSale` 字段**（不带 `omitempty`，缺字段视为上架）；**带 `phone=` 时按该手机号的顾客等级算好 `price` 下发**（D24：非零售等级且批发价 > 0 → 批发价，`tier` 在信封里，缺字段视为零售） |
| POST | `/api/products` | 建档/编辑商品（**自动写入条码字典层**）：服务端校验条码/名称必填、价格非负（**批发价非负且不得高于零售价**）、库存非负，并执行比价防线（超价 `400`，批发与无参考价豁免）；`stock` 字段**不传 = 不改库存**（编辑表单不改库存），传了才写；`wholesalePrice` 不传 = 清零（覆盖式 upsert，调用方必须带全）；成功返回保存后的商品，`syncStatus` 置 `pending` |
| POST | `/api/products/onsale` | 批量上下架（D23）：`{codes:[...], onSale:true\|false}`，只改 `product.on_sale` 一个字段，返回 `{ok, changed}`；**编辑档案走 `/api/products`、上下架走这里，两者互不影响**；下架只在顾客端生效（档案/库存/历史订单/条码字典都不动） |
| DELETE | `/api/products/{code}` | 删除商品档案（任务池①）：库存必须为 0（否则 `409` 提示先盘点为 0）、没有进行中订单引用（否则 `409`）；删档**保留条码字典层记录**（D6 永久沉淀）；成功返回 `{ok:true, code}` |
| POST | `/api/products/stock` | 手动改库存 `{code, stock}`（D8：库存一律手动调整，扫码只读）；同时把 `syncStatus` 置为 `pending` |
| GET | `/api/addresses?phone=` | 收货地址簿列表（D18）：默认地址排最前，其余按入库顺序；`phone` 为空返回 `400` |
| POST | `/api/addresses` | 新增/编辑收货地址 `{id, phone, contact, address, isDefault}`：`id=0` 新增（**第一条自动成为默认**），带 `id` 则按 `id + phone` 更新（不存在返回 `404`）；`isDefault=true` 时摘掉同手机号其它条目的默认标记 |
| DELETE | `/api/addresses/{id}?phone=` | 删除一条（不存在 `404`、编号非法 `400`）；**删掉默认地址后由最早的一条顶为默认** |
| GET | `/api/customers` | 顾客列表（D24）：`{items:[{phone, name, tier, tags, note}], total}`，等级存 `customer.tier`（`retail` 默认 / `wholesale` / `vip`） |
| POST | `/api/customers/tier` | 登记 / 改顾客等级（D24）：`{phone, name, tier}`，`tier` 只接受 `retail` / `wholesale` / `vip`（非法或手机号为空 → `400 参数不合法: …`）；`name` 留空保留原名；**改等级只影响之后的单**，历史订单价格是下单当时快照 |
| GET | `/api/orders?status=` | 订单列表 |
| POST | `/api/orders` | 下单（事务内校验 → 扣库存 → 写订单，避免超卖），成功返回 `201` |
| GET | `/api/orders/{id}` | 订单详情 |
| POST | `/api/orders/{id}/advance` | 状态流转 `{to: delivering\|ready\|done\|cancelled}` |
| GET | `/api/barcode/resolve?code=` | 条码解析链：商品档案 → 本地字典 → 云端；查到永久回填字典，查无标记 90 天，连续失败 5 次熔断当日 |
| GET | `/api/barcode/lib?limit=` | 条码字典层列表（默认 200 条，只读） |
| GET | `/api/pricing/check` | 比价防线巡检，返回 `{total, over, violations}` |
| GET | `/admin` | 管理端干净地址：直接把 `STATIC_DIR/admin.html` 吐出来；`/admin/` 带尾斜杠会 301 到 `/admin`（带斜杠时页面内相对路径基准变成 `/admin/`，`assets/theme.css` 等会 404）；旧 `/admin.html` 继续可用 |
| — | `/`（其余路径） | 静态文件（`STATIC_DIR`） |

**错误码**：`400` 参数不合法 / `404` 资源不存在 / `409` 库存不足或状态不允许流转 / `405` 方法不支持 / `500` 其他。领域错误到 HTTP 码的映射写在 `server/cmd/server/main.go:441` 的 `writeErr`，用 `errors.Is` 判断 `store.ErrBadInput` / `ErrNotFound` / `ErrStockLess` / `ErrConflict`。（`ErrBadInput` 的响应文案统一带「参数不合法: 」前缀，前端 `sdy-api.js` 原样透出，所以页面上看到的校验提示可能带这个前缀。）

所有接口都带 CORS（`Access-Control-Allow-Origin: *`），`OPTIONS` 直接返回 `204`，方便扫码台在别的端口调试。请求体上限 1 MiB（`http.MaxBytesReader`）。

## 测试

```bash
cd /home/kiddyt00/GolandProjects/sdy/server
go test ./... -count=1        # 37 个单测
./smoke.sh                    # 起真服务跑 HTTP 全流程
```

`go test ./...` 实测结果（全部 PASS）：

| 包 | 数量 | 用例 |
| --- | --- | --- |
| `server/internal/barcode` | 6 | `TestResolveProductFirst`、`TestResolveLibSecond`、`TestResolveCloudBackfill`、`TestResolveCloudNotFoundTTL`、`TestResolveCircuitBreaker`、`TestResolveEdgeCases` |
| `server/internal/pricing` | 5 | `TestDeliveryFee`、`TestDeliveryFeeCustomConfig`、`TestCheckRetailPrice`、`TestPricingCheck`、`TestEffectivePrice` |
| `server/internal/store` | 19 | `TestUpsertAndGetProduct`、`TestListProductsFilter`、`TestSetStockMarksPending`、`TestCreateOrderPickup`、`TestCreateOrderDeliveryFee`、`TestCreateOrderValidation`、`TestCreateOrderInsufficientStock`、`TestAdvanceOrderStateMachine`、`TestCancelOrderRestoresStock`、`TestListOrdersAndCustomer`、`TestListLib`、`TestUpsertProductValidation`、`TestUpsertProductPriceGuard`、`TestDeleteProductGuard`、`TestAddressBook`、`TestProductOnSaleSemantics`、`TestOnSaleColumnMigration`、`TestCustomerTierWholesalePrice`、`TestTierColumnMigration` |
| `server/cmd/server` | 7 | `TestProductHTTPFlow`、`TestProductStockSemantics`、`TestProductOnSaleHTTPFlow`、`TestAddressHTTPFlow`、`TestAdminCleanURL`、`TestHealthzAndOptions`、`TestCustomerTierHTTPFlow` |

合计 **37 个单测**，本机实测 `go test ./... -count=1` 全部通过（`gofmt -l .` 无输出、`go vet ./...` 干净）。

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
- **商品档案校验**：`POST /api/products` 在 store 层校验条码/名称必填、价格非负、库存非负，并**在服务端执行比价防线**（`UpsertProduct` 内调 `pricing.CheckRetailPrice`，超价返回 `400`，批发与无参考价豁免）；缺省单位补「件」、分类补「未分类」。**`stock` 不传 = 保留原库存**（指针区分「没传」与「传 0」），保证管理端编辑表单不会误清库存。
- **删除商品档案**：`DeleteProduct` 先查在库量与进行中订单，再删行；**条码字典层（`barcode_lib`）不删**——D6 的永久沉淀，删档后扫码仍能识别。
- **D18 收货地址簿**：`customer_address` 按手机号一档多条（`phone` 建索引），`ListAddresses/SaveAddress/GetAddress/DeleteAddress` 四个方法守住三条语义——第一条自动为默认、`isDefault=true` 时摘掉同号其它默认、删掉默认后由最早一条顶替；`SaveAddress` 不传 `isDefault` 时**不动原有默认标记**（避免改门牌丢默认），更新不存在的 `id` 返回 `404`。订单里存的仍是下单当时的地址快照，改地址簿不影响历史订单。
- **D23 商品上下架**：`product.on_sale INTEGER NOT NULL DEFAULT 1`，只为老库补的列走 `ensureColumn`（幂等：`PRAGMA table_info` 里没有才 `ALTER TABLE ADD COLUMN`），**升级不用清库**；`SetProductsOnSale(codes, on) (int, error)` 一条 `UPDATE ... WHERE code IN (...)`，返回真正改动的行数；`ListProducts(onSaleOnly=true)` 过滤在售；**`CreateOrder` 会拦下架商品**（即使前端被绕过），形成「顾客端不显示 + 下单端拦截」双保险；`onSale` 用**不带 `omitempty`** 的字段下发，缺字段一律视为上架（老库/老前端不会集体消失）。
- **上下架与建档是两条路**：`UpsertProduct`（`POST /api/products`）**不读写 `on_sale`**（保持原值），上下架只走 `POST /api/products/onsale`——「编辑不改库存」（D16）与「编辑不改上下架」（D23）是同一条原则的两个实例。
- **D24 批发价与顾客等级**：`product.wholesale_price REAL NOT NULL DEFAULT 0`（**0 = 未设**）与 `customer.tier TEXT NOT NULL DEFAULT 'retail'` 都走 `ensureColumn` 幂等迁移，升级不用清库；等级白名单只有 `retail` / `wholesale` / `vip`（`pricing.ValidTier`——空串也算合法并归一成零售，`pricing.NormalizeTier('') == "retail"`）。**有效价只有一条公式**：`pricing.EffectivePrice(tier, salePrice, wholesalePrice)` = 非零售等级（`pricing.IsWholesaleTier`：`wholesale` / `vip`）**且**批发价 > 0 ? `round2(wholesalePrice)` : `round2(salePrice)`——所以「批发价 = 0」就是「这货不批发」，批发客户仍按零售价。
- **D24 价格真源在服务端**：`GET /api/products?phone=` 用 `GetCustomerTier` 查等级、把算好的 `price` 下发给前端（信封里还带 `tier`，查不到手机号 → `retail`，`price` 不带 `omitempty`）；`CreateOrder` 在同一个事务里先 `SELECT tier FROM customer WHERE phone=?`（`ErrNoRows` → `retail`），再逐行 `SELECT name, sale_price, wholesale_price, stock, on_sale` 并用**同一个** `EffectivePrice` 算行价小计——**前端传的价格不参与结算**（与 D12「前端只经 `sdy-api.js`、规则只在服务端」同一条原则）。`SetCustomerTier(phone, name, tier)` 校验手机号非空 + 等级白名单（否则 `ErrBadInput`，文案「参数不合法: 顾客等级只能是 retail / wholesale / vip」），`name` 留空保留原名；`GetCustomerTier`/`GetCustomer`/`ListCustomers` 是只读口。**改等级只影响之后的单**：历史订单价格是下单当时的快照（同「地址快照」「小票只读投影」）。批发价**不参与零售比价防线**（防线守的是零售价，`ExcludeWholesale` 那一维不变）。
- **`wholesale_price` 与 `img` 一样是覆盖式**：`UpsertProduct` 的 `ON CONFLICT ... SET wholesale_price=excluded.wholesale_price`，调用方漏传即清零——`web/sdy-api.js` 的每个 upsert payload 与 `deploy/seed-demo.py` 都必须带 `wholesalePrice`（种子数据里 7 款商品带了批发价）。
- **D8 扫码只读**：`/api/barcode/resolve` 只识别、不写价格库存；库存只能通过 `/api/products/stock` 手动改。
- **D6 双库**：建档（`POST /api/products`）会**顺带把条码写进字典层**（`source=product`），所以建过档的码永久走本地命中，不再花云端配额。字典层的命中计数不会被 upsert 重置。

**持久化与运行**

- SQLite 非内存库时统一追加 `?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)`；`:memory:` 时强制 `SetMaxOpenConns(1)`（否则每个连接会看到不同的内存库）。WAL 模式让容器里两个实例可以同时读写，写锁最多等 5 秒。
- 7 张表：`product`（含 `on_sale`（第 18 轮）与 `wholesale_price`（第 19 轮））、`barcode_lib`、`customer`（含 `tier`，第 19 轮）、`customer_address`（收货地址簿，D18）、`orders`、`order_item`、`sync_batch`。**`sync_batch`（对账批次）目前只有表和 store 方法，HTTP 层没有暴露接口**。加列一律走 `ensureColumn` 幂等迁移，不重建表。
- 首次启动且**库为空**时写入 6 个示例商品（可口可乐/农夫山泉/心相印抽纸/旺旺雪饼/青岛啤酒/伊利纯牛奶），方便联调。条码、售价、库存与前端 `web/mall.js` 的种子一致，但**分类/规格等文案两边略有出入**（如心相印抽纸这里分类是「日用品」、前端写「纸品」；青岛啤酒这里规格是「330ml 罐装」、前端写「500ml 罐」）。
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
- [`../细节讨论记录.html`](../细节讨论记录.html) — 决策台账（D6 双库、D8 扫码只读、D12 单一真源、D18 收货地址簿、D23 商品上下架、D24 批发价与顾客等级等）
- [`../独立小程序商城可行性分析与架构方案.html`](../独立小程序商城可行性分析与架构方案.html) — 架构与实现现状
- [`../web/README.md`](../web/README.md) — 商城 Web 端（`web/sdy-api.js` 是它的数据通道）
- [`../barcode-demo/README.md`](../barcode-demo/README.md) — 扫码台（`barcode-demo/bd-api.js` 是它的数据通道）
- [`../sync-demo/README.md`](../sync-demo/README.md) — 牵牛花月度 CSV 对账

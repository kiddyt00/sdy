# server · 商城后端（Go 1.24）

商城唯一的**服务端真源**：商品、库存、订单、配送费、价格防线、条码解析链都在这里执行，前端四个页面（`web/`、`barcode-demo/`、`sync-demo/`）只做展示。跑起来是**一个静态二进制**——纯标准库 `net/http` + `modernc.org/sqlite`（纯 Go 实现，`CGO_ENABLED=0`）。

这样做的原因：牵牛花抽成与账期不可控、顾客数据在平台侧；自建后佣金归零。规则集中在服务端，页面在探不到后端时自动降级为本地演示。

## 文件清单

| 文件 | 职责 |
| --- | --- |
| `server/cmd/server/main.go` | 进程入口（438 行）：环境变量、建库与种子数据、路由表、CORS/日志中间件、超时与优雅退出、云端条码 HTTP 客户端 |
| `server/cmd/server/main_test.go` | HTTP 层单测（200 行，3 个）：商品建档/编辑/删除全流程、库存语义、CORS 预检 |
| `server/internal/store/store.go` | 数据层（681 行）：6 张表、事务下单、状态机、库存回补、商品档案增删改校验、条码字典 |
| `server/internal/store/store_test.go` | 数据层单测（450 行，14 个） |
| `server/internal/pricing/pricing.go` | 价格与配送规则（111 行），与 `web/pricing.js` 语义一致 |
| `server/internal/pricing/pricing_test.go` | 规则单测（95 行，4 个） |
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
#   顾客端 http://127.0.0.1:8093/   管理端 http://127.0.0.1:8093/admin.html
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
| GET | `/api/products?keyword=&category=` | 商品列表，返回 `{items, total}`；`keyword` 匹配名称或条码，`category` 精确等值，按条码排序 |
| POST | `/api/products` | 建档/编辑商品（**自动写入条码字典层**）：服务端校验条码/名称必填、价格非负、库存非负，并执行比价防线（超价 `400`，批发与无参考价豁免）；`stock` 字段**不传 = 不改库存**（编辑表单不改库存），传了才写；成功返回保存后的商品，`syncStatus` 置 `pending` |
| DELETE | `/api/products/{code}` | 删除商品档案（任务池①）：库存必须为 0（否则 `409` 提示先盘点为 0）、没有进行中订单引用（否则 `409`）；删档**保留条码字典层记录**（D6 永久沉淀）；成功返回 `{ok:true, code}` |
| POST | `/api/products/stock` | 手动改库存 `{code, stock}`（D8：库存一律手动调整，扫码只读）；同时把 `syncStatus` 置为 `pending` |
| GET | `/api/orders?status=` | 订单列表 |
| POST | `/api/orders` | 下单（事务内校验 → 扣库存 → 写订单，避免超卖），成功返回 `201` |
| GET | `/api/orders/{id}` | 订单详情 |
| POST | `/api/orders/{id}/advance` | 状态流转 `{to: delivering\|ready\|done\|cancelled}` |
| GET | `/api/barcode/resolve?code=` | 条码解析链：商品档案 → 本地字典 → 云端；查到永久回填字典，查无标记 90 天，连续失败 5 次熔断当日 |
| GET | `/api/barcode/lib?limit=` | 条码字典层列表（默认 200 条，只读） |
| GET | `/api/pricing/check` | 比价防线巡检，返回 `{total, over, violations}` |
| — | `/`（其余路径） | 静态文件（`STATIC_DIR`） |

**错误码**：`400` 参数不合法 / `404` 资源不存在 / `409` 库存不足或状态不允许流转 / `405` 方法不支持 / `500` 其他。领域错误到 HTTP 码的映射写在 `server/cmd/server/main.go:392` 的 `writeErr`，用 `errors.Is` 判断 `store.ErrBadInput` / `ErrNotFound` / `ErrStockLess` / `ErrConflict`。

所有接口都带 CORS（`Access-Control-Allow-Origin: *`），`OPTIONS` 直接返回 `204`，方便扫码台在别的端口调试。请求体上限 1 MiB（`http.MaxBytesReader`）。

## 测试

```bash
cd /home/kiddyt00/GolandProjects/sdy/server
go test ./... -count=1        # 27 个单测
./smoke.sh                    # 起真服务跑 HTTP 全流程
```

`go test ./...` 实测结果（全部 PASS）：

| 包 | 数量 | 用例 |
| --- | --- | --- |
| `server/internal/barcode` | 6 | `TestResolveProductFirst`、`TestResolveLibSecond`、`TestResolveCloudBackfill`、`TestResolveCloudNotFoundTTL`、`TestResolveCircuitBreaker`、`TestResolveEdgeCases` |
| `server/internal/pricing` | 4 | `TestDeliveryFee`、`TestDeliveryFeeCustomConfig`、`TestCheckRetailPrice`、`TestPricingCheck` |
| `server/internal/store` | 14 | `TestUpsertAndGetProduct`、`TestListProductsFilter`、`TestSetStockMarksPending`、`TestCreateOrderPickup`、`TestCreateOrderDeliveryFee`、`TestCreateOrderValidation`、`TestCreateOrderInsufficientStock`、`TestAdvanceOrderStateMachine`、`TestCancelOrderRestoresStock`、`TestListOrdersAndCustomer`、`TestListLib`、`TestUpsertProductValidation`、`TestUpsertProductPriceGuard`、`TestDeleteProductGuard` |
| `server/cmd/server` | 3 | `TestProductHTTPFlow`、`TestProductStockSemantics`、`TestHealthzAndOptions` |

合计 **27 个单测**，本机实测 `go test ./... -count=1` 全部通过（`gofmt -l .` 无输出、`go vet ./...` 干净）。

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
- **D8 扫码只读**：`/api/barcode/resolve` 只识别、不写价格库存；库存只能通过 `/api/products/stock` 手动改。
- **D6 双库**：建档（`POST /api/products`）会**顺带把条码写进字典层**（`source=product`），所以建过档的码永久走本地命中，不再花云端配额。字典层的命中计数不会被 upsert 重置。

**持久化与运行**

- SQLite 非内存库时统一追加 `?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)`；`:memory:` 时强制 `SetMaxOpenConns(1)`（否则每个连接会看到不同的内存库）。WAL 模式让容器里两个实例可以同时读写，写锁最多等 5 秒。
- 6 张表：`product`、`barcode_lib`、`customer`、`orders`、`order_item`、`sync_batch`。**`sync_batch`（对账批次）目前只有表和 store 方法，HTTP 层没有暴露接口**。
- 首次启动且**库为空**时写入 6 个示例商品（可口可乐/农夫山泉/心相印抽纸/旺旺雪饼/青岛啤酒/伊利纯牛奶），方便联调。条码、售价、库存与前端 `web/mall.js` 的种子一致，但**分类/规格等文案两边略有出入**（如心相印抽纸这里分类是「日用品」、前端写「纸品」；青岛啤酒这里规格是「330ml 罐装」、前端写「500ml 罐」）。
- HTTP 超时：读头 5s、读 15s、写 30s、空闲 60s；收到 `SIGINT`/`SIGTERM` 后 `Shutdown` 最多 10s，**蓝绿滚动更新时不丢请求**。
- 日志中间件只记 `/api/` 前缀的请求（含耗时 ms），避免静态资源刷屏。
- 云端调用超时 8s；HTTP 非 200 视为失败（400 参数 / 401 鉴权 / 429 限流 / 5xx 故障），**返回 200 但查无内容不算失败**（记为「查无」并写 TTL）。连续失败到 `MaxFails: 5` 就熔断到当天 23:59:59，期间 `/api/barcode/resolve` 返回 `blocked`；`/healthz` 的 `circuitOpen`、`cloudFails` 供前端显示状态。
- **端口避让**：生产机已占用 `22/53/80/443/8081/8082`，本项目只用 `8093/8094`（`sdy-api-a`/`sdy-api-b`，不对宿主之外直连）。

**坑**

- `STATIC_DIR` 默认是 `.`（`server/` 目录），所以直接 `go run ./cmd/server` 后在浏览器打开根路径看到的是文件列表，不是商城——要看页面必须显式设 `STATIC_DIR`。
- 商品搜索的 `keyword` **只匹配名称和条码，不含品牌**；前端顾客端搜索框额外匹配了品牌，两边口径不同（已知差异）。
- `POST /api/products` 是**覆盖式 upsert**（`ON CONFLICT(code) DO UPDATE`），服务端**不会拦重复建档**；防重复的检查在前端：扫码台 `bd-api.js` 与管理端 `Admin.saveProduct({requireNew:true})`。**所以「编辑」和「重复建档」在后端是同一条接口**，管理端靠 `requireNew` 区分。

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
- [`../细节讨论记录.html`](../细节讨论记录.html) — 决策台账（D6 双库、D8 扫码只读、D12 单一真源等）
- [`../独立小程序商城可行性分析与架构方案.html`](../独立小程序商城可行性分析与架构方案.html) — 架构与实现现状
- [`../web/README.md`](../web/README.md) — 商城 Web 端（`web/sdy-api.js` 是它的数据通道）
- [`../barcode-demo/README.md`](../barcode-demo/README.md) — 扫码台（`barcode-demo/bd-api.js` 是它的数据通道）
- [`../sync-demo/README.md`](../sync-demo/README.md) — 牵牛花月度 CSV 对账

# 商城后端（Go 1.24）

独立小程序商城的服务端：纯标准库 `net/http` + `database/sql`(`modernc.org/sqlite`，纯 Go 无 CGO，静态单文件）。

## 运行

```bash
cd server
# 本地开发（数据库落 ./data/sdy.db，ADDR 默认 127.0.0.1:8093，避免占用生产/其他服务端口）
go run ./cmd/server

# 想同时用浏览器打开仓库里的演示页：静态目录指向仓库根
STATIC_DIR=.. go run ./cmd/server     # 然后访问 http://127.0.0.1:8093/mall-demo/mall.html

# 启用云端条码（阿里云市场 APPCODE，永远只从环境变量读，不写配置文件/不入库）
BARCODE_APPCODE=你的AppCode go run ./cmd/server
```

环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ADDR` | `127.0.0.1:8093` | 监听地址（容器内用 `0.0.0.0:8080`） |
| `DB_PATH` | `data/sdy.db` | SQLite 文件路径，`:memory:` 可跑内存库 |
| `STATIC_DIR` | `.` | 静态文件根目录（演示页托管） |
| `BARCODE_APPCODE` | 空 | 云端条码 APPCODE；留空 = 纯本地模式 |
| `BARCODE_GATEWAY` | `https://gscode.market.alicloudapi.com/getBarcode` | 云端网关 |

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/healthz` | 健康检查（含条码云端熔断状态） |
| GET | `/api/products?keyword=&category=` | 商品列表 |
| POST | `/api/products` | 建档/覆盖商品（自动写入条码字典层） |
| POST | `/api/products/stock` | 手动改库存 `{code,stock}`（D8：库存一律手动调整，扫码只读） |
| GET | `/api/orders?status=` | 订单列表 |
| POST | `/api/orders` | 下单（服务端校验库存 → 扣减 → 生成订单，事务内完成，避免超卖） |
| GET | `/api/orders/{id}` | 订单详情 |
| POST | `/api/orders/{id}/advance` | 状态流转 `{to: delivering|ready|done|cancelled}` |
| GET | `/api/barcode/resolve?code=` | 条码解析链：商品档案 → 本地字典 → 云端（查到永久回填；查无标记 90 天；连续失败 5 次熔断当日） |
| GET | `/api/pricing/check` | 比价防线巡检（售价 ≤ 牵牛花参考价 × 0.95） |

错误码：`400` 参数不合法 / `404` 不存在 / `409` 库存不足或状态不允许流转。

## 测试

```bash
cd server
go test ./...        # 20 个单测：解析链/熔断/价格规则/状态机/事务扣库存
./smoke.sh           # 起真实服务跑一遍 HTTP 全流程（下单→扣库存→状态流转→取消回补）
```

## 部署（生产服务器，Docker 蓝绿）

```bash
cp .env.example .env      # 填 BARCODE_APPCODE 等（.env 不入库）
./deploy/deploy.sh        # 拉基础镜像（docker.1ms.run 代理）→ compose 起 api-a/api-b
./deploy/rolling-update.sh # 逐台重启，不停服
```

- 容器：`sdy-api-a` → 宿主 `127.0.0.1:8093`、`sdy-api-b` → `127.0.0.1:8094`（不对外直连）
- 数据库：`./data/sdy.db` 挂载进容器（WAL 模式，允许两个实例读写，写锁等待 5s）
- 主机 Nginx：`deploy/host-nginx.conf` 模板，80→443、`upstream sdy_api` 挂两台实例
- 端口避让：生产服务器已占用 `22/53/80/443/8081/8082`（yiguan 等），本项目只用 `8093/8094`

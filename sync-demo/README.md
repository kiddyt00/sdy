# sync-demo · 牵牛花月度 CSV 对账

每个月末把**牵牛花后台导出的商品/库存 CSV** 和**自己商城里的商品库**放一起比一遍：库存以门店实盘为准回填给牵牛花，售价差异只做提示，云端独有的货人工决定去留。差异勾选确认后才导出 CSV，人工回传。

纯前端、纯本地：**不连牵牛花接口、不上传任何数据**，CSV 在浏览器里算完就下载到本地。

## 文件清单

| 文件 | 职责 |
| --- | --- |
| `sync-demo/sync-csv.js` | 对账引擎（177 行，全局 `SyncCSV`）：CSV 解析/生成、表头映射、对账、回填与建档 CSV 生成 |
| `sync-demo/sync.html` | 对账工作台（274 行）：STEP 1 载入导出 → STEP 2 看差异并勾选确认 → STEP 3 导出 CSV |
| `sync-demo/牵牛花导出确认清单.html` | 行动项 0 的清单（126 行）：向牵牛花确认导出能力的条目，可打印带去谈 |
| `sync-demo/test-sync.js` | 引擎测试（178 行，62 项断言） |

## 本地运行

没有构建步骤、没有依赖，起一个静态服务即可：

```bash
cd /home/kiddyt00/GolandProjects/sdy
python3 -m http.server 8910        # 端口自定，示例用 8910
```

→ <http://127.0.0.1:8910/sync-demo/sync.html>

**必须从仓库根起服务**：工作台的「本地侧数据」读的是同源 `localStorage['bd_products']`——商城商品库写的、扫码台商品库写的都是这一个键。只 `cd sync-demo` 起服务会读不到商品，页面会退回内置样例数据（页面上会标明是「内置样例」）。

没有商品库也能试：页面提供「填入示例数据」，覆盖一致 / 库存差 / 价差 / 双差 / 云端独有 / 无码行六种情况。

## 测试

```bash
cd /home/kiddyt00/GolandProjects/sdy
node sync-demo/test-sync.js        # 通过 62 项 / 失败 0 项
```

| 测试 | 实测结果 | 覆盖什么 | 需要后端 |
| --- | --- | --- | --- |
| `sync-demo/test-sync.js` | 通过 62 项 / 失败 0 项 | ① CSV 解析（引号、换行、BOM、分隔符自动识别）② 表头映射（中英文别名、大小写）③ 对账（库存/价格差异、双差、云端独有、本地独有、无码行）④ 回填与上传 CSV 生成 | 否 |

测试环境：Node v24.11.1。纯函数测试，不读写浏览器、不连网络。

## 设计要点与不变量

**对账规则（每条都对应代码里的一个分支）**

- **库存以本地实盘为准**：库存差异一律生成本地 → 牵牛花的**回填 CSV**。牵牛花是单据权威，我们是实物权威。
- **售价只提示，不回填**：价格差异在页面上标出来，由人决定是否在牵牛花后台改价，引擎不生成改价文件。
- **云端有、本地无** → 列入 `cloudOnly` 清单，人工决定要不要在商城建档，**不自动建**。
- **本地有、云端无** → 列入 `localOnly` 清单，生成「本地新增建档 CSV」供人工上传。
- **无条码的行记为无效跳过**（`stats.invalid`），不参与对账。
- **某侧缺值不算差异**：任一侧库存/价格为 `null` 时差异记为 `null`，不计入差异数（避免把空值当成 0）。
- **差异默认未确认**：每条差异 `confirmed: false`，页面上**勾选后才会进入导出**，未确认的行永远不进 CSV。这是防止误覆盖的手闸。

**字段映射**

引擎自带中英文别名表，表头大小写不敏感，同一标准字段命中任一别名即可（`mapRow` 还会忽略空单元格）：

| 标准字段 | 可识别的表头 |
| --- | --- |
| `code` | 条码、商品条码、条形码、barcode、code、编码、商品编码 |
| `name` | 名称、商品名称、品名、name、商品 |
| `stock` | 库存、库存数量、数量、stock、qty、结存、库存数 |
| `price` | 零售价、售价、销售价、零售价格、price、单价 |

牵牛花改了导出列名时，只需要改 `sync-csv.js` 里的 `DEFAULT_FIELD_MAP`（或调用时传 `opts.fieldMap` 覆盖），不用动对账逻辑。

**模块 API**（`sync-csv.js` 导出，Node 可 `require`）

| 函数 | 签名 / 返回 |
| --- | --- |
| `parseCsv(text, opts?)` | → `{ headers, rows }`；自动识别逗号/制表符分隔、去 BOM、处理 CRLF 与引号内换行 |
| `mapRow(rowObj, fieldMap?)` | → `{ code, name, stock, price }`（数字字段解析失败为 `null`） |
| `reconcile(cloudRows, localProducts, opts?)` | → `{ diffs, cloudOnly, localOnly, stats }`；`diffs` 按条码升序，每条含 `code/name/unit/cloudStock/localStock/stockDiff/cloudPrice/localPrice/priceDiff/verdict/confirmed`，`verdict` 取 `stock` \| `price` \| `both` |
| `buildBackfill(diffs)` | → 行 `{ 条码, 名称, 实盘库存, 云端库存, 差异 }`（只含库存有差异的行） |
| `buildUpload(localOnly)` | → 行 `{ 条码, 名称, 库存, 售价, 单位 }` |
| `toCsv(headers, rows)` | → CSV 文本（转义引号/逗号/换行） |

`stats` 字段：`cloudTotal`（云端行数）、`localTotal`（本地商品数）、`matched`（两边都有）、`ok`（完全一致）、`stockDiff`、`priceDiff`、`both`（库存价双差）、`cloudOnly`、`localOnly`、`invalid`（无条码行）。

**约定与坑**

- **本地侧数据来源是 `bd_products`**，字段与商城、扫码台一致：`code / name / stock / salePrice / unit`。注意对账读的是 **`salePrice`**（不是 `price`），改商品库字段名要先改 `reconcile` 里的入参映射。
- **导出的 CSV 是给人看的中文表头**（`条码/名称/实盘库存/云端库存/差异`、`条码/名称/库存/售价/单位`），文件名带时间戳（`库存回填_*.csv`、`本地新增建档_*.csv`）。
- **同源要求**：与商城、扫码台必须用**同一个端口**打开，否则读不到 `bd_products`（会静默退回内置样例）。
- 这个工具**不写回**任何数据：不改 `localStorage`、不调后端、不连牵牛花。对账结果只以文件形式落地，后续动作（改价、上传建档）都在牵牛花后台人工完成。

## 相关文档

- [`../README.md`](../README.md) — 仓库总览、里程碑状态（M3 对账）、测试矩阵
- [`../开发计划.html`](../开发计划.html) — 路线图与当前重心
- [`../细节讨论记录.html`](../细节讨论记录.html) — 决策台账（对账口径、牵牛花只保留对账等）
- [`../独立小程序商城可行性分析与架构方案.html`](../独立小程序商城可行性分析与架构方案.html) — 架构与实现现状
- [`../web/README.md`](../web/README.md) — 商城 Web 端（`bd_products` 的写入方）
- [`../barcode-demo/README.md`](../barcode-demo/README.md) — 扫码台（`bd_products` 的另一个写入方）
- [`../server/README.md`](../server/README.md) — 后端（含对账批次表 `sync_batch`，HTTP 层暂未暴露接口）

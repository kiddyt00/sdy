# sync-demo · 牵牛花 CSV 对账（M3）

只做一件事：**把牵牛花导出的商品/库存 CSV 和本地商品库对账，产出「库存回填」和「新增建档」两份文件。**
纯前端 + 纯逻辑，无外部依赖、不联网、数据不上传。

## 运行

```bash
cd sync-demo
python3 -m http.server 8911        # 端口随便换；也可直接双击 html（同源 localStorage 需 http）
# 打开 http://127.0.0.1:8911/sync.html
```

## 页面

| 文件 | 用途 |
| --- | --- |
| `sync.html` | 对账工作台：载入 CSV → 对账 → 勾选确认 → 导出回填/上传 CSV |
| `牵牛花导出确认清单.html` | 行动项 0：向牵牛花确认导出能力的清单（可打印带去谈） |

## 对账规则（重要）

| 情况 | 处理 |
| --- | --- |
| 库存不一致 | **以本地实盘为准** → 生成《库存回填》CSV 交牵牛花导入 |
| 售价不一致 | 只提示差异，改价在管理端做（牵牛花售价仅作参考价 / 比价防线基线） |
| 云端有、本地无 | 列入清单，由人决定建档还是停售 |
| 本地有、云端无 | 生成《本地新增建档》CSV |
| 无条码行 | 记为「无效」跳过，绝不参与对账 |
| 某侧缺值 | 不算差异，不误报 |

差异默认**未确认**，必须人工勾选后才进导出——防止误回填。

## 字段映射（可配）

`sync-csv.js` 的 `DEFAULT_FIELD_MAP` 支持中英文别名，例如：

- 条码：`条码 / 商品条码 / 条形码 / barcode / code / 编码 / 商品编码`
- 名称：`名称 / 商品名称 / 品名 / name / 商品`
- 库存：`库存 / 库存数量 / 数量 / stock / qty / 结存 / 库存数`
- 售价：`零售价 / 售价 / 销售价 / 零售价格 / price / 单价`

拿到牵牛花真实导出后，如果列名不在上表，改 `DEFAULT_FIELD_MAP` 即可（或调用时传 `{fieldMap:{code:['你的列名']}}`）。

## 模块 API（`sync-csv.js`）

```js
SyncCSV.parseCsv(text)                     // → {headers, rows}：剥 BOM、CRLF、引号转义、自动判 , vs Tab
SyncCSV.mapRow(rowObj, fieldMap?)          // → {code,name,stock,price}（数字已解析，空→null）
SyncCSV.reconcile(cloudRows, localProducts)// → {diffs, cloudOnly, localOnly, stats}
SyncCSV.buildBackfill(diffs)               // → 仅库存有差异的行（用本地实盘）
SyncCSV.buildUpload(localOnly)             // → 本地新增待上传行
SyncCSV.toCsv(headers, rows)               // → CSV 文本（含引号转义）
```

`stats` 含 `cloudTotal / localTotal / matched / ok / stockDiff / priceDiff / both / cloudOnly / localOnly / invalid`。

## 测试

```bash
node test-sync.js        # 62 项：解析 / 字段映射 / 对账 / 回填导出
```

## 本地商品数据来自哪

`sync.html` 读同源 localStorage 的 `bd_products`（`mall-demo`、`barcode-demo` 共用），为空时用内置 6 个样例商品，
所以三个 demo 用同一个 `python3 -m http.server` 端口打开即可互相看到数据。

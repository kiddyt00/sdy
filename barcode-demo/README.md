# barcode-demo · 扫码台（商品库 + 本地条码字典 + 云端兜底）

门店里**拿手机或扫码枪扫一个条码，立刻知道这是什么货、有没有建档、卖多少钱、还剩多少**的工具台。它同时承担「没建档的货当场建档」的入口——扫码只做识别，价格和库存一律人工填。

三库分工：**商品档案**（经营数据，有价格库存）→ **本地条码字典**（只存"这个码是什么"，永久缓存、查过就不再花钱）→ **云端条码 API**（双库都未命中时才调用，配额有限，失败会熔断）。

## 文件清单

| 文件 | 职责 |
| --- | --- |
| `barcode-demo/index.html` | 扫码台页面（200 行）：扫码台 / 商品库 / 本地条码库 / 扫码日志 / 设置 五个页签 |
| `barcode-demo/app.js` | 全部前端逻辑（800 行，全局 `DemoApp`）：解析链、配额与熔断、建档、渲染、摄像头扫码 |
| `barcode-demo/bd-api.js` | 扫码台 ↔ Go 后端通道（232 行，全局 `BdApi`）：后端在线则解析/建档全交给服务端 |
| `barcode-demo/proxy.py` | 本地代理（87 行）：给浏览器补 CORS 并注入 APPCODE，供「真实云端」调试用 |
| `barcode-demo/appcode.txt` | **本地凭证**（已 gitignore）：第一行 APPCODE、第二行网关地址；仓库里不出现 |
| `barcode-demo/test-*.js` | 4 套测试（见下），纯 Node 运行 |

## 本地运行

四种跑法，按需要选（**端口不要用 8093**，那是后端在跑的端口）。

### 1. 纯离线演示（最省事）

直接从文件系统打开 `barcode-demo/index.html` 即可：`localStorage` 存三库数据，云端走内置 Mock（12 条样例商品），完整解析链都能演示。

想走 http 协议则从**仓库根**起服务：

```bash
cd /home/kiddyt00/GolandProjects/sdy
python3 -m http.server 8900
```

→ <http://127.0.0.1:8900/barcode-demo/index.html>

从仓库根起（而不是 `cd barcode-demo`）是为了和商城、对账工具**同源共用** `bd_products`。

### 2. 真实阿里云市场条码 API（走本地代理）

浏览器直连阿里云网关会被 CORS 拦，也会把 APPCODE 暴露在页面里，所以用 `proxy.py`：

```bash
cd /home/kiddyt00/GolandProjects/sdy/barcode-demo
python3 proxy.py      # 默认端口 8900，可用 BARCODE_PORT 覆盖
```

→ <http://127.0.0.1:8900/index.html>

在页面「设置」里：云端 Provider 选 `ali`，网关填 `http://127.0.0.1:8900/barcode`，**APPCODE 留空**——凭证由代理从 `appcode.txt`（或环境变量 `BARCODE_APPCODE` / `BARCODE_GATEWAY`）注入，页面不持有。

注意：`proxy.py` 只服务 `barcode-demo/` 自己这个目录，因此这种方式下跨模块的 `../web/`、`../sync-demo/` 链接打不开；要与商城共用商品库就走第 1 种或第 3 种。

### 3. 接 Go 后端（推荐，生产同构）

```bash
cd /home/kiddyt00/GolandProjects/sdy/server
STATIC_DIR=.. BARCODE_APPCODE=你的APPCODE go run ./cmd/server
```

→ <http://127.0.0.1:8093/barcode-demo/index.html>

不设 `BARCODE_APPCODE` 就是「纯本地模式」：解析链的前两层照常工作，云端那层返回 `cloud_error`（云端未配置），**页面不会报错**，只是查不到新码。此时后端地址同源，不用在设置里填。

## 测试

```bash
cd /home/kiddyt00/GolandProjects/sdy
node barcode-demo/test-core.js          # 7 组场景 / 28 条断言
node barcode-demo/test-api.js           # 55 项
node barcode-demo/test-page-boot.js     # 28 项
node barcode-demo/test-integration.js   # 34 项（需后端在线）
```

| 测试 | 实测结果 | 覆盖什么 | 需要后端 |
| --- | --- | --- | --- |
| `barcode-demo/test-core.js` | `ALL TESTS PASSED ✔`（7 组场景 / 28 条断言），失败时抛 `TEST FAILED:` 并 `exit 1` | 四级命中（商品库/条码字典/云端/查无）、云端结果回填、二次扫码不再调云端、查无 TTL、配额拦截、连续 5 次失败 → 当日熔断、建档闭环、条码格式校验 | 否 |
| `barcode-demo/test-api.js` | `✅ ALL PASS：55 通过 / 0 失败` | `BdApi` 的探测、地址优先级、`fetchImpl` 注入、列表映射（商品库/条码字典镜像）、解析结果 → 页面结构的映射、建档写接口 | 否（注入假 fetch） |
| `barcode-demo/test-page-boot.js` | `✅ ALL PASS：28 通过 / 0 失败` | 假 DOM 下页面脚本启动：离线启动、后端可用时把解析/建档交给服务端 | 否 |
| `barcode-demo/test-integration.js` | 34 项（需后端在线；探测不到会自动跳过并 `exit 0`） | 真 fetch → 真后端：条码解析命中商品档案、双库回填、建档后二次扫码走本地、写接口与后端一致 | **是** |

联调跑法（后端自己起在别的端口，别用 8093 上的现有实例）：

```bash
# 终端 1：起一个专用后端
cd /home/kiddyt00/GolandProjects/sdy/server
ADDR=127.0.0.1:8097 DB_PATH=/tmp/sdy-bd.db STATIC_DIR=.. go run ./cmd/server

# 终端 2：指向它
cd /home/kiddyt00/GolandProjects/sdy
SDY_API_BASE=http://127.0.0.1:8097 node barcode-demo/test-integration.js
```

联调用例每次生成一个**时间戳条码**（`699` + 时间戳后 10 位），所以可以反复跑同一个库而不会撞「该条码已在商品库」。

测试环境：Node v24.11.1。

## 设计要点与不变量

**解析链（顺序固定，不可调换）**

1. **商品档案命中** → 直接返回，**不消耗云端配额**
2. **本地条码字典命中** → 直接返回；若字典里记的是「查无」且还在 TTL 内，直接回查无，也不调云端
3. **熔断期内** → 直接返回 `blocked`，当天不再调云端
4. **云端** → 查到就永久回填字典；查无则写一条带 TTL 的「查无」标记（默认 90 天）

只有走到第 4 步才花配额。前端 `resolve()` 的返回 `source` 取值：`invalid | product | lib | none | cloud | quota | blocked | cloud_error`。

**红线（不要动）**

- **D8 扫码只读**：扫码只做识别 / 建档 / 查询，**绝不改库存**。库存一律手动调整（入库单、盘点、直接改数）。
- **价格与库存永不自动填云端值**：云端只提供「这是什么货」的候选（名称/规格/品牌/分类），价格和库存必须人工确认后手填。
- **建档必须人工确认**：云端结果只填表单，人不点保存就不建档。
- **云端配额**：套餐每日可调用次数默认 200（设置里可改），每成功调一次云端 +1；用尽后直接返回 `quota` 拦截。**HTTP 200 才算一次调用**。
- **失败熔断**：连续失败 5 次 → 当日熔断到 23:59:59，期间不再调云端，页面顶部亮出熔断标记；第二天自动恢复。设置里有「云端失败模拟」开关，专门演示这条链。
- **同码去重锁**：同一个条码在飞行中的请求会被复用（`codeLock`），避免连点两次烧两份配额；云端调用另有一个全局串行队列，不会并发打出去。

**约定与坑**

- **localStorage 键**：`bd_products`（商品库，**与商城、对账工具同源共用**）、`bd_barcodeLib`（本地条码字典）、`bd_scanLog`（扫码日志，上限 300 条）、`bd_settings`（provider / gateway / quota / ttlDays / failSim）、`bd_usage`（当日用量，跨天自动归零）、`bd_api_base`（后端地址）。
- **扫码方式**：扫码枪走 HID 键盘模式（聚焦输入框直接扫、回车即查）；摄像头扫码要 `navigator.mediaDevices.getUserMedia` + `BarcodeDetector`，**桌面 Chrome/Edge 与安卓可用，iOS Safari 不支持**，此时页面会给出提示并让你改用扫码枪或手动输入。示例码按钮等价于「模拟手机扫码」（对应将来的 `wx.scanCode`）。
- **演示条码（5 个示例码对应解析链的每一级）**：`6901234567892` 已建档商品 / `6902083884567` 条码字典命中 / `6901028076768` 云端新码（查到后回填字典）/ `6900000000000` 云端查无（TTL 内不再重复查）/ `6904321000999` 完全未知码。
- **在线模式的重复建档**：`bd-api.js` 会先 `getProduct` 查一次，存在就抛「该条码已在商品库，请勿重复建档」。而后端 `POST /api/products` 本身是**覆盖式 upsert**（`ON CONFLICT(code) DO UPDATE`），服务端不拦重复——防线在前端，别误以为服务端会拒。
- **在线模式下建档会同时写商品档案和条码字典两层**，所以建档后这个码永久走本地命中，不再花配额。
- **端口**：`proxy.py` 默认 8900（`BARCODE_PORT` 可改）；页面设置区那条「用 `BARCODE_PORT=8910` 起代理」的提示与 8900 不一致，且 8910 会和商城静态服务撞端口——**以代码里的 8900 为准**，要改就显式传 `BARCODE_PORT`。

## 相关文档

- [`../README.md`](../README.md) — 仓库总览、里程碑状态、测试矩阵
- [`../开发计划.html`](../开发计划.html) — 路线图（扫码台在 M1/M4 的位置）
- [`../细节讨论记录.html`](../细节讨论记录.html) — 决策台账（D6 双库、D8 扫码只读等）
- [`../独立小程序商城可行性分析与架构方案.html`](../独立小程序商城可行性分析与架构方案.html) — 架构与实现现状（§2.7 条码双库）
- [`../server/README.md`](../server/README.md) — 后端 `/api/barcode/*` 接口与云端熔断实现
- [`../web/README.md`](../web/README.md) — 商城 Web 端（共用 `bd_products`）
- [`../sync-demo/README.md`](../sync-demo/README.md) — 牵牛花月度 CSV 对账（共用 `bd_products`）

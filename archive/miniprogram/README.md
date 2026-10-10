# 归档 · 微信小程序骨架（M5 暂缓）

> **状态：⏸ 暂缓，代码未删除、可随时续做。** 2026-10-10 用户决定「小程序先缓缓，先把商城做成 Web 端、先实现功能」（详见 `../../细节讨论记录.html` D14），小程序从「下一里程碑」下调为暂缓，Web 端成为当前重心。本目录是当时已写完并测试通过的小程序客户端骨架，原样封存作为后续阶段的地基。

## 为什么暂缓

| 原因 | 说明 |
| --- | --- |
| 平台前置条件未到位 | 小程序要**账号 + 商户号**（审批 1–2 周）、服务器域名必须 **HTTPS 且已备案**——两项都在用户侧推进中 |
| 先跑通业务更快 | Web 端零门槛、当天可演示、功能可立刻试；商城逻辑（商品/购物车/订单/运费/库存）与载体无关，先在 Web 上定型可避免在小程序里返工 |
| 逻辑已复用 | 后端（`server/`）、规则（价格防护 / 配送）、数据通道模式（`web/sdy-api.js`）都是载体无关的，小程序阶段只需接口层 |

## 里面有什么

```
archive/miniprogram/
├── app.js / app.json / app.wxss     # 小程序入口；tabBar 4 页（首页/购物车/订单/我的）
├── pages/
│   ├── index/                       # 首页：商品列表
│   ├── cart/                        # 购物车：加购/步进/结算
│   ├── orders/                      # 订单：列表与状态
│   └── mine/                        # 我的：入口与设置
├── utils/
│   ├── api.js                       # 后端通道（与 web/sdy-api.js、barcode-demo/bd-api.js 同构：在线=服务端真源，离线=本地演示）
│   ├── rules.js                     # 价格防护 / 配送规则的小程序侧实现（与 server/internal/pricing 对齐）
│   └── store.js                     # wx.storage 封装
├── project.config.json / sitemap.json
└── test-api.js / test-pages.js / test-integration.js   # 三套测试
```

## 测试

```bash
node archive/miniprogram/test-api.js          # 62 项 · 通道降级（假 wx）· 不需要后端
node archive/miniprogram/test-pages.js        # 47 项 · 四页逻辑冒烟（假 Page/wx）· 不需要后端
node archive/miniprogram/test-integration.js  # 21 项 · 真后端联调（需先起 server，或用 SDY_API_BASE 指定）
```

## 续做条件与注意事项

续做前需要（用户侧）：**① 小程序账号；② 微信支付商户号；③ 已备案的 HTTPS 域名**。

恢复开发时要做的事：

1. **主题色对齐**：`app.json` 里的 `navigationBarBackgroundColor` / `tabBar.selectedColor` 仍是旧的蓝色 `#2563eb`，应改为 Web 端设计系统的主色 `#16a34a`（`web/assets/theme.css`）。
2. **接口地址**：小程序的 `request` 只能请求**已在后台配置的 HTTPS 域名**，不能用 `127.0.0.1`；开发期用「不校验合法域名」开关，上线前必须在后台配置。
3. **扫码**：用 `wx.scanCode` 替换 Web 端的 `getUserMedia + BarcodeDetector`（D7：MVP 不买扫码枪），并遵守 **D8 扫码只读**（只做识别/建档/查询，不改库存）。
4. **支付与消息**：微信支付、订阅消息是 Web 端没有的能力，也是当初做小程序的主要理由；需等服务端下单流程在 Web 上定型后再接。
5. **逻辑同源**：`utils/rules.js` 与 `server/internal/pricing`、`utils/api.js` 与 `web/sdy-api.js` 的语义必须保持一致，改动任一处要同步检查另一处。

## 相关文档

- 路线与当前重心：[`../../开发计划.html`](../../开发计划.html)（M5 = 暂缓）
- 决策台账 D14（为什么先 Web）与 D7/D8：[`../../细节讨论记录.html`](../../细节讨论记录.html)
- 里程碑状态只在根 README 维护：[`../../README.md`](../../README.md)

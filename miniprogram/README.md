# 微信小程序端（M5 · 已启动）

> **状态：🚧 开发中（2026-10-12 起）。** 原 `archive/miniprogram` 骨架已激活为本目录；小程序注册（主体：海宁啥都有网络科技有限公司）小额打款验证已通过，等 AppID 与已备案 HTTPS 域名到位即可接后台配置。载体换了，业务逻辑不变：商品 / 购物车 / 订单 / 运费 / 库存全部复用 `server/` 的后端接口。

## 里面有什么

```
miniprogram/
├── app.js / app.json / app.wxss     # 入口；tabBar 4 页（首页/购物车/订单/我的）；主色 #16a34a
├── pages/
│   ├── index/                       # 首页：商品列表 + 分类 + 扫码找货
│   ├── cart/                        # 购物车：加购/步进/结算
│   ├── orders/                      # 订单：列表与状态
│   └── mine/                        # 我的：连接状态与后端地址
├── utils/
│   ├── config.js                    # **唯一域名配置点**：DEV_BASE_URL / PROD_BASE_URL
│   ├── api.js                       # 后端通道（与 web/sdy-api.js 同构：在线=服务端真源，离线=本地演示）
│   ├── rules.js                     # 价格防护 / 配送规则（与 server/internal/pricing 同源）
│   └── store.js                     # wx.storage 封装
├── project.config.json / sitemap.json
└── test-api.js / test-pages.js / test-integration.js   # 三套测试
```

## 测试

```bash
node miniprogram/test-api.js          # 73 项 · 通道/配置/扫码（假 wx）· 不需要后端
node miniprogram/test-pages.js        # 57 项 · 四页逻辑冒烟（假 Page/wx）· 不需要后端
node miniprogram/test-integration.js  # 21 项 · 真后端联调（需先起 server，或用 SDY_API_BASE 指定）
```

## 上线前改造清单

| # | 事项 | 状态 |
| --- | --- | --- |
| 1 | 主题色对齐 Web 设计系统主色 `#16a34a`（`app.json` / `app.wxss` / `cart.wxss`） | ✅ 已完成 |
| 2 | 新增 `utils/config.js`，`api.js` 的 `DEFAULT_BASE` 改读它（域名只改一处） | ✅ 已完成 |
| 3 | `api.resolveBarcode(code)` → `GET /api/barcode/resolve`（**只读**，D8） | ✅ 已完成 |
| 4 | 首页扫码找货：`wx.scanCode` → 填搜索框筛出来（认不出就把条码填进去） | ✅ 已完成 |
| 5 | `PROD_BASE_URL` 填已备案 HTTPS 域名 + 后台「服务器域名」配置 | ⬜ 等域名 |
| 6 | `project.config.json` 填真 AppID（现在是测试号/占位） | ⬜ 等 AppID |
| 7 | 服务端 `POST /api/wx/login`（`code2Session`）、`/api/wx/pay`、`/api/wx/notify` | ⬜ 等 AppID/AppSecret |
| 8 | 微信支付、订阅消息（Web 端没有的能力，也是做小程序的主要理由） | ⬜ |

## 上线三步（用户侧）

1. **域名**：把已备案域名解析到生产服务器 `124.223.16.159`，我用 certbot 配 HTTPS（这是 Web 端任务池 ⑧ 的最后一环，小程序也依赖它）。
2. **AppID**：小程序后台 `开发与服务 → 开发管理 → 开发设置 → AppID(小程序ID)`，填进 `project.config.json` 与后台配置；AppSecret 只进服务器 `.env`（`WX_APPID` / `WX_SECRET`），**绝不入库**。
3. **微信认证**：微信支付要求 AppID 已通过微信认证；关联商户号后**不支持解绑**（一个商户号最多关联 50 个 AppID）。

## 注意事项

1. **接口地址**：`wx.request` 只能请求**后台配置过的 HTTPS 域名**（不能是 IP、不能带端口）；开发期在开发者工具「详情 → 本地设置」勾选「不校验合法域名」，直连本机 `127.0.0.1:8093`。
2. **扫码只读（D8）**：`wx.scanCode` 只做识别 / 建档 / 查询，绝不改库存；库存一律由老板在 Web 管理端手动调整。
3. **逻辑同源**：`utils/rules.js` 与 `server/internal/pricing`、`utils/api.js` 与 `web/sdy-api.js` 语义必须一致，改一处要同步检查另一处。
4. **价格真源在服务端**：顾客等级 / 批发价由 `GET /api/products?phone=` 下发，小程序不自己算价。

## 相关文档

- 上手引导：[`../小程序开发引导.html`](../小程序开发引导.html)
- 路线与里程碑：[`../开发计划.html`](../开发计划.html)、[`../README.md`](../README.md)
- 决策台账：[`../细节讨论记录.html`](../细节讨论记录.html)（D7/D8 扫码、D14 先 Web、D25 库存审计）

# 微信小程序端（M5 · 已启动）

> **状态：🚧 开发中（2026-10-12 起）。** 第 21 轮把 `archive/miniprogram` 恢复激活为本目录；第 22 轮（2026-10-13）三项前置全部到位——AppID `wx3f2d2aa52660b80f`、已备案 HTTPS 域名 `https://mall.shadouyou.cloud`（小程序后台「request 合法域名」已配置）、生产接口可用，**开发版 0.1.0 已上传，真机预览二维码可扫**（家人要用则先在后台「选为体验版」并加为体验成员）。
>
> 下一步：服务端 `POST /api/wx/login`（`code2Session`，**不依赖微信认证**）→「我的」页接登录态；微信支付要等**微信认证（¥300/年）+ 关联商户号**之后。载体换了，业务逻辑不变：商品 / 购物车 / 订单 / 运费 / 库存全部复用 `server/` 的后端接口。

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
├── project.config.json              # AppID 已填 wx3f2d2aa52660b80f；开发期 urlCheck:false
└── test-api.js / test-pages.js / test-integration.js   # 三套测试
```

## 开发版上传与真机预览（第 22 轮新增）

本机是 Linux、**没装微信开发者工具**（无 GUI 可用），所以走命令行：`deploy/mp-ci.js`（微信官方 `miniprogram-ci`）。

```bash
# 一次性准备（装在仓库外，项目本身仍零 npm 依赖）
mkdir -p /tmp/mpci && cd /tmp/mpci && npm init -y && npm install miniprogram-ci

# 出预览二维码 + 上传开发版（仓库根执行）
NODE_PATH=/tmp/mpci/node_modules node deploy/mp-ci.js          # all
NODE_PATH=/tmp/mpci/node_modules node deploy/mp-ci.js preview  # 只出二维码
NODE_PATH=/tmp/mpci/node_modules node deploy/mp-ci.js upload   # 只上传开发版
```

- 产物：`.preview/mp-preview-qr.png`（真机预览二维码，**约 25 分钟有效**，过期重跑）
- 扫开的人必须是**管理员 / 项目成员 / 体验成员**；家人要用：`管理 → 版本管理 → 开发版本 → 选为体验版` + `管理 → 成员管理 → 体验成员`
- 两个已知坑（`/etc/hosts` 强制 servicewechat 走 IPv4、代码上传密钥 IP 白名单 `errCode -10008`）见 `.agent_rules.md` 规则 25

## 测试

```bash
node miniprogram/test-api.js          # 73 项 · 通道/配置/扫码（假 wx）· 不需要后端
node miniprogram/test-pages.js        # 57 项 · 四页逻辑冒烟（假 Page/wx）· 不需要后端
node miniprogram/test-integration.js  # 24 项 · 真后端联调（需先起 server，或用 SDY_API_BASE 指定）
```

## 上线前改造清单

| # | 事项 | 状态 |
| --- | --- | --- |
| 1 | 主题色对齐 Web 设计系统主色 `#16a34a`（`app.json` / `app.wxss` / `cart.wxss`） | ✅ 已完成 |
| 2 | 新增 `utils/config.js`，`api.js` 的 `DEFAULT_BASE` 改读它（域名只改一处） | ✅ 已完成 |
| 3 | `api.resolveBarcode(code)` → `GET /api/barcode/resolve`（**只读**，D8） | ✅ 已完成 |
| 4 | 首页扫码找货：`wx.scanCode` → 填搜索框筛出来（认不出就把条码填进去） | ✅ 已完成 |
| 5 | `PROD_BASE_URL` 填已备案 HTTPS 域名 + 后台「服务器域名」配置 | ✅ 2026-10-13 |
| 6 | `project.config.json` 填真 AppID | ✅ 2026-10-13 |
| 7 | 开发版上传 + 真机预览（`deploy/mp-ci.js`） | ✅ 2026-10-13（0.1.0） |
| 8 | 服务端 `POST /api/wx/login`（`code2Session`）+「我的」页登录态 | ⬜ 第 23 轮先做（不依赖认证） |
| 9 | 服务端 `/api/wx/pay`、`/api/wx/notify` + 订阅消息 | ⬜ 等微信认证 + 关联商户号 |
| 10 | 上传体验版给家人用 + 真机走一遍下单 | ⬜ 用户侧 2 步 |

## 上线三步（用户侧）

1. **域名** ✅ 已完成（2026-10-13）：`mall.shadouyou.cloud` 解析到生产服务器，acme.sh(ZeroSSL ECC) 签发证书，80 自动 301 到 HTTPS，每日自动续期。
2. **AppID / AppSecret** ✅ 已完成：AppID 是公开信息，已进 `project.config.json`；AppSecret 只在服务器 `/root/sdy/.env` 与本机 `.wx_secret.env`，**绝不入库**。
3. **微信认证（¥300/年）+ 关联微信支付商户号** ⬜ **唯一还花钱的卡点**：认证通过后到 `产品中心 → APPID授权管理 → +关联AppID` 发起绑定，小程序侧在「微信支付 → 商户号管理 → 待关联商户号」确认；**关联后不支持解绑**，一个商户号最多关联 50 个 AppID。另需回传营业执照「营业期限」原文与食品类资质持证主体（须与小程序主体一致）。

## 注意事项

1. **接口地址**：`wx.request` 只能请求**后台配置过的 HTTPS 域名**（不能是 IP、不能带端口）；生产走 `https://mall.shadouyou.cloud`，开发期在开发者工具「详情 → 本地设置」勾选「不校验合法域名」或用控制台 `api.setBase('http://127.0.0.1:8093')` 直连本机。
2. **扫码只读（D8）**：`wx.scanCode` 只做识别 / 建档 / 查询，绝不改库存；库存一律由老板在 Web 管理端手动调整。
3. **逻辑同源**：`utils/rules.js` 与 `server/internal/pricing`、`utils/api.js` 与 `web/sdy-api.js` 语义必须一致，改一处要同步检查另一处。
4. **价格真源在服务端**：顾客等级 / 批发价由 `GET /api/products?phone=` 下发，小程序不自己算价。
5. **预览二维码不等于发布**：预览 / 开发版只对管理员、项目成员、体验成员可见，正式上线还要走「提交审核 → 发布」，且微信支付必须先完成认证与商户号关联。

## 相关文档

- 上手引导：[`../小程序开发引导.html`](../小程序开发引导.html)
- 路线与里程碑：[`../开发计划.html`](../开发计划.html)、[`../README.md`](../README.md)
- 决策台账：[`../细节讨论记录.html`](../细节讨论记录.html)（D7/D8 扫码、D14 先 Web、D25 库存审计、D26 小程序口径、D27 域名与证书）

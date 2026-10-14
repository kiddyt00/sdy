# 微信小程序端（M5 · 进行中 · 当前第 27 轮 / 开发版 0.6.0）

> **状态：🚧 开发中（2026-10-12 起）。** 第 21 轮把 `archive/miniprogram` 恢复激活为本目录；第 22 轮（2026-10-13）三项前置全部到位——AppID `wx3f2d2aa52660b80f`、已备案 HTTPS 域名 `https://mall.shadouyou.cloud`（小程序后台「request 合法域名」已配置）、生产接口可用，**开发版 0.1.0 已上传，真机预览二维码可扫**（家人要用则先在后台「选为体验版」并加为体验成员）。
>
> **第 23 轮（2026-10-13）：微信登录打通（D28，开发版 0.2.0）。**「我的」页新增账号区——`wx.login` 拿 `code` → 服务端 `POST /api/wx/login`（`code2Session`）换 `openid` 并绑手机号档案，**不依赖微信认证**；登录后按手机号等级看价（批发 / 白名单价格由服务端下发），登录**不提权**（新顾客一律零售档，批发价只能老板在管理端设）。
>
> **第 24 轮（2026-10-13）：界面整体重做（D29 品牌更名 / D30 引入 `@vant/weapp`，开发版 0.3.0）。** 参考开源商城 `EastWorld/wechat-app-mall` **只吸页面骨架与交互、不吸业务**：引入 **`@vant/weapp 1.11.7`**（本项目唯一获批的 npm 依赖，**只在小程序端**），页面 **4 → 10 页**（新增 商品详情 / 分类 / 搜索 / 订单详情 / 地址簿 list+edit，重做 首页 / 购物车 / 订单 / 我的），打通**浏览→详情→下单**主链路（详情「加入购物车 / 立即购买」、购物车多选 + 左滑删除 + 步进 + 地址簿回填、订单按状态分页 + 确认收货 / 取消 / 再来一单）；门店更名 **啥都有快送**；Web 端同步对齐（详情「立即购买」临时单、订单状态文案与确认收货）。
>
> **第 25 轮（2026-10-13）：登录与信息展示收敛（D31，开发版 0.4.0）。** 按用户五条反馈改：① 登录改用微信官方**「头像昵称填写能力」**（`<button open-type="chooseAvatar">` + `<input type="nickname">`；`wx.getUserProfile` 自 2022-10-25 起只给灰头像与「微信用户」，**不能用**），头像用 `wx.getFileSystemManager().saveFile` 落本机永久文件（临时路径重启就失效）并 `POST /api/wx/profile` 回传云地址（`wxfile://` 传上去没用，不回传）；② **登录不再要手机号**——只走 `wx.login` → `openid`，手机号推到**下单时**填，填过一次由 `api.rememberPhone()` 记住（它仍是价格身份与地址簿钥匙，见 D24/D18），地址簿改成「显式手机号优先、否则用记住的」；③ 登录后**不再显示「微信一键登录」**，也**没有「保存头像昵称」入口**——点头像即选即存、昵称随登录 body 提交（上线后老板又让把那张「微信头像昵称」卡删掉，现在全自动）；**头像全页只留顶部一处**（`chooseAvatar` 只出现 1 次，登录卡里原来那个第二头像已删——之前出现了两个头像）；④ **头像椭圆彻底修掉**——两次才修对：第一次重置原生 `button` 的 `padding`/`line-height`/`::after` 后老板反馈**仍是椭圆**，最终把**可见的一层换成纯 `view` + `image` 圆容器**（`mine.wxml` 的 `.mavatar-wrap`），`open-type="chooseAvatar"` 的 `button` 退化成 `opacity:0` 的**透明点击层**（`.mavatar-hit`）——形状不再由 `button` 决定，椭圆从根上消失；⑤ **顾客端不露开发信息**——「我的」页删掉「后端连接」一行，**首页 / 购物车 / 订单 / 我的四处**一律只画小圆点（`.cdot` 在 `app.wxss` 一处定义，`.ok` 绿 / `.off` 灰，首页 `.sdot` 与我的 `.mdot` 只管位置配色），旧的 `.badge` 胶囊（含「🟢 后端已连接」）**已从 `app.wxss` 删除**，页面 data 里的 `statusLabel` 一并删掉；测试加了「遍历 10 个页面扫开发字样」的守卫。服务端 `wx_user` 加 `avatar` 列（`ensureColumn` 幂等迁移）、`/api/wx/login` 的 `phone` 变可选、新增 `POST /api/wx/profile`。⑥ **开发入口连入口都不许有**——「我的」页最底下那行带下划线的「开发者选项」已删（老板原话「我的最底下的开发者选项不能显示」），随后老板又说「长按版本号进面板 这个功能也不需要」，于是**连调试面板一起整块删除**（`devMode`/`statusDetail`/`apiBase` 与那三个按钮全没了，顾客端不留任何开发入口），同时把 **「退出登录」从面板里挪到顾客区**（独立卡片 `.mexit` → `doLogout()`，自带二次确认）——它是顾客的正常功能，藏进调试面板等于顾客退不了登录；全页扫描的禁用词加上「开发者选项」。⑦ **订单页 6 个状态标签不再顶出屏幕**——`van-tabs` 的 `swipe-threshold` 默认 **5**，而状态标签有 **6** 个（全部 → 已取消）→ 走「横向滚动」分支（每格 22%、共 132%）溢出 750rpx；改成 `swipe-threshold="{{6}}"` 等分（每格约 125rpx），并用 `--tab-font-size:23rpx` / `--tabs-line-height:78rpx` 压紧（3 字标签 69rpx + 左右 padding 48rpx = 117rpx < 125rpx，不挤不裁）。⑧ **登录与顶部绿框合并、退出登录清头像**——老板原话「退出登录之后顶部绿色框里为啥还显示用户的微信头像」「绿色框下面还有个框是微信登录和微信一键登录按钮…有点功能冗余」。登录表单搬进 `.mhead` 内的 `.mlogin`（`.lnick` 昵称 `input[type=nickname]` + `.lbtn` + `.ltip`），独立登录卡 `.mcard.login` 整块删除；**登录按钮本身就是头像按钮**（`.lbtn` = `open-type="chooseAvatar"` + `bindchooseavatar="onChooseAvatar"`，`onChooseAvatar` → `persistAvatar()` → `doLogin()`，点一次同时拿到微信头像并完成登录）；**「更换头像」入口一并删掉**（透明点击层 `.mavatar-hit` 删除，头像不可点——要换头像就退出登录再点一次登录按钮）；`doLogout()` 除 `api.clearSession()` 外还 `wx.removeStorageSync('sdy_mp_avatar')` 并清 `nickname/avatar`，**退出后绿框里不再挂着上一个用户的头像**。⑨ **原生 `input` 必须写死高度**——老板反馈购物车「收货人 / 手机号 / 送货地址」三个框**字只露上半截**：原生 `input` 自带 `1.4rem`（≈56rpx）默认高度，`app.wxss` 的 `.input` 又加了 `padding:16rpx 20rpx`，`box-sizing:border-box` 下内容区只剩 24rpx（≈半个字高）→ 被裁；改成 `height:80rpx; line-height:78rpx; padding:0 20rpx`（纵向 padding 归零、高度交给 `height` 管），并加断言防止回退。⑩ **调试面板整块删除**——老板看了 0.4.0 之后又补一句「长按版本号进面板 这个功能也不需要」：`wx:if="{{devMode}}"` 的调试面板（面板标题「调试面板」/`statusDetail`/后端地址 `van-field`/保存并重连 / 清空本地缓存 / 退出登录三个按钮）与 `.mfoot` 的 `bindlongpress="toggleDev"` 全部删除，`mine.js` 的 data 不再有 `devMode/statusDetail/apiBase`、方法 `toggleDev/onBase/saveBase/clearAll` 一并删除；「退出登录」卡片 `.mcard.exit` 留在顾客区。全页扫描禁用词加「调试面板」，并断言页面不再暴露这四个方法。小程序三套测试 **104 / 167 / 50** 全绿。
>
> **第 26 轮（2026-10-14）：员工身份 + 员工扫码工作台（D32，开发版 0.5.0）。** 小程序登录时多了一个身份选择：**「我是顾客」/「我是员工」**（默认顾客，顾客界面一个字节都没改）——**身份不是自己点出来的**，老板必须在 Web 管理端新增的「用户角色」面板里把这个微信号标成员工，否则选了员工登录会拿到 `403`「这个微信号还不是员工，请让老板在管理后台把角色改成员工」；服务端 `wx_user` 加 `role TEXT NOT NULL DEFAULT 'customer'` 与 `staff_token TEXT NOT NULL DEFAULT ''` 两列（都走 `ensureColumn` 幂等迁移；**令牌故意不进 `store.WxUser` 结构体**，防止列表接口泄露），是员工就一律回 64 位 `staffToken`（**每次员工登录轮换、旧令牌立刻失效**；**角色改回顾客时令牌一并清空**）。员工端是**非 tab 的 5 页工作台** `pages/staff/*`——`home`（今日营业额 / 今日订单 / 待处理 / 低库存 + 待处理前 5 + 低库存前 5 + 最近流水 + 一个大按钮「扫码找货」）/ `scan`（扫码台）/ `stock`（库存，看得到已下架的货）/ `orders`（订单，可推进状态）/ `mine`（员工我的，可「切回顾客版」）；**为什么不做成 tabBar**：小程序 tabBar 最多 5 项且 `app.json` 里是静态的，顾客的 5 个 tab 已占满，于是员工端用自绘底栏组件 `components/staff-nav`（`wx.redirectTo` 切页，避免页面栈越堆越深），顾客路径完全不动。**扫码台是本轮核心**：`wx.scanCode` 扫 69 码 → 服务端查货 → 显示名称 / 规格 / 条码 / 库存 / 售价 / 进价 / 上下架，**扫码本身只读**；入库（`stock_in`，增量）、出库（`adjust`，传负数）、盘点（`stock_take`，传实盘绝对值）都要**再点一下并二次确认**才动库存（每次动作写库存流水，记原因与操作人），未建档的条码可以**当场建档**（表单里**库存留空就一个字节都不发**，绝不把现有库存覆盖成 0，守 D16），可改价、可上下架（上下架只走独立接口，守 D23）。`utils/api.js` 新增并导出 `sessionRole` / `isStaff` / `staffToken` / `staffHeaders` / `view` / `setView` / `staffOverview` / `staffScan` / `changeStock` / `saveProduct` / `setOnSale` / `listAllProducts`（员工接口一律带 `X-Staff-Token`，**不是员工时在本地就被拒绝，一个请求都不发**）。注意**界面开关和本机身份是两件事**：`setView('customer')` 只是切回顾客版界面，服务端员工身份与令牌都还在，只有老板在后台把角色改回顾客，令牌才失效。测试小程序 **147 / 218 / 71** 全绿。
>
> **第 27 轮（2026-10-14）：买得完 / 看得对 · 正确性与身份底座（D33，开发版 0.6.0 代码侧已 bump）。** 这一轮不加功能，专修三端「会算错钱、会越权、把失败当空数据」的地方，小程序侧改动集中在**顾客体验的正确性**上：① **10 个顾客页统一四态**——`loading → error → empty → ok`：以前任何请求失败都渲染成「空数据」（顾客看到「一件商品都没有」而不是「连不上店里」），现在失败要显示**错误卡 + 「重新加载」按钮**，「空」只在**成功且真的为空**时才显示（新文件 `miniprogram/pages/common/ui.js` 用 `errText(e)` 把 `request:fail` / `timeout` / `Failed to fetch` / `ERR_*` 一类技术词翻成人话「店里系统没连上，请稍后重试」）；样式集中在 `miniprogram/styles/state.wxss`。② **没身份就一个请求都不发**——`ui.hasIdentity()` 查 `api.identityParams()` 的 `qs` 是否非空，订单页 / 地址页在本地就拦住未登录也没填手机号的顾客，不再拿 400 当「订单为空」。③ **购物车离线不提交也不跳转**（不允许在断连时假装下单成功）；库存上限兜底；失效（已下架/已删除）商品分组、不参与结算。④ **规则只认服务端**——结算运费与低库存阈值只读 `GET /api/settings` 下发值（`api.lowStock()` 读 `cachedSettings().lowStock`，非法或 ≤0 才回落 5），`state.wxss` 里注释写明「阈值由服务端下发，页面不许自己写死 5」；配送费口径与 Web / Go 三端同判（`utils/rules.js` 已退化为**薄适配层**：`goods=round2(subtotal)`、`(c.minFree>0 && goods>=c.minFree)?0:c.deliveryFee`、未知配送方式按 delivery、先 round2 再比门槛）。⑤ **下单幂等**：`api.createOrder` 带 `clientToken='C'+Date.now()+随机`，服务端同 token 第二次返回原单 + `duplicated:true`，只扣一次库存；**取消订单改走 `POST /api/orders/{id}/cancel`**（`advance` 只用于员工推进 / 归属人「确认收货」；非员工推进非 `done` 在本地就 reject「只有店主可以推进订单状态」）。⑥ **地址簿能力钥匙**：`api.addrKey()` / `api.saveAddrKey(k)` 落 `sdy_mp_addr_key`，读写删地址都带 `key=`，`saveAddress` 拿响应里的 `d.key` 存本地——修掉「仅凭手机号就能读写别人地址」。⑦ **角标全改 `store.subscribe`**。三套测试复跑全绿：**167 / 281 / 88**。**本轮的灰度缺口（如实记）**：管理端鉴权只交付了通道，`ADMIN_PASSWORD` 未设置时服务端会把**无身份请求按管理端放行**，所以小程序订单页「没身份就不发请求」不只是体验优化，也是**当前生产环境下看得到自己订单的前提**；正式启用鉴权留第 30 轮（要同时支持员工令牌 + 后台登录页）。」
>
> 下一步：把 **0.6.0 设为体验版**、加家人为体验成员做真机验证（同时在小程序后台补 `<image>` 需要的「**downloadFile 合法域名**」——`chooseAvatar` 之后服务端头像是网络图，这一步不做真机上会不显示）；微信支付（`/api/wx/pay`、`/api/wx/notify`）与订阅消息要等**微信认证（¥300，2026-10-13 已付款审核中）+ 关联商户号**。载体换了，业务逻辑不变：商品 / 购物车 / 订单 / 运费 / 库存全部复用 `server/` 的后端接口。

## 里面有什么

```
miniprogram/
├── app.js / app.json / app.wxss     # 入口；tabBar 5 页（首页/分类/购物车/订单/我的）；主色 #16a34a
├── pages/                           # 顾客端 10 页 + 员工工作台 5 页（共 15 页）
│   ├── index/ cart/ orders/ mine/   # 顾客端主链路 4 页（tabBar）
│   ├── goods/ category/ search/     # 第 24 轮新增：商品详情 / 分类 / 搜索
│   ├── order/ address/              # 第 24 轮新增：订单详情 / 地址簿 list+edit
│   └── staff/                       # 第 26 轮新增（D32，非 tab）：home 工作台 / scan 扫码台 / stock 库存 / orders 订单 / mine 员工我的（可切回顾客版）
├── components/staff-nav/            # 员工端自绘底栏（wx.redirectTo 切页；只在各员工页 page json 里声明，不写进 app.json 全局）
├── pages/common/ui.js               # 第 27 轮（D33）：顾客页四态共用——errText(e) 把技术错误翻成人话、hasIdentity() 身份前置（唯一真源）
├── styles/staff.wxss                # 员工端共用样式
├── styles/state.wxss                # 第 27 轮（D33）：四态共用样式（错误卡 .errbox + 加载骨架 .statecard + 低库存角标 .gtag.low/.sstock）
├── utils/
│   ├── config.js                    # **唯一域名配置点**：DEV_BASE_URL / PROD_BASE_URL
│   ├── api.js                       # 后端通道（与 web/sdy-api.js 同构：在线=服务端真源，离线=本地演示）；第 27 轮新增 identityParams / authHeader / addrKey / saveAddrKey / lowStock / NO_IDENTITY，下单带 clientToken，取消走 /cancel
│   ├── staff.js                     # 第 26 轮：员工端会话 / 令牌 / 接口封装（D32）
│   ├── rules.js                     # 价格防护 / 配送规则 / 等级与有效价（第 27 轮起是 server/internal/pricing 的薄适配层，三端同判）
│   └── store.js                     # wx.storage 封装（购物车、后端地址、登录会话 sdy_mp_session）
├── project.config.json              # AppID 已填 wx3f2d2aa52660b80f；开发期 urlCheck:false
└── test-api.js / test-pages.js / test-integration.js   # 三套测试
```

## 顾客页四态与身份前置（第 27 轮，D33）

- **四态**：`loading`（加载骨架 `.statecard`）→ `error`（错误卡 `.errbox`，带「重新加载」按钮）→ `empty`（**只在成功且真的为空时**才显示）→ `ok`。修的是本轮审计的第一条病：**请求失败被渲染成空数据**（顾客看到「一件商品都没有」，以为店里没货）。
- **错误翻人话**：`miniprogram/pages/common/ui.js` 导出 `errText(e)`——空错误 → `NET_HINT`「店里系统没连上，请稍后重试」；命中 `/request:fail|timeout|Failed to fetch|NetworkError|net::|ERR_[A-Z]|无法连接后端|没有 wx\.request|wx\.login 失败/i` → 同样的人话；`/^HTTP\s*\d{3}$/i` 或「无此路由」→ `BUSY_HINT`「店里系统有点忙，请稍后重试」；>40 字截断加 `…`；**其余原样透传服务端业务文案**（D12：不自己改写结论）。
- **没身份就不发请求**：`hasIdentity()` 看 `api.identityParams()` 的 `qs` 是否非空；订单页 / 地址页在本地就拦住未登录也没填手机号的顾客——**这不只是体验**：服务端 `ADMIN_PASSWORD` 未设置（第 27 轮灰度档）时，无身份的 `GET /api/orders` 会被当成管理端请求、回全店订单（含别人姓名地址），所以「本地先拦」是当前生产环境下看得到正确订单的前提。
- **购物车离线不提交也不跳转**；库存上限兜底；失效（下架/删除）商品分组、不参与结算。
- **规则只认服务端**：结算运费与低库存阈值只读 `GET /api/settings` 下发值（`api.lowStock()` 读 `cachedSettings().lowStock`，非法或 ≤0 才回落 5）；`styles/state.wxss` 注释写明「不许自己写死 5」；配送费口径与 Web / Go **三端同判**（先 `round2` 再比门槛：29.995 → 30.00 → 免运费，29.994 → 收 3 元；未知配送方式按 delivery；`minFree<=0` 永不包邮）。
- **下单幂等与取消**：`api.createOrder` 带 `clientToken`（同 token 第二次服务端回原单 + `duplicated:true`，只扣一次库存）；**取消走 `POST /api/orders/{id}/cancel`**；`advanceOrder` 非员工且 `to !== 'done'` 时在本地就 reject「只有店主可以推进订单状态」。
- **地址簿能力钥匙**：`api.addrKey()` / `api.saveAddrKey(k)` 落 `sdy_mp_addr_key`（服务端首次保存地址时下发 32 位 hex），读写删都带 `key=` —— 修掉「仅凭手机号就能读写别人地址」。

## 员工身份与扫码工作台（第 26 轮，D32）

- **只有两种角色**：`customer`（顾客，默认）/ `staff`（员工）。**角色只能由老板在 Web 管理端「用户角色」面板设定**（`GET /api/wx/users` + `POST /api/wx/role`）——小程序登录时选「我是员工」只是「我想以员工身份进来」，后台没标成员工就会被 `403`「这个微信号还不是员工，请让老板在管理后台把角色改成员工」挡掉，**权限点不出来**。
- **员工端 5 页（非 tab 页）**：

| 页面 | 干什么 |
| --- | --- |
| `pages/staff/home` | 工作台：今日营业额 / 今日订单 / 待处理 / 低库存 + 待处理订单前 5 + 低库存前 5（阈值 5，与 Web 管理端同口径）+ 最近 5 条库存流水，一个大按钮「扫码找货」 |
| `pages/staff/scan` | **扫码台（本轮核心）**：扫 69 码 → 服务端查货 → 名称 / 规格 / 条码 / 库存 / 售价 / 进价 / 上下架；**扫码只读**，入库（增量）/ 出库（负数）/ 盘点（实盘绝对值）都要再点一下并二次确认才动库存，每次动作写库存流水；未建档可当场建档；可改价、可上下架 |
| `pages/staff/stock` | 库存（看得到已下架的货） |
| `pages/staff/orders` | 订单，可推进状态 |
| `pages/staff/mine` | 员工我的，可「切回顾客版」 |

- **底栏为什么自绘**：小程序 tabBar 最多 5 项且 `app.json` 里是静态的，顾客的 5 个 tab 已占满；员工端用 `components/staff-nav`（`wx.redirectTo` 切页，避免页面栈越堆越深），**只在各员工页的 page json 里声明、没写进 `app.json` 的全局 `usingComponents`**。
- **接口**：`GET /api/staff/overview`、`GET /api/staff/scan?code=`，一律带请求头 `X-Staff-Token`（失败 `401`「员工身份已失效，请用员工身份重新登录」）；**不是员工时这些接口在本地就被拒绝，一个请求都不发**。令牌**每次员工登录轮换、旧的立刻失效**；**角色被改回顾客时令牌清空**。
- **员工是全权限**（跟 Web 管理后台一样：能改价 / 删商品 / 改顾客等级），所以员工的写操作复用既有开放接口，只有上面两个聚合接口带令牌；**站点级管理端鉴权目前仍是遗留项**。
- **界面开关 ≠ 身份**：`setView('customer')` 只切回顾客版界面，服务端员工身份与令牌都还在；只有老板在后台把角色改回顾客，令牌才失效。

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
node miniprogram/test-api.js          # 167 项（第 27 轮实测）· 通道/配置/扫码/等级与有效价/微信登录与头像昵称/员工身份与令牌/身份参数与地址钥匙（假 wx）· 不需要后端
node miniprogram/test-pages.js        # 281 项 · 十五页逻辑冒烟（假 Page/wx，含四态错误卡与「重新加载」、不绑手机号的微信登录、头像本地落缓存、地址簿、员工工作台 5 页）· 不需要后端
node miniprogram/test-integration.js  # 88 项 · 真后端联调（需先起 server，或用 SDY_API_BASE 指定；含 29.995 元边界三端同判；员工端整节用 WX_API_BASE 指向假微信服务器）
```

> 第 27 轮起三端全量可以一条命令跑完：`bash deploy/verify-all.sh`（自起临时后端与假微信，Go 单测 + 小程序三套 + Web 五套 + CDP，最后打 17 行汇总表）。

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
| 8 | 服务端 `POST /api/wx/login`（`code2Session`）+「我的」页登录态 | ✅ 2026-10-13（第 23 轮 D28，开发版 0.2.0） |
| 9 | 服务端 `/api/wx/pay`、`/api/wx/notify` + 订阅消息 | ⬜ 等微信认证 + 关联商户号 |
| 10 | 上传体验版给家人用 + 真机走一遍下单 | ⬜ 用户侧 2 步 |
| 11 | 员工身份 + 员工扫码工作台（D32：登录选身份、员工端 5 页、扫码只读 + 二次确认才动库存、Web「用户角色」面板） | ✅ 2026-10-14（第 26 轮，开发版 0.5.0） |
| 12 | 顾客页四态（加载/错误+重新加载/空/正常）+ 身份前置 + 离线不假装下单 + 运费与低库存阈值走服务端下发（D33） | ✅ 2026-10-14（第 27 轮，开发版 0.6.0 代码侧已 bump） |

## 上线三步（用户侧）

1. **域名** ✅ 已完成（2026-10-13）：`mall.shadouyou.cloud` 解析到生产服务器，acme.sh(ZeroSSL ECC) 签发证书，80 自动 301 到 HTTPS，每日自动续期。
2. **AppID / AppSecret** ✅ 已完成：AppID 是公开信息，已进 `project.config.json`；AppSecret 只在服务器 `/root/sdy/.env` 与本机 `.wx_secret.env`，**绝不入库**。
3. **微信认证（¥300/年）+ 关联微信支付商户号** 🚧 认证费 **2026-10-13 已付款、审核中**；商户号未开始关联：认证通过后到 `产品中心 → APPID授权管理 → +关联AppID` 发起绑定，小程序侧在「微信支付 → 商户号管理 → 待关联商户号」确认；**关联后不支持解绑**，一个商户号最多关联 50 个 AppID。另需回传营业执照「营业期限」原文与食品类资质持证主体（须与小程序主体一致）。

## 注意事项

1. **接口地址**：`wx.request` 只能请求**后台配置过的 HTTPS 域名**（不能是 IP、不能带端口）；生产走 `https://mall.shadouyou.cloud`，开发期在开发者工具「详情 → 本地设置」勾选「不校验合法域名」或用控制台 `api.setBase('http://127.0.0.1:8093')` 直连本机。
2. **扫码只读（D8）**：`wx.scanCode` 只做识别 / 建档 / 查询，绝不改库存；库存一律由老板在 Web 管理端手动调整。
3. **逻辑同源**：`utils/rules.js` 与 `server/internal/pricing`、`utils/api.js` 与 `web/sdy-api.js` 语义必须一致，改一处要同步检查另一处。
4. **价格真源在服务端**：顾客等级 / 批发价由 `GET /api/products?phone=` 下发，小程序不自己算价。
5. **预览二维码不等于发布**：预览 / 开发版只对管理员、项目成员、体验成员可见，正式上线还要走「提交审核 → 发布」，且微信支付必须先完成认证与商户号关联。

## 相关文档

- 上手引导：[`../小程序开发引导.html`](../小程序开发引导.html)
- 路线与里程碑：[`../开发计划.html`](../开发计划.html)、[`../README.md`](../README.md)
- 决策台账：[`../细节讨论记录.html`](../细节讨论记录.html)（D7/D8 扫码、D14 先 Web、D25 库存审计、D26 小程序口径、D27 域名与证书、D28 微信登录、D32 员工身份与员工扫码工作台、**D33 身份底座 / 正确性收敛 / 管理端鉴权灰度**）

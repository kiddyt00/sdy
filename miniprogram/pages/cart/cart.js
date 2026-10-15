// 购物车 + 提交订单（下单以服务端为准：配送费、库存、总额都由后端算）
// 第 24 轮：勾选/全选、步进器、左滑删除、「立即购买」直通（buyNow 模式只渲染那一件，不写购物车）
const api = require('../../utils/api.js')
const store = require('../../utils/store.js')
const rules = require('../../utils/rules.js')
const ui = require('../common/ui.js')

Page({
  data: {
    online: false,
    lines: [],
    badLines: [], // 失效商品（已下架 / 已删除 / 库存 0）单独一组，不参与结算（第 27 轮 P0-6）
    buyNow: false,
    buyNowLines: [],
    deliveryType: 'delivery',
    name: '',
    phone: '',
    address: '',
    subtotalText: '0.00',
    feeText: '0.00',
    totalText: '0.00',
    feeHint: '',
    empty: false,
    loading: true,
    loadErr: '',
    shop: {}, // 自提要显示的门店地址 / 电话（第 27 轮 P0-5，来自 settings）
    submitting: false,
    allChecked: true,
    checkedCount: 0,
    cartCount: 0,
    addrPicked: false,
    loggedIn: false
  },

  onLoad() {
    // 第 27 轮 P0-1：购物车变更统一走 store 广播（tabBar 角标由 store 一处维护，这里只同步本页计数）
    this._off = store.subscribe(() => this.syncCount())
  },

  onUnload() {
    if (this._off) this._off()
  },

  syncCount() {
    this.setData({ cartCount: store.cartCount() })
  },

  onShow() {
    // 详情页「立即购买」放进来的那一件：消费即清，下次进购物车不会又冒出来
    const bn = store.takeBuyNow()
    if (bn) this.setData({ buyNow: true, buyNowLines: bn })
    this.takePickedAddress()

    const c = store.getCustomer()
    const s = api.session() || {}
    // 已登录就用登录态里的姓名/手机号兜底（省得每次重输；地址仍以本地记住的为准）
    this.setData({
      name: c.name || s.name || '',
      phone: c.phone || s.phone || '',
      address: c.address || '',
      loggedIn: api.isLoggedIn()
    })
    return this.refresh()
  },

  refresh() {
    this.setData({ loading: true, loadErr: '' })
    return getApp()
      .refreshStatus()
      .then((st) => {
        this.setData({ online: !!st.online })
        // 第 27 轮 P0-5：配送费 / 免运费门槛 / 自提门店信息都从 settings 来（真源在服务端）
        return api.getSettings()
      })
      .then((s) => {
        this.setData({ shop: Object.assign({ name: '啥都有快送' }, api.cachedSettings() || {}, s || {}) })
        return this.reprice()
      })
      .then(() => {
        this.setData({ loading: false })
        return this.render()
      }, (e) => {
        // 第 27 轮 P0-2：取不到 settings 就明说 + 给「重新加载」，
        // 绝不把请求失败渲染成「购物车还是空的」。
        this.setData({ loading: false, loadErr: ui.errText(e), empty: false })
        return null
      })
  },

  // 错误卡上的「重新加载」：重新探测 + 重新取 settings + 重新算钱
  reload() {
    return this.refresh()
  },

  // 第 27 轮 P0-5：配送费与门槛以服务端 settings 为准（rules 只兜底），页面不许再写死 3 元 / 30 元
  feeCfg() {
    const s = this.data.shop || {}
    const c = {}
    if (isFinite(Number(s.minFree))) c.minFree = Number(s.minFree)
    if (isFinite(Number(s.deliveryFee))) c.deliveryFee = Number(s.deliveryFee)
    if (isFinite(Number(s.pickupFee))) c.pickupFee = Number(s.pickupFee)
    return c
  },

  // 用服务端有效价刷新购物车单价：登录 / 换等级后价格会变（价格真源在服务端，D24）
  // 第 27 轮 P0-6：顺带同步库存与「还在不在卖」——已下架 / 已删除 / 库存 0 的行要单独分组
  reprice() {
    if (!this.data.online || this.data.buyNow) return Promise.resolve(false)
    const raw = store.getCart()
    if (!raw.length) return Promise.resolve(false)
    return api
      .listProducts()
      .then((items) => {
        let changed = false
        raw.forEach((it) => {
          const hit = items.filter((p) => p.code === it.code)[0]
          if (!hit) {
            // 在售列表里找不到 = 已下架或已删除：标成失效，页面单独分组 + 一键清理
            store.setLineMeta(it.code, { valid: false })
            return
          }
          const now = rules.round2(hit.salePrice)
          if (now !== rules.round2(it.price)) {
            store.setPrice(it.code, now)
            changed = true
          }
          const stock = Number(hit.stock) || 0
          const valid = hit.onSale !== false && stock > 0
          if (Number(it.stock) !== stock || it.valid !== valid) {
            store.setLineMeta(it.code, { stock: stock, valid: valid })
          }
        })
        return changed
      })
      .catch(() => false)
  },

  currentLines() {
    return this.data.buyNow ? this.data.buyNowLines || [] : store.getCart()
  },

  // 合计：购物车只算勾选项；立即购买就那一件
  amount() {
    if (this.data.buyNow) {
      return rules.round2((this.data.buyNowLines || []).reduce((s, it) => s + Number(it.price) * Number(it.qty), 0))
    }
    return store.cartAmount()
  },

  render() {
    const raw = this.currentLines()
    const fmt = (it) => {
      const stock = Number(it.stock) || 0
      return {
        code: it.code,
        name: it.name,
        spec: it.spec,
        unit: it.unit,
        emoji: it.emoji,
        img: it.img || '',
        price: rules.round2(it.price),
        priceText: rules.round2(it.price).toFixed(2),
        qty: Number(it.qty) || 0,
        stock: stock,
        // van-stepper 的上限：有库存就按库存，未知（0）时不限制（老数据没带 stock）
        max: stock > 0 ? stock : 999,
        checked: this.data.buyNow ? true : store.isChecked(it),
        amountText: (rules.round2(it.price) * (Number(it.qty) || 0)).toFixed(2)
      }
    }
    // 第 27 轮 P0-6：失效商品（已下架 / 已删除 / 库存 0）单独分组，不混进可买商品、不参与提交
    const lines = []
    const badLines = []
    raw.forEach((it) => {
      if (!this.data.buyNow && !store.isValid(it)) badLines.push(fmt(it))
      else lines.push(fmt(it))
    })
    const subtotal = this.amount()
    const cfg = this.feeCfg()
    const fee = rules.deliveryFee(this.data.deliveryType, subtotal, cfg)
    this.setData({
      lines: lines,
      badLines: badLines,
      empty: lines.length === 0 && badLines.length === 0,
      subtotalText: subtotal.toFixed(2),
      feeText: fee.toFixed(2),
      totalText: rules.round2(subtotal + fee).toFixed(2),
      feeHint: rules.feeHint(this.data.deliveryType, subtotal, cfg),
      allChecked: this.data.buyNow ? true : store.allChecked(),
      checkedCount: this.data.buyNow ? 1 : store.cartCheckedCount(),
      cartCount: store.cartCount()
    })
  },

  // 第 27 轮 P0-6：数量上限 = 该商品库存；超了夹到库存并明确提示（不静默改数）
  capQty(code, want) {
    const stock = store.cartStock(code)
    const n = Math.max(0, Number(want) || 0)
    if (stock > 0 && n > stock) {
      wx.showToast({ title: '最多只能买 ' + stock + ' 件（库存就这么多）', icon: 'none' })
      return stock
    }
    return n
  },

  // 失效商品一键清理（第 27 轮 P0-6）
  clearBad() {
    const bad = this.data.badLines || []
    if (!bad.length) return Promise.resolve(null)
    return new Promise((resolve) => {
      wx.showModal({
        title: '清理失效商品？',
        content: '这 ' + bad.length + ' 件已经下架或没货了，清掉更干净',
        success: (r) => resolve(!!(r && r.confirm)),
        fail: () => resolve(false)
      })
    }).then((yes) => {
      if (!yes) return null
      bad.forEach((it) => store.removeFromCart(it.code))
      wx.showToast({ title: '已清理', icon: 'none' })
      return this.render()
    })
  },

  // 门店电话（自提时顾客要打电话问店里）：走缓存的门店信息，不额外打网络
  callShop() {
    const s = api.cachedSettings() || {}
    if (!s.phone) {
      wx.showToast({ title: '店里还没留电话', icon: 'none' })
      return null
    }
    if (typeof wx !== 'undefined' && wx.makePhoneCall) wx.makePhoneCall({ phoneNumber: String(s.phone) })
    return null
  },

  /* ---------------- 勾选 ---------------- */
  onCheck(e) {
    store.setChecked(e.currentTarget.dataset.code, e.detail)
    this.render()
  },
  onCheckAll(e) {
    store.setAllChecked(e.detail)
    this.render()
  },

  /* ---------------- 数量 ---------------- */
  // van-stepper：e.detail 是绝对值
  onStep(e) {
    const code = e.currentTarget.dataset.code
    const q = this.capQty(code, e.detail)
    if (this.data.buyNow) {
      const lines = (this.data.buyNowLines || []).map((it) => (it.code === code ? Object.assign({}, it, { qty: q }) : it))
      this.setData({ buyNowLines: lines })
    } else {
      store.setQty(code, q)
    }
    this.render()
  },
  // 旧版相对增减（保留：首页/测试仍在用 delta）
  onQty(e) {
    const code = e.currentTarget.dataset.code
    const d = Number(e.currentTarget.dataset.delta) || 0
    const hit = this.currentLines().filter((it) => it.code === code)[0]
    if (!hit) return
    const q = this.capQty(code, (Number(hit.qty) || 0) + d)
    if (this.data.buyNow) {
      const lines = (this.data.buyNowLines || []).map((it) => (it.code === code ? Object.assign({}, it, { qty: q }) : it))
      this.setData({ buyNowLines: lines.filter((it) => Number(it.qty) > 0) })
      if (!this.data.buyNowLines.length) this.setData({ buyNow: false })
    } else {
      store.setQty(code, q)
    }
    this.render()
  },

  onRemove(e) {
    const code = e.currentTarget.dataset.code
    if (this.data.buyNow) {
      this.setData({ buyNowLines: (this.data.buyNowLines || []).filter((it) => it.code !== code) })
      if (!this.data.buyNowLines.length) this.setData({ buyNow: false })
    } else {
      store.removeFromCart(code)
    }
    this.render()
  },

  onClear() {
    if (this.data.buyNow) {
      this.setData({ buyNow: false, buyNowLines: [] })
      this.render()
      return
    }
    wx.showModal({
      title: '清空购物车？',
      content: '清掉之后要重新挑一遍',
      success: (res) => {
        if (res.confirm) {
          store.clearCart()
          this.render()
        }
      }
    })
  },

  /* ---------------- 收货信息 ---------------- */
  onDelivery(e) {
    this.setData({ deliveryType: e.currentTarget.dataset.kind })
    this.render()
  },
  onName(e) { this.setData({ name: e.detail.value }) },
  onPhone(e) { this.setData({ phone: e.detail.value }) },
  onAddress(e) { this.setData({ address: e.detail.value }) },

  // 地址簿的钥匙是手机号（D18）：登录不带手机号（D31），所以以「下单页刚填的号」优先
  addrPhone() {
    const p = String(this.data.phone || '').trim()
    if (/^1\d{10}$/.test(p)) return p
    return api.boundPhone()
  },

  pickAddress() {
    const ph = this.addrPhone()
    if (!ph) {
      return this.warn('先填收货手机号，才能用地址簿')
    }
    api.rememberPhone(ph) // 地址簿页要按这个号取
    wx.navigateTo({ url: '/pages/address/list?pick=1' })
    return null
  },
  takePickedAddress() {
    const a = store.takePickedAddress()
    if (!a) return null
    this.setData({
      address: a.address || '',
      name: a.contact || this.data.name,
      addrPicked: true
    })
    return a
  },
  // 把手填的地址存进地址簿，下次点一下就能选
  saveToBook() {
    const contact = String(this.data.name || '').trim()
    const address = String(this.data.address || '').trim()
    if (!contact || !address) return this.warn('先填好收货人和地址')
    const ph = this.addrPhone()
    if (!ph) return this.warn('先填收货手机号，才能存地址簿')
    api.rememberPhone(ph)
    return api.saveAddress({ contact: contact, address: address, isDefault: false }, ph).then(
      () => {
        this.setData({ addrPicked: true })
        wx.showToast({ title: '已存进地址簿', icon: 'none' })
        return true
      },
      (e) => this.warn(ui.errText(e) || '存地址失败')
    )
  },

  goAddressBook() {
    const ph = this.addrPhone()
    if (!ph) return this.warn('先填收货手机号，才能用地址簿')
    api.rememberPhone(ph)
    wx.navigateTo({ url: '/pages/address/list' })
    return null
  },

  goIndex() {
    if (typeof wx !== 'undefined' && wx.switchTab) wx.switchTab({ url: '/pages/index/index' })
  },

  submit() {
    if (this.data.submitting) return Promise.resolve(null)
    const name = String(this.data.name || '').trim()
    const phone = String(this.data.phone || '').trim()
    const address = String(this.data.address || '').trim()
    const isDelivery = this.data.deliveryType === 'delivery'
    if (!name) return this.warn('请填写收货人姓名')
    if (!/^1\d{10}$/.test(phone)) return this.warn('请填写 11 位手机号')
    if (isDelivery && !address) return this.warn('送货上门需要地址')

    const items = this.data.buyNow
      ? (this.data.buyNowLines || []).map((it) => ({ code: it.code, qty: Number(it.qty) }))
      : store.orderItems()
    if (!items.length) return this.warn('还没选商品')

    // 第 29 轮：在线下单要进收银台，而支付认的是微信 openid —— 没登录先拦住，不发起下单。
    // 离线（第 27 轮 P0-3）只能记在本机，保持原行为不受这条限制。
    if (this.data.online && !(api.session() || {}).openid) {
      return this.warn('请先用微信登录，下单后可直接支付')
    }

    this.setData({ submitting: true })
    store.saveCustomer({ name: name, phone: phone, address: address })
    // 第 27 轮 P0-8：下单填的手机号就是这次请求的身份（D24/D31）。
    // 必须先记进本地会话，否则「在线但没登录」的顾客会被后端按「缺少身份」挡回来。
    api.rememberPhone(phone)
    return api
      .createOrder({
        customerName: name,
        phone: phone,
        address: isDelivery ? address : '',
        deliveryType: this.data.deliveryType,
        items: items
      })
      .then((r) => {
        if (this.data.buyNow) this.setData({ buyNow: false, buyNowLines: [] })
        else store.clearCart()
        this.setData({ submitting: false })
        this.render()
        if (typeof wx !== 'undefined') {
          if (wx.showToast) {
            wx.showToast({
              title: r.local ? '本地演示：未入库' : '下单成功，等老板确认',
              icon: r.local ? 'none' : 'success'
            })
          }
          // 第 27 轮 P0-3：离线只是记在本机，绝不跳进「下单成功」的页面流程，
          // 明确告诉顾客「离线未提交，请连上店里系统后重试」。
          if (r.local) {
            if (wx.showModal) {
              wx.showModal({
                title: '离线未提交',
                content: '离线未提交，请连上店里系统后重试',
                showCancel: false,
                confirmText: '知道了'
              })
            }
          } else if (wx.redirectTo && r.order && r.order.id && api.payEnabled()) {
            // 第 29 轮：在线下单成功直接进「收银台」付钱（离线不进这个分支）
            // 第 31 轮：店里没开通在线支付就别把人送去一个付不了款的收银台，照旧去订单页
            wx.redirectTo({ url: '/pages/pay/pay?orderId=' + encodeURIComponent(r.order.id) })
          } else if (wx.switchTab) {
            setTimeout(() => { try { wx.switchTab({ url: '/pages/orders/orders' }) } catch (e) { /* 忽略 */ } }, 600)
          }
        }
        return r.order
      })
      .catch((e) => {
        this.setData({ submitting: false })
        // 服务端报错（例如库存不足 409）原文提示，购物车保留不清空；
        // 网络类错误由 ui.errText 换成人话，不把 request:fail 这类串甩给顾客
        this.warn(ui.errText(e))
        return null
      })
  },

  warn(msg) {
    if (typeof wx !== 'undefined' && wx.showToast) wx.showToast({ title: msg, icon: 'none', duration: 2500 })
    return null
  }
})

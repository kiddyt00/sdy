// 购物车 + 提交订单（下单以服务端为准：配送费、库存、总额都由后端算）
// 第 24 轮：勾选/全选、步进器、左滑删除、「立即购买」直通（buyNow 模式只渲染那一件，不写购物车）
const api = require('../../utils/api.js')
const store = require('../../utils/store.js')
const rules = require('../../utils/rules.js')

Page({
  data: {
    online: false,
    statusLabel: '⏳ 探测中…',
    lines: [],
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
    empty: true,
    submitting: false,
    allChecked: true,
    checkedCount: 0,
    cartCount: 0,
    addrPicked: false,
    loggedIn: false
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
    return getApp()
      .refreshStatus()
      .then((st) => {
        this.setData({ online: st.online, statusLabel: st.label })
        return this.reprice()
      })
      .then(() => this.render())
  },

  // 用服务端有效价刷新购物车单价：登录 / 换等级后价格会变（价格真源在服务端，D24）
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
          if (!hit) return
          const now = rules.round2(hit.salePrice)
          if (now !== rules.round2(it.price)) {
            store.setPrice(it.code, now)
            changed = true
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
    const lines = raw.map((it) => ({
      code: it.code,
      name: it.name,
      spec: it.spec,
      unit: it.unit,
      emoji: it.emoji,
      img: it.img || '',
      price: rules.round2(it.price),
      priceText: rules.round2(it.price).toFixed(2),
      qty: Number(it.qty) || 0,
      checked: this.data.buyNow ? true : store.isChecked(it),
      amountText: (rules.round2(it.price) * (Number(it.qty) || 0)).toFixed(2)
    }))
    const subtotal = this.amount()
    const fee = rules.deliveryFee(this.data.deliveryType, subtotal)
    this.setData({
      lines: lines,
      empty: lines.length === 0,
      subtotalText: subtotal.toFixed(2),
      feeText: fee.toFixed(2),
      totalText: rules.round2(subtotal + fee).toFixed(2),
      feeHint: rules.feeHint(this.data.deliveryType, subtotal),
      allChecked: this.data.buyNow ? true : store.allChecked(),
      checkedCount: this.data.buyNow ? 1 : store.cartCheckedCount(),
      cartCount: store.cartCount()
    })
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
    const q = Number(e.detail) || 0
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
    const q = (Number(hit.qty) || 0) + d
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

  pickAddress() {
    if (!api.boundPhone()) {
      return this.warn('先登录并绑定手机号，才能用地址簿')
    }
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
    if (!api.boundPhone()) return this.warn('先登录并绑定手机号，才能存地址簿')
    return api.saveAddress({ contact: contact, address: address, isDefault: false }).then(
      () => {
        this.setData({ addrPicked: true })
        wx.showToast({ title: '已存进地址簿', icon: 'none' })
        return true
      },
      (e) => this.warn((e && e.message) || '存地址失败')
    )
  },

  goAddressBook() {
    if (!api.boundPhone()) return this.warn('先登录并绑定手机号，才能用地址簿')
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

    this.setData({ submitting: true })
    store.saveCustomer({ name: name, phone: phone, address: address })
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
          if (!r.local && wx.switchTab) {
            setTimeout(() => { try { wx.switchTab({ url: '/pages/orders/orders' }) } catch (e) { /* 忽略 */ } }, 600)
          }
        }
        return r.order
      })
      .catch((e) => {
        this.setData({ submitting: false })
        // 服务端报错（例如库存不足 409）原文提示，购物车保留不清空
        this.warn(e.message)
        return null
      })
  },

  warn(msg) {
    if (typeof wx !== 'undefined' && wx.showToast) wx.showToast({ title: msg, icon: 'none', duration: 2500 })
    return null
  }
})

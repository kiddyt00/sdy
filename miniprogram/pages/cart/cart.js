// 购物车 + 提交订单（下单以服务端为准：配送费、库存、总额都由后端算）
const api = require('../../utils/api.js')
const store = require('../../utils/store.js')
const rules = require('../../utils/rules.js')

Page({
  data: {
    online: false,
    statusLabel: '⏳ 探测中…',
    lines: [],
    deliveryType: 'delivery',
    name: '',
    phone: '',
    address: '',
    subtotalText: '0.00',
    feeText: '0.00',
    totalText: '0.00',
    feeHint: '',
    empty: true,
    submitting: false
  },

  onShow() {
    const c = store.getCustomer()
    const s = api.session() || {}
    // 已登录就用登录态里的姓名/手机号兜底（省得每次重输；地址仍以本地记住的为准）
    this.setData({
      name: c.name || s.name || '',
      phone: c.phone || s.phone || '',
      address: c.address || ''
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
    if (!this.data.online) return Promise.resolve(false)
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

  render() {
    const raw = store.getCart()
    const lines = raw.map((it) => ({
      code: it.code,
      name: it.name,
      spec: it.spec,
      unit: it.unit,
      emoji: it.emoji,
      price: rules.round2(it.price),
      priceText: rules.round2(it.price).toFixed(2),
      qty: Number(it.qty) || 0,
      amountText: (rules.round2(it.price) * (Number(it.qty) || 0)).toFixed(2)
    }))
    const subtotal = store.cartAmount()
    const fee = rules.deliveryFee(this.data.deliveryType, subtotal)
    this.setData({
      lines: lines,
      empty: lines.length === 0,
      subtotalText: subtotal.toFixed(2),
      feeText: fee.toFixed(2),
      totalText: rules.round2(subtotal + fee).toFixed(2),
      feeHint: rules.feeHint(this.data.deliveryType, subtotal)
    })
  },

  onQty(e) {
    const code = e.currentTarget.dataset.code
    const d = Number(e.currentTarget.dataset.delta) || 0
    const hit = store.getCart().filter((it) => it.code === code)[0]
    if (!hit) return
    store.setQty(code, (Number(hit.qty) || 0) + d)
    this.render()
  },
  onRemove(e) {
    store.removeFromCart(e.currentTarget.dataset.code)
    this.render()
  },
  onClear() {
    store.clearCart()
    this.render()
  },

  onDelivery(e) {
    this.setData({ deliveryType: e.currentTarget.dataset.kind })
    this.render()
  },
  onName(e) { this.setData({ name: e.detail.value }) },
  onPhone(e) { this.setData({ phone: e.detail.value }) },
  onAddress(e) { this.setData({ address: e.detail.value }) },

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
    const items = store.orderItems()
    if (!items.length) return this.warn('购物车是空的')

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
        store.clearCart()
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

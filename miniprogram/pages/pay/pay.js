// 收银台（第 29 轮 / 0.9.0 顾客侧）
// 下单成功后直接进来：先查支付态（已经付过就不再拉起），未付才自动拉一次微信收银台。
// 铁律：一次进入只自动拉起一次 —— 取消 / 失败后留在本页给「重新支付」按钮，绝不循环弹窗。
const api = require('../../utils/api.js')
const rules = require('../../utils/rules.js')
const ui = require('../common/ui.js')

Page({
  data: {
    orderId: '',
    loading: true,
    err: '',
    needLogin: false,   // 没有 openid：支付认微信身份，先在页面拦住
    notFoundText: '',
    online: false,
    paid: false,        // 已付款（成功态）
    paying: false,      // 正在拉起收银台 / 等微信回调
    expired: false,     // 超时未付（服务端会把单自动取消）
    noPayConfig: false, // 店里没开通在线支付（服务端 503）
    amountText: '',     // ¥6.00（服务端整数分换算）
    countText: '',      // 共 2 件（拿得到订单就显示）
    leftText: '',       // 还剩 04:32
    expireAt: 0,
    failMsg: '',        // 失败原因（取消 → 「你取消了支付」）
    transactionId: ''   // 微信支付单号（对账用）
  },

  onLoad(q) {
    this.setData({ orderId: String((q && q.orderId) || '') })
  },

  onShow() {
    // 「支付成功 → 查看订单 → 返回」时只是刷一下，绝不再拉起一次收银台
    if (this.data.paid) return Promise.resolve(null)
    return this.boot()
  },

  onUnload() { this.stopTick() },
  onHide() { this.stopTick() },

  // 进入收银台的完整流程：订单号 → 登录态 → 支付态 → 未付才拉起
  boot() {
    this.stopTick()
    const id = this.data.orderId
    if (!id) {
      this.setData({ loading: false, err: '', notFoundText: '缺少订单号' })
      return Promise.resolve(null)
    }
    // 支付必须有 openid（第 29 轮红线）：没登录不发起任何支付请求
    const sess = api.session() || {}
    if (!sess.openid) {
      this.setData({ loading: false, needLogin: true, err: '', notFoundText: '' })
      this.warn('请先用微信登录，下单后可直接支付')
      return Promise.resolve(null)
    }
    this.setData({ loading: true, err: '', notFoundText: '', needLogin: false, noPayConfig: false, failMsg: '' })
    return api.probe().then((st) => {
      this.setData({ online: !!st.online })
      if (!st.online) {
        this.setData({ loading: false, err: ui.NET_HINT })
        return null
      }
      // 第 31 轮（payEnabled）：先把 /api/settings 拉回来（拿不到 = 未开通），
      // 后面要用它决定能不能拉起收银台 —— 支付没开通时绝不弹窗催款。
      return api.getSettings().catch(() => null).then(() => {
        // 订单详情只用来补「金额 / 件数」展示，拿不到也不挡支付
        const orderP = api.getOrder(id).catch(() => null)
        return api.payStatus(id).then((s) => {
          return orderP.then((o) => {
            this.applyOrder(o)
            this.applyStatus(s)
            if (s.paid || this.data.expired) return null
            // 没开通在线支付：不自动拉起、也不打 prepay，直接摆「店里还没开通」
            if (!api.payEnabled()) {
              this.setData({ paying: false, noPayConfig: true, failMsg: '' })
              return null
            }
            return this.autoPay()
          })
        }, (e) => {
          this.setData({ loading: false, err: ui.errText(e) })
          return null
        })
      })
    })
  },

  // 失败卡 / 超时卡上的「重新加载」：身份、支付态全部重新问一遍
  reload() {
    this._autoTried = false
    return this.boot()
  },

  applyOrder(o) {
    if (!o) return
    const n = Number(o.count) || 0
    this.setData({
      amountText: o.totalText ? '¥' + o.totalText : this.data.amountText,
      countText: n > 0 ? '共 ' + n + ' 件' : ''
    })
  },

  // 服务端支付态 → 页面状态
  applyStatus(s) {
    const v = s || {}
    const payView = { status: v.status || 'pending', paid: v.paid, paidKnown: true, payExpireAt: v.expireAt }
    // 未付 + 已取消（超时未付被服务端取消 / 顾客自己取消）都按「不能再付」处理
    const dead = !v.paid && (rules.payExpired(payView) || v.status === 'cancelled')
    this.setData({
      paid: !!v.paid,
      transactionId: v.transactionId || '',
      expired: !!dead,
      loading: false
    })
    if (v.paid) {
      this.stopTick()
      this.setData({ leftText: '', failMsg: '' })
      wx.setNavigationBarTitle({ title: '支付成功' })
      return
    }
    if (dead) {
      this.stopTick()
      this.setData({ leftText: '', failMsg: '' })
      return
    }
    this.startTick(v.expireAt)
  },

  /* ---------------- 倒计时 ---------------- */
  startTick(expireAt) {
    this.stopTick()
    const exp = Number(expireAt) || 0
    this.setData({ expireAt: exp })
    if (!exp) return
    this.tick()
    this._timer = setInterval(() => this.tick(), 1000)
  },

  tick() {
    const exp = this.data.expireAt
    if (!exp) return
    const left = rules.payLeftSeconds({ payExpireAt: exp })
    if (left <= 0) {
      // 到点就停：不再自动重试，也不许按钮继续拉起
      this.stopTick()
      this.setData({ leftText: '', expired: true, failMsg: '' })
      return
    }
    this.setData({ leftText: '还剩 ' + rules.payLeftText({ payExpireAt: exp, paid: false }) })
  },

  stopTick() {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
  },

  /* ---------------- 支付 ---------------- */
  // 自动拉起：整个页面实例只来一次（failed/cancel 后走「重新支付」按钮）
  autoPay() {
    if (this._autoTried) return Promise.resolve(null)
    this._autoTried = true
    return this.pay()
  },

  // 按钮：重新支付
  retry() {
    if (this.data.expired || this.data.noPayConfig) return Promise.resolve(null)
    this._autoTried = true
    return this.pay()
  },

  pay() {
    if (this.data.paying || this.data.expired || this.data.noPayConfig) return Promise.resolve(null)
    // 第 31 轮（payEnabled）：兜底再确认一次 —— 店铺没开通在线支付时连 prepay 都不该发出去
    // （按钮本来就藏了，这里是防「状态被别处改过」时的第二道闸）
    if (!api.payEnabled()) {
      this.setData({ paying: false, noPayConfig: true, failMsg: '' })
      return Promise.resolve(null)
    }
    const id = this.data.orderId
    this.setData({ paying: true, failMsg: '' })
    return api.prepay(id).then((d) => {
      // 金额以 prepay 下发的整数分为准（比订单总额更权威：这就是要付的钱）
      if (d.amountText) this.setData({ amountText: d.amountText })
      if (d.expireAt) this.startTick(d.expireAt)
      return api.requestPayment(d.payParams).then(() => {
        // 微信侧已经扣款：先把话说满，再异步对一次账（回调可能晚几秒到）
        this.stopTick()
        this.setData({ paying: false, paid: true, failMsg: '', leftText: '' })
        wx.setNavigationBarTitle({ title: '支付成功' })
        this.confirmPaid(id)
        return true
      }, (e) => {
        // 取消 / 失败：留在本页，显示原因 + 「重新支付」
        this.setData({ paying: false, failMsg: ui.errText(e) })
        return false
      })
    }, (e) => {
      if (e && e.noPayConfig) {
        this.setData({ paying: false, noPayConfig: true, failMsg: '' })
        return false
      }
      this.setData({ paying: false, failMsg: ui.errText(e) })
      return false
    })
  },

  // 支付成功后对账一次：拿到微信支付单号就展示（拿不到也不算失败，钱在微信那边）
  confirmPaid(id) {
    return api.payStatus(id).then((s) => {
      if (s && s.paid) this.setData({ transactionId: s.transactionId || '' })
      return s
    }).catch(() => null)
  },

  /* ---------------- 跳转 ---------------- */
  goOrder() {
    wx.navigateTo({ url: '/pages/order/order?id=' + encodeURIComponent(this.data.orderId) })
    return null
  },

  goLogin() {
    wx.switchTab({ url: '/pages/mine/mine' })
    return null
  },

  warn(msg) {
    if (typeof wx !== 'undefined' && wx.showToast) wx.showToast({ title: msg, icon: 'none', duration: 2500 })
    return null
  }
})

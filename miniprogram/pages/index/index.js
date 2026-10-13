// 首页：商品列表 + 分类 + 加购
const api = require('../../utils/api.js')
const store = require('../../utils/store.js')

Page({
  data: {
    online: false,
    statusLabel: '⏳ 正在探测后端…',
    statusDetail: '',
    keyword: '',
    category: '全部',
    categories: ['全部', '饮料', '酒水', '乳品', '零食', '日用', '其他'],
    products: [],
    cartCount: 0,
    cartAmountText: '0.00'
  },

  onShow() {
    return this.refresh()
  },

  onPullDownRefresh() {
    this.refresh().then(() => {
      if (typeof wx !== 'undefined' && wx.stopPullDownRefresh) wx.stopPullDownRefresh()
    })
  },

  // 探测后端 → 拉商品 → 刷新购物车角标
  refresh() {
    this._all = []
    return getApp()
      .refreshStatus()
      .then((st) => {
        this.setData({ online: st.online, statusLabel: st.label, statusDetail: st.detail })
        return this.load()
      })
      .then(() => this.refreshCart())
  },

  load() {
    return api
      .listProducts(this.data.keyword)
      .then((list) => {
        this._all = list
        this.setData({ products: this.applyCategory(list) })
        return list
      })
      .catch((e) => {
        this._all = []
        this.setData({ products: [] })
        if (typeof wx !== 'undefined' && wx.showToast) wx.showToast({ title: e.message, icon: 'none' })
        return []
      })
  },

  applyCategory(list) {
    const c = this.data.category
    if (c === '全部') return list
    return list.filter((p) => p.category === c)
  },

  refreshCart() {
    this.setData({
      cartCount: store.cartCount(),
      cartAmountText: store.cartAmount().toFixed(2)
    })
  },

  onKeyword(e) {
    this.setData({ keyword: e.detail.value })
  },
  onSearch() {
    this.load()
  },
  onCategory(e) {
    this.setData({ category: e.currentTarget.dataset.cat })
    this.setData({ products: this.applyCategory(this._all || []) })
  },
  // 扫码找货（D8 扫码只读）：识别条码 → 查后端条码库 → 把结果填进搜索框筛出来。
  // 绝不改库存、绝不自动加购；认不出的条码也原样填进去，让老板人工看。
  onScan() {
    if (typeof wx === 'undefined' || typeof wx.scanCode !== 'function') {
      this._toast('当前环境不支持扫码')
      return Promise.resolve(null)
    }
    return new Promise((resolve) => {
      wx.scanCode({
        onlyFromCamera: false,
        scanType: ['barCode', 'qrCode'],
        success: (res) => resolve(res && res.result ? String(res.result).trim() : ''),
        fail: () => resolve('')
      })
    }).then((code) => {
      if (!code) return null
      return api
        .resolveBarcode(code)
        .catch(() => ({ code: code, found: false, source: 'error' }))
        .then((hit) => {
          const found = !!(hit && hit.found)
          const kw = found && hit.name ? hit.name : code
          this.setData({ keyword: kw, category: '全部' })
          this._toast(found ? '已找到：' + hit.name : '条码未建档，可拿给老板看')
          return this.load().then(() => hit)
        })
    })
  },

  _toast(title) {
    if (typeof wx !== 'undefined' && wx.showToast) wx.showToast({ title: title, icon: 'none' })
  },

  onAdd(e) {
    const code = e.currentTarget.dataset.code
    const p = (this._all || []).filter((x) => x.code === code)[0]
    if (!p) return
    if (p.stock <= 0) {
      if (typeof wx !== 'undefined' && wx.showToast) wx.showToast({ title: '库存不足，到店问老板', icon: 'none' })
      return
    }
    store.addToCart(p, 1)
    this.refreshCart()
    if (typeof wx !== 'undefined' && wx.showToast) wx.showToast({ title: '已加入购物车', icon: 'success' })
  },
  goCart() {
    if (typeof wx !== 'undefined' && wx.switchTab) wx.switchTab({ url: '/pages/cart/cart' })
  }
})

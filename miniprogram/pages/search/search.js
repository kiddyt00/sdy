// 搜索页（第 24 轮新增）：历史词（≤10、去重）+ 热门词 + 300ms 防抖 + 结果网格
const api = require('../../utils/api.js')
const store = require('../../utils/store.js')
const config = require('../../utils/config.js')
const ui = require('../common/ui.js')

const HIST_KEY = 'sdy_mp_search_history'
const HIST_MAX = 10
const DEFAULT_HOT = ['可乐', '雪碧', '啤酒', '牛奶', '抽纸', '矿泉水', '薯片']

function readHist() {
  try {
    const v = wx.getStorageSync(HIST_KEY)
    return Array.isArray(v) ? v : []
  } catch (e) {
    return []
  }
}

Page({
  data: {
    keyword: '',
    hist: [],
    hot: DEFAULT_HOT,
    results: [],
    searched: false,
    loading: false,
    empty: false,
    loadErr: '',
    online: false,
    cartCount: 0,
    // 第 27 轮 P0-9：低库存阈值由服务端 settings 下发（api.lowStock 兜底 5）
    lowStock: 5
  },

  onLoad() {
    this.setData({ hist: readHist(), lowStock: api.lowStock() })
    // 第 27 轮 P0-2：搜索结果里加购 / 别处加购，角标和计数都要跟着变
    this._unsub = store.subscribe(() => this.syncCart())
    this.syncCart()
    // 热门词优先用店铺的真实分类，接口不通就退回默认词
    api.listCategories().then((cs) => {
      const names = (cs || []).map((c) => c.name).filter((n) => n && n !== '未分类')
      if (names.length) this.setData({ hot: names.slice(0, 8) })
    }).catch(() => {})
  },

  onUnload() {
    if (this._unsub) this._unsub()
  },

  syncCart() {
    this.setData({ cartCount: store.cartCount() })
  },

  onShow() {
    api.probe().then((st) => this.setData({ online: !!st.online }))
  },

  // 输入防抖：300ms 不敲字才去查（参考项目里没做，翻页会抖）
  onInput(e) {
    this.setData({ keyword: e.detail.value })
    if (this._t) clearTimeout(this._t)
    this._t = setTimeout(() => this.doSearch(false), 300)
  },

  onConfirm() {
    if (this._t) clearTimeout(this._t)
    return this.doSearch(true)
  },

  onClear() {
    this.setData({ keyword: '', results: [], searched: false, empty: false })
    return null
  },

  tapWord(e) {
    this.setData({ keyword: e.currentTarget.dataset.w })
    return this.doSearch(true)
  },

  doSearch(save) {
    const kw = String(this.data.keyword || '').trim()
    if (!kw) {
      this.setData({ results: [], searched: false, empty: false, loadErr: '' })
      return Promise.resolve([])
    }
    this.setData({ loading: true, loadErr: '' })
    return api.listProducts(kw, '').then((list) => {
      this.setData({
        results: list,
        searched: true,
        loading: false,
        empty: list.length === 0,
        loadErr: ''
      })
      if (save) this.pushHist(kw)
      return list
    }, (e) => {
      // 第 27 轮 P0-1：搜索失败 ≠ 「没找到这件商品」，给错误卡 + 「重新加载」
      this.setData({ loading: false, searched: true, empty: false, results: [], loadErr: ui.errText(e) })
      return []
    })
  },

  // 错误卡上的「重新加载」：按当前关键词真正重查一次（不再重复记历史词）
  reload() {
    return this.doSearch(false)
  },

  // 第 27 轮 P0-7：搜索结果里直接加购（缺货按钮不可用，数量上限看库存）
  onAdd(e) {
    const code = e.currentTarget.dataset.code
    const p = (this.data.results || []).filter((x) => String(x.code) === String(code))[0]
    if (!p) return null
    if (p.stock <= 0) {
      wx.showToast({ title: '这件暂时没货', icon: 'none' })
      return null
    }
    const have = store.cartStock(p.code)
    if (have + 1 > p.stock) {
      wx.showToast({ title: '最多只能买 ' + p.stock + (p.unit || '件'), icon: 'none' })
      return null
    }
    store.addToCart(p, 1)
    this.syncCart()
    wx.showToast({ title: '已加入购物车', icon: 'success' })
    return null
  },

  pushHist(kw) {
    const list = [kw].concat(readHist().filter((x) => x !== kw)).slice(0, HIST_MAX)
    try {
      wx.setStorageSync(HIST_KEY, list)
    } catch (e) { /* 忽略 */ }
    this.setData({ hist: list })
  },

  clearHist() {
    try {
      wx.removeStorageSync(HIST_KEY)
    } catch (e) { /* 忽略 */ }
    this.setData({ hist: [] })
  },

  goDetail(e) {
    const code = e.currentTarget.dataset.code
    if (!code) return
    wx.navigateTo({ url: '/pages/goods/goods?code=' + encodeURIComponent(code) })
  },

  goIndex() {
    wx.switchTab({ url: '/pages/index/index' })
  },

  goCart() {
    wx.switchTab({ url: '/pages/cart/cart' })
  }
})

// 搜索页（第 24 轮新增；第 28 轮加排序 / 分页 / 无结果推荐热销）
// 历史词（≤10、去重）+ 热门词 + 300ms 防抖 + 结果网格 + 综合/销量/价格排序 + 触底翻页
const api = require('../../utils/api.js')
const store = require('../../utils/store.js')
const config = require('../../utils/config.js')
const ui = require('../common/ui.js')

const HIST_KEY = 'sdy_mp_search_history'
const HIST_MAX = 10
const DEFAULT_HOT = ['可乐', '雪碧', '啤酒', '牛奶', '抽纸', '矿泉水', '薯片']
// 第 28 轮契约 7.8：防抖 300ms、分页 limit=20、排序值逐字相同
const DEBOUNCE_MS = 300
const PAGE_SIZE = 20
const SORTS = [
  { v: 'default', t: '综合' },
  { v: 'hot', t: '销量' },
  { v: 'price_asc', t: '价格↑' },
  { v: 'price_desc', t: '价格↓' }
]

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
    emptyText: '',
    recs: [],            // 无结果时的热销 6 件（契约 7.8）
    loadErr: '',
    online: false,
    cartCount: 0,
    // 第 28 轮：排序 + 分页
    sort: 'default',
    sorts: SORTS,
    total: 0,
    hasMore: false,
    loadingMore: false,
    moreErr: '',
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
    if (this._t) clearTimeout(this._t)
    if (this._unsub) this._unsub()
  },

  syncCart() {
    this.setData({ cartCount: store.cartCount() })
  },

  onShow() {
    api.probe().then((st) => this.setData({ online: !!st.online }))
  },

  // 输入防抖 300ms：防抖期间不发请求（连打 5 个字符只发 1 次）；同一关键词不清空已有结果
  onInput(e) {
    this.setData({ keyword: e.detail.value })
    if (this._t) clearTimeout(this._t)
    this._t = setTimeout(() => { this._t = null; this.doSearch(false) }, DEBOUNCE_MS)
  },

  onConfirm() {
    if (this._t) { clearTimeout(this._t); this._t = null }
    return this.doSearch(true)
  },

  // 排序切换：值逐字 default|hot|price_asc|price_desc，切了就从第一页重查
  onSort(e) {
    const s = String((e.currentTarget.dataset.sort) || '').trim()
    if (!s || s === this.data.sort) return Promise.resolve(this.data.results)
    this.setData({ sort: s })
    return this.doSearch(false)
  },

  onClear() {
    this.setData({
      keyword: '', results: [], searched: false, empty: false, emptyText: '',
      recs: [], loadErr: '', total: 0, hasMore: false, loadingMore: false, moreErr: ''
    })
    return null
  },

  tapWord(e) {
    this.setData({ keyword: e.currentTarget.dataset.w })
    return this.doSearch(true)
  },

  // 一页商品；传 opts 才走第 28 轮分页契约（返回 {items,total,hasMore}）
  fetchPage(kw, offset) {
    return api.listProducts(kw, '', { sort: this.data.sort, limit: PAGE_SIZE, offset: offset })
  },

  doSearch(save) {
    const kw = String(this.data.keyword || '').trim()
    if (!kw) {
      this.setData({
        results: [], searched: false, empty: false, emptyText: '', recs: [],
        loadErr: '', total: 0, hasMore: false, loading: false, loadingMore: false, moreErr: ''
      })
      return Promise.resolve([])
    }
    this.setData({ loading: true, loadErr: '', moreErr: '' })
    return this.fetchPage(kw, 0).then((page) => {
      const items = (page && page.items) || []
      this.setData({
        results: items,
        total: page && page.total !== undefined ? page.total : items.length,
        hasMore: !!(page && page.hasMore),
        loading: false,
        searched: true,
        empty: items.length === 0,
        emptyText: items.length === 0 ? '没找到「' + kw + '」，换个词试试' : '',
        loadErr: ''
      })
      if (!items.length) this.loadRecs()
      else this.setData({ recs: [] })
      if (save) this.pushHist(kw)
      return items
    }, (e) => {
      // 第 27 轮 P0-1：搜索失败 ≠ 「没找到这件商品」，给错误卡 + 「重新加载」
      this.setData({
        loading: false, searched: true, empty: false, emptyText: '', recs: [],
        results: [], total: 0, hasMore: false, loadErr: ui.errText(e)
      })
      return []
    })
  },

  // 无结果时推荐热销 6 件（接口失败就安静不显示，不冒充「有推荐」）
  loadRecs() {
    return api.hotProducts(6).then((d) => {
      this.setData({ recs: (d && d.items) || [] })
      return this.data.recs
    }, () => {
      this.setData({ recs: [] })
      return []
    })
  },

  // 触底翻页：offset 递增；hasMore=false 后不再发请求
  onReachBottom() {
    return this.loadMore()
  },

  loadMore() {
    if (this.data.loading || this.data.loadingMore || !this.data.hasMore) return Promise.resolve([])
    const kw = String(this.data.keyword || '').trim()
    if (!kw) return Promise.resolve([])
    const off = (this.data.results || []).length
    this.setData({ loadingMore: true, moreErr: '' })
    return this.fetchPage(kw, off).then((page) => {
      const items = (this.data.results || []).concat((page && page.items) || [])
      this.setData({
        results: items,
        total: page && page.total !== undefined ? page.total : items.length,
        hasMore: !!(page && page.hasMore),
        loadingMore: false,
        empty: false
      })
      return items
    }, (e) => {
      this.setData({ loadingMore: false, moreErr: ui.errText(e) })
      return []
    })
  },

  // 错误卡上的「重新加载」：按当前关键词真正重查一次（不再重复记历史词）
  reload() {
    return this.doSearch(false)
  },

  // 第 27 轮 P0-7：搜索结果里直接加购（缺货按钮不可用，数量上限看库存）
  // 无结果推荐的热销商品也走同一个入口，点「＋」能加购
  onAdd(e) {
    const code = e.currentTarget.dataset.code
    const pool = (this.data.results || []).concat(this.data.recs || [])
    const p = pool.filter((x) => String(x.code) === String(code))[0]
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

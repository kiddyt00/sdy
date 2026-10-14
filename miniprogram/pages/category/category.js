// 分类页（第 24 轮新增）：左侧分类栏 + 右侧商品列表
// 第 28 轮：右侧加排序切换 / 触底分页（limit=20 + hasMore），下拉刷新真正重新拉数据
const api = require('../../utils/api.js')
const store = require('../../utils/store.js')
const ui = require('../common/ui.js')

// 第 28 轮契约 7.8：分页统一 limit=20&offset=n；排序值逐字 default|hot|price_asc|price_desc
const PAGE_SIZE = 20
const PICK_KEY = 'sdy_mp_cat_pick'
const SORTS = [
  { v: 'default', t: '综合' },
  { v: 'hot', t: '销量' },
  { v: 'price_asc', t: '价格↑' },
  { v: 'price_desc', t: '价格↓' }
]

Page({
  data: {
    cats: [],
    cat: '',
    catIndex: 0,
    products: [],
    loading: true,
    online: false,
    empty: false,
    loadErr: '',
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
    // 第 27 轮 P0-2：分类页原来是个「角标漏同步」的入口——
    // 在首页 / 详情页加购后切回来，这里的计数还是旧的。改成订阅 store 广播。
    this._off = store.subscribe(() => this.syncCart())
  },

  onUnload() {
    if (this._off) this._off()
  },

  onShow() {
    this.setData({ lowStock: api.lowStock() })
    this.syncCart()
    // 第 28 轮：首页金刚区点分类过来——tabBar 页不能带 query，用 storage 手递一次
    try {
      const pick = String(wx.getStorageSync(PICK_KEY) || '').trim()
      if (pick) {
        wx.removeStorageSync(PICK_KEY)
        this._pick = pick
        this.setData({ cat: pick })
      }
    } catch (e) { /* 存储不可用时按默认分类走 */ }
    return api.probe().then((st) => {
      this.setData({ online: !!st.online })
      return this.load()
    })
  },

  // 第 28 轮：下拉刷新真的重新拉数据（category.json 已打开 enablePullDownRefresh）
  onPullDownRefresh() {
    return api.probe().then(() => this.load())
      .then(() => wx.stopPullDownRefresh(), () => wx.stopPullDownRefresh())
  },

  // 分类列表来自 listCategories；右侧商品按「每页 20 条」服务端分页拉
  load() {
    this.setData({ loading: true, loadErr: '', moreErr: '' })
    return api.listCategories().catch(() => null).then((cs) => {
      if (cs && cs.length) {
        const cat = this.pickCat(cs)
        this._pick = ''
        return this.fetchFirst(cat, cs)
      }
      // 分类接口不通：先拉「全部」第一页，按商品自身的 category 现场归类（口径与后端一致）
      return api.listProducts('', '', { sort: this.data.sort, limit: PAGE_SIZE, offset: 0 }).then((page) => {
        const items = (page && page.items) || []
        const cats = this.deriveCats(items)
        const want = this.pickCat(cats)
        this._pick = ''
        if (want) return this.fetchFirst(want, cats)
        return this.applyPage('', cats, page)
      }, (e) => this.failLoad(e))
    })
  },

  // 选中分类：首页金刚区指定 > 当前分类 > 第一个分类
  pickCat(cats) {
    const names = (cats || []).map((c) => c.name)
    if (names.indexOf(this.data.cat) >= 0) return this.data.cat
    if (this._pick && names.indexOf(this._pick) >= 0) return this._pick
    return names.length ? names[0] : ''
  },

  fetchFirst(cat, cats) {
    return api.listProducts('', cat, { sort: this.data.sort, limit: PAGE_SIZE, offset: 0 })
      .then((page) => this.applyPage(cat, cats, page), (e) => this.failLoad(e))
  },

  applyPage(cat, cats, page) {
    const items = (page && page.items) || []
    const list = (cats && cats.length) ? cats : this.deriveCats(items)
    const idx = Math.max(0, list.map((c) => c.name).indexOf(cat))
    this.setData({
      cats: list,
      cat: cat,
      catIndex: idx,
      products: items,
      total: (page && page.total !== undefined) ? page.total : items.length,
      hasMore: !!(page && page.hasMore),
      loading: false,
      empty: items.length === 0,
      loadErr: ''
    })
    return items
  },

  failLoad(e) {
    // 第 27 轮 P0-1：失败 ≠ 「这个分类还没上架商品」，给错误卡 + 「重新加载」
    this.setData({
      cats: [], cat: '', products: [], loading: false, empty: false,
      loadErr: ui.errText(e), total: 0, hasMore: false, loadingMore: false
    })
    return []
  },

  // 错误卡上的「重新加载」：真正重新发请求
  reload() {
    return this.load()
  },

  // 分类接口不通时，按商品自身的 category 现场归类（口径与后端一致：空 → 未分类）
  deriveCats(list) {
    const m = {}
    ;(list || []).forEach((p) => {
      const k = p.category || '未分类'
      m[k] = (m[k] || 0) + 1
    })
    return Object.keys(m).map((k) => ({ name: k, count: m[k] }))
  },

  onSelect(e) {
    const name = e.currentTarget.dataset.name || ''
    const idx = this.data.cats.map((c) => c.name).indexOf(name)
    this.setData({ cat: name, catIndex: idx < 0 ? 0 : idx })
    return this.fetchFirst(name, this.data.cats)
  },

  // van-sidebar：e.detail 是 index
  onSideChange(e) {
    const idx = Number((e.detail && e.detail.index) || 0) || 0
    const c = this.data.cats[idx] || { name: '' }
    this.setData({ cat: c.name, catIndex: idx })
    return this.fetchFirst(c.name, this.data.cats)
  },

  // 排序切换：切了就从第一页重拉（左侧分类不变）
  onSort(e) {
    const s = String((e.currentTarget.dataset.sort) || '').trim()
    if (!s || s === this.data.sort) return Promise.resolve(this.data.products)
    this.setData({ sort: s })
    return this.fetchFirst(this.data.cat, this.data.cats)
  },

  // 触底分页：offset 递增；hasMore=false 后不再发请求
  onLower() {
    return this.loadMore()
  },

  onReachBottom() {
    return this.loadMore()
  },

  loadMore() {
    if (this.data.loading || this.data.loadingMore || !this.data.hasMore) return Promise.resolve([])
    const off = (this.data.products || []).length
    this.setData({ loadingMore: true, moreErr: '' })
    return api.listProducts('', this.data.cat, { sort: this.data.sort, limit: PAGE_SIZE, offset: off }).then((page) => {
      const items = (this.data.products || []).concat((page && page.items) || [])
      this.setData({
        products: items,
        total: (page && page.total !== undefined) ? page.total : items.length,
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

  onAdd(e) {
    const code = e.currentTarget.dataset.code
    const p = (this.data.products || []).filter((x) => x.code === code)[0]
    if (!p) return null
    if (p.stock <= 0) {
      wx.showToast({ title: '这件暂时没货', icon: 'none' })
      return null
    }
    // 第 27 轮 P0-6：数量上限 = 该商品库存
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

  goDetail(e) {
    const code = e.currentTarget.dataset.code
    if (!code) return
    wx.navigateTo({ url: '/pages/goods/goods?code=' + encodeURIComponent(code) })
  },

  goCart() {
    wx.switchTab({ url: '/pages/cart/cart' })
  },

  goSearch() {
    wx.navigateTo({ url: '/pages/search/search' })
  },

  syncCart() {
    this.setData({ cartCount: store.cartCount() })
  },

  onShareAppMessage() {
    return { title: '啥都有快送 · 分类', path: '/pages/category/category' }
  }
})

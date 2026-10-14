// 分类页（第 24 轮新增）：左侧分类栏 + 右侧商品列表
const api = require('../../utils/api.js')
const store = require('../../utils/store.js')
const ui = require('../common/ui.js')

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
    return api.probe().then((st) => {
      this.setData({ online: !!st.online })
      return this.load()
    })
  },

  onPullDownRefresh() {
    return api.probe().then(() => this.load())
      .then(() => wx.stopPullDownRefresh(), () => wx.stopPullDownRefresh())
  },

  // 商品只拉一次（全量在售），分类和筛选都在本地做：切分类不再打网络
  load() {
    this.setData({ loading: true, loadErr: '' })
    return api.listProducts('', '').then((list) => {
      this._all = list || []
      return api.listCategories().catch(() => null).then((cs) => {
        const cats = (cs && cs.length) ? cs : this.deriveCats(this._all)
        let cat = this.data.cat
        if (!cats.some((c) => c.name === cat)) cat = cats.length ? cats[0].name : ''
        const idx = Math.max(0, cats.map((c) => c.name).indexOf(cat))
        this.setData({ cats: cats, cat: cat, catIndex: idx, loadErr: '' })
        this.applyProducts(cat)
        return cats
      })
    }, (e) => {
      // 第 27 轮 P0-1：失败 ≠ 「这个分类还没上架商品」，给错误卡 + 「重新加载」
      this._all = []
      this.setData({ cats: [], cat: '', products: [], loading: false, empty: false, loadErr: ui.errText(e) })
      return []
    })
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

  applyProducts(cat) {
    const list = (this._all || []).filter((p) => !cat || (p.category || '未分类') === cat)
    this.setData({ products: list, loading: false, empty: list.length === 0 })
    return list
  },

  onSelect(e) {
    const name = e.currentTarget.dataset.name || ''
    const idx = this.data.cats.map((c) => c.name).indexOf(name)
    this.setData({ cat: name, catIndex: idx < 0 ? 0 : idx })
    return Promise.resolve(this.applyProducts(name))
  },

  // van-sidebar：e.detail 是 index
  onSideChange(e) {
    const idx = Number((e.detail && e.detail.index) || 0) || 0
    const c = this.data.cats[idx] || { name: '' }
    this.setData({ cat: c.name, catIndex: idx })
    return Promise.resolve(this.applyProducts(c.name))
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

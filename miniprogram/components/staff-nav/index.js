// 员工端底部导航（第 26 轮 / D32）
// 为什么不用原生 tabBar：小程序 tabBar 最多 5 项且写在 app.json 里是静态的，
// 顾客的 5 个 tab 已经占满，没有位置再塞一套员工 tab。所以员工走独立页面
// （pages/staff/*，非 tab 页）+ 这个自绘底栏：顾客那条路径一个字节都不用改。
// 切页用 redirectTo（不是 navigateTo）：员工在 5 个页面之间来回点不会越堆越深，
// 加到 10 层就点不动了。
const ITEMS = [
  { key: 'home', text: '工作台', icon: 'wap-home-o', url: '/pages/staff/home' },
  { key: 'scan', text: '扫码', icon: 'scan', url: '/pages/staff/scan' },
  { key: 'stock', text: '库存', icon: 'goods-collect-o', url: '/pages/staff/stock' },
  { key: 'orders', text: '订单', icon: 'orders-o', url: '/pages/staff/orders' },
  { key: 'mine', text: '我的', icon: 'user-o', url: '/pages/staff/mine' }
]

Component({
  properties: {
    // 当前页面的 key（home/scan/stock/orders/mine）
    active: { type: String, value: 'home' }
  },
  data: { items: ITEMS },
  methods: {
    go(e) {
      const ds = (e && e.currentTarget && e.currentTarget.dataset) || {}
      const key = ds.key || ''
      const url = ds.url || ''
      if (!url || key === this.data.active) return
      if (typeof wx !== 'undefined' && wx.redirectTo) wx.redirectTo({ url: url })
    }
  }
})

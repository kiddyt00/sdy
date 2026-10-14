// 扫码台（第 26 轮 / D32）：员工端的核心一页。
// 口径（D8）：**扫码只读**。扫到一个 69 码只会把「这是什么货 / 还有多少 / 卖多少钱 /
// 最近谁动过」摆出来；入库、出库、盘点、改价、上下架都必须员工再点一下，
// 每次动作都由服务端写库存流水（谁改的、为什么、改成多少都留痕，D25）。
const api = require('../../utils/api.js')
const staff = require('../../utils/staff.js')

const EMPTY_FORM = { name: '', brand: '', spec: '', category: '未分类', unit: '件', salePrice: '', costPrice: '', wholesalePrice: '', stock: '' }

Page({
  data: {
    code: '',
    loading: false,
    err: '',
    found: false,
    product: null,
    resolve: null,
    recent: [],
    // 第 27 轮 P0-9：阈值真源 = 服务端 settings（api.lowStock()，兜底 5），页面不再写死 5
    lowStock: api.lowStock(),
    qty: '1',
    busy: false,
    editing: false,
    form: Object.assign({}, EMPTY_FORM),
    priceSale: '',
    priceWholesale: ''
  },

  onLoad(options) {
    const code = String((options && options.code) || '').trim()
    if (code) {
      this.setData({ code: code })
      this.load(code)
    }
  },

  onShow() {
    if (!staff.ensureStaff()) return
  },

  onPullDownRefresh() {
    const c = this.data.code
    const p = c ? this.load(c) : Promise.resolve()
    p.then(() => {
      if (typeof wx !== 'undefined' && wx.stopPullDownRefresh) wx.stopPullDownRefresh()
    })
  },

  // 调起微信扫码（69 条码属于 barCode；顺手允许二维码，方便扫自制的货架码）
  doScan() {
    if (typeof wx === 'undefined' || !wx.scanCode) {
      staff.toast('当前环境不能扫码')
      return
    }
    wx.scanCode({
      onlyFromCamera: false,
      scanType: ['barCode', 'qrCode'],
      success: (r) => {
        const code = String((r && r.result) || '').trim()
        if (!code) {
          staff.toast('没扫到条码，再试一次')
          return
        }
        this.setData({ code: code })
        this.load(code)
      },
      fail: () => { /* 用户取消不提示 */ }
    })
  },
  onCodeInput(e) {
    this.setData({ code: (e.detail && e.detail.value) || '' })
  },
  search() {
    const c = String(this.data.code || '').trim()
    if (!c) {
      staff.toast('先输入或扫一个条码')
      return
    }
    this.load(c)
  },

  // 查一次：命中商品档案就显示货；没建档就把解析链给的名字规格填进建档表单
  load(code) {
    const c = String(code || '').trim()
    if (!c) return Promise.resolve(null)
    this.setData({ loading: true, err: '' })
    return api.staffScan(c).then(
      (d) => {
        const p = d && d.product ? d.product : null
        const r = d && d.resolve ? d.resolve : null
        const cur = Object.assign({}, EMPTY_FORM)
        if (!p && r) {
          cur.name = r.name || ''
          cur.spec = r.spec || ''
        }
        this.setData({
          loading: false,
          found: !!(d && d.found),
          product: p ? this.mapProduct(p) : null,
          resolve: r,
          // 第 27 轮 P0-9：扫码接口下发的 lowStock 优先，拿不到退回 api.lowStock()（兜底 5）
          lowStock: (d && Number(d.lowStock) > 0) ? Number(d.lowStock) : api.lowStock(),
          recent: ((d && d.recent) || []).map((e) => ({
            id: String(e.id || ''),
            deltaText: (Number(e.delta) > 0 ? '+' : '') + e.delta,
            after: Number(e.after) || 0,
            reason: e.reason || '',
            by: e.by || '',
            at: (e.ts || '').replace('T', ' ').slice(5, 16)
          })),
          form: p ? Object.assign({}, EMPTY_FORM, { name: cur.name }) : cur,
          priceSale: p ? String(p.salePrice == null ? '' : p.salePrice) : '',
          priceWholesale: p ? String(p.wholesalePrice == null ? '' : p.wholesalePrice) : '',
          editing: false
        })
        return d
      },
      (e) => {
        this.setData({ loading: false, err: (e && e.message) || '查询失败' })
        return null
      }
    )
  },

  mapProduct(p) {
    const n = (v) => {
      const x = Number(v)
      return isFinite(x) ? x : 0
    }
    return {
      code: String(p.code || ''),
      name: p.name || '',
      brand: p.brand || '',
      spec: p.spec || '',
      category: p.category || '未分类',
      unit: p.unit || '件',
      img: p.img || '',
      refPrice: n(p.refPrice),
      salePrice: n(p.salePrice),
      salePriceText: n(p.salePrice).toFixed(2),
      costPrice: n(p.costPrice),
      costPriceText: n(p.costPrice).toFixed(2),
      wholesalePrice: n(p.wholesalePrice),
      wholesalePriceText: n(p.wholesalePrice).toFixed(2),
      stock: n(p.stock),
      onSale: p.onSale !== false,
      isWholesale: !!p.isWholesale
    }
  },

  onQty(e) {
    this.setData({ qty: (e.detail && e.detail.value) || '' })
  },
  qtyNum() {
    const n = Number(String(this.data.qty || '').trim())
    return isFinite(n) ? n : 0
  },

  // 入库：数量必须大于 0（服务端也会挡）
  stockIn() {
    const q = this.qtyNum()
    if (!(q > 0)) {
      staff.toast('入库数量要大于 0')
      return
    }
    this.act('stock_in', q, '员工小程序入库', '入库 ' + q + ' ' + (this.data.product ? this.data.product.unit : '件') + '？')
  },
  // 出库：adjust 是增量，所以传负数
  stockOut() {
    const q = this.qtyNum()
    if (!(q > 0)) {
      staff.toast('出库数量要大于 0')
      return
    }
    this.act('adjust', -q, '员工小程序出库', '出库 ' + q + ' 件？')
  },
  // 盘点：qty 是实盘数（不是增量）
  stockTake() {
    const q = this.qtyNum()
    if (q < 0) {
      staff.toast('盘点数不能是负数')
      return
    }
    this.act('stock_take', q, '员工小程序盘点', '把库存改成盘点数 ' + q + '？')
  },

  act(kind, qty, reason, tip) {
    const p = this.data.product
    if (!p || this.data.busy) return
    staff.confirm('确认操作', tip).then((ok) => {
      if (!ok) return
      this.setData({ busy: true })
      api
        .changeStock(p.code, kind, qty, reason)
        .then(() => this.load(p.code))
        .then(() => {
          this.setData({ busy: false })
          staff.toast('已记账')
        })
        .catch((e) => {
          this.setData({ busy: false })
          staff.toast((e && e.message) || '操作失败')
        })
    })
  },

  // 上下架（D23）：只动状态，绝不碰库存
  toggleOnSale() {
    const p = this.data.product
    if (!p || this.data.busy) return
    const to = !p.onSale
    staff.confirm(to ? '重新上架' : '先下架', to ? '把「' + p.name + '」放回货架？' : '把「' + p.name + '」从商城下架？（库存不动）').then((ok) => {
      if (!ok) return
      this.setData({ busy: true })
      api
        .setOnSale([p.code], to)
        .then(() => this.load(p.code))
        .then(() => {
          this.setData({ busy: false })
          staff.toast(to ? '已上架' : '已下架')
        })
        .catch((e) => {
          this.setData({ busy: false })
          staff.toast((e && e.message) || '操作失败')
        })
    })
  },

  toggleEdit() {
    this.setData({ editing: !this.data.editing })
  },
  onPriceSale(e) {
    this.setData({ priceSale: (e.detail && e.detail.value) || '' })
  },
  onPriceWholesale(e) {
    this.setData({ priceWholesale: (e.detail && e.detail.value) || '' })
  },
  // 改价：服务端 upsert 是覆盖式的，所以现有字段一个都不能少（尤其 img / 批发价），
  // 否则会被空值覆盖掉（第 25 轮踩过的坑）。
  savePrice() {
    const p = this.data.product
    if (!p) return
    const sale = Number(String(this.data.priceSale || '').trim())
    if (!(sale >= 0) || String(this.data.priceSale).trim() === '') {
      staff.toast('零售价填个数字')
      return
    }
    const whole = String(this.data.priceWholesale || '').trim() === '' ? 0 : Number(this.data.priceWholesale)
    this.setData({ busy: true })
    api
      .saveProduct({
        code: p.code,
        name: p.name,
        brand: p.brand,
        spec: p.spec,
        category: p.category,
        img: p.img,
        unit: p.unit,
        costPrice: p.costPrice,
        refPrice: p.refPrice,
        salePrice: sale,
        wholesalePrice: whole,
        isWholesale: p.isWholesale,
        stock: p.stock
      })
      .then(() => this.load(p.code))
      .then(() => {
        this.setData({ busy: false, editing: false })
        staff.toast('价格已保存')
      })
      .catch((e) => {
        this.setData({ busy: false })
        staff.toast((e && e.message) || '保存失败')
      })
  },

  // 建档表单
  onFormInput(e) {
    const f = (e.currentTarget.dataset.field) || ''
    if (!f) return
    const form = Object.assign({}, this.data.form)
    form[f] = (e.detail && e.detail.value) || ''
    this.setData({ form: form })
  },
  saveNew() {
    const f = this.data.form
    const code = String(this.data.code || '').trim()
    if (!code) {
      staff.toast('没有条码，先扫一下')
      return
    }
    if (!String(f.name || '').trim()) {
      staff.toast('商品名称必填')
      return
    }
    const sale = Number(String(f.salePrice || '').trim() || '0')
    const stockRaw = String(f.stock == null ? '' : f.stock).trim()
    const body = {
      code: code,
      name: f.name,
      brand: f.brand,
      spec: f.spec,
      category: f.category,
      unit: f.unit,
      salePrice: sale,
      costPrice: Number(String(f.costPrice || '').trim() || '0'),
      wholesalePrice: Number(String(f.wholesalePrice || '').trim() || '0')
    }
    // 库存留空就是「先不填库存」——一个字节都不发给服务端，免得把现有库存覆盖成 0（D16）
    if (stockRaw !== '') body.stock = Number(stockRaw) || 0
    this.setData({ busy: true })
    api
      .saveProduct(body)
      .then(() => this.load(code))
      .then(() => {
        this.setData({ busy: false })
        staff.toast('已建档')
      })
      .catch((e) => {
        this.setData({ busy: false })
        staff.toast((e && e.message) || '建档失败')
      })
  }
})

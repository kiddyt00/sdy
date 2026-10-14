// 编辑 / 新增收货地址（第 24 轮新增）
const api = require('../../utils/api.js')
const ui = require('../common/ui.js')

Page({
  data: {
    id: '',
    isNew: true,
    contact: '',
    address: '',
    isDefault: false,
    saving: false,
    loggedIn: true,
    loading: false,
    err: '',
    loadErr: ''
  },

  onLoad(q) {
    const id = String((q && q.id) || '')
    this.setData({ id: id, isNew: !id })
    if (id) wx.setNavigationBarTitle({ title: '编辑地址' })
    else wx.setNavigationBarTitle({ title: '新增地址' })
  },

  onShow() {
    const phone = api.boundPhone && api.boundPhone()
    if (!phone) {
      this.setData({ loggedIn: false })
      return Promise.resolve(null)
    }
    this.setData({ loggedIn: true })
    if (!this.data.id) return Promise.resolve(null)
    return this.load()
  },

  load() {
    this.setData({ loading: true, err: '', loadErr: '' })
    return api.listAddresses().then((list) => {
      const hit = (list || []).filter((a) => String(a.id) === String(this.data.id))[0]
      if (!hit) {
        this.setData({ loading: false, err: '地址不存在' })
        return null
      }
      this.setData({
        loading: false,
        contact: hit.contact,
        address: hit.address,
        isDefault: !!hit.isDefault
      })
      return hit
    }, (e) => {
      // 第 27 轮 P0-2：加载失败用人话 + 给「重新加载」，不冒充「地址不存在」
      this.setData({ loading: false, err: '', loadErr: ui.errText(e) })
      return null
    })
  },

  // 错误卡上的「重新加载」：真正重新发请求
  reload() {
    return this.load()
  },

  onContact(e) {
    this.setData({ contact: (e.detail && e.detail.value) || '' })
  },

  onAddress(e) {
    this.setData({ address: (e.detail && e.detail.value) || '' })
  },

  // van-switch：e.detail 是布尔
  onDefault(e) {
    this.setData({ isDefault: !!e.detail })
  },

  save() {
    if (this.data.saving) return Promise.resolve(null)
    const contact = String(this.data.contact || '').trim()
    const address = String(this.data.address || '').trim()
    if (!contact) {
      wx.showToast({ title: '请填写收货人', icon: 'none' })
      return Promise.resolve(null)
    }
    if (contact.length > 20) {
      wx.showToast({ title: '收货人不能超过 20 字', icon: 'none' })
      return Promise.resolve(null)
    }
    if (!address) {
      wx.showToast({ title: '请填写送货地址', icon: 'none' })
      return Promise.resolve(null)
    }
    if (address.length > 120) {
      wx.showToast({ title: '送货地址不能超过 120 字', icon: 'none' })
      return Promise.resolve(null)
    }
    this.setData({ saving: true })
    const payload = {
      contact: contact,
      address: address,
      isDefault: !!this.data.isDefault
    }
    if (this.data.id) payload.id = Number(this.data.id)
    return api.saveAddress(payload).then((r) => {
      this.setData({ saving: false })
      if (r && r.ok === false) {
        wx.showToast({ title: (r.error || '保存失败'), icon: 'none' })
        return null
      }
      wx.showToast({ title: '已保存', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 500)
      return r
    }, (err) => {
      this.setData({ saving: false })
      wx.showToast({ title: ui.errText(err) || '保存失败', icon: 'none' })
      return null
    })
  },

  goMine() {
    wx.switchTab({ url: '/pages/mine/mine' })
  }
})

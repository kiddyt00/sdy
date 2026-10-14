// 员工端公用小工具（第 26 轮 / D32）
// 五个员工页面都要做同一件事：进来先确认「这个微信号是不是员工」。
// 顾客误闯员工页面时不能白屏，也不能真的看到营业额——直接友好地送回「我的」。
const api = require('./api.js')

function toast(msg) {
  if (typeof wx !== 'undefined' && wx.showToast) wx.showToast({ title: String(msg || ''), icon: 'none' })
}

function confirm(title, content) {
  return new Promise((resolve) => {
    if (typeof wx !== 'undefined' && wx.showModal) {
      wx.showModal({
        title: title,
        content: content,
        success: (r) => resolve(!!(r && r.confirm)),
        fail: () => resolve(false)
      })
      return
    }
    resolve(true)
  })
}

// 员工身份 + 员工令牌都在才算员工（令牌是服务端签的，本地伪造不出来）
function ensureStaff() {
  if (api.isStaff() && api.staffToken()) return true
  toast('这个微信号还不是员工，请让老板在后台把角色改成员工')
  if (typeof wx !== 'undefined' && wx.switchTab) {
    setTimeout(() => wx.switchTab({ url: '/pages/mine/mine' }), 800)
  }
  return false
}

function go(url) {
  if (typeof wx !== 'undefined' && wx.redirectTo) wx.redirectTo({ url: url })
}

// 员工端统一的金额显示
function money(v) {
  const n = Number(v)
  return (isFinite(n) ? n : 0).toFixed(2)
}

module.exports = { toast: toast, confirm: confirm, ensureStaff: ensureStaff, go: go, money: money }

// 本地「假微信」服务器：只实现 jscode2session，供本地联调与验收使用（不含任何真实凭证）。
// 用法：node deploy/fake-wx.js [端口]   （默认 8097；服务端用 WX_API_BASE 指过来）
// 约定：js_code=STAFF → openid=o_int_staff；其它 js_code → o_int_<小写字母数字>
const http = require('http')
const port = Number(process.argv[2] || 8097)
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  if (u.pathname.indexOf('jscode2session') >= 0) {
    const code = u.searchParams.get('js_code') || ''
    const openid = code === 'STAFF' ? 'o_int_staff' : 'o_int_' + code.toLowerCase().replace(/[^a-z0-9]/g, '')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ openid: openid, session_key: 'sk_fake', unionid: 'u_' + openid }))
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end('{"errcode":404,"errmsg":"not found"}')
})
srv.listen(port, '127.0.0.1', () => console.log('fake wx on ' + port))

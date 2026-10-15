#!/usr/bin/env bash
# pay-check.sh —— 微信支付配置体检（只读，不改任何东西、不打印任何密钥内容）
#
# 用法（服务器上）：
#   bash deploy/pay-check.sh                 # 默认根目录 /root/sdy、服务端口 127.0.0.1:8093
#   bash deploy/pay-check.sh /root/sdy       # 指定根目录
#   bash deploy/pay-check.sh /root/sdy --url http://127.0.0.1:8094
#
# 退出码：0 = 未开通（正常，不影响下单）或已开通；1 = 配置有问题（需要修）。
#
# 为什么要这个脚本：老板把商户资料放上服务器后，靠人肉核对「序列号是不是 40 位、APIv3 密钥是不是 32 位、
# pem 权限对不对、容器里路径是不是 /app/secrets/…」很容易漏；这里一次全查，并且**不重启服务**。

set -u

ROOT="${1:-/root/sdy}"
URL="http://127.0.0.1:8093"
if [ "${2:-}" = "--url" ] && [ -n "${3:-}" ]; then URL="$3"; fi

ENVF="$ROOT/.env"
SEC="$ROOT/secrets"
PROBLEMS=0
NOTE=""

ok()    { printf '  \033[32m✔\033[0m %s\n' "$1"; }
bad()   { printf '  \033[31m✘\033[0m %s\n' "$1"; PROBLEMS=$((PROBLEMS+1)); }
warn()  { printf '  \033[33m!\033[0m %s\n' "$1"; }
info()  { printf '  · %s\n' "$1"; }
head_() { printf '\n%s\n' "$1"; }

# 取 .env 里某个变量的值（去掉 export 前缀/引号/CR），找不到就空
envval() {
  [ -f "$ENVF" ] || { echo ""; return; }
  sed -n "s/^[[:space:]]*\(export[[:space:]]\+\)\?$1[[:space:]]*=[[:space:]]*//p" "$ENVF" \
    | tail -n 1 | tr -d '\r' | sed 's/^"//; s/"$//; s/^'"'"'//; s/'"'"'$//' | sed 's/[[:space:]]*$//'
}
mask() { # 只显示长度与首尾，绝不整串打印
  local v="$1"
  [ -z "$v" ] && { echo "（空）"; return; }
  local n=${#v}
  if [ "$n" -le 6 ]; then echo "长度 $n"; else echo "长度 $n（${v:0:2}…${v: -2}）"; fi
}

printf '微信支付配置体检 · 根目录 %s · 服务 %s\n' "$ROOT" "$URL"
printf '%s\n' '（本脚本只读：不写 .env、不动 secrets、不重启容器、不打印任何密钥原文）'

head_ "一、.env 文件"
if [ ! -f "$ENVF" ]; then
  bad "$ENVF 不存在（服务端配置都在这个文件里）"
else
  ok "$ENVF 存在（权限 $(stat -c '%a %U:%G' "$ENVF" 2>/dev/null || echo '?')）"
  if grep -qE '^[[:space:]]*WXPAY_' "$ENVF"; then
    ok "已出现 WXPAY_* 配置行"
  else
    warn "没有任何 WXPAY_* 行 → 支付处于「未开通」，下单/备货/打印不受影响"
  fi
fi

head_ "二、六个必需项（缺任一项＝未开通，不会半开）"
MCHID="$(envval WXPAY_MCHID)";   SERIAL="$(envval WXPAY_SERIAL_NO)";  V3="$(envval WXPAY_API_V3_KEY)"
PRIV="$(envval WXPAY_PRIVATE_KEY_PATH)"; PLAT="$(envval WXPAY_PLATFORM_CERT_PATH)"
NOTIFY="$(envval WXPAY_NOTIFY_URL)"; APPID="$(envval WX_APPID)"; APIBASE="$(envval WXPAY_API_BASE)"

if [ -z "$MCHID" ]; then bad "WXPAY_MCHID 为空"; else
  case "$MCHID" in *[!0-9]*) bad "WXPAY_MCHID 应全是数字（当前 $(mask "$MCHID")）";;
    *) ok "WXPAY_MCHID $(mask "$MCHID")";; esac
fi

if [ -z "$SERIAL" ]; then bad "WXPAY_SERIAL_NO 为空"; else
  case "$SERIAL" in
    *[!0-9A-Fa-f]*) bad "WXPAY_SERIAL_NO 应全是十六进制（当前 $(mask "$SERIAL")）";;
    *) if [ "${#SERIAL}" -eq 40 ]; then ok "WXPAY_SERIAL_NO 40 位十六进制"
       else bad "WXPAY_SERIAL_NO 应为 40 位十六进制，当前 $(mask "$SERIAL")"; fi;;
  esac
fi

if [ -z "$V3" ]; then bad "WXPAY_API_V3_KEY 为空"; else
  if [ "${#V3}" -eq 32 ]; then ok "WXPAY_API_V3_KEY 正好 32 字节"
  else bad "WXPAY_API_V3_KEY 必须正好 32 字节，当前 $(mask "$V3")"; fi
fi

# 容器内路径（/app/...）要映射回宿主机 $ROOT/... 才能检查
hostpath() {
  case "$1" in
    /app/*) printf '%s/%s' "$ROOT" "${1#/app/}";;
    *) printf '%s' "$1";;
  esac
}

# 平台证书与微信支付公钥都接受（方案 §1.2 明确「平台证书 / 微信支付公钥」任选其一；
# server/internal/wxpay/crypto.go 的 parsePlatformPubKey 两种 PEM 都支持）。
# 只认 BEGIN CERTIFICATE 会**误报**——2026-10-15 生产用微信支付公钥（BEGIN PUBLIC KEY
# + PUB_KEY_ID_…）时就被本脚本判成 ✘，而实际上支付已开通（第五节 prepay 探针为证）。
#
# 用 `~~` 分隔「正则 | 给人看的标签」：正则本身带 `|`，不能用 `|` 当分隔符
# （踩过一次：pattern 被截成 `BEGIN (CERTIFICATE`，断言恒失败）。
for pair in "WXPAY_PRIVATE_KEY_PATH:$PRIV:BEGIN .*PRIVATE KEY~~商户私钥" \
            "WXPAY_PLATFORM_CERT_PATH:$PLAT:BEGIN (CERTIFICATE|PUBLIC KEY)~~平台证书 / 微信支付公钥"; do
  name="${pair%%:*}"; rest="${pair#*:}"; val="${rest%%:*}"; want="${rest##*:}"
  pat="${want%%~~*}"; label="${want##*~~}"
  if [ -z "$val" ]; then bad "$name 为空"; continue; fi
  case "$val" in
    /app/*) ok "$name = $val（容器内路径，正确）";;
    *) warn "$name = $val（**不是** /app/secrets/... 容器内路径，容器里可能读不到）";;
  esac
  hp="$(hostpath "$val")"
  if [ ! -f "$hp" ]; then bad "宿主机上找不到 $hp"; continue; fi
  if ! grep -qE "$pat" "$hp" 2>/dev/null; then
    bad "$hp 内容不像 $label PEM"; continue
  fi
  perm="$(stat -c '%a' "$hp" 2>/dev/null || echo '?')"
  owner="$(stat -c '%U:%G' "$hp" 2>/dev/null || echo '?')"
  if [ "$perm" = "600" ]; then ok "$hp 权限 600（$owner）"; else bad "$hp 权限应为 600，实际 $perm"; fi
done

case "$NOTIFY" in
  "") bad "WXPAY_NOTIFY_URL 为空";;
  https://*/api/pay/notify) ok "WXPAY_NOTIFY_URL 指向 /api/pay/notify";;
  *) warn "WXPAY_NOTIFY_URL = $NOTIFY（若配了支付，必须是 https 且以 /api/pay/notify 结尾）";;
esac

if [ -z "$APPID" ]; then warn "WX_APPID 为空 → 即使商户号配齐，回调的 appid 也校验不过"
else ok "WX_APPID 已设置（支付复用它做 appid 校验）"; fi
if [ -z "$APIBASE" ]; then info "WXPAY_API_BASE 为空 → 用正式域名 api.mch.weixin.qq.com（正确）"
else warn "WXPAY_API_BASE = $APIBASE（只有联调假支付时才该有值，正式环境要留空）"; fi

head_ "三、secrets 目录"
if [ -d "$SEC" ]; then
  p="$(stat -c '%a %U:%G' "$SEC" 2>/dev/null)"
  case "$p" in 700*) ok "$SEC 权限 $p";; *) bad "$SEC 权限应为 700 且属主 10001，实际 $p";; esac
  ls -1 "$SEC" 2>/dev/null | sed 's/^/  · /' || true
else
  bad "$SEC 不存在（直接跑 ./deploy/deploy.sh 会建好）"
fi

head_ "四、容器与服务"
if command -v docker >/dev/null 2>&1; then
  names="$(docker ps --format '{{.Names}}' 2>/dev/null | grep -E 'sdy-api' | tr '\n' ' ')"
  if [ -n "$names" ]; then ok "运行中的容器：$names"; else bad "没看到 sdy-api-* 容器在跑"; fi
else
  warn "本机没有 docker 命令（在服务器上跑这个脚本才能查容器）"
fi
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$URL/healthz" 2>/dev/null || true)"
code="${code:-000}"
if [ "$code" = "200" ]; then ok "$URL/healthz → 200"; else bad "$URL/healthz → $code（服务没起来就先把服务弄起来）"; fi

head_ "五、支付到底开通了没有（拿 prepay 探一下，不看密钥）"
# 一次请求同时拿到响应体与状态码（第二次请求会白跑一遍业务，没必要）
resp="$(curl -s --max-time 5 -w '\n%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' "$URL/api/pay/prepay" 2>/dev/null || true)"
pcode="$(printf '%s' "$resp" | tail -n 1 | tr -d '\r')"
pcode="${pcode:-000}"
case "$pcode" in 000|"") pcode=000;; esac
probe="$(printf '%s' "$resp" | sed '$d')"
case "$pcode" in
  503) if printf '%s' "$probe" | grep -q '微信支付未配置'; then
         NOTE="未开通"
         warn "支付**未开通**：prepay 回 503「微信支付未配置」——顾客看到「店里还没开通在线支付」，下单不受影响"
         if [ "$PROBLEMS" -gt 0 ]; then info "上面还有 $PROBLEMS 个配置问题（那份才需要修）"; fi
       else bad "prepay 回 503 但不是「未配置」文案，请查容器日志"; fi;;
  400|401|403)
    if printf '%s' "$probe" | grep -q '缺少身份\|订单'; then
      NOTE="已开通"
      ok "支付**已开通**：prepay 已进入业务校验（回 $pcode 是因为这个探测请求没带身份），说明商户号/证书/密钥都已加载"
    else bad "prepay 回 $pcode，内容不认识，请查容器日志：$probe"; fi;;
  502) bad "prepay 回 502：微信侧调用失败（证书序列号/私钥/网络/APPID 绑定有问题），容器日志会有 WARN";;
  000) bad "prepay 连不上（服务没起来？）";;
  *) bad "prepay 回 $pcode：$probe";;
esac

head_ "六、容器日志里的支付线索"
if command -v docker >/dev/null 2>&1; then
  logs="$(docker logs --tail 200 sdy-api-a 2>&1 || true)"
  if printf '%s' "$logs" | grep -q 'WARN 微信支付未启用'; then
    warn "启动日志：$(printf '%s' "$logs" | grep -m1 'WARN 微信支付未启用')"
  fi
  if printf '%s' "$logs" | grep -q '超时未付扫单已启动'; then
    ok "启动日志：$(printf '%s' "$logs" | grep -m1 '超时未付扫单已启动')"
  else
    warn "日志里没看到「超时未付扫单已启动」（旧二进制？重启一下再看）"
  fi
fi

head_ "结论"
if [ "$PROBLEMS" -gt 0 ]; then
  printf '  ✘ 发现 %d 个问题，按上面 ✘ 逐条修（改完 ./deploy/rolling-update.sh 再跑一次本脚本）\n' "$PROBLEMS"
  exit 1
fi
if [ "$NOTE" = "已开通" ]; then
  printf '  ✔ 支付已开通且配置自检通过。记得做上线自检 5 条（见 docs/支付与配送-方案与验收.md §1.11）\n'
else
  printf '  ✔ 没有配置错误。当前=未开通（缺上面列的必需项），补齐后重启即可；在此之前下单/备货/打印一切正常。\n'
fi

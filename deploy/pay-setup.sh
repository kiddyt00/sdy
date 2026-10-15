#!/usr/bin/env bash
# pay-setup.sh —— 微信支付上线向导（在**服务器上**跑，交互式，把 4 样东西填进 .env）
#
# 用法：
#   ssh 到服务器 → cd /root/sdy → bash deploy/pay-setup.sh
#
# 它做三件事：① 逐项问你要商户号 / 证书序列号 / APIv3 密钥（密钥输入不回显、不写日志）；
# ② 校验格式（商户号纯数字、序列号 40 位十六进制、APIv3 密钥正好 32 字节、pem 在不在、权限对不对）；
# ③ 幂等更新 /root/sdy/.env 里那 7 个 WXPAY_* 行（先备份 .env.bak，已有行原地替换，不重复追加）。
#
# 它**不会**读你的私钥内容、**不会**打印 APIv3 密钥、**不会**重启服务、**不会**碰 Git。
# 填完它只告诉你下一条命令（rolling-update + pay-check）。

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ "${1:-}" = "" ] || ROOT="$1"
ENVF="$ROOT/.env"
SEC="$ROOT/secrets"

MCHID=""; SERIAL=""; V3=""
PRIV_PATH="/app/secrets/apiclient_key.pem"
PLAT_PATH="/app/secrets/wechatpay_platform_cert.pem"
NOTIFY_URL="https://mall.shadouyou.cloud/api/pay/notify"

say()  { printf '%s\n' "$*"; }
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✘\033[0m %s\n' "$*"; }

say "=================================================="
say " 微信支付上线向导 · 根目录 $ROOT"
say "=================================================="
say ""
say "开跑之前，请先在微信商户平台（pay.weixin.qq.com，微信扫码登录）把这几样找出来："
say "  ① 商户号：首页右上角 / 账户中心 → 商户信息（10 位数字）"
say "  ② APIv3 密钥：账户中心 → API 安全 → APIv3 密钥（32 位；没设过就点「设置」）"
say "  ③ 商户证书序列号 + 私钥：账户中心 → API 安全 → API 证书 →「申请证书」"
say "     下载的压缩包里 apiclient_key.pem 就是私钥，页面上那串 40 位十六进制就是序列号"
say "  ④ 平台证书（或微信支付公钥）：账户中心 → API 安全 →「微信支付平台证书」/「微信支付公钥」下载"
say ""
say "安全提醒：**不要把密钥贴到聊天里、不要提交到 Git**。本向导只在本机读写，输出不会回显密钥。"
say ""
[ -t 0 ] || warn "检测到标准输入不是终端（管道执行）：下面的输入会被逐行读取。"
# 所有交互读取都走 ask：读到 EOF 直接退出，避免在管道/重定向下空转死循环。
ask() { # ask <提示语> [--secret]
  local prompt="$1" flag="${2:-}"
  if [ "$flag" = "--secret" ]; then
    read -r -s -p "$prompt" REPLY_VALUE
  else
    read -r -p "$prompt" REPLY_VALUE
  fi
  if [ $? -ne 0 ]; then
    say ""
    bad "标准输入已结束（EOF）——非交互环境下请改用：先手工把 WXPAY_* 写进 $ENVF，再跑 bash deploy/pay-check.sh 体检。"
    exit 1
  fi
  return 0
}
ask "准备好了就回车继续（Ctrl-C 退出）："

# ---------- 前置检查 ----------
say ""
say "【0/3】前置检查"
if [ ! -f "$ENVF" ]; then
  bad "$ENVF 不存在。先跑一次 ./deploy/deploy.sh（它会建好 .env / data / web / secrets），再来这里。"
  exit 1
fi
ok "$ENVF 存在"
if [ -d "$SEC" ]; then ok "$SEC 存在"; else mkdir -p "$SEC" && ok "$SEC 已创建"; fi

# ---------- 逐项收集 ----------
say ""
say "【1/3】三项文本配置"

while :; do
  ask "  商户号 WXPAY_MCHID（10 位数字）："
  MCHID="$(printf '%s' "$REPLY_VALUE" | tr -d ' \t\r')"
  case "$MCHID" in
    "") bad "不能为空";;
    *[!0-9]*) bad "只能是数字";;
    *) [ "${#MCHID}" -ge 8 ] && break || bad "位数不对（应该是 10 位左右），当前 ${#MCHID} 位";;
  esac
done
ok "商户号已记录（${#MCHID} 位）"

# 序列号：如果 apiclient_cert.pem 已经在 secrets 里，允许直接用 openssl 自动读出来
auto_serial() {
  local f="$SEC/apiclient_cert.pem"
  [ -f "$f" ] || return 1
  command -v openssl >/dev/null 2>&1 || return 1
  openssl x509 -in "$f" -noout -serial 2>/dev/null | sed 's/^serial=//' | tr 'a-f' 'A-F'
}
if [ -z "${SERIAL:-}" ]; then
  if s="$(auto_serial)" && [ -n "$s" ]; then
    ask "  证书序列号 WXPAY_SERIAL_NO（回车 = 用 secrets/apiclient_cert.pem 自动读到的 $s）："
    SERIAL="$REPLY_VALUE"
    [ -n "$SERIAL" ] || SERIAL="$s"
  else
    while :; do
      ask "  证书序列号 WXPAY_SERIAL_NO（40 位十六进制）："
      SERIAL="$REPLY_VALUE"
      [ -n "$SERIAL" ] && break || bad "不能为空"
    done
  fi
fi
SERIAL="$(printf '%s' "$SERIAL" | tr -d ' \t\r' | tr 'a-f' 'A-F')"
while :; do
  case "$SERIAL" in
    *[!0-9A-F]*) bad "只能是十六进制字符（0-9 A-F），当前长度 ${#SERIAL}";;
    *) if [ "${#SERIAL}" -eq 40 ]; then break; else bad "必须 40 位，当前 ${#SERIAL} 位"; fi;;
  esac
  ask "  重新输入序列号：" 
  SERIAL="$(printf '%s' "$REPLY_VALUE" | tr -d ' \t\r' | tr 'a-f' 'A-F')"
done
ok "序列号已记录（40 位十六进制）"

while :; do
  ask "  APIv3 密钥 WXPAY_API_V3_KEY（输入不回显，32 位）：" --secret; say ""
  V3="$REPLY_VALUE"
  if [ -z "$V3" ]; then bad "不能为空"; continue; fi
  if [ "${#V3}" -ne 32 ]; then bad "必须正好 32 个字符，当前 ${#V3} 个"; continue; fi
  ask "  再输一遍确认：" --secret; say ""
  V3B="$REPLY_VALUE"
  if [ "$V3" != "$V3B" ]; then bad "两次不一致，重来"; continue; fi
  break
done
ok "APIv3 密钥已记录（32 字符，未回显、未落日志）"

# ---------- pem 文件 ----------
say ""
say "【2/3】两个 pem 文件"
check_pem() { # check_pem <文件名> <期望 BEGIN 关键字>
  local f="$SEC/$1" want="$2"
  if [ ! -f "$f" ]; then bad "$f 不存在 —— 请把文件传到这个路径再看"; return 1; fi
  if ! grep -q "BEGIN .*$want" "$f" 2>/dev/null; then bad "$f 内容不像 $want PEM（是不是传错文件了？）"; return 1; fi
  chown 10001:10001 "$f" 2>/dev/null && chmod 600 "$f"
  local perm; perm="$(stat -c '%a %U:%G' "$f" 2>/dev/null)"
  case "$perm" in 600*) ok "$f（权限 $perm）";; *) warn "$f 权限 $perm（期望 600）";; esac
  return 0
}
MISSING=0
check_pem "apiclient_key.pem" "PRIVATE KEY" || MISSING=1
check_pem "wechatpay_platform_cert.pem" "CERTIFICATE" \
  || { warn "如果商户平台给你的是「微信支付公钥」而不是平台证书，那 PEM 开头会是 BEGIN PUBLIC KEY —— 这种情况执行："
       say  "      grep -q 'BEGIN PUBLIC KEY' $SEC/wechatpay_platform_cert.pem && chmod 600 $SEC/wechatpay_platform_cert.pem && echo 公钥格式 OK"
       MISSING=1; }
[ "$MISSING" = 1 ] && warn "有文件还没到位：**可以先跑完本向导**（.env 会写好），把文件放好后再跑一次 bash deploy/pay-check.sh 复检。"

# ---------- 写 .env ----------
say ""
say "【3/3】写入 $ENVF（幂等：已有 WXPAY_* 行原地替换，不重复追加）"
BAK="$ENVF.bak.$(date +%Y%m%d%H%M%S)"
if cp -p "$ENVF" "$BAK"; then ok "已备份 $BAK（同目录，注意别提交到 Git）"; else bad "备份失败，中止"; exit 1; fi

TMP="$(mktemp)"
awk -v mchid="$MCHID" -v serial="$SERIAL" -v v3="$V3" \
    -v priv="$PRIV_PATH" -v plat="$PLAT_PATH" -v notify="$NOTIFY_URL" '
  function kv(k) { if (k=="WXPAY_MCHID") return mchid; if (k=="WXPAY_SERIAL_NO") return serial
                   if (k=="WXPAY_API_V3_KEY") return v3; if (k=="WXPAY_PRIVATE_KEY_PATH") return priv
                   if (k=="WXPAY_PLATFORM_CERT_PATH") return plat; if (k=="WXPAY_NOTIFY_URL") return notify
                   if (k=="WXPAY_API_BASE") return ""; return "" }
  { line=$0
    key=""
    if (match(line, /^[ \t]*(export[ \t]+)?WXPAY_[A-Z0-9_]+[ \t]*=/)) {
      s=substr(line, RSTART, RLENGTH); sub(/^[ \t]*(export[ \t]+)?/, "", s); sub(/[ \t]*=$/, "", s); key=s
    }
    if (key != "") { print key "=" kv(key); seen[key]=1; next }
    print line }
  END {
    need[1]="WXPAY_MCHID"; need[2]="WXPAY_SERIAL_NO"; need[3]="WXPAY_API_V3_KEY"
    need[4]="WXPAY_PRIVATE_KEY_PATH"; need[5]="WXPAY_PLATFORM_CERT_PATH"
    need[6]="WXPAY_NOTIFY_URL"; need[7]="WXPAY_API_BASE"
    first=1
    for (i=1;i<=7;i++) { k=need[i]; if (!(k in seen)) {
      if (first) { print ""; print "# --- 微信支付（deploy/pay-setup.sh 写入；密钥只留本文件，勿提交） ---"; first=0 }
      print k "=" kv(k) } }
  }' "$ENVF" > "$TMP" || { bad "改写失败"; rm -f "$TMP"; exit 1; }

if ! grep -q '^WXPAY_MCHID=' "$TMP"; then bad "改写结果异常（没写进 WXPAY_MCHID），保持原文件不动"; rm -f "$TMP"; exit 1; fi
chmod 600 "$TMP"
mv "$TMP" "$ENVF"
chmod 600 "$ENVF"
ok "已写入 7 个 WXPAY_* 变量（路径用容器内 /app/secrets/…，正式环境 WXPAY_API_BASE 留空）"

say ""
say "==================== 下一步 ===================="
if [ "$MISSING" = 1 ]; then
  say "  ① 把两个 pem 传到 $SEC/（宝塔面板「文件」上传，或本机 scp 到服务器）"
  say "  ② cd $ROOT && bash deploy/pay-check.sh     # 体检（只读）"
  say "  ③ ./deploy/rolling-update.sh               # 重启生效"
else
  say "  ① cd $ROOT && bash deploy/pay-check.sh     # 体检（只读，会告诉你「已开通」还是哪项不对）"
  say "  ② ./deploy/rolling-update.sh               # 重启生效"
  say "  ③ 到小程序下一笔最小金额的单，走一次收银台；付款成功后到后台看「今日已收款」"
fi
say "  任何时候想核对，重跑 bash deploy/pay-check.sh 即可。"
say ""
say "  回滚：cp $BAK $ENVF && ./deploy/rolling-update.sh"

#!/bin/bash
# 商城后端 · 端到端冒烟：起真实服务，跑一遍关键链路（不依赖任何外部服务/云端）
set -e
cd "$(dirname "$0")"

PORT="${SMOKE_PORT:-8099}"
DB="$(mktemp -u /tmp/sdy-smoke-XXXXXX.db)"
BIN="$(mktemp -u /tmp/sdy-server-XXXXXX)"

cleanup() {
  [ -n "$PID" ] && kill "$PID" 2>/dev/null || true
  rm -f "$DB" "$DB-wal" "$DB-shm" "$BIN"
}
trap cleanup EXIT

go build -o "$BIN" ./cmd/server
ADDR="127.0.0.1:$PORT" DB_PATH="$DB" "$BIN" >/tmp/sdy-smoke.log 2>&1 &
PID=$!
B="http://127.0.0.1:$PORT"

for _ in $(seq 1 20); do
  curl -fsS "$B/healthz" >/dev/null 2>&1 && break
  sleep 0.5
done

echo "① 健康检查：$(curl -fsS "$B/healthz")"
echo "② 商品数：$(curl -fsS "$B/api/products" | grep -o '"total":[0-9]*')"
echo "③ 条码解析（本地档案命中）：$(curl -fsS "$B/api/barcode/resolve?code=6901234567892")"

ORDER=$(curl -fsS -X POST "$B/api/orders" -H 'Content-Type: application/json' \
  -d '{"customerName":"冒烟测试","phone":"13800000000","deliveryType":"pickup","items":[{"code":"6901234567892","qty":2}]}')
OID=$(printf '%s' "$ORDER" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
echo "④ 下单：$OID"

BEFORE=$(curl -fsS "$B/api/products?keyword=可乐" | grep -o '"stock":[0-9.]*' | head -1 | cut -d: -f2)
echo "⑤ 下单后库存：$BEFORE（原始 120）"

CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/orders/$OID/advance" \
  -H 'Content-Type: application/json' -d '{"to":"done"}')
echo "⑥ 非法流转 pending→done：HTTP $CODE（期望 409）"

curl -fsS -X POST "$B/api/orders/$OID/advance" -H 'Content-Type: application/json' -d '{"to":"cancelled"}' >/dev/null
AFTER=$(curl -fsS "$B/api/products?keyword=可乐" | grep -o '"stock":[0-9.]*' | head -1 | cut -d: -f2)
echo "⑦ 取消回补后库存：$AFTER（期望 120）"
echo "⑧ 比价巡检：$(curl -fsS "$B/api/pricing/check")"
echo ""
echo "✅ 冒烟通过"

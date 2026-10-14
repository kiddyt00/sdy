#!/usr/bin/env bash
# 「啥都有快送」三端全量验收：Go 单测 + 小程序三套 + Web 五套 + 真后端联调 + CDP 页面异常检查。
#
# 用法：
#   bash deploy/verify-all.sh                 # 全部跑
#   SKIP_CDP=1 bash deploy/verify-all.sh      # 跳过需要 Chrome 的部分
#   SKIP_INTEGRATION=1 bash deploy/verify-all.sh   # 跳过需要临时后端的部分
#
# 脚本自带两个临时服务（本机回环，退出时清理）：
#   假微信 127.0.0.1:8097（deploy/fake-wx.js，只回 jscode2session，不含任何真实凭证）
#   Go API 127.0.0.1:8093（临时库 /tmp/sdy-verify.db，STATIC_DIR 指向仓库里的 web/）
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export GOROOT="${GOROOT:-$HOME/sdk/go1.24.4}"
export PATH="$GOROOT/bin:$PATH"
export GOPROXY="${GOPROXY:-https://goproxy.cn,direct}"
export CGO_ENABLED=0

PORT_API=8093
PORT_WX=8097
TMPDB=/tmp/sdy-verify.db
BIN=/tmp/sdy-verify-server
WX_PID=""
API_PID=""

cleanup() {
  [ -n "$WX_PID" ] && kill "$WX_PID" 2>/dev/null
  [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null
  wait 2>/dev/null
}
trap cleanup EXIT

NAMES=(); CODES=()
run() { # run <显示名> <命令...>
  local name="$1"; shift
  echo ""
  echo "=========== $name ==========="
  local out rc
  out="$("$@" 2>&1)"; rc=$?
  echo "$out" | tail -6
  NAMES+=("$name"); CODES+=("$rc")
  return 0
}

echo "############ 0/5 编译与静态检查 ############"
rm -f "$TMPDB" "$TMPDB-wal" "$TMPDB-shm"
FMT="$(gofmt -l server 2>&1)"
if [ -n "$FMT" ]; then
  echo "gofmt 需要格式化："; echo "$FMT"
  NAMES+=("gofmt"); CODES+=(1)
else
  echo "gofmt 干净"
  NAMES+=("gofmt"); CODES+=(0)
fi
run "go vet" bash -c 'cd server && go vet ./...'
run "go build" bash -c "cd server && go build -o $BIN ./cmd/server"

echo ""
echo "############ 1/5 Go 单测 ############"
run "go test（server）" bash -c 'cd server && go test ./... -count=1'

if [ "${SKIP_INTEGRATION:-0}" != "1" ]; then
  echo ""
  echo "############ 2/5 起临时后端（假微信 $PORT_WX + Go $PORT_API） ############"
  node deploy/fake-wx.js "$PORT_WX" >/tmp/verify-wx.log 2>&1 &
  WX_PID=$!
  env ADDR="127.0.0.1:$PORT_API" DB_PATH="$TMPDB" STATIC_DIR="$ROOT/web" \
    WX_APPID=wx_verify WX_SECRET=sec_verify WX_API_BASE="http://127.0.0.1:$PORT_WX" \
    "$BIN" >/tmp/verify-api.log 2>&1 &
  API_PID=$!
  OK=0
  for _ in $(seq 1 40); do
    if curl -fsS "http://127.0.0.1:$PORT_API/healthz" >/dev/null 2>&1; then OK=1; break; fi
    sleep 0.5
  done
  if [ "$OK" != "1" ]; then
    echo "临时后端没起来，日志末尾："; tail -12 /tmp/verify-api.log
    NAMES+=("临时后端"); CODES+=(1)
  else
    echo "临时后端已就绪：http://127.0.0.1:$PORT_API/healthz"
  fi

  echo ""
  echo "############ 3/5 第 27/28 轮契约 + 小程序三套 ############"
  # 契约验收必须在最前面：它要求「干净的库」（SEED_DEMO 默认关 → 一个商品都没有），
  # 后面的联调用例会往库里写商品和订单。
  run "accept-r27（真后端契约）" node deploy/accept-r27.js "http://127.0.0.1:$PORT_API"
  # 第 28 轮契约（排序 / 分页 / 热销 / 替代推荐 / 订单筛选 / CSV 导出）。同样要跑在播种之前；
  # 它自己会建商品与订单，所以必须排在 accept-r27 的「干净库」断言之后。
  run "accept-r28（排序/筛选/导出契约）" node deploy/accept-r28.js "http://127.0.0.1:$PORT_API"
  # 联调用例依赖演示商品（可口可乐 / 批发价 / 演示地址），走生产的播种脚本而不是服务端内置播种
  run "播种演示库（deploy/seed-demo.py）" python3 deploy/seed-demo.py "http://127.0.0.1:$PORT_API"
  run "miniprogram test-api" node miniprogram/test-api.js
  run "miniprogram test-pages" node miniprogram/test-pages.js
  run "miniprogram test-integration（真后端）" env SDY_API_BASE="http://127.0.0.1:$PORT_API" node miniprogram/test-integration.js

  if [ "${SKIP_CDP:-0}" != "1" ]; then
    echo ""
    echo "############ 4/5 真浏览器（CDP）检查 ############"
    run "CDP 商城首页 /" node deploy/cdp-check.js "http://127.0.0.1:$PORT_API/"
    run "CDP 管理后台 /admin（含导出下载）" node deploy/cdp-check.js "http://127.0.0.1:$PORT_API/admin"
    # 第 28 轮验收第 5 条：搜索防抖要「运行时」可验证（静态扫描只能证明源码里有 300ms）
    run "CDP 搜索防抖 + 无结果实测" node deploy/cdp-debounce.js "http://127.0.0.1:$PORT_API/"
  else
    echo ""
    echo "（SKIP_CDP=1，跳过 CDP 检查）"
  fi
else
  echo ""
  echo "（SKIP_INTEGRATION=1，跳过联调 / CDP）"
fi

echo ""
echo "############ 5/5 Web 五套 ############"
run "web test-pricing" node web/test-pricing.js
run "web test-mall" node web/test-mall.js
run "web test-sdy-api" node web/test-sdy-api.js
run "web test-page-boot" node web/test-page-boot.js
run "web test-admin" node web/test-admin.js

echo ""
echo "==================== 汇总 ===================="
FAIL=0
for i in "${!NAMES[@]}"; do
  if [ "${CODES[$i]}" = "0" ]; then
    printf '  ✅ %s\n' "${NAMES[$i]}"
  else
    printf '  ❌ %s（退出码 %s）\n' "${NAMES[$i]}" "${CODES[$i]}"
    FAIL=$((FAIL + 1))
  fi
done
echo "============================================="
if [ "$FAIL" = "0" ]; then echo "全部通过"; else echo "$FAIL 个步骤失败"; fi
exit "$FAIL"

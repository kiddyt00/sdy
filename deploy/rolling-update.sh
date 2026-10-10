#!/bin/bash
# 独立小程序商城 · 滚动更新（蓝绿 A/B，逐台替换，主机 Nginx 池自动容错）
#   1) 重建并启动 api-b（此时 api-a 仍在服务）
#   2) 健康检查通过后，重建并启动 api-a
#   3) 主机 Nginx upstream 同时挂 8093/8094，任一实例重启期间不会 502
set -e
cd "$(dirname "$0")/.."

hc() {
  local port="$1"
  for i in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1; then
      echo "✅ 127.0.0.1:${port} 健康"
      return 0
    fi
    sleep 1
  done
  echo "❌ 127.0.0.1:${port} 健康检查超时"
  return 1
}

echo "🔁 更新 api-b ..."
docker compose up -d --build --no-deps api-b
hc 8094

echo "🔁 更新 api-a ..."
docker compose up -d --build --no-deps api-a
hc 8093

docker image prune -f >/dev/null 2>&1 || true
echo "✅ 滚动更新完成"

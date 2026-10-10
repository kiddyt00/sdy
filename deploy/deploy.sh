#!/bin/bash
# 独立小程序商城 · 生产部署（参照同机 yiguan 项目范式）
#   1) 基础镜像走国内代理 docker.1ms.run/library 拉取（已存在则跳过）
#   2) docker compose up -d --build 起 api-a / api-b（绑定 127.0.0.1:8093 / 8094）
#   3) 健康检查
# 注：主机级 Nginx 负责 80/443 与证书，模板见 deploy/host-nginx.conf
set -e
cd "$(dirname "$0")/.."

PROXY="docker.1ms.run/library"

ensure_image() {
  local image="$1"
  if docker image inspect "$image" &>/dev/null; then
    echo "✅ $image 已存在，跳过"
    return
  fi
  echo "📦 拉取 $image (via $PROXY)..."
  docker pull "$PROXY/$image"
  docker tag "$PROXY/$image" "$image"
}

ensure_image golang:1.24-alpine
ensure_image alpine:3.21

if [ ! -f .env ]; then
  echo "⚠️  未找到 .env，从 .env.example 复制（请填入 BARCODE_APPCODE 等）"
  cp .env.example .env
fi

mkdir -p data web
echo "🔨 构建并启动容器..."
docker compose up -d --build

echo "⏳ 等待健康检查..."
for i in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:8093/healthz >/dev/null 2>&1; then
    echo "✅ api-a 健康: $(curl -s http://127.0.0.1:8093/healthz)"
    break
  fi
  sleep 1
done
curl -fsS http://127.0.0.1:8094/healthz >/dev/null 2>&1 && echo "✅ api-b 健康" || echo "⚠️  api-b 未就绪"

echo ""
echo "部署完成。主机 Nginx 上线（首次）："
echo "  cp deploy/host-nginx.conf /etc/nginx/conf.d/<你的域名>.conf  # 先填 SDY_DOMAIN"
echo "  nginx -t && systemctl reload nginx"

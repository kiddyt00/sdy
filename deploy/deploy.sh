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
# 容器内以 uid 10001(app) 运行：
#   data 必须是 10001 可写，否则 SQLite 报「unable to open database file: out of memory (14)」
#   web  必须对 others 可读（本地仓库常见 600 权限），否则容器读不到静态文件 → 403 / 目录列表
chown -R 10001:10001 data 2>/dev/null || true
chmod -R a+rX web 2>/dev/null || true
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
echo "  cp deploy/host-nginx.conf /etc/nginx/conf.d/<你的域名>.conf  # 先填 SDY_DOMAIN（域名 + TLS）"
echo "  # 域名备案前想先用 IP 看界面："
echo "  sed 's/__SDY_HOST__/<本机公网IP>/' deploy/host-nginx-ip.conf > /etc/nginx/conf.d/sdy-ip.conf  # 仅 HTTP 80"
echo "  nginx -t && systemctl reload nginx"
echo ""
echo "从本机同步代码到服务器时请带权限参数（否则容器读不到静态文件）："
echo "  rsync -az --chmod=D755,F644 --exclude .git --exclude .venv --exclude .tools \\"
echo "        --exclude .preview --exclude '.env' --exclude '*.docx' ./ root@<服务器>:/root/sdy/"
echo ""
echo "⛔ 千万不要加 --delete / --delete-excluded："
echo "   服务器上的 data/sdy.db（真数据）与 .env 都不在仓库里，加了就会被同步删掉，"
echo "   容器随即报「unable to open database file: out of memory (14)」并无限重启。"
echo ""
echo "想让线上有一套完整演示数据（商品/订单/地址）时："
echo "  python3 deploy/seed-demo.py http://<本机或公网地址>   # 幂等，可反复执行"


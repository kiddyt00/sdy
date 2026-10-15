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

mkdir -p data web secrets
# 容器内以 uid 10001(app) 运行：
#   data 必须是 10001 可写，否则 SQLite 报「unable to open database file: out of memory (14)」
#   web  必须对 others 可读（本地仓库常见 600 权限），否则容器读不到静态文件 → 403 / 目录列表
#   secrets 只读挂进容器（/app/secrets），同样必须 10001 可读，否则支付初始化读不到私钥
chown -R 10001:10001 data 2>/dev/null || true
chmod -R a+rX web 2>/dev/null || true
chown -R 10001:10001 secrets 2>/dev/null || true
find secrets -maxdepth 1 -name '*.pem' -exec chmod 600 {} + 2>/dev/null || true
chmod 700 secrets 2>/dev/null || true
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
echo "        --exclude .preview --exclude '.env' --exclude '*.docx' \\"
echo "        --exclude 'cert.txt' --exclude '*.wx*.key' --exclude '.wx_secret.env' \\"
echo "        --exclude 'secrets' --exclude '*.zip' \\"
echo "        ./ root@<服务器>:/root/sdy/"
echo "  # 上面几条 --exclude 是微信凭证：AppSecret / 代码上传密钥 / 微信支付商户私钥绝不上服务器工作区，"
echo "  # 需要 AppSecret 时只手工写进服务器 /root/sdy/.env（不进仓库、不进 rsync 源）。"
echo ""
echo "微信支付上线（拿到商户号/密钥后，在服务器上做，一次性）："
echo "  mkdir -p /root/sdy/secrets && cd /root/sdy/secrets"
echo "  # 放入微信商户平台下载的 apiclient_key.pem 与平台证书 wechatpay_platform_cert.pem"
echo "  chown 10001:10001 *.pem && chmod 600 *.pem && chmod 700 /root/sdy/secrets"
echo "  # /root/sdy/.env 填 7 项：WXPAY_MCHID / WXPAY_SERIAL_NO / WXPAY_API_V3_KEY /"
echo "  #   WXPAY_PRIVATE_KEY_PATH=/app/secrets/apiclient_key.pem /"
echo "  #   WXPAY_PLATFORM_CERT_PATH=/app/secrets/wechatpay_platform_cert.pem /"
echo "  #   WXPAY_NOTIFY_URL=https://mall.shadouyou.cloud/api/pay/notify（WXPAY_API_BASE 留空用正式域名）"
echo "  bash deploy/pay-check.sh            # 体检：序列号 40 位 / APIv3 密钥 32 字节 / pem 权限 / 容器内路径 / 开通与否（只读，不重启）"
echo "  ./deploy/rolling-update.sh          # 七项缺任一 = 支付关闭，下单照旧，不会有半开状态"
echo "  curl -s http://127.0.0.1:8093/healthz   # 起来后到小程序下单实测一笔最小金额"
echo ""
echo "⛔ 千万不要加 --delete / --delete-excluded："
echo "   服务器上的 data/sdy.db（真数据）与 .env 都不在仓库里，加了就会被同步删掉，"
echo "   容器随即报「unable to open database file: out of memory (14)」并无限重启。"
echo ""
echo "想让线上有一套完整演示数据（商品/订单/地址）时："
echo "  python3 deploy/seed-demo.py http://<本机或公网地址>   # 幂等，可反复执行"


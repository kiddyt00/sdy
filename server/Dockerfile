# 独立小程序商城后端（Go 1.24，纯标准库 + modernc.org/sqlite）
# 两段式构建，参照同机 yiguan 项目：静态单文件、非 root 运行、自带健康检查。
# 构建：docker build -t sdy-server ./server   （上下文为 server/）

FROM golang:1.24-alpine AS builder
RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories \
 && apk add --no-cache git ca-certificates
ENV GOPROXY=https://goproxy.cn,direct \
    CGO_ENABLED=0 \
    GOOS=linux
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -trimpath -ldflags="-s -w" -o /out/sdy-server ./cmd/server

FROM alpine:3.21
RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories \
 && apk add --no-cache ca-certificates tzdata wget \
 && adduser -D -u 10001 app
ENV TZ=Asia/Shanghai \
    ADDR=0.0.0.0:8080 \
    DB_PATH=/data/sdy.db \
    STATIC_DIR=/app/web
WORKDIR /app
COPY --from=builder /out/sdy-server /app/sdy-server
RUN mkdir -p /data /app/web && chown -R app:app /data /app
USER app
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/app/sdy-server"]

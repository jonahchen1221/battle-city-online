#!/usr/bin/env bash
# 阿里云（Ubuntu 22.04/24.04）一次性初始化脚本：装 Node 22 + Caddy，配置 systemd 服务与反向代理。
# 用法（在服务器上以 root 运行）：
#   bash setup-server.sh              # 无域名：Caddy 监听 80 端口反代（http://服务器IP 访问）
#   bash setup-server.sh play.xx.com  # 有域名：Caddy 自动签发 HTTPS（需域名已解析到本机 IP）
set -euo pipefail

DOMAIN="${1:-}"
APP_DIR=/opt/battle-city
APP_PORT=8080

echo "==> 安装 Node.js 22（NodeSource）"
if ! command -v node >/dev/null || [[ "$(node -v)" != v22* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "==> 安装 Caddy（官方源）"
if ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update && apt-get install -y caddy
fi

echo "==> 建立应用目录 ${APP_DIR}"
mkdir -p "${APP_DIR}"

echo "==> 写入 systemd 服务 battle-city.service"
cat > /etc/systemd/system/battle-city.service <<EOF
[Unit]
Description=Battle City Online game server
After=network.target

[Service]
WorkingDirectory=${APP_DIR}
Environment=PORT=${APP_PORT}
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable battle-city

echo "==> 写入 Caddy 反向代理配置"
if [[ -n "${DOMAIN}" ]]; then
  # 有域名：Caddy 自动申请/续期 HTTPS 证书；WebSocket 升级自动透传（客户端将自动用 wss）。
  cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
    reverse_proxy 127.0.0.1:${APP_PORT}
}
EOF
else
  # 无域名：80 端口纯 HTTP 反代（http://服务器IP 访问；ws:// 在 http 页面下可正常工作）。
  cat > /etc/caddy/Caddyfile <<EOF
:80 {
    reverse_proxy 127.0.0.1:${APP_PORT}
}
EOF
fi
systemctl restart caddy

echo "==> 初始化完成。下一步在本地运行 scripts/deploy.sh 推送应用代码。"
if [[ -n "${DOMAIN}" ]]; then
  echo "    部署后访问：https://${DOMAIN}"
else
  echo "    部署后访问：http://$(curl -s ifconfig.me 2>/dev/null || echo '<服务器IP>')"
fi

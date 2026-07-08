#!/usr/bin/env bash
# 从本地一键部署到服务器：构建 → rsync 上传 → 安装生产依赖 → 重启服务 → 健康检查。
# 用法（在项目根目录）：
#   ./scripts/deploy.sh root@<服务器IP>
# 前提：服务器已用 scripts/setup-server.sh 初始化过；本地可 ssh 免密或输密码登录。
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "用法: $0 <user@host>" >&2
  exit 1
fi
TARGET="$1"
APP_DIR=/opt/battle-city

echo "==> 本地构建"
npm run build

echo "==> 上传到 ${TARGET}:${APP_DIR}"
rsync -az --delete \
  --include='dist/***' \
  --include='src/***' \
  --include='package.json' \
  --include='package-lock.json' \
  --include='tsconfig.json' \
  --exclude='*' \
  ./ "${TARGET}:${APP_DIR}/"

echo "==> 安装生产依赖并重启服务"
ssh "${TARGET}" "cd ${APP_DIR} && npm ci --omit=dev --no-fund --no-audit && systemctl restart battle-city"

echo "==> 健康检查"
sleep 1
ssh "${TARGET}" "curl -sf http://127.0.0.1:8080/healthz" && echo " ✓ 服务已就绪"

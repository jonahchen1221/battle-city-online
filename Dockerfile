# 单容器 = 整个应用：构建客户端到 dist/，运行时用一个 Node 进程同端口托管静态 + WS。
FROM node:22-alpine

WORKDIR /app

# 先装依赖（利用镜像层缓存：package 不变则跳过重装）。
COPY package.json package-lock.json ./
RUN npm ci

# 拷贝源码并构建客户端（tsc --noEmit 类型检查 + vite build → dist/）。
COPY . .
RUN npm run build

# 平台通过 PORT 注入端口；本镜像默认 8080，健康检查见 /healthz。
EXPOSE 8080
ENV PORT=8080

# 生产启动：tsx 直接跑服务器源码，托管已构建的 dist/ + 游戏 WS。
CMD ["npm", "start"]

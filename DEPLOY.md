# 部署指南

## 架构

单容器即整个应用：一个 Node 进程同端口同时提供 **HTTP 静态客户端（`dist/`）** 与 **游戏 WebSocket**（经 upgrade 复用端口）。端口由 `PORT` 环境变量注入（默认 8080），健康检查走 `GET /healthz`（返回 `ok`）。TLS 与域名由托管平台负责；HTTPS 下客户端自动改用 `wss`。

本地构建 + 运行：

```bash
npm run build        # tsc 类型检查 + vite build → dist/
PORT=8090 npm start  # 生产模式：单端口托管 dist/ + WS
```

---

## Zeabur（推荐，香港节点）

1. 注册 [zeabur.com](https://zeabur.com)。
2. 新建项目，**区域选香港（Hong Kong）**。
3. 连接 GitHub 仓库（或本地 `npx zeabur@latest deploy`）。
4. Zeabur 自动识别根目录 `Dockerfile`，构建并运行。
5. 在服务设置里绑定生成的 `xxx.zeabur.app` 域名，开玩。

> 注意：免费额度可能不含 HK 区；HK 区通常需 Developer 计划（约 $5/月）。

---

## Railway

1. New Project → **Deploy from GitHub**。
2. Region 选 **Singapore**（离大陆较近）。
3. Railway 自动识别 `Dockerfile` 并构建。
4. Settings → Networking → **Generate Domain** 得到公网域名。

---

## Fly.io

```bash
fly launch      # 识别根目录 Dockerfile；region 选 hkg（香港）
fly deploy
```

> 注意：`*.fly.dev` 在大陆访问可能不稳定。

---

## 朋友怎么玩

1. 访问 `https://你的域名`。
2. 点 **CREATE ROOM**，把生成的 4 位房间码报给朋友。
3. 朋友访问同一域名 → **JOIN ROOM** → 输入房间码 → 全员准备 → 房主开局。

---

## 更新姿势

- Zeabur / Railway：`git push` 后平台自动重建并发布。
- Fly.io：本地 `fly deploy`。

---

## 注意事项

- **只跑单实例**：房间与对局状态都在内存里，多实例会把玩家分裂到不同进程、房间码互相看不见。若平台默认多副本，请把副本数固定为 1。
- HTTPS 域名下客户端自动使用 `wss`，无需额外配置。
- 全员断线后房间保留 60 秒宽限期供重连，超时自动销毁。

## 阿里云轻量应用服务器（当前选定方案）

> 推荐：香港地域（免备案、可绑域名开 HTTPS）、Ubuntu 22.04/24.04、最低配即可（约 ¥34/月）。
> 控制台防火墙需放行 80 与 443 端口。

1. **初始化（服务器上以 root 执行一次）**：
   ```bash
   # 无域名：
   bash setup-server.sh
   # 有域名（需已解析到本机 IP）：
   bash setup-server.sh play.example.com
   ```
   脚本内容见 `scripts/setup-server.sh`：安装 Node 22 + Caddy，配置 systemd（崩溃自启/开机自启）与反向代理（有域名时自动 HTTPS）。
2. **部署 / 更新（本地执行）**：
   ```bash
   ./scripts/deploy.sh root@<服务器IP>
   ```
   构建 → rsync 上传 → 装生产依赖 → 重启服务 → 健康检查，一条命令完成。
3. **访问**：有域名 `https://域名`；无域名 `http://服务器IP`。朋友打开同一地址，JOIN ROOM 输房间码即可。
4. **排查**：`systemctl status battle-city`、`journalctl -u battle-city -f`、`systemctl status caddy`。

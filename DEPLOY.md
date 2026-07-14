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

## 阿里云轻量应用服务器（当前选定方案）—— 从零复活手册

> 服务器可随时销毁退订，一切所需都在本仓库 + 本地 SSH 密钥里；按本节从零重建约 10 分钟。
> 实测结论（2026-07）：玩家在大陆 → 选**大陆地域**（如武汉/杭州，43ms/0% 丢包）；
> 香港虽免备案但跨境线路差（实测 147ms/20% 丢包）。大陆地域用 `http://IP` 访问免备案（绑域名才需备案）。

**第 -1 步：购买清单**（阿里云控制台 → 轻量应用服务器）：
- 地域：大陆（武汉/杭州等，离玩家近的）；镜像：**系统镜像 Ubuntu 24.04**（勿选应用镜像）；
- 套餐：最低配即可（游戏单房间 CPU 占用 <1%）；时长 1 个月起，**自动续费按需**；
- 购买后到实例的"防火墙"页确认已放行 TCP 80/443（新实例默认通常已有 22/80/443/ICMP）。

**第 0 步：SSH 引导（不需要 root 密码）**——用控制台"命令助手"把本地公钥装进新机器：
- 控制台 → 该地域 → 命令助手 → 新建命令（Shell），内容如下，执行目标选中新实例：
  ```bash
  mkdir -p /root/.ssh && chmod 700 /root/.ssh
  echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIL3DPWII8hzGIHDPTdhNyb4YhO01dCambBuA7uSy9C7B battle-city-deploy' >> /root/.ssh/authorized_keys
  chmod 600 /root/.ssh/authorized_keys
  ```
  （公钥对应本地私钥 `~/.ssh/battle_city_hk`；换了工作机则先 `ssh-keygen -t ed25519` 生成新对并替换上面的公钥。）
- 本地 `~/.ssh/config` 加/改别名（换 IP 只改这里，仓库脚本不含 IP）：
  ```
  Host battle-city
    HostName <新服务器公网IP>
    User root
    IdentityFile ~/.ssh/battle_city_hk
  ```
- 验证：`ssh battle-city 'echo ok'`。

1. **初始化（本地一条命令，含上传脚本）**：
   ```bash
   scp scripts/setup-server.sh battle-city:/root/ && ssh battle-city 'bash /root/setup-server.sh'
   # 有域名（需已解析到新 IP）：…… 'bash /root/setup-server.sh play.example.com'
   ```
   脚本内容见 `scripts/setup-server.sh`：安装 Node 22 + Caddy，配置 systemd（崩溃自启/开机自启）与反向代理（有域名时自动 HTTPS）。
2. **部署 / 更新（本地执行）**：
   ```bash
   ./scripts/deploy.sh battle-city
   ```
   构建 → rsync 上传 → 装生产依赖 → 重启服务 → 健康检查，一条命令完成。以后每次更新代码也只需这一条。
3. **访问**：有域名 `https://域名`；无域名 `http://服务器IP`。朋友打开同一地址，JOIN ROOM 输房间码即可。
4. **排查**：`systemctl status battle-city`、`journalctl -u battle-city -f`、`systemctl status caddy`。

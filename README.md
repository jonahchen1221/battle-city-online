# Battle City Online

NES《坦克大战》复刻，支持 1–4 人局域网合作。TypeScript + Canvas + Node，服务器权威联机，不用任何外部图片资产（像素画全部代码生成）。

## 局域网开玩

```bash
npm install
npm run lan
```

启动后终端会打印局域网地址（如 `http://192.168.1.87:8080`）。房主用该地址打开、CREATE ROOM，然后把地址栏的 `?room=房间码` 链接发给同一 WiFi 的朋友，点开即进房；也可在大厅按 C 复制链接。全员 Enter 准备，房主 S 开局。

键位：方向键 / WASD 移动，Space 或 J 开火，P 暂停，Enter 确认/准备。

手柄：十字键 / 左摇杆移动，A/B/X 开火，Start 开始，Select 暂停；菜单里 A 确认 / B 返回（房间码仍需键盘输入或粘贴）。

## 开发

```bash
npm run dev         # vite 客户端（单机调试）
npm run dev:server  # 联机服务器（tsx watch 热重载，端口 8080）
npm run typecheck   # 类型检查（提交前必须通过）
```

改代码前先读 [CLAUDE.md](CLAUDE.md)：架构铁律（`src/game/` 是纯模拟层）、坐标规格、美术约定都在里面。

## 多人规则（与 NES 原版的差异）

- 团队制：一人清完敌人即全队过关；新关卡全员满命复活。
- 多人初始 5 条命（单机保持原版 3 条）；生命耗尽自动向随机队友借 1 条（队友需剩 ≥2）。
- 友军火力：击中队友不掉血，但对方会被冻结 3 秒。

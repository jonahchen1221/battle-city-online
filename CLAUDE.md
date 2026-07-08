# Battle City Online

NES《坦克大战》的联机复刻（1–4 人合作）。当前阶段：Phase 1 单机核心。
UI 目标是尽量还原 NES 原版观感；玩法保留经典机制，细节可为多人模式调整。

## 架构铁律（为将来的服务器权威联机铺路）

1. **`src/game/` 是纯模拟层**：不得引用 DOM、canvas、`performance.now`、`Math.random`。
   随机数一律用注入的 `Rng`（`src/core/rng.ts`）。这一层将来会原样跑在 Node 服务器上。
2. **固定 60Hz 逻辑帧**（`src/core/loop.ts`）。所有速度、计时以 tick 为单位，不用毫秒。
3. **渲染层（`src/render/`）只读 `GameState`**，绝不修改它。
4. **`GameState` 保持可序列化**，将来要做网络快照。
5. **输入即消息**：`InputState`（`src/core/types.ts`）是每帧输入快照，`update(state, inputs[])`
   接收所有玩家的输入数组 —— 单机时数组长度为 1。

## 坐标与尺寸约定（NES 原版规格）

- 原生分辨率 368×256（为 1–4 人合作放大后的战场），放大渲染，`imageSmoothing` 关闭。
  显示倍率由 `main.ts` 按视口取半整数步长（1, 1.5, 2, …，最小 1）。
- 战场 320×240，位于 (16, 8)；右侧 32px 为 HUD 栏（x = FIELD_X + FIELD_WIDTH）。
- 20×15 大格（16px，坦克尺寸）= 40×30 子格（8px，砖块破坏单位）。
- 鹰巢在底部正中（子格列 19-20、行 28-29）；玩家出生列 6/14/24/32、敌方出生点 4 处（x=0/104/200/304）。
- 常量一律从 `src/core/constants.ts` 引用，不得散落魔法数字。

## 美术约定

- 不使用外部图片资产。像素画以调色板索引的字符串数组定义在 `src/render/sprites.ts`，
  启动时绘制到 offscreen canvas。风格对齐 NES 原版（4 色内/精灵，NES 调色板取色）。

## 命令

- `npm run dev` — 开发服务器
- `npm run typecheck` — 类型检查（提交前必须通过）
- `npm run dev:server` — 联机服务器（tsx watch，热重载，端口 8080）
- `npm run server` — 联机服务器（tsx 单次运行，端口 8080，可用 PORT 覆盖）
- `npm start` — 生产模式：单端口托管 dist（HTTP 静态）+ WS（需先 `npm run build`；见 DEPLOY.md）

import { Rng, createRng } from '../core/rng';
import {
  PLAYER_LIVES_START,
  STAGE_COUNT,
  STAGE_ENEMY_MIX,
  SPAWN_FLASH_TICKS,
} from '../core/constants';
import { LevelState, cloneLevel } from './level';
import { STAGES } from './levels';
import { TankState, TankKind, EnemyKind, createPlayer, isPlayerTank } from './tank';
import { BulletState } from './bullet';
import type { PowerupState } from './powerup';

// 出生中的敌方坦克：闪光结束后原样加入 tanks，期间不可碰撞、不受控。
export interface SpawnState {
  tank: TankState; // 待实体化的坦克（已含出生点/种类/属性）
  ticksLeft: number; // 剩余闪光帧
}

// 爆炸特效：纯数据，tick 驱动。x/y 为精灵左上角战场相对坐标。
export interface ExplosionState {
  x: number;
  y: number;
  ticksLeft: number;
  big: boolean; // true=坦克死亡大爆炸(32×32) / false=子弹火花小爆炸(16×16)
}

// 关卡阶段：开场幕布 / 游玩中 / 失败 / 通关。
// stagestart 为每关开局的经典“STAGE N”幕布（模拟冻结，到时自动转 playing）；
// gameover、stageclear 期间同样冻结模拟（爆炸仍播完）。
export type Phase = 'stagestart' | 'playing' | 'gameover' | 'stageclear';

// 音效事件：游戏层在事件发生的瞬间 push 到 state.events，由调用方（main.ts）逐帧读取并清空。
// 纯字符串联合，保持 GameState 可序列化；游戏层绝不直接触碰音频。
export type GameEvent =
  | 'playerFire' // 玩家开火
  | 'brickHit' // 子弹击中砖块
  | 'steelHit' // 子弹击中钢块 / 鹰巢 / 边界
  | 'explosionSmall' // 子弹互相抵消的小火花
  | 'explosionBig' // 敌方坦克被击毁
  | 'playerDeath' // 玩家坦克被击毁
  | 'eagleDeath' // 鹰巢被摧毁
  | 'stageStart' // 关卡开场幕布（STAGE N）：短促过场小调
  | 'stageClear' // 通关
  | 'gameOver' // 失败
  | 'pause' // 暂停 / 解除暂停
  | 'powerupSpawn' // 携带者掉落道具（浮标出现）
  | 'powerupPickup' // 拾取道具（除 tank 外）
  | 'lifeUp'; // 拾取 tank 道具（加命）：独立的 1UP 欢快音效

// 整局游戏的完整状态。必须保持可序列化（除 rng 外无函数/类实例），
// 联机版中服务器持有它并向客户端广播快照。
export interface GameState {
  tick: number;
  rng: Rng;
  level: LevelState;
  tanks: TankState[];
  bullets: BulletState[];
  spawning: SpawnState[]; // 出生闪光中的坦克（敌人 + 玩家复活）
  explosions: ExplosionState[]; // 爆炸特效
  enemyQueue: TankKind[]; // 待出生敌军队列（按出生先后）
  enemySpawnTimer: number; // 距下次出生的倒计时（≤0 且有空位即出生）
  enemySpawnPoint: number; // 下一个出生点索引（0→1→2 轮转）
  nextEnemyId: number; // 敌方坦克 id 分配器
  stage: number; // 当前关号（1-based，1..STAGE_COUNT）
  phase: Phase; // 当前阶段
  phaseTicks: number; // 进入当前阶段以来的帧数（stagestart 幕布计时 / gameover 滑入动画等据此推算）
  eagleDestroyed: boolean; // 鹰巢（基地）是否已被摧毁
  playerCount: number; // 本局玩家数（1–4）
  livesByPlayer: number[]; // 每名玩家的剩余生命（含当前在场坦克），按 playerIndex 索引
  // 待定结果：某触发（鹰毁 / 玩家阵亡 / 全歼）已武装但仍在延迟模拟中；
  // resultTimer 归零后 phase 切到 pendingResult。null 表示未武装。
  pendingResult: Exclude<Phase, 'playing'> | null;
  resultTimer: number; // 距切换到 pendingResult 的剩余帧数
  scoreByPlayer: number[]; // 每名玩家的累计得分（跨关累积），按 playerIndex 索引
  killsByPlayer: Array<Record<EnemyKind, number>>; // 每名玩家各种敌军击毁数（每关重置），按 playerIndex 索引
  paused: boolean; // 是否暂停（游玩中按 P 切换；谁都能暂停/恢复）
  pausedBy: number; // 触发本次暂停的玩家 playerIndex（用于显示 "nP PAUSED"）；未暂停时 -1
  prevStart: boolean; // 上一帧 start 键聚合状态（边沿检测：结算重开 / 大厅）
  prevPause: boolean; // 上一帧 pause 键聚合状态（边沿检测：暂停切换）
  // ── 道具系统 ──
  powerup: PowerupState | null; // 场上当前道具浮标（同时至多一枚）；被拾取 / 被新掉落替换前持续存在
  enemyFreezeTicks: number; // timer 道具：>0 时敌军冻结（不动、不开火），逐帧递减
  shovelTicks: number; // shovel 道具：>0 时鹰巢护墙已钢化，归零时恢复砖墙，逐帧递减
  enemiesDequeued: number; // 已出队敌军计数（用于按第 4/11/18 台标记携带者）
  events: GameEvent[]; // 本帧音效事件队列；main.ts 逐帧读取并清空
}

// 按某关编成（STAGE_ENEMY_MIX[stageIndex]）构建敌军出生队列（queue[0] 最先出生）。
// 轮转交错（round-robin）：依次遍历各种类，剩余数 >0 则取一台，直至取空 —— 使种类分散、确定性、无需 rng。
// 携带道具者仍由 enemy.ts 按第 4/11/18 台出队计数标记，与队列内容无关。
// 每名玩家一份“全零”的击毁计数表（避免共享同一对象引用）。
function emptyKillsByPlayer(playerCount: number): Array<Record<EnemyKind, number>> {
  return Array.from({ length: playerCount }, () => ({ basic: 0, fast: 0, power: 0, armor: 0 }));
}

function createStageQueue(stageIndex: number): TankKind[] {
  const mix = STAGE_ENEMY_MIX[stageIndex % STAGE_ENEMY_MIX.length];
  const remaining = mix.map((m) => ({ kind: m.kind, count: m.count }));
  const total = remaining.reduce((s, m) => s + m.count, 0);
  const queue: TankKind[] = [];
  let i = 0;
  while (queue.length < total) {
    if (remaining[i].count > 0) {
      queue.push(remaining[i].kind);
      remaining[i].count--;
    }
    i = (i + 1) % remaining.length;
  }
  return queue;
}

// 建立一局全新游戏。stage 为 1-based 关号（默认第 1 关），载入对应关卡地形与出生队列。
// 开局即进入 'stagestart' 幕布（模拟冻结，STAGE_START_TICKS 帧后自动转 playing），并发一次 stageStart 事件。
export function createGameState(seed: number, playerCount = 1, stage = 1): GameState {
  const stageIndex = (stage - 1) % STAGE_COUNT;
  // 玩家坦克：id 为 1..N，playerIndex 为 0..N-1。
  const tanks: TankState[] = [];
  for (let i = 0; i < playerCount; i++) {
    tanks.push(createPlayer(i, i + 1));
  }
  return {
    tick: 0,
    rng: createRng(seed),
    // 拷贝一份，避免就地破坏砖块时污染 STAGES 常量。
    level: cloneLevel(STAGES[stageIndex]),
    tanks,
    bullets: [],
    spawning: [],
    explosions: [],
    enemyQueue: createStageQueue(stageIndex),
    enemySpawnTimer: 0, // 开局即可出生第一台
    enemySpawnPoint: 0,
    nextEnemyId: playerCount + 1, // 玩家占用 id=1..N
    stage,
    phase: 'stagestart',
    phaseTicks: 0,
    eagleDestroyed: false,
    playerCount,
    livesByPlayer: new Array<number>(playerCount).fill(PLAYER_LIVES_START),
    pendingResult: null,
    resultTimer: 0,
    scoreByPlayer: new Array<number>(playerCount).fill(0),
    killsByPlayer: emptyKillsByPlayer(playerCount),
    paused: false,
    pausedBy: -1,
    prevStart: false,
    prevPause: false,
    powerup: null,
    enemyFreezeTicks: 0,
    shovelTicks: 0,
    enemiesDequeued: 0,
    events: ['stageStart'],
  };
}

// 通关后进入下一关（就地修改同一 state 对象）。
// 关号 +1（通关第 STAGE_COUNT 关后回卷到第 1 关），载入新关卡地形与出生队列，进入 'stagestart' 幕布。
// 保留（跨关累积）：scoreByPlayer、livesByPlayer、每名玩家 star 等级 level、playerCount、rng（继续推进）。
// 重置（每关独立）：killsByPlayer、道具/冻结/铲子计时、bullets/explosions/spawning、eagleDestroyed、
//                  出队计数 enemiesDequeued / 出生计时 / 出生点、paused / pendingResult。
export function nextStage(state: GameState): void {
  const nextStageNum = (state.stage % STAGE_COUNT) + 1;
  const stageIndex = nextStageNum - 1;

  // 先捕获每名玩家当前 star 等级（跨关保留）：来源为在场坦克或复活闪光中的坦克，缺席者按 0。
  const levelByPlayer = new Array<number>(state.playerCount).fill(0);
  for (const t of state.tanks) {
    if (isPlayerTank(t)) levelByPlayer[t.playerIndex] = t.level;
  }
  for (const s of state.spawning) {
    if (isPlayerTank(s.tank)) levelByPlayer[s.tank.playerIndex] = s.tank.level;
  }

  state.stage = nextStageNum;
  state.level = cloneLevel(STAGES[stageIndex]);
  state.enemyQueue = createStageQueue(stageIndex);

  // 每关独立的战斗态一律清空。
  state.tanks = [];
  state.bullets = [];
  state.spawning = [];
  state.explosions = [];
  state.enemySpawnTimer = 0;
  state.enemySpawnPoint = 0;
  state.nextEnemyId = state.playerCount + 1;
  state.eagleDestroyed = false;
  state.pendingResult = null;
  state.resultTimer = 0;
  // scoreByPlayer 跨关累积、保持不动；killsByPlayer 每关独立、清零重建。
  state.killsByPlayer = emptyKillsByPlayer(state.playerCount);
  state.powerup = null;
  state.enemyFreezeTicks = 0;
  state.shovelTicks = 0;
  state.enemiesDequeued = 0;
  state.paused = false;
  state.pausedBy = -1;
  state.prevPause = false;

  // 尚有生命的玩家在各自出生点复活（经出生闪光入场），并沿用其 star 等级。
  for (let i = 0; i < state.playerCount; i++) {
    if (state.livesByPlayer[i] <= 0) continue;
    const tank = createPlayer(i, i + 1);
    tank.level = levelByPlayer[i];
    state.spawning.push({ tank, ticksLeft: SPAWN_FLASH_TICKS });
  }

  // 进入开场幕布。
  state.phase = 'stagestart';
  state.phaseTicks = 0;
  state.events.push('stageStart');
}

// 就地重置为全新的第 1 关（保留同一 state 对象引用，供 main.ts 持有）——一切归零（生命/得分/等级/关号）。
// 用于 gameover 时按 start 重开整局：seed 由旧 rng 派生，保持确定性；玩家数沿用本局。
export function resetGameState(state: GameState, seed: number): void {
  Object.assign(state, createGameState(seed, state.playerCount, 1));
}

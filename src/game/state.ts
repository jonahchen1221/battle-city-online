import { Rng, createRng } from '../core/rng';
import { STAGE_ENEMY_TOTAL, PLAYER_LIVES_START } from '../core/constants';
import { LevelState, cloneLevel } from './level';
import { STAGE_1 } from './levels';
import { TankState, TankKind, createPlayer1 } from './tank';
import { BulletState } from './bullet';

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

// 关卡阶段：游玩中 / 失败 / 通关。gameover、stageclear 期间冻结模拟（爆炸仍播完）。
export type Phase = 'playing' | 'gameover' | 'stageclear';

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
  | 'stageClear' // 通关
  | 'gameOver' // 失败
  | 'pause'; // 暂停 / 解除暂停

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
  phase: Phase; // 当前阶段
  phaseTicks: number; // 进入当前阶段以来的帧数（gameover 滑入动画等据此推算）
  eagleDestroyed: boolean; // 鹰巢（基地）是否已被摧毁
  playerLives: number; // 玩家剩余生命（含当前在场坦克）
  // 待定结果：某触发（鹰毁 / 玩家阵亡 / 全歼）已武装但仍在延迟模拟中；
  // resultTimer 归零后 phase 切到 pendingResult。null 表示未武装。
  pendingResult: Exclude<Phase, 'playing'> | null;
  resultTimer: number; // 距切换到 pendingResult 的剩余帧数
  score: number; // 本局累计得分
  killsByKind: Record<'basic' | 'fast' | 'power' | 'armor', number>; // 各种敌军击毁数
  paused: boolean; // 是否暂停（游玩中按 start 切换）
  prevStart: boolean; // 上一帧 start 键聚合状态（边沿检测：暂停切换 / 结算重开）
  events: GameEvent[]; // 本帧音效事件队列；main.ts 逐帧读取并清空
}

// 第 1 关经典敌军队列：18 基础 + 2 快速，快速坦克位于第 4、11 位（1 起）。
// 出生顺序即队列顺序（queue[0] 最先出生）。
function createStageQueue(): TankKind[] {
  const queue: TankKind[] = [];
  for (let i = 1; i <= STAGE_ENEMY_TOTAL; i++) {
    queue.push(i === 4 || i === 11 ? 'fast' : 'basic');
  }
  return queue;
}

export function createGameState(seed: number): GameState {
  return {
    tick: 0,
    rng: createRng(seed),
    // 拷贝一份，避免就地破坏砖块时污染 STAGE_1 常量。
    level: cloneLevel(STAGE_1),
    tanks: [createPlayer1(1)],
    bullets: [],
    spawning: [],
    explosions: [],
    enemyQueue: createStageQueue(),
    enemySpawnTimer: 0, // 开局即可出生第一台
    enemySpawnPoint: 0,
    nextEnemyId: 2, // 玩家 1 占用 id=1
    phase: 'playing',
    phaseTicks: 0,
    eagleDestroyed: false,
    playerLives: PLAYER_LIVES_START,
    pendingResult: null,
    resultTimer: 0,
    score: 0,
    killsByKind: { basic: 0, fast: 0, power: 0, armor: 0 },
    paused: false,
    prevStart: false,
    events: [],
  };
}

// 就地重置为全新的第 1 关（保留同一 state 对象引用，供 main.ts 持有）。
// 用于 gameover / stageclear 时按 start 重开：seed 由旧 rng 派生，保持确定性。
export function resetGameState(state: GameState, seed: number): void {
  Object.assign(state, createGameState(seed));
}

import { Rng, createRng } from '../core/rng';
import {
  PLAYER_LIVES_START,
  PLAYER_LIVES_START_MP,
  STAGE_COUNT,
  STAGE_ENEMY_MIX,
  stageGroup,
  stageKind,
  SPAWN_FLASH_TICKS,
  NEUTRAL_POWERUP_FIRST_TICKS,
  TANK_SIZE,
} from '../core/constants';
import { LevelState, cloneLevel } from './level';
import { bossArenaForStage, normalLevelForStage } from './levels';
import { TankState, TankKind, EnemyKind, WeaponKind, createPlayer, isPlayerTank } from './tank';
import { BulletState } from './bullet';
import { MVP_POWERUP_KINDS, shuffledNeutralQueue } from './powerup';
import type { PowerupState, PowerupKind } from './powerup';
import { createBoss } from './boss';
import type { BossState } from './boss';
import {
  createEscortLevel,
  createEscortState,
  escortPlayerSpawn,
  type EscortState,
} from './escort';

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
// 游戏层绝不直接触碰音频。
export type AudioEvent =
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

// 道具拾取通知：与拾取音效一起进入事件队列。客户端据此排入顶部跑马灯；对象结构仍可直接序列化，
// 联机时由权威服务器随 snapshot 事件一并广播，所有客户端看到相同的拾取者与道具效果。
export interface PowerupPickupEvent {
  type: 'powerupPicked';
  playerIndex: number; // 玩家为 0..3；敌方拾取者为 -1
  kind: PowerupKind;
}

export type GameEvent = AudioEvent | PowerupPickupEvent;

// 整局游戏的完整状态。必须保持可序列化（除 rng 外无函数/类实例），
// 联机版中服务器持有它并向客户端广播快照。
export interface GameState {
  tick: number;
  rng: Rng;
  // 地图实例代际：每次跨关或整局重开都单调递增。与 level.rev 共同构成网络地形缓存键。
  levelEpoch: number;
  level: LevelState;
  tanks: TankState[];
  bullets: BulletState[];
  spawning: SpawnState[]; // 出生闪光中的坦克（敌人 + 玩家复活）
  explosions: ExplosionState[]; // 爆炸特效
  enemyQueue: TankKind[]; // 待出生敌军队列（按出生先后）
  enemySpawnTimer: number; // 距下次出生的倒计时（≤0 且有空位即出生）
  nextEnemyId: number; // 敌方坦克 id 分配器
  nextBulletId: number; // 子弹 id 分配器（联机插值按此稳定匹配多发同源子弹）
  stage: number; // 当前关号（1-based，1..STAGE_COUNT）
  // Boss 关（每组第 3 关：3 / 6 / … / 30）的 Boss 实体；普通关 / 护送关恒为 null。
  // 纯数据，随快照整体下发；过关条件与败因判定见 phase.ts。
  boss: BossState | null;
  phase: Phase; // 当前阶段
  phaseTicks: number; // 进入当前阶段以来的帧数（stagestart 幕布计时 / gameover 滑入动画等据此推算）
  eagleDestroyed: boolean; // 鹰巢（基地）是否已被摧毁
  escort: EscortState | null; // 护送关的移动鹰巢；普通关为 null
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
  powerups: PowerupState[]; // 场上全部道具浮标（最多 MAX_POWERUPS_ON_FIELD 枚，数组序即年龄序：越靠前越旧）
  playerFreezeTicks: number; // 敌方 timer：>0 时全部玩家冻结
  playerSlowTicks: number; // 敌方 hourglass：>0 时全部玩家半速
  enemyFreezeTicks: number; // timer 道具：>0 时敌军冻结（不动、不开火），逐帧递减
  enemySlowTicks: number; // hourglass 道具：>0 时敌军半速（仅偶数 tick 行动），逐帧递减
  shovelTicks: number; // shovel 道具：>0 时鹰巢护墙已钢化，归零时恢复砖墙，逐帧递减
  neutralQueue: PowerupKind[]; // 本关剩余待刷的中立道具（开关洗牌，保证 5 种新道具每关各出一次）
  neutralTimer: number; // 距下一枚中立道具刷新的剩余帧（仅 playing 期间递减）
  enemiesDequeued: number; // 已出队敌军计数（用于按第 4/11/18 台标记携带者）
  // 本关开始时每名玩家的累计分快照：nextStage 据此算出上一关各人得分差，评出 MVP（仅多人局）。
  stageScoreStart: number[];
  events: GameEvent[]; // 本帧音效 / UI 事件队列；main.ts 逐帧读取并清空
}

// 按某关编成（STAGE_ENEMY_MIX[stageIndex]）构建敌军出生队列（queue[0] 最先出生）。
// 轮转交错（round-robin）：依次遍历各种类，剩余数 >0 则取一台，直至取空 —— 使种类分散、确定性、无需 rng。
// 携带道具者仍由 enemy.ts 按第 4/11/18 台出队计数标记，与队列内容无关。
// 每名玩家一份“全零”的击毁计数表（避免共享同一对象引用）。
function emptyKillsByPlayer(playerCount: number): Array<Record<EnemyKind, number>> {
  return Array.from({ length: playerCount }, () => ({
    basic: 0,
    fast: 0,
    power: 0,
    armor: 0,
    smart: 0,
  }));
}

// 某关的敌军出生队列。普通关 / 护送关取本组编成（STAGE_ENEMY_MIX[组号-1]）；
// Boss 关不走有限队列（返回空数组），小兵由 enemy.ts updateBossMinions 无限补充。
function createStageQueue(stage: number): TankKind[] {
  if (stageKind(stage) === 'boss') return [];
  const mix = STAGE_ENEMY_MIX[(stageGroup(stage) - 1) % STAGE_ENEMY_MIX.length];
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
  // 关卡类型（普通 / 护送 / Boss）单点分流：取图、建队列、建 boss/escort 全部据此。
  const kind = stageKind(stage);
  const escortStage = kind === 'escort';
  const bossStage = kind === 'boss';
  const level = escortStage
    ? createEscortLevel(stage)
    : cloneLevel(bossStage ? bossArenaForStage(stage) : normalLevelForStage(stage));
  const escort = escortStage ? createEscortState(level, stage) : null;
  // 玩家坦克：id 为 1..N，playerIndex 为 0..N-1。
  const tanks: TankState[] = [];
  for (let i = 0; i < playerCount; i++) {
    const tank = createPlayer(i, i + 1);
    const spawn = escortPlayerSpawn(escort, i, level);
    tank.x = spawn.x;
    tank.y = spawn.y;
    tanks.push(tank);
  }
  // rng 先行创建：本关中立道具队列的洗牌即取自它（必须在 state 组装前完成）。
  const rng = createRng(seed);
  // Boss 关走专属中立池（2 星 + 头盔 + 战靴 + 1 件随机武器），普通关 / 护送关维持原 5 种池。
  const neutralQueue = shuffledNeutralQueue(rng, bossStage);
  // 护送关首枚中立道具固定为扳手，让玩家在 10 秒后稳定获得一次修车机会。
  if (escort) {
    const wrench = neutralQueue.indexOf('wrench');
    if (wrench > 0) [neutralQueue[0], neutralQueue[wrench]] = [neutralQueue[wrench], neutralQueue[0]];
  }
  return {
    tick: 0,
    rng,
    levelEpoch: 0,
    // 拷贝一份，避免就地破坏砖块时污染 STAGES 常量。
    level,
    tanks,
    bullets: [],
    spawning: [],
    explosions: [],
    enemyQueue: createStageQueue(stage),
    enemySpawnTimer: 0, // 开局即可出生第一台
    nextEnemyId: playerCount + 1, // 玩家占用 id=1..N
    nextBulletId: 1,
    stage,
    // Boss 关：幕布结束后 Boss 即已在位（不走出生闪光）。普通关为 null。
    boss: bossStage ? createBoss(playerCount) : null,
    phase: 'stagestart',
    phaseTicks: 0,
    eagleDestroyed: false,
    escort,
    playerCount,
    // 单机 3 条（NES 原版）；多人合作 5 条（且可向队友借命，见 update.ts onPlayerKilled）。
    livesByPlayer: new Array<number>(playerCount).fill(
      playerCount > 1 ? PLAYER_LIVES_START_MP : PLAYER_LIVES_START,
    ),
    pendingResult: null,
    resultTimer: 0,
    scoreByPlayer: new Array<number>(playerCount).fill(0),
    killsByPlayer: emptyKillsByPlayer(playerCount),
    paused: false,
    pausedBy: -1,
    prevStart: false,
    prevPause: false,
    powerups: [],
    playerFreezeTicks: 0,
    playerSlowTicks: 0,
    enemyFreezeTicks: 0,
    enemySlowTicks: 0,
    shovelTicks: 0,
    neutralQueue,
    neutralTimer: NEUTRAL_POWERUP_FIRST_TICKS,
    enemiesDequeued: 0,
    stageScoreStart: new Array<number>(playerCount).fill(0),
    events: ['stageStart'],
  };
}

// 通关后进入下一关（就地修改同一 state 对象）。
// 关号 +1（通关第 STAGE_COUNT 关后回卷到第 1 关），载入新关卡地形与出生队列，进入 'stagestart' 幕布。
// 保留（跨关累积）：scoreByPlayer、每名玩家 star 等级 level、playerCount、rng（继续推进）；
// livesByPlayer 单人跨关累积，多人则每关恢复初始值（团队一起进新关，见下）。
// 重置（每关独立）：killsByPlayer、道具/冻结/铲子计时、bullets/explosions/spawning、eagleDestroyed、
//                  出队计数 enemiesDequeued / 出生计时 / 出生点、paused / pendingResult。
export function nextStage(state: GameState): void {
  const nextStageNum = (state.stage % STAGE_COUNT) + 1;
  const nextKind = stageKind(nextStageNum);

  // ── MVP 开局奖励（仅多人局）──
  // 规则：以「本关得分差」评 MVP —— delta[i] = 当前累计分 − 本关开始时的累计分快照；
  // 取 delta 最高者，并列时取 playerIndex 最小者（全员 delta 为 0 也照发，由并列规则兜底）。
  // 奖励为一枚随机“强力道具”，刷在 MVP 下一关出生点的正前方（朝上一个坦克身位）。
  // 必须在下方重置 powerups 之前算出 MVP（重置会清空场上道具），实际投放在重置之后。
  let mvpIndex = -1;
  if (state.playerCount > 1) {
    let best = -Infinity;
    for (let i = 0; i < state.playerCount; i++) {
      const delta = state.scoreByPlayer[i] - (state.stageScoreStart[i] ?? 0);
      if (delta > best) {
        best = delta;
        mvpIndex = i;
      }
    }
  }

  // 先捕获每名玩家当前 star 等级 / 武器 / 钻头（三者跨关保留）：来源为在场坦克或复活闪光中的
  // 坦克，缺席者按 0 / 'cannon' / false。注意这只影响“过关”这一条路径 —— 关内被击毁后复活仍
  // 走 createPlayer，等级、武器、钻头照旧清零。
  const levelByPlayer = new Array<number>(state.playerCount).fill(0);
  const weaponByPlayer = new Array<WeaponKind>(state.playerCount).fill('cannon');
  const drillByPlayer = new Array<boolean>(state.playerCount).fill(false);
  const capture = (t: TankState): void => {
    if (!isPlayerTank(t)) return;
    levelByPlayer[t.playerIndex] = t.level;
    weaponByPlayer[t.playerIndex] = t.weapon;
    drillByPlayer[t.playerIndex] = t.drill;
  };
  for (const t of state.tanks) capture(t);
  for (const s of state.spawning) capture(s.tank);

  state.stage = nextStageNum;
  state.levelEpoch++;
  state.level =
    nextKind === 'escort'
      ? createEscortLevel(nextStageNum)
      : cloneLevel(
          nextKind === 'boss'
            ? bossArenaForStage(nextStageNum)
            : normalLevelForStage(nextStageNum),
        );
  state.escort = nextKind === 'escort' ? createEscortState(state.level, nextStageNum) : null;
  state.enemyQueue = createStageQueue(nextStageNum);
  // Boss 关重建一台满血 Boss；普通关 / 护送关清空。
  state.boss = nextKind === 'boss' ? createBoss(state.playerCount) : null;

  // 每关独立的战斗态一律清空。
  state.tanks = [];
  state.bullets = [];
  state.spawning = [];
  state.explosions = [];
  state.enemySpawnTimer = 0;
  state.nextEnemyId = state.playerCount + 1;
  state.eagleDestroyed = false;
  state.pendingResult = null;
  state.resultTimer = 0;
  // scoreByPlayer 跨关累积、保持不动；killsByPlayer 每关独立、清零重建。
  state.killsByPlayer = emptyKillsByPlayer(state.playerCount);
  state.powerups = [];
  state.playerFreezeTicks = 0;
  state.playerSlowTicks = 0;
  state.enemyFreezeTicks = 0;
  state.enemySlowTicks = 0;
  state.shovelTicks = 0;
  // 新关卡重新洗一副中立道具队列（Boss 关用专属池），计时归位到首枚延迟。
  state.neutralQueue = shuffledNeutralQueue(state.rng, state.boss !== null);
  if (state.escort) {
    const wrench = state.neutralQueue.indexOf('wrench');
    if (wrench > 0) {
      [state.neutralQueue[0], state.neutralQueue[wrench]] =
        [state.neutralQueue[wrench], state.neutralQueue[0]];
    }
  }
  state.neutralTimer = NEUTRAL_POWERUP_FIRST_TICKS;
  state.enemiesDequeued = 0;
  state.paused = false;
  state.pausedBy = -1;
  state.prevPause = false;

  // MVP 奖励投放（多人局）：种类由 state.rng 从强力道具池随机取，位置为该玩家出生点正上方
  // 一个坦克身位（y−16，越界钳到 0），一进关卡就能顺手吃到。单机局 mvpIndex 恒为 -1，不发。
  if (mvpIndex >= 0) {
    const kind = MVP_POWERUP_KINDS[state.rng.int(MVP_POWERUP_KINDS.length)];
    const spawn = escortPlayerSpawn(state.escort, mvpIndex, state.level);
    state.powerups.push({ kind, x: spawn.x, y: Math.max(0, spawn.y - TANK_SIZE) });
  }

  // 多人合作：团队过关 = 全队一起进下一关 —— 新关卡全员生命恢复到初始值，阵亡者重新入场
  //（star 等级不保留，从 0 开始）。单人保持 NES 原版规则：生命跨关累积。
  if (state.playerCount > 1) {
    state.livesByPlayer.fill(PLAYER_LIVES_START_MP);
  }

  // 尚有生命的玩家在各自出生点复活（经出生闪光入场），并沿用其 star 等级 / 武器 / 钻头。
  for (let i = 0; i < state.playerCount; i++) {
    if (state.livesByPlayer[i] <= 0) continue;
    const tank = createPlayer(i, i + 1);
    const spawn = escortPlayerSpawn(state.escort, i, state.level);
    tank.x = spawn.x;
    tank.y = spawn.y;
    tank.level = levelByPlayer[i];
    tank.weapon = weaponByPlayer[i];
    tank.drill = drillByPlayer[i];
    state.spawning.push({ tank, ticksLeft: SPAWN_FLASH_TICKS });
  }

  // 记录新关开始时的累计分快照（下一次 nextStage 据此算本关得分差、评 MVP）。
  state.stageScoreStart = state.scoreByPlayer.slice();

  // 进入开场幕布。
  state.phase = 'stagestart';
  state.phaseTicks = 0;
  state.events.push('stageStart');
}

// 就地重置为全新的第 1 关（保留同一 state 对象引用，供 main.ts 持有）——一切归零（生命/得分/等级/关号）。
// 用于 gameover 时按 start 重开整局：seed 由旧 rng 派生，保持确定性；玩家数沿用本局。
export function resetGameState(state: GameState, seed: number): void {
  const nextLevelEpoch = state.levelEpoch + 1;
  const fresh = createGameState(seed, state.playerCount, 1);
  fresh.levelEpoch = nextLevelEpoch;
  Object.assign(state, fresh);
}

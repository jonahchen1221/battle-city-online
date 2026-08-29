import { Rng, createRng } from '../core/rng';
import {
  PLAYER_LIVES_START,
  PLAYER_LIVES_START_MP,
  STAGE_COUNT,
  STAGE_ENEMY_MIX,
  bossOrdinalForStage,
  stageGroup,
  stageKind,
  SPAWN_FLASH_TICKS,
  NEUTRAL_POWERUP_FIRST_TICKS,
  TANK_SIZE,
} from '../core/constants';
import { LevelState, cloneLevel, levelHasWater } from './level';
import {
  bossArenaConfigForStage,
  bossPlayerSpawnForStage,
  normalLevelForStage,
  versusArenaForStage,
} from './levels';
import {
  TankState,
  TankKind,
  EnemyKind,
  WeaponKind,
  createPlayer,
  createVersusEnemy,
  isPlayerTank,
  restorePlayerUpgrade,
} from './tank';
import { BulletState } from './bullet';
import { shuffledNeutralQueue } from './powerup';
import type { PowerupState, PowerupKind } from './powerup';
import { createBoss } from './boss';
import type { BossState, MineState } from './boss';
import {
  createEscortLevel,
  createEscortState,
  escortPlayerSpawn,
  escortVariantForStage,
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
  | 'dash' // 玩家冲刺（技能触发）
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
  // Boss 关（每组第 3 关：3 / 7 / … / 39）的 Boss 实体；其他关恒为 null。
  // 纯数据，随快照整体下发；过关条件与败因判定见 phase.ts。
  boss: BossState | null;
  // Boss 沿途布下的地雷（仅第 6 位起的 Boss 会布雷）：普通关 / 护送关恒为空数组，
  // 因此对既有关卡零影响。纯数据，随快照整体下发。
  mines: MineState[];
  nextMineId: number; // 地雷 id 分配器（联机插值按此稳定匹配）
  phase: Phase; // 当前阶段
  phaseTicks: number; // 进入当前阶段以来的帧数（stagestart 幕布计时 / gameover 滑入动画等据此推算）
  eagleDestroyed: boolean; // 鹰巢（基地）是否已被摧毁
  escort: EscortState | null; // 护送关的移动鹰巢；普通关为 null
  playerCount: number; // 本局玩家数（1–4）
  // 当前可操控的玩家数。本地局等于 playerCount；联机局由服务器逐帧更新，
  // 护送关据此调整护卫位数，渲染层也能显示与规则一致的标记。
  activePlayerCount: number;
  livesByPlayer: number[]; // 每名玩家的剩余生命（含当前在场坦克），按 playerIndex 索引
  // 对战关每个 AI 席位的剩余生命（含当前在场/复活中坦克）；非对战关恒为空。
  versusLivesByEnemy: number[];
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
  neutralQueue: PowerupKind[]; // 本关剩余待刷的中立道具（开关洗牌；无水场景不含船）
  neutralTimer: number; // 距下一枚中立道具刷新的剩余帧（仅 playing 期间递减）
  enemiesDequeued: number; // 已出队敌军计数（用于按第 4/11/18 台标记携带者）
  // 本关开始时每名玩家的累计分快照：nextStage 据此算出上一关各人得分差，评出 MVP（仅多人局）。
  stageScoreStart: number[];
  // 本关开场时的完整检查点。仅权威模拟持有，不随网络快照下发；GAME OVER 重试时恢复。
  stageStartCheckpoint: StageStartCheckpoint | null;
  events: GameEvent[]; // 本帧音效 / UI 事件队列；main.ts 逐帧读取并清空
}

// 检查点只保留纯数据：rng 以其内部状态代替，events 与检查点自身不递归保存。
// 因此即使 GameState 新增普通可序列化字段，也会自动纳入重试恢复范围。
export type StageStartCheckpoint = Omit<
  GameState,
  'rng' | 'events' | 'stageStartCheckpoint' | 'activePlayerCount'
> & {
  rngState: number;
};

function cloneCheckpoint(checkpoint: StageStartCheckpoint): StageStartCheckpoint {
  return structuredClone(checkpoint);
}

function saveStageStartCheckpoint(state: GameState): void {
  const {
    rng,
    events: _events,
    stageStartCheckpoint: _stageStartCheckpoint,
    activePlayerCount: _activePlayerCount,
    ...serializableState
  } = state;
  state.stageStartCheckpoint = cloneCheckpoint({
    ...serializableState,
    rngState: rng.getState(),
  });
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
  const kind = stageKind(stage);
  if (kind === 'boss' || kind === 'versus') return [];
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

// 护送关抵达前会按本关原始编成循环呼叫援军。普通关仍只使用初始化时的一轮有限队列。
export function createStageEnemyQueue(stage: number): TankKind[] {
  return createStageQueue(stage);
}

function prioritizeEscortNeutralQueue(queue: PowerupKind[], stage: number): void {
  const wrench = queue.indexOf('wrench');
  if (wrench > 0) [queue[0], queue[wrench]] = [queue[wrench], queue[0]];

  // 群岛船坞的核心分流是“守桥或驾船走水路”；确保第二枚中立道具就是船，让这条支线
  // 稳定出现而不依赖洗牌。首枚扳手仍保留护送关统一的倒计时容错。
  if (escortVariantForStage(stage) === 7) {
    const boat = queue.indexOf('boat');
    if (boat > 1) [queue[1], queue[boat]] = [queue[boat], queue[1]];
  }
}

// 建立一局全新游戏。stage 为 1-based 关号（默认第 1 关），载入对应关卡地形与出生队列。
// 开局即进入 'stagestart' 幕布（模拟冻结，STAGE_START_TICKS 帧后自动转 playing），并发一次 stageStart 事件。
export function createGameState(seed: number, playerCount = 1, stage = 1): GameState {
  // 关卡类型（普通 / 护送 / Boss）单点分流：取图、建队列、建 boss/escort 全部据此。
  const kind = stageKind(stage);
  const escortStage = kind === 'escort';
  const bossStage = kind === 'boss';
  const versusStage = kind === 'versus';
  const bossArena = bossStage ? bossArenaConfigForStage(stage) : null;
  const level = escortStage
    ? createEscortLevel(stage)
    : cloneLevel(
        bossStage
          ? bossArena!.level
          : versusStage
            ? versusArenaForStage(stage)
            : normalLevelForStage(stage),
      );
  const escort = escortStage ? createEscortState(level, stage) : null;
  const startingLives = playerCount > 1 ? PLAYER_LIVES_START_MP : PLAYER_LIVES_START;
  const livesByPlayer = new Array<number>(playerCount).fill(startingLives);
  // 玩家坦克：id 为 1..N，playerIndex 为 0..N-1。
  const tanks: TankState[] = [];
  for (let i = 0; i < playerCount; i++) {
    const tank = createPlayer(i, i + 1);
    const spawn = bossStage
      ? bossPlayerSpawnForStage(stage, i)
      : escortPlayerSpawn(escort, i, level);
    tank.x = spawn.x;
    tank.y = spawn.y;
    tanks.push(tank);
  }
  // 对战关不走敌军队列：与玩家同时在场的 N 台智能坦克各占一个稳定席位。
  if (versusStage) {
    for (let i = 0; i < playerCount; i++) {
      tanks.push(createVersusEnemy(i, playerCount + i + 1));
    }
  }
  // rng 先行创建：本关中立道具队列的洗牌即取自它（必须在 state 组装前完成）。
  const rng = createRng(seed);
  // Boss 关走专属中立池（2 星 + 头盔 + 战靴 + 1 件随机武器）；普通关 / 护送关无水时排除船。
  const neutralQueue = shuffledNeutralQueue(rng, bossStage, levelHasWater(level));
  // 护送关首枚中立道具固定为扳手，让玩家在 10 秒后稳定获得一次倒计时奖励。
  if (escort) {
    prioritizeEscortNeutralQueue(neutralQueue, stage);
  }
  const state: GameState = {
    tick: 0,
    rng,
    levelEpoch: 0,
    // 拷贝一份，避免就地破坏砖块时污染关卡模板。
    level,
    tanks,
    bullets: [],
    spawning: [],
    explosions: [],
    enemyQueue: createStageQueue(stage),
    enemySpawnTimer: 0, // 开局即可出生第一台
    nextEnemyId: versusStage ? playerCount * 2 + 1 : playerCount + 1, // 对战 AI 紧随玩家 id
    nextBulletId: 1,
    stage,
    // Boss 关：幕布结束后 Boss 即已在位（不走出生闪光）。普通关为 null。
    // 第 b 位 Boss（b = 组号）：血量 / 攻击间隔 / 技能池全部按序号取（见 constants）。
    boss: bossStage
      ? createBoss(playerCount, bossOrdinalForStage(stage), bossArena!.bossSpawn)
      : null,
    mines: [],
    nextMineId: 1,
    phase: 'stagestart',
    phaseTicks: 0,
    eagleDestroyed: false,
    escort,
    playerCount,
    activePlayerCount: playerCount,
    // 单机 3 条（NES 原版）；多人合作 5 条（且可向队友借命，见 death.ts onPlayerKilled）。
    livesByPlayer,
    // 对战双方开局命数完全一致，一一对应；普通/护送/Boss 关不使用。
    versusLivesByEnemy: versusStage ? livesByPlayer.slice() : [],
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
    stageStartCheckpoint: null,
    events: ['stageStart'],
  };
  saveStageStartCheckpoint(state);
  return state;
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
  const nextBossArena = nextKind === 'boss' ? bossArenaConfigForStage(nextStageNum) : null;

  // ── MVP 开局奖励（仅多人局）──
  // 规则：以「本关得分差」评 MVP —— delta[i] = 当前累计分 − 本关开始时的累计分快照；
  // 取 delta 最高者，并列时取 playerIndex 最小者（全员 delta 为 0 也照发，由并列规则兜底）。
  // 奖励固定为一枚五角星，刷在 MVP 下一关出生点的正前方（朝上一个坦克身位）。
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

  // 先捕获每名玩家当前 star 等级、剩余车体生命、护甲、武器与钻头（均跨关保留）。
  // 关内被击毁后复活仍走 createPlayer，所有升级照旧清零。
  const levelByPlayer = new Array<number>(state.playerCount).fill(0);
  const hpByPlayer = new Array<number>(state.playerCount).fill(1);
  const armorByPlayer = new Array<number>(state.playerCount).fill(0);
  const weaponByPlayer = new Array<WeaponKind>(state.playerCount).fill('cannon');
  const drillByPlayer = new Array<boolean>(state.playerCount).fill(false);
  const capture = (t: TankState): void => {
    if (!isPlayerTank(t)) return;
    levelByPlayer[t.playerIndex] = t.level;
    hpByPlayer[t.playerIndex] = t.hp;
    armorByPlayer[t.playerIndex] = t.armor;
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
            ? nextBossArena!.level
            : nextKind === 'versus'
              ? versusArenaForStage(nextStageNum)
              : normalLevelForStage(nextStageNum),
        );
  state.escort = nextKind === 'escort' ? createEscortState(state.level, nextStageNum) : null;
  state.enemyQueue = createStageQueue(nextStageNum);
  // Boss 关重建一台满血 Boss（按新关号取序号）；普通关 / 护送关清空。地雷一律清场。
  state.boss =
    nextKind === 'boss'
      ? createBoss(
          state.playerCount,
          bossOrdinalForStage(nextStageNum),
          nextBossArena!.bossSpawn,
        )
      : null;
  state.mines = [];

  // 每关独立的战斗态一律清空。
  state.tanks = [];
  state.bullets = [];
  state.spawning = [];
  state.explosions = [];
  state.enemySpawnTimer = 0;
  state.nextEnemyId = state.playerCount + 1;
  state.versusLivesByEnemy = [];
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
  state.neutralQueue = shuffledNeutralQueue(
    state.rng,
    state.boss !== null,
    levelHasWater(state.level),
  );
  if (state.escort) {
    prioritizeEscortNeutralQueue(state.neutralQueue, nextStageNum);
  }
  state.neutralTimer = NEUTRAL_POWERUP_FIRST_TICKS;
  state.enemiesDequeued = 0;
  state.paused = false;
  state.pausedBy = -1;
  state.prevPause = false;

  // MVP 奖励投放（多人局）：固定五角星，位置为该玩家出生点正上方一个坦克身位
  //（y−16，越界钳到 0），一进关卡就能顺手吃到。单机局 mvpIndex 恒为 -1，不发。
  if (mvpIndex >= 0) {
    const spawn =
      nextKind === 'boss'
        ? bossPlayerSpawnForStage(nextStageNum, mvpIndex)
        : escortPlayerSpawn(state.escort, mvpIndex, state.level);
    state.powerups.push({ kind: 'star', x: spawn.x, y: Math.max(0, spawn.y - TANK_SIZE) });
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
    const spawn =
      nextKind === 'boss'
        ? bossPlayerSpawnForStage(nextStageNum, i)
        : escortPlayerSpawn(state.escort, i, state.level);
    tank.x = spawn.x;
    tank.y = spawn.y;
    restorePlayerUpgrade(tank, levelByPlayer[i], hpByPlayer[i], armorByPlayer[i]);
    tank.weapon = weaponByPlayer[i];
    tank.drill = drillByPlayer[i];
    state.spawning.push({ tank, ticksLeft: SPAWN_FLASH_TICKS });
  }

  // 对战关为每名玩家建立一名独立 AI 对手。AI 命数复制对应玩家进入本关时的命数，
  // 两边都经过同样的出生闪光入场；后续复活由 death.ts 按席位单独结算。
  if (nextKind === 'versus') {
    state.versusLivesByEnemy = state.livesByPlayer.slice();
    for (let i = 0; i < state.playerCount; i++) {
      const tank = createVersusEnemy(i, state.playerCount + i + 1);
      state.spawning.push({ tank, ticksLeft: SPAWN_FLASH_TICKS });
    }
    state.nextEnemyId = state.playerCount * 2 + 1;
  }

  // 记录新关开始时的累计分快照（下一次 nextStage 据此算本关得分差、评 MVP）。
  state.stageScoreStart = state.scoreByPlayer.slice();

  // 进入开场幕布。
  state.phase = 'stagestart';
  state.phaseTicks = 0;
  state.events.push('stageStart');
  saveStageStartCheckpoint(state);
}

// GAME OVER 后把当前关卡恢复为刚进入时的完整状态：关号、生命、分数、装备、地图、
// 敌军编成、Boss / 护送状态与后续随机序列都会回到检查点。levelEpoch 仍单调递增，
// 让联机客户端一定收到恢复后的完整地形；events 只重新发出本关开场音效。
export function restoreStageStart(state: GameState): void {
  const checkpoint = state.stageStartCheckpoint;
  if (!checkpoint) return;

  const nextLevelEpoch = state.levelEpoch + 1;
  const restored = cloneCheckpoint(checkpoint);
  const { rngState, ...serializableState } = restored;
  Object.assign(state, serializableState, {
    rng: createRng(rngState),
    levelEpoch: nextLevelEpoch,
    stageStartCheckpoint: checkpoint,
    events: ['stageStart'] satisfies GameEvent[],
  });
}

// 就地重置为全新的第 1 关（保留同一 state 对象引用，供 main.ts 持有）——一切归零（生命/得分/等级/关号）。
// 用于 gameover 时按 start 重开整局：seed 由旧 rng 派生，保持确定性；玩家数沿用本局。
export function resetGameState(state: GameState, seed: number): void {
  const nextLevelEpoch = state.levelEpoch + 1;
  const fresh = createGameState(seed, state.playerCount, 1);
  fresh.levelEpoch = nextLevelEpoch;
  Object.assign(state, fresh);
}

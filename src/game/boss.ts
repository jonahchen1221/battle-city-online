import {
  BOSS_SIZE,
  BOSS_X,
  BOSS_Y,
  BOSS_OWNER_ID,
  BOSS_DAMAGE_NORMAL,
  BOSS_DAMAGE_LASER,
  BOSS_HIT_FLASH_TICKS,
  BOSS_PHASE2_HP_RATIO,
  BOSS_LASER_WINDUP_TICKS,
  BOSS_LASER_ACTIVE_TICKS,
  BOSS_LASER_WIDTH,
  BOSS_DUAL_LASER_SOLO_OFFSET,
  BOSS_RADIAL_BULLETS,
  BOSS_RADIAL_SPEED,
  BOSS_BURST_SHOTS,
  BOSS_BURST_INTERVAL_TICKS,
  BOSS_BURST_SPEED,
  BOSS_SPIN_WAVES,
  BOSS_SPIN_BULLETS,
  BOSS_SPIN_WAVE_INTERVAL_TICKS,
  BOSS_SPIN_STEP_RAD,
  BOSS_SPIN_SPEED,
  BOSS_DEATH_EXPLOSION_MIN,
  BOSS_DEATH_EXPLOSION_RANGE,
  BOSS_MINION_INTERVAL_TICKS,
  BOSS_SPEED,
  BOSS_SPEED_SOLO_P2,
  BOSS_MOVE_COMMIT_TICKS,
  BOSS_BREACH_INTERVAL_TICKS,
  BOSS_BREACH_BULLET_SPEED,
  BOSS_WALL_SPACING,
  BOSS_WALL_GAP_SLOTS,
  BOSS_WALL_SPEED,
  BOSS_CHARGE_WARN_TICKS,
  BOSS_CHARGE_SPEED,
  BOSS_CHARGE_STUN_STEEL_TICKS,
  BOSS_CHARGE_STUN_SOFT_TICKS,
  BOSS_MORTAR_COUNT,
  BOSS_MORTAR_FUSE_TICKS,
  BOSS_MORTAR_SCATTER,
  BOSS_MORTAR_BLAST,
  BOSS_SUMMON_COUNT,
  BOSS_ENEMY_HARD_CAP,
  BOSS_MINE_SIZE,
  BOSS_MINE_MAX,
  BOSS_MINE_INTERVAL_TICKS,
  BOSS_MINE_ARM_TICKS,
  BOSS_MINE_LIFE_TICKS,
  BOSS_MAGNET_WARN_TICKS,
  BOSS_MAGNET_TICKS,
  BOSS_MAGNET_PULL_PER_TICK,
  BOSS_MAGNET_WAVE_INTERVAL_TICKS,
  BOSS_MAGNET_BULLETS,
  BOSS_MAGNET_SPEED,
  BOSS_SWEEP_WARN_TICKS,
  BOSS_SWEEP_SPEED,
  BOSS_ENRAGE_ORDINAL,
  BOSS_ENRAGE_HP_RATIO,
  BOSS_ENRAGE_BULLET_SPEED_MULT,
  BOSS_MINION_CARRIER_EVERY,
  SPAWN_FLASH_TICKS,
  bossAttackIntervalTicks,
  bossMaxHp,
  bossMinesEnabled,
  bossMinionKindsForStage,
  bossSkillsFor,
  BULLET_SIZE,
  TANK_SIZE,
  FIELD_WIDTH,
  FIELD_HEIGHT,
  SUBTILE,
  EXPLOSION_BIG_TICKS,
  EXPLOSION_BIG_SIZE,
} from '../core/constants';
import type { Direction } from '../core/types';
import { TankState, canTankOccupy, createEnemy, isPlayerTank } from './tank';
import { BulletState, bulletHitRect, makeSmallExplosion } from './bullet';
import { damagePlayerTank, destroyPlayerTank } from './death';
import { Cell, brickMaskOverlapsRect, getCell, setCell } from './level';
import { applyBossArenaPhase2 } from './levels';
import type { GameState } from './state';

// Boss 关的核心逻辑（纯模拟层）：一切随机取自 state.rng，BossState 全部为可序列化的纯数据。
// Boss 不是 TankState —— 它是 32×32、可移动、只有玩家子弹能伤到的独立实体。
//
// 十位 Boss 共用这一套状态机：序号 b（= BossState.ordinal，1..10）决定血量、攻击间隔、
// 攻击池（constants 的 bossSkillsFor 表）与被动布雷；第 10 位另有狂暴（enraged）。

// Boss 当前攻击。'none' = 冷却中（attackTimer 递减）。
// 前六种为 1 号 Boss 的基础组，其余按序号累积解锁（见 constants bossSkillsFor）。
export type BossAttackKind =
  | 'none'
  | 'laser'
  | 'radial'
  | 'burst'
  | 'spin'
  | 'dualLaser'
  | 'bulletWall'
  | 'charge'
  | 'mortar'
  | 'summon'
  | 'magnet'
  | 'sweepLaser';

// 迫击炮落点：16×16 爆炸判定盒的左上角 + 引信剩余帧。纯数据，随快照下发。
export interface BossMortarMark {
  x: number;
  y: number;
  ticksLeft: number;
}

// 地雷（Boss 序号 ≥6 的被动技能产物）：8×8，纯数据，存在 GameState.mines。
// 普通关 / 护送关该数组恒为空，因此不影响任何既有关卡。
export interface MineState {
  id: number;
  x: number; // 8×8 盒左上角（战场相对像素）
  y: number;
  armTicks: number; // 武装倒计时：>0 时碰触无害
  lifeTicks: number; // 剩余存活帧：归零自爆消失
}

// Boss 实体：纯数据、可序列化（无函数 / 类实例），随快照整体下发。
export interface BossState {
  ordinal: number; // Boss 序号 b（1..10，= 关卡组号）：血量 / 间隔 / 攻击池 / 布雷全按它索引
  enraged: boolean; // 狂暴（仅第 10 位、hp < 25% 时进入，单向）：间隔 ×0.75、弹速 ×1.2
  hp: number;
  maxHp: number;
  phase: 1 | 2; // 阶段（hp < maxHp/2 时转 2，单向不回退）
  x: number; // 32×32 车体左上角
  y: number;
  size: number; // 车体边长（= BOSS_SIZE，随快照一并下发，渲染层不必再查常量）
  dir: Direction; // 车体 / 炮塔朝向（移动或破障方向）
  moveDir: Direction; // 当前追踪移动方向
  moveCommitTicks: number; // 方向承诺剩余帧：>0 时优先沿用 moveDir（被堵则立即解除），抑制甩头
  moving: boolean; // 本帧是否实际移动（供渲染 / 调试）
  breachCooldown: number; // 破障双发激光冷却
  hitFlash: number; // 受击白闪剩余帧
  attack: BossAttackKind; // 当前攻击
  attackTimer: number; // 距下次发动攻击的剩余帧（attack==='none' 时递减）
  windupTicks: number; // 激光前摇剩余帧（>0 期间只显示瞄准线，不伤人）
  activeTicks: number; // 激光持续剩余帧（>0 期间每帧判定）
  stepTimer: number; // 连射 / 波次的间隔计时
  stepsLeft: number; // 剩余连射发数 / 剩余波数
  laserCols: number[]; // 本次激光各列的中心 x（战场相对像素）
  laserHitPlayers: number[]; // 本次激光已结算过的 playerIndex（同一玩家一次激光至多一次）
  spinAngle: number; // 旋转弹幕当前相位角（弧度）
  // ── 新技能的状态字段（全部为纯数据，随快照下发；未解锁的技能恒为初值）──
  stunTicks: number; // 冲撞撞墙后的眩晕剩余帧：>0 时不移动、不攻击，但照常挨打（反制窗口）
  chargeDir: Direction; // 本次蓄力冲撞锁定的冲锋方向（预警期渲染整条路径闪烁）
  mortarMarks: BossMortarMark[]; // 迫击炮落点（引信走完即爆），空数组表示当前无炮击
  sweepX: number; // 横扫激光当前列中心 x（战场相对像素）
  sweepDir: number; // 横扫方向：−1 向左 / +1 向右（0 表示未在横扫）
  mineTimer: number; // 被动布雷倒计时（仅移动状态推进）
  minionTimer: number; // 小兵补充倒计时
  minionsSpawned: number; // 已生成小兵计数（每第 BOSS_MINION_CARRIER_EVERY 只携带道具）
  freezeTicks: number; // timer（时钟）冻结剩余帧：>0 时不动、不破障、攻击状态机整体暂停
  slowTicks: number; // hourglass（沙漏）半速剩余帧：>0 时仅偶数 tick 推进移动与攻击
  dead: boolean; // 已被击杀（弹幕已清、大爆炸已播；过关判定据此）
}

// 建立第 bossOrdinal 位 Boss：血量随人数与序号放大，开局即在竞技场配置的 spawn
// 就位（不走出生闪光），第一次攻击等一个完整冷却（长度同样按序号收紧）。
export function createBoss(
  playerCount: number,
  bossOrdinal = 1,
  spawn: { x: number; y: number } = { x: BOSS_X, y: BOSS_Y },
): BossState {
  return {
    ordinal: bossOrdinal,
    enraged: false,
    hp: bossMaxHp(playerCount, bossOrdinal),
    maxHp: bossMaxHp(playerCount, bossOrdinal),
    phase: 1,
    x: spawn.x,
    y: spawn.y,
    size: BOSS_SIZE,
    dir: 'down',
    moveDir: 'down',
    moveCommitTicks: 0,
    moving: false,
    breachCooldown: 0,
    hitFlash: 0,
    attack: 'none',
    attackTimer: bossAttackIntervalTicks(1, bossOrdinal),
    windupTicks: 0,
    activeTicks: 0,
    stepTimer: 0,
    stepsLeft: 0,
    laserCols: [],
    laserHitPlayers: [],
    spinAngle: 0,
    stunTicks: 0,
    chargeDir: 'down',
    mortarMarks: [],
    sweepX: 0,
    sweepDir: 0,
    mineTimer: BOSS_MINE_INTERVAL_TICKS,
    minionTimer: BOSS_MINION_INTERVAL_TICKS,
    minionsSpawned: 0,
    freezeTicks: 0,
    slowTicks: 0,
    dead: false,
  };
}

// Boss 车体 AABB。
function bossRect(boss: BossState): { x0: number; y0: number; x1: number; y1: number } {
  return { x0: boss.x, y0: boss.y, x1: boss.x + boss.size, y1: boss.y + boss.size };
}

// Boss 车体对坦克是实心障碍。移动碰撞（tank.ts）只认 16×16 的 TankState 盒，
// 因此把 32×32 车体拆成 2×2 个 16×16 的“伪坦克”交给既有夹紧逻辑 —— 它们只在本帧的
// 碰撞数组里存在，绝不进入 state.tanks，也不参与任何结算（子弹 / 计分 / 胜负）。
// id 取负数，与真实坦克（≥1）永不冲突。
export function bossBlockerTanks(boss: BossState | null): TankState[] {
  if (!boss || boss.dead) return [];
  const cells = boss.size / TANK_SIZE; // 2
  const out: TankState[] = [];
  for (let r = 0; r < cells; r++) {
    for (let c = 0; c < cells; c++) {
      const blocker = createEnemy('armor', -(out.length + 1), 0);
      blocker.x = boss.x + c * TANK_SIZE;
      blocker.y = boss.y + r * TANK_SIZE;
      out.push(blocker);
    }
  }
  return out;
}

// 本帧用于移动碰撞的完整占位数组：场上坦克 + Boss 车体伪坦克。
export function collisionTanks(state: GameState): TankState[] {
  const blockers = bossBlockerTanks(state.boss);
  return blockers.length === 0 ? state.tanks : state.tanks.concat(blockers);
}

// 场上存活的玩家坦克（按 playerIndex 升序，保证随机取样确定性）。
function alivePlayers(state: GameState): TankState[] {
  return state.tanks
    .filter((t) => t.alive && isPlayerTank(t))
    .sort((a, b) => a.playerIndex - b.playerIndex);
}

// 距 Boss 中心最近的玩家；完全同距时 playerIndex 小者优先（结果稳定可复现）。
function nearestPlayer(state: GameState, boss: BossState): TankState | null {
  const cx = boss.x + boss.size / 2;
  const cy = boss.y + boss.size / 2;
  let best: TankState | null = null;
  let bestDistance = Infinity;
  for (const t of alivePlayers(state)) {
    const dx = t.x + TANK_SIZE / 2 - cx;
    const dy = t.y + TANK_SIZE / 2 - cy;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      best = t;
      bestDistance = distance;
    }
  }
  return best;
}

const EPS = 1e-6;
const BOSS_MOVE_DIRECTIONS: ReadonlyArray<Direction> = ['up', 'down', 'left', 'right'];

function bossOverlapsTank(x: number, y: number, size: number, tank: TankState): boolean {
  return (
    x < tank.x + TANK_SIZE &&
    x + size > tank.x &&
    y < tank.y + TANK_SIZE &&
    y + size > tank.y
  );
}

interface BossMoveProbe {
  x: number;
  y: number;
  blocked: boolean;
  destructible: boolean;
}

// 探测 Boss 沿某方向走一步（步长 speed）后的 32×32 完整车体。只有砖墙（含残砖）可破坏；
// 钢墙、水、鹰巢、边界和坦克一律只能绕行 —— 破障激光已不再穿钢，钢块对 Boss 是永久障碍。
// Boss 不碾压玩家 / 小兵，避免生成无法解开的重叠状态。
function probeBossMove(
  state: GameState,
  boss: BossState,
  dir: Direction,
  speed: number,
): BossMoveProbe {
  let x = boss.x;
  let y = boss.y;
  if (dir === 'up') y -= speed;
  else if (dir === 'down') y += speed;
  else if (dir === 'left') x -= speed;
  else x += speed;

  if (x < 0 || y < 0 || x + boss.size > FIELD_WIDTH || y + boss.size > FIELD_HEIGHT) {
    return { x, y, blocked: true, destructible: false };
  }

  let blocked = false;
  let brickBlocked = false;
  let hardBlocked = false; // 钢 / 水 / 鹰巢 / 坦克：破障也开不出路，只能换方向
  const c0 = Math.floor(x / SUBTILE);
  const c1 = Math.floor((x + boss.size - EPS) / SUBTILE);
  const r0 = Math.floor(y / SUBTILE);
  const r1 = Math.floor((y + boss.size - EPS) / SUBTILE);
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      const cell = getCell(state.level, col, row);
      if (cell === Cell.BRICK) {
        if (brickMaskOverlapsRect(state.level, col, row, x, y, x + boss.size, y + boss.size)) {
          blocked = true;
          brickBlocked = true;
        }
      } else if (cell === Cell.STEEL || cell === Cell.WATER || cell === Cell.EAGLE) {
        blocked = true;
        hardBlocked = true;
      }
    }
  }

  for (const tank of state.tanks) {
    if (!tank.alive) continue;
    if (bossOverlapsTank(x, y, boss.size, tank)) {
      blocked = true;
      hardBlocked = true;
    }
  }
  // 只有“纯砖块挡路”才值得开破障 —— 混着钢块时打穿砖也过不去，直接换方向。
  return { x, y, blocked, destructible: brickBlocked && !hardBlocked };
}

// 以追踪目标为主生成稳定的候选方向：优先走距离更长的轴，再试另一轴，最后尝试其余方向。
// 不使用随机数，因此相同状态下的移动选择完全一致，服务器快照可复现。
function bossMoveCandidates(boss: BossState, target: TankState): Direction[] {
  const dx = target.x + TANK_SIZE / 2 - (boss.x + boss.size / 2);
  const dy = target.y + TANK_SIZE / 2 - (boss.y + boss.size / 2);
  const horizontal: Direction = dx < 0 ? 'left' : 'right';
  const vertical: Direction = dy < 0 ? 'up' : 'down';
  const preferred = Math.abs(dx) > Math.abs(dy)
    ? [horizontal, vertical]
    : [vertical, horizontal];
  const out: Direction[] = [];
  for (const dir of [...preferred, boss.moveDir, ...BOSS_MOVE_DIRECTIONS]) {
    if (!out.includes(dir)) out.push(dir);
  }
  return out;
}

function makeBreachBullet(
  state: GameState,
  boss: BossState,
  dir: Direction,
  laneOffset: number,
): BulletState {
  let x: number;
  let y: number;
  let vx = 0;
  let vy = 0;
  if (dir === 'up' || dir === 'down') {
    x = boss.x + laneOffset - BULLET_SIZE / 2;
    y = dir === 'up' ? boss.y : boss.y + boss.size - BULLET_SIZE;
    vy = dir === 'up' ? -BOSS_BREACH_BULLET_SPEED : BOSS_BREACH_BULLET_SPEED;
  } else {
    x = dir === 'left' ? boss.x : boss.x + boss.size - BULLET_SIZE;
    y = boss.y + laneOffset - BULLET_SIZE / 2;
    vx = dir === 'left' ? -BOSS_BREACH_BULLET_SPEED : BOSS_BREACH_BULLET_SPEED;
  }
  return {
    id: state.nextBulletId++,
    x,
    y,
    prevX: x,
    prevY: y,
    dir,
    speed: BOSS_BREACH_BULLET_SPEED,
    vx,
    vy,
    age: 0,
    kind: 'laser',
    ownerId: BOSS_OWNER_ID,
    ownerPlayerIndex: -1,
    fromEnemy: true,
    attacksEagle: false,
    alive: true,
    viewportBounds: null,
    // 破障激光只穿砖不穿钢：命中钢块即消亡，钢块保留（掩体不再被 Boss 瞬间蒸发）。
    steelPiercing: false,
  };
}

// 两枚激光分别从车体 1/4 与 3/4 线出膛。每枚激光开 16px 宽的破坏带，
// 合起来为 32px Boss 车体清出完整通路；激光沿途可连续击穿砖块，撞上钢块即止。
function fireBreachVolley(state: GameState, boss: BossState, dir: Direction): void {
  state.bullets.push(
    makeBreachBullet(state, boss, dir, boss.size / 4),
    makeBreachBullet(state, boss, dir, (boss.size * 3) / 4),
  );
  boss.breachCooldown = BOSS_BREACH_INTERVAL_TICKS;
}

// 本帧的追踪步长。单机减压：一阶段 Boss 定点不动（速度 0 → 不追踪也不破障，攻击照常），
// 二阶段起以 BOSS_SPEED_SOLO_P2 慢速追踪；多人局两阶段都用 BOSS_SPEED。
function bossMoveSpeed(state: GameState, boss: BossState): number {
  if (state.playerCount !== 1) return BOSS_SPEED;
  return boss.phase === 2 ? BOSS_SPEED_SOLO_P2 : 0;
}

function moveBoss(state: GameState, boss: BossState, target: TankState | null): void {
  boss.moving = false;
  if (boss.breachCooldown > 0) boss.breachCooldown--;
  const speed = bossMoveSpeed(state, boss);
  if (speed <= 0 || !target) return;

  // 贴身站定：追击轴上与目标只剩不到一步的间隙、且另一轴车体投影已重叠（真·脸贴脸）时，
  // 面向目标原地输出攻击。否则会为“再挤近半步”在两轴间来回改向，表现为贴身甩头。
  const dx = target.x + TANK_SIZE / 2 - (boss.x + boss.size / 2);
  const dy = target.y + TANK_SIZE / 2 - (boss.y + boss.size / 2);
  const halfSum = (boss.size + TANK_SIZE) / 2;
  const gapX = Math.abs(dx) - halfSum; // ≤0 = X 轴投影重叠
  const gapY = Math.abs(dy) - halfSum;
  if (gapX <= speed && gapY <= 0) {
    boss.dir = dx < 0 ? 'left' : 'right';
    boss.moveDir = boss.dir;
    return;
  }
  if (gapY <= speed && gapX <= 0) {
    boss.dir = dy < 0 ? 'up' : 'down';
    boss.moveDir = boss.dir;
    return;
  }

  // 方向承诺期：换向后至少坚持 BOSS_MOVE_COMMIT_TICKS 帧（被堵或该轴走完则立即解除并重评估）。
  // 没有它会出现两类甩头：斜向追击时 |dx|≈|dy| 导致主次轴逐帧互换（楼梯抖动）、
  // 绕障时逐帧重评估导致的来回横跳。
  if (boss.moveCommitTicks > 0) {
    boss.moveCommitTicks--;
    const step = bossStepFor(dx, dy, boss.moveDir, speed);
    if (step > 0) {
      const probe = probeBossMove(state, boss, boss.moveDir, step);
      if (!probe.blocked) {
        boss.x = probe.x;
        boss.y = probe.y;
        boss.moving = true;
        return;
      }
    }
    boss.moveCommitTicks = 0; // 被堵 / 该轴走完：立即结束承诺，本帧重评估
  }

  // 重评估：A* 首步优先（钢/水/鹰巢视为障碍、砖视为高代价可穿 —— 需要穿砖时贪心层
  // 自然触发破障），贪心候选序仅作为回退（覆盖 A* 网格不感知的动态障碍：坦克压路等）。
  // 全部方向都被硬障碍堵死时不做任何事（原地停留，攻击照常）—— 绝不会卡死。
  const planned = bossPathDirection(state, boss, target);
  const candidates: Direction[] = [];
  for (const dir of planned
    ? [planned, ...bossMoveCandidates(boss, target)]
    : bossMoveCandidates(boss, target)) {
    if (!candidates.includes(dir)) candidates.push(dir);
  }
  for (const dir of candidates) {
    // 朝目标方向的步长按该轴剩余路程截断（走到对齐即停，杜绝过冲折返）；绕行方向全速。
    const step = bossStepFor(dx, dy, dir, speed);
    if (step <= 0) continue;
    const probe = probeBossMove(state, boss, dir, step);
    if (!probe.blocked) {
      boss.x = probe.x;
      boss.y = probe.y;
      if (dir !== boss.moveDir) boss.moveCommitTicks = BOSS_MOVE_COMMIT_TICKS;
      boss.moveDir = dir;
      boss.dir = dir;
      boss.moving = true;
      return;
    }
    if (probe.destructible) {
      boss.moveDir = dir;
      boss.dir = dir;
      if (boss.breachCooldown === 0) fireBreachVolley(state, boss, dir);
      return;
    }
  }
}

// 某方向的本帧步长：朝目标方向 = min(速度, 该轴与目标中心的剩余距离)，走到对齐即停、
// 杜绝过冲折返；背向目标 / 该轴已对齐 = 全速（此时它是 A* 规划出的绕行步，需要真实位移）。
function bossStepFor(dx: number, dy: number, dir: Direction, speed: number): number {
  switch (dir) {
    case 'left':
      return dx < 0 ? Math.min(speed, -dx) : speed;
    case 'right':
      return dx > 0 ? Math.min(speed, dx) : speed;
    case 'up':
      return dy < 0 ? Math.min(speed, -dy) : speed;
    case 'down':
      return dy > 0 ? Math.min(speed, dy) : speed;
  }
}

// ── Boss 寻路（A*，与智能坦克同款思路但按 32×32 车体规格）──
// 8px 导航网格：车体覆盖 4×4 子格。钢 / 水 / 鹰巢 = 永久障碍；砖 = 可破障但代价高
//（与破障激光机制自洽：A* 只有在绕路太远时才会选择穿砖，届时贪心层自然触发破障）。
// 确定性：开放集为最小堆，同分按 h、再按下标排序；不使用 rng。
const BOSS_NAV_CELLS = 4; // 32 / SUBTILE
const BOSS_NAV_BRICK_COST = 6;

interface BossNavNode {
  index: number;
  f: number;
  h: number;
  seq: number; // 入堆序号：平手时先入先出，使等价最优路径偏向主轴优先（见邻居排序）
}

function bossNavBefore(a: BossNavNode, b: BossNavNode): boolean {
  return a.f < b.f || (a.f === b.f && (a.h < b.h || (a.h === b.h && a.seq < b.seq)));
}

function bossNavPush(heap: BossNavNode[], node: BossNavNode): void {
  heap.push(node);
  let i = heap.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (!bossNavBefore(heap[i], heap[parent])) break;
    [heap[i], heap[parent]] = [heap[parent], heap[i]];
    i = parent;
  }
}

function bossNavPop(heap: BossNavNode[]): BossNavNode | undefined {
  const first = heap[0];
  const last = heap.pop();
  if (heap.length > 0 && last) {
    heap[0] = last;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let best = i;
      if (l < heap.length && bossNavBefore(heap[l], heap[best])) best = l;
      if (r < heap.length && bossNavBefore(heap[r], heap[best])) best = r;
      if (best === i) break;
      [heap[i], heap[best]] = [heap[best], heap[i]];
      i = best;
    }
  }
  return first;
}

// 车体左上角落在 (col,row) 时的进入代价；覆盖的 4×4 子格含永久障碍则不可进入。
function bossNavCost(state: GameState, col: number, row: number): number {
  let hasBrick = false;
  for (let dr = 0; dr < BOSS_NAV_CELLS; dr++) {
    for (let dc = 0; dc < BOSS_NAV_CELLS; dc++) {
      const cell = getCell(state.level, col + dc, row + dr);
      if (cell === Cell.STEEL || cell === Cell.WATER || cell === Cell.EAGLE) return Infinity;
      if (cell === Cell.BRICK) hasBrick = true;
    }
  }
  return hasBrick ? BOSS_NAV_BRICK_COST : 1;
}

// A* 求追向目标的第一步方向。目标不可达时走向已搜索到的离目标最近的可达点；
// 起点即最近点（已被围死）时返回 null，由调用方原地停留。
function bossPathDirection(state: GameState, boss: BossState, target: TankState): Direction | null {
  const level = state.level;
  const navCols = level.cols - BOSS_NAV_CELLS + 1;
  const navRows = level.rows - BOSS_NAV_CELLS + 1;
  const clampCol = (x: number): number =>
    Math.max(0, Math.min(navCols - 1, Math.round(x / SUBTILE)));
  const clampRow = (y: number): number =>
    Math.max(0, Math.min(navRows - 1, Math.round(y / SUBTILE)));
  const startCol = clampCol(boss.x);
  const startRow = clampRow(boss.y);
  // 目标格：车体中心对准玩家中心。
  const goalCol = clampCol(target.x + TANK_SIZE / 2 - boss.size / 2);
  const goalRow = clampRow(target.y + TANK_SIZE / 2 - boss.size / 2);
  const startIndex = startRow * navCols + startCol;
  const goalIndex = goalRow * navCols + goalCol;
  const size = navCols * navRows;
  const costs = new Array<number>(size).fill(Infinity);
  const firstSteps = new Array<Direction | null>(size).fill(null);
  const closed = new Array<boolean>(size).fill(false);
  const open: BossNavNode[] = [];
  const h0 = Math.abs(goalCol - startCol) + Math.abs(goalRow - startRow);
  costs[startIndex] = 0;
  let seq = 0;
  bossNavPush(open, { index: startIndex, f: h0, h: h0, seq: seq++ });

  // 邻居按“主轴优先”排序：目标偏移量大的轴先入堆；配合平手 FIFO，
  // 等价最优路径会选主轴先行（大方向先走，细对齐后走），观感更接近人开车。
  const stepUp = { dir: 'up' as Direction, dc: 0, dr: -1 };
  const stepDown = { dir: 'down' as Direction, dc: 0, dr: 1 };
  const stepLeft = { dir: 'left' as Direction, dc: -1, dr: 0 };
  const stepRight = { dir: 'right' as Direction, dc: 1, dr: 0 };
  const gdx = goalCol - startCol;
  const gdy = goalRow - startRow;
  const xSteps = gdx < 0 ? [stepLeft, stepRight] : [stepRight, stepLeft];
  const ySteps = gdy < 0 ? [stepUp, stepDown] : [stepDown, stepUp];
  const steps =
    Math.abs(gdx) > Math.abs(gdy)
      ? [xSteps[0], ySteps[0], xSteps[1], ySteps[1]]
      : [ySteps[0], xSteps[0], ySteps[1], xSteps[1]];
  let closestIndex = startIndex;
  let closestH = h0;
  while (open.length > 0) {
    const current = bossNavPop(open)!;
    if (closed[current.index]) continue;
    closed[current.index] = true;
    if (
      current.h < closestH ||
      (current.h === closestH && costs[current.index] < costs[closestIndex])
    ) {
      closestIndex = current.index;
      closestH = current.h;
    }
    if (current.index === goalIndex) {
      closestIndex = current.index;
      break;
    }
    const col = current.index % navCols;
    const row = (current.index / navCols) | 0;
    for (const s of steps) {
      const nc = col + s.dc;
      const nr = row + s.dr;
      if (nc < 0 || nr < 0 || nc >= navCols || nr >= navRows) continue;
      const stepCost = bossNavCost(state, nc, nr);
      if (!Number.isFinite(stepCost)) continue;
      const ni = nr * navCols + nc;
      const nCost = costs[current.index] + stepCost;
      if (nCost >= costs[ni]) continue;
      costs[ni] = nCost;
      firstSteps[ni] = current.index === startIndex ? s.dir : firstSteps[current.index];
      const h = Math.abs(goalCol - nc) + Math.abs(goalRow - nr);
      bossNavPush(open, { index: ni, f: nCost + h, h, seq: seq++ });
    }
  }
  return firstSteps[closestIndex];
}

// 速度向量的主轴朝向：子弹的地形开凿 / 前沿扫描一律按它定向（斜飞只体现在 vx/vy 上）。
function dominantDir(vx: number, vy: number): Direction {
  if (Math.abs(vx) > Math.abs(vy)) return vx < 0 ? 'left' : 'right';
  return vy < 0 ? 'up' : 'down';
}

// 狂暴弹速乘子：仅第 10 位 Boss 进入 enraged 后生效（×1.2），其余恒为 1。
function bulletSpeedMult(boss: BossState): number {
  return boss.enraged ? BOSS_ENRAGE_BULLET_SPEED_MULT : 1;
}

// 生成一发 Boss 弹幕弹（fromEnemy 普通弹：只打玩家，玩家子弹可将其抵消）。
// x/y 为 4×4 弹体左上角；速度向量由调用方给出，speed 只作为主轴标称值。
function pushBossBullet(
  state: GameState,
  x: number,
  y: number,
  vx: number,
  vy: number,
  speed: number,
): void {
  const bullet: BulletState = {
    id: state.nextBulletId++,
    x,
    y,
    prevX: x,
    prevY: y,
    dir: dominantDir(vx, vy),
    speed,
    vx,
    vy,
    age: 0,
    // 'pellet' 与散弹粒同类：可斜飞，地形 / 抵消结算与经典弹一致。
    kind: 'pellet',
    ownerId: BOSS_OWNER_ID,
    ownerPlayerIndex: -1,
    fromEnemy: true,
    attacksEagle: false, // Boss 关无鹰巢，保持 false 以免任何回退路径误伤基地
    alive: true,
    viewportBounds: null, // Boss 只出现在单屏竞技场，沿用经典地图边界
    steelPiercing: false,
  };
  state.bullets.push(bullet);
}

// 从 Boss 车体外沿按角度发射一发弹幕弹。
// 出膛半径取车体外接圆之外，确保任何角度都不会与自身重叠。狂暴时弹速自动放大。
function fireBossBullet(state: GameState, boss: BossState, angleRad: number, speed: number): void {
  const cx = boss.x + boss.size / 2;
  const cy = boss.y + boss.size / 2;
  const radius = (boss.size / 2) * Math.SQRT2 + 2;
  const v = speed * bulletSpeedMult(boss);
  pushBossBullet(
    state,
    cx + Math.cos(angleRad) * radius - BULLET_SIZE / 2,
    cy + Math.sin(angleRad) * radius - BULLET_SIZE / 2,
    Math.cos(angleRad) * v,
    Math.sin(angleRad) * v,
    v,
  );
}

// 把某个 x 坐标钳到“整条激光完全落在战场内”的中心范围。
function clampLaserCenter(x: number): number {
  const half = BOSS_LASER_WIDTH / 2;
  return Math.max(half, Math.min(FIELD_WIDTH - half, x));
}

// ── 新技能的公共工具 ──

// 两个轴对齐矩形是否严格重叠（边缘相贴不算）。
function rectsOverlap(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number,
): boolean {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

// 矩形覆盖的子格范围（含端点）。
function cellRange(x0: number, y0: number, x1: number, y1: number): {
  c0: number; c1: number; r0: number; r1: number;
} {
  return {
    c0: Math.floor(x0 / SUBTILE),
    c1: Math.floor((x1 - EPS) / SUBTILE),
    r0: Math.floor(y0 / SUBTILE),
    r1: Math.floor((y1 - EPS) / SUBTILE),
  };
}

// 把矩形覆盖到的砖块**整格**清除（冲撞粉碎 / 迫击炮爆炸共用）。钢 / 水 / 冰一律不动。
function crushBricksInRect(state: GameState, x0: number, y0: number, x1: number, y1: number): void {
  const { c0, c1, r0, r1 } = cellRange(x0, y0, x1, y1);
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      if (getCell(state.level, col, row) === Cell.BRICK) {
        setCell(state.level, col, row, Cell.EMPTY);
      }
    }
  }
}

// 与矩形重叠、且当前可被结算的存活玩家（护盾期间不结算，与激光判定口径一致）。
function playersInRect(
  state: GameState,
  x: number, y: number, w: number, h: number,
): TankState[] {
  const out: TankState[] = [];
  for (const t of state.tanks) {
    if (!t.alive || !isPlayerTank(t)) continue;
    if (t.invulnTicks > 0) continue;
    if (rectsOverlap(x, y, w, h, t.x, t.y, TANK_SIZE, TANK_SIZE)) out.push(t);
  }
  return out;
}

// 场上敌军数（含出生闪光中的）：召唤援军的硬上限据此判定。
function enemiesOnField(state: GameState): number {
  let n = 0;
  for (const s of state.spawning) if (!isPlayerTank(s.tank)) n++;
  for (const t of state.tanks) if (t.alive && !isPlayerTank(t)) n++;
  return n;
}

// ① 弹幕墙：从 Boss 所在行朝目标半场齐射一整排子弹，横向间隔 BOSS_WALL_SPACING(16)，
// 由 rng 随机留一个连续 BOSS_WALL_GAP_SLOTS(2) 弹位 = 32px 的缺口 —— 缺口即唯一生路。
function fireBulletWall(state: GameState, boss: BossState, target: TankState): void {
  const down = target.y + TANK_SIZE / 2 >= boss.y + boss.size / 2;
  const y = down ? boss.y + boss.size : boss.y - BULLET_SIZE;
  const speed = BOSS_WALL_SPEED * bulletSpeedMult(boss);
  const vy = down ? speed : -speed;
  const slots = Math.floor(FIELD_WIDTH / BOSS_WALL_SPACING); // 20
  const gapStart = state.rng.int(slots - BOSS_WALL_GAP_SLOTS + 1); // 缺口起始弹位
  for (let i = 0; i < slots; i++) {
    if (i >= gapStart && i < gapStart + BOSS_WALL_GAP_SLOTS) continue;
    const cx = i * BOSS_WALL_SPACING + BOSS_WALL_SPACING / 2;
    pushBossBullet(state, cx - BULLET_SIZE / 2, y, 0, vy, speed);
  }
}

// ② 蓄力冲撞：锁定与 Boss 更接近对齐的那条轴（|dy| 更小 → 已近乎同一行 → 横向冲撞），
// 朝目标方向定下 chargeDir，随后进入 BOSS_CHARGE_WARN_TICKS 帧预警（渲染层闪烁整条路径）。
function beginCharge(boss: BossState, target: TankState): void {
  const dx = target.x + TANK_SIZE / 2 - (boss.x + boss.size / 2);
  const dy = target.y + TANK_SIZE / 2 - (boss.y + boss.size / 2);
  boss.chargeDir =
    Math.abs(dy) <= Math.abs(dx) ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'up' : 'down';
  boss.dir = boss.chargeDir;
  boss.moveDir = boss.chargeDir;
  boss.windupTicks = BOSS_CHARGE_WARN_TICKS;
}

// 冲锋一帧。返回 true 表示本次冲撞已结束（已装填眩晕，调用方随即 endAttack）。
// 规则：沿途砖块整格粉碎、碾到玩家即击毁；撞钢眩晕 90 帧、撞边界 / 水面眩晕 45 帧。
// 眩晕期间 Boss 完全静止且不攻击 —— 这是整套技能里最大的一段免费输出窗口。
function advanceCharge(state: GameState, boss: BossState): boolean {
  const dir = boss.chargeDir;
  let nx = boss.x;
  let ny = boss.y;
  if (dir === 'up') ny -= BOSS_CHARGE_SPEED;
  else if (dir === 'down') ny += BOSS_CHARGE_SPEED;
  else if (dir === 'left') nx -= BOSS_CHARGE_SPEED;
  else nx += BOSS_CHARGE_SPEED;

  // 越界：钳到边界，走完最后一步后按“软眩晕”处理。
  let hitBoundary = false;
  const maxX = FIELD_WIDTH - boss.size;
  const maxY = FIELD_HEIGHT - boss.size;
  if (nx < 0 || ny < 0 || nx > maxX || ny > maxY) {
    hitBoundary = true;
    nx = Math.max(0, Math.min(maxX, nx));
    ny = Math.max(0, Math.min(maxY, ny));
  }

  // 目标位置上的硬障碍：钢块（重眩晕）与水 / 鹰巢（软眩晕）都挡得住 32 吨车体。
  let hitSteel = false;
  let hitHard = false;
  const { c0, c1, r0, r1 } = cellRange(nx, ny, nx + boss.size, ny + boss.size);
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      const cell = getCell(state.level, col, row);
      if (cell === Cell.STEEL) hitSteel = true;
      else if (cell === Cell.WATER || cell === Cell.EAGLE) hitHard = true;
    }
  }
  if (hitSteel || hitHard) {
    boss.stunTicks = hitSteel ? BOSS_CHARGE_STUN_STEEL_TICKS : BOSS_CHARGE_STUN_SOFT_TICKS;
    boss.moving = false;
    return true;
  }

  // 砖块整格粉碎后推进车体，并碾毁沿途玩家。
  crushBricksInRect(state, nx, ny, nx + boss.size, ny + boss.size);
  boss.x = nx;
  boss.y = ny;
  boss.moving = true;
  for (const victim of playersInRect(state, boss.x, boss.y, boss.size, boss.size)) {
    destroyPlayerTank(state, victim);
  }
  if (hitBoundary) {
    boss.stunTicks = BOSS_CHARGE_STUN_SOFT_TICKS;
    boss.moving = false;
    return true;
  }
  return false;
}

// ③ 迫击炮雨：每名存活玩家附近 rng 散布 ±BOSS_MORTAR_SCATTER 取一个落点，
// 不足 BOSS_MORTAR_COUNT 个再用全场随机点凑满。存的是 16×16 判定盒左上角。
function planMortarMarks(state: GameState, boss: BossState): void {
  const half = BOSS_MORTAR_BLAST / 2;
  const clampX = (v: number): number => Math.max(0, Math.min(FIELD_WIDTH - BOSS_MORTAR_BLAST, v));
  const clampY = (v: number): number => Math.max(0, Math.min(FIELD_HEIGHT - BOSS_MORTAR_BLAST, v));
  const marks: BossMortarMark[] = [];
  const scatter = (): number => state.rng.int(BOSS_MORTAR_SCATTER * 2 + 1) - BOSS_MORTAR_SCATTER;
  for (const t of alivePlayers(state)) {
    if (marks.length >= BOSS_MORTAR_COUNT) break;
    marks.push({
      x: clampX(t.x + TANK_SIZE / 2 + scatter() - half),
      y: clampY(t.y + TANK_SIZE / 2 + scatter() - half),
      ticksLeft: BOSS_MORTAR_FUSE_TICKS,
    });
  }
  while (marks.length < BOSS_MORTAR_COUNT) {
    marks.push({
      x: clampX(state.rng.int(FIELD_WIDTH)),
      y: clampY(state.rng.int(FIELD_HEIGHT)),
      ticksLeft: BOSS_MORTAR_FUSE_TICKS,
    });
  }
  boss.mortarMarks = marks;
}

// 一个落点起爆：16×16 判定内的玩家即毁、砖块整格清除、钢块不毁。
function explodeMortarMark(state: GameState, mark: BossMortarMark): void {
  const size = BOSS_MORTAR_BLAST;
  crushBricksInRect(state, mark.x, mark.y, mark.x + size, mark.y + size);
  for (const victim of playersInRect(state, mark.x, mark.y, size, size)) {
    destroyPlayerTank(state, victim);
  }
  const off = (EXPLOSION_BIG_SIZE - size) / 2;
  state.explosions.push({
    x: mark.x - off,
    y: mark.y - off,
    ticksLeft: EXPLOSION_BIG_TICKS,
    big: true,
  });
  state.events.push('explosionBig');
}

// ④ 召唤援军：在 Boss 两侧（不行则上下）闪现小兵，无视 BOSS_MINION_MAX 软上限，
// 但受全场敌军硬上限 BOSS_ENEMY_HARD_CAP 约束，放不下就少放。种类取当前关的小兵池。
function summonMinions(state: GameState, boss: BossState): void {
  const mid = (boss.size - TANK_SIZE) / 2;
  const spots = [
    { x: boss.x - TANK_SIZE, y: boss.y + mid }, // 左
    { x: boss.x + boss.size, y: boss.y + mid }, // 右
    { x: boss.x + mid, y: boss.y - TANK_SIZE }, // 上（两侧被占时的退路）
    { x: boss.x + mid, y: boss.y + boss.size }, // 下
  ];
  const pool = bossMinionKindsForStage(state.stage);
  // 出生闪光中的小兵也算占位：否则连续两次召唤会把两台坦克叠在同一个格子上。
  const obstacles = collisionTanks(state).concat(state.spawning.map((s) => s.tank));
  let placed = 0;
  for (const spot of spots) {
    if (placed >= BOSS_SUMMON_COUNT) break;
    if (enemiesOnField(state) >= BOSS_ENEMY_HARD_CAP) break;
    const kind = pool[state.rng.int(pool.length)];
    const tank = createEnemy(kind, state.nextEnemyId, 0);
    if (!canTankOccupy(tank, spot.x, spot.y, state.level, obstacles)) continue;
    tank.x = spot.x;
    tank.y = spot.y;
    state.nextEnemyId++;
    boss.minionsSpawned++;
    if (boss.minionsSpawned % BOSS_MINION_CARRIER_EVERY === 0) tank.carriesPowerup = true;
    state.spawning.push({ tank, ticksLeft: SPAWN_FLASH_TICKS });
    placed++;
  }
}

// ⑤ 磁力牵引：每帧把所有存活玩家向 Boss 中心拉 BOSS_MAGNET_PULL_PER_TICK 像素。
// 逐轴用 canTankOccupy 校验（与玩家自己移动同一套通行判定）：拉不动就停在障碍前，绝不穿墙。
function pullPlayersToBoss(state: GameState, boss: BossState): void {
  const cx = boss.x + boss.size / 2;
  const cy = boss.y + boss.size / 2;
  const obstacles = collisionTanks(state);
  for (const t of state.tanks) {
    if (!t.alive || !isPlayerTank(t)) continue;
    const dx = cx - (t.x + TANK_SIZE / 2);
    const dy = cy - (t.y + TANK_SIZE / 2);
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < EPS) continue;
    const ux = (dx / dist) * BOSS_MAGNET_PULL_PER_TICK;
    const uy = (dy / dist) * BOSS_MAGNET_PULL_PER_TICK;
    if (canTankOccupy(t, t.x + ux, t.y, state.level, obstacles)) t.x += ux;
    if (canTankOccupy(t, t.x, t.y + uy, state.level, obstacles)) t.y += uy;
  }
}

// ⑥ 横扫激光：起始列为 Boss 所在列，扫向目标所在的半场；扫出战场即结束。
function beginSweep(boss: BossState, target: TankState): void {
  const cx = boss.x + boss.size / 2;
  boss.sweepDir = target.x + TANK_SIZE / 2 < cx ? -1 : 1;
  boss.sweepX = clampLaserCenter(cx);
  boss.laserCols = [boss.sweepX];
  boss.windupTicks = BOSS_SWEEP_WARN_TICKS;
}

// 开始一次攻击：装填该攻击的计时 / 目标。目标缺失（无存活玩家）时直接回到冷却。
function beginAttack(state: GameState, boss: BossState, attack: BossAttackKind): void {
  const players = alivePlayers(state);
  boss.laserCols = [];
  boss.laserHitPlayers = [];
  boss.windupTicks = 0;
  boss.activeTicks = 0;
  boss.stepTimer = 0;
  boss.stepsLeft = 0;
  boss.mortarMarks = [];
  boss.sweepDir = 0;

  if (players.length === 0) {
    endAttack(boss);
    return;
  }

  switch (attack) {
    case 'laser': {
      const target = players[state.rng.int(players.length)];
      boss.laserCols = [clampLaserCenter(target.x + TANK_SIZE / 2)];
      boss.windupTicks = BOSS_LASER_WINDUP_TICKS;
      break;
    }
    case 'dualLaser': {
      if (players.length >= 2) {
        // 锁定两名不同玩家：先随机取一名，再从其余玩家中随机取第二名。
        const first = state.rng.int(players.length);
        const offset = 1 + state.rng.int(players.length - 1);
        const second = (first + offset) % players.length;
        boss.laserCols = [
          clampLaserCenter(players[first].x + TANK_SIZE / 2),
          clampLaserCenter(players[second].x + TANK_SIZE / 2),
        ];
      } else {
        // 单人局（或只剩一名存活）：改锁该玩家列的 ±32px 两列，留出中间的生路。
        const cx = players[0].x + TANK_SIZE / 2;
        boss.laserCols = [
          clampLaserCenter(cx - BOSS_DUAL_LASER_SOLO_OFFSET),
          clampLaserCenter(cx + BOSS_DUAL_LASER_SOLO_OFFSET),
        ];
      }
      boss.windupTicks = BOSS_LASER_WINDUP_TICKS;
      break;
    }
    case 'radial': {
      // 即时齐射：8 发 45° 放射，随即回到冷却。
      for (let i = 0; i < BOSS_RADIAL_BULLETS; i++) {
        fireBossBullet(state, boss, (i * 2 * Math.PI) / BOSS_RADIAL_BULLETS, BOSS_RADIAL_SPEED);
      }
      endAttack(boss);
      return;
    }
    case 'burst':
      boss.stepsLeft = BOSS_BURST_SHOTS;
      boss.stepTimer = 0; // 下一帧即打出首发
      break;
    case 'spin':
      boss.stepsLeft = BOSS_SPIN_WAVES;
      boss.stepTimer = 0; // 下一帧即打出首波
      break;
    case 'bulletWall': {
      // 即时齐射一整排（带缺口），随即回到冷却。
      fireBulletWall(state, boss, players[state.rng.int(players.length)]);
      endAttack(boss);
      return;
    }
    case 'charge':
      beginCharge(boss, nearestPlayer(state, boss) ?? players[0]);
      break;
    case 'mortar':
      planMortarMarks(state, boss);
      break;
    case 'summon': {
      // 即时召唤，随即回到冷却（小兵自己走出生闪光）。
      summonMinions(state, boss);
      endAttack(boss);
      return;
    }
    case 'magnet':
      boss.windupTicks = BOSS_MAGNET_WARN_TICKS; // 预警：Boss 泛紫脉冲
      break;
    case 'sweepLaser':
      beginSweep(boss, players[state.rng.int(players.length)]);
      break;
    default:
      endAttack(boss);
      return;
  }
  boss.attack = attack;
}

// 直接发动某个指定攻击。正常流程由 updateBoss 从该阶段的攻击池随机取一；
// 这个入口供测试（与将来可能的脚本化演出）确定性地点名某个技能。
export function startBossAttack(
  state: GameState,
  boss: BossState,
  attack: BossAttackKind,
): void {
  beginAttack(state, boss, attack);
}

// 攻击收尾：回到冷却，按当前阶段 / 序号 / 狂暴装填下一次攻击的间隔。
function endAttack(boss: BossState): void {
  boss.attack = 'none';
  boss.attackTimer = bossAttackIntervalTicks(boss.phase, boss.ordinal, boss.enraged);
  boss.windupTicks = 0;
  boss.activeTicks = 0;
  boss.stepTimer = 0;
  boss.stepsLeft = 0;
  boss.laserCols = [];
  boss.laserHitPlayers = [];
  boss.mortarMarks = [];
  boss.sweepDir = 0;
}

// 激光激活期间的逐帧判定：站在目标列内的玩家按“被敌弹击中”处理。
// 同一玩家在一次激光中至多结算一次；护盾（invulnTicks>0）期间不结算、也不记入去重表。
function resolveLaserHits(state: GameState, boss: BossState): void {
  const half = BOSS_LASER_WIDTH / 2;
  for (const t of state.tanks) {
    if (!t.alive || !isPlayerTank(t)) continue;
    if (t.invulnTicks > 0) continue;
    if (boss.laserHitPlayers.includes(t.playerIndex)) continue;
    for (const center of boss.laserCols) {
      if (t.x < center + half && t.x + TANK_SIZE > center - half) {
        boss.laserHitPlayers.push(t.playerIndex);
        damagePlayerTank(state, t);
        break;
      }
    }
  }
}

// 推进当前攻击一帧。
function advanceAttack(state: GameState, boss: BossState): void {
  switch (boss.attack) {
    case 'laser':
    case 'dualLaser': {
      if (boss.windupTicks > 0) {
        // 前摇：只显示闪烁的红色瞄准线，不伤人。
        boss.windupTicks--;
        if (boss.windupTicks === 0) boss.activeTicks = BOSS_LASER_ACTIVE_TICKS;
        return;
      }
      resolveLaserHits(state, boss);
      boss.activeTicks--;
      if (boss.activeTicks <= 0) endAttack(boss);
      return;
    }
    case 'burst': {
      // 归零那一帧即开火 —— 间隔恰为 BOSS_BURST_INTERVAL_TICKS 帧。
      if (boss.stepTimer > 0) {
        boss.stepTimer--;
        if (boss.stepTimer > 0) return;
      }
      // 方向按发射瞬间实时瞄准最近玩家的中心。
      const target = nearestPlayer(state, boss);
      if (!target) {
        endAttack(boss);
        return;
      }
      const cx = boss.x + boss.size / 2;
      const cy = boss.y + boss.size / 2;
      const angle = Math.atan2(target.y + TANK_SIZE / 2 - cy, target.x + TANK_SIZE / 2 - cx);
      boss.dir = dominantDir(Math.cos(angle), Math.sin(angle));
      fireBossBullet(state, boss, angle, BOSS_BURST_SPEED);
      boss.stepsLeft--;
      if (boss.stepsLeft <= 0) endAttack(boss);
      else boss.stepTimer = BOSS_BURST_INTERVAL_TICKS;
      return;
    }
    case 'spin': {
      // 归零那一帧即开火 —— 波间恰为 BOSS_SPIN_WAVE_INTERVAL_TICKS 帧。
      if (boss.stepTimer > 0) {
        boss.stepTimer--;
        if (boss.stepTimer > 0) return;
      }
      for (let i = 0; i < BOSS_SPIN_BULLETS; i++) {
        const angle = boss.spinAngle + (i * 2 * Math.PI) / BOSS_SPIN_BULLETS;
        fireBossBullet(state, boss, angle, BOSS_SPIN_SPEED);
      }
      // 每波起始角偏转 7.5°，三波叠成旋转网。
      boss.spinAngle += BOSS_SPIN_STEP_RAD;
      boss.stepsLeft--;
      if (boss.stepsLeft <= 0) endAttack(boss);
      else boss.stepTimer = BOSS_SPIN_WAVE_INTERVAL_TICKS;
      return;
    }
    case 'charge': {
      // 预警相：只闪烁路径，不移动、不伤人（这是玩家唯一的让位窗口）。
      if (boss.windupTicks > 0) {
        boss.windupTicks--;
        return;
      }
      if (advanceCharge(state, boss)) endAttack(boss); // 撞停：眩晕已装填
      return;
    }
    case 'mortar': {
      // 引信同步递减，归零的落点当帧起爆；全部炸完即回到冷却。
      for (const mark of boss.mortarMarks) mark.ticksLeft--;
      const pending: BossMortarMark[] = [];
      for (const mark of boss.mortarMarks) {
        if (mark.ticksLeft > 0) pending.push(mark);
        else explodeMortarMark(state, mark);
      }
      boss.mortarMarks = pending;
      if (pending.length === 0) endAttack(boss);
      return;
    }
    case 'magnet': {
      if (boss.windupTicks > 0) {
        // 预警：紫色脉冲（渲染层表现），尚未开始牵引。
        boss.windupTicks--;
        if (boss.windupTicks === 0) {
          boss.activeTicks = BOSS_MAGNET_TICKS;
          boss.stepTimer = 0; // 进入激活相的第一帧即放一圈弹幕
        }
        return;
      }
      pullPlayersToBoss(state, boss);
      if (boss.stepTimer <= 0) {
        for (let i = 0; i < BOSS_MAGNET_BULLETS; i++) {
          fireBossBullet(state, boss, (i * 2 * Math.PI) / BOSS_MAGNET_BULLETS, BOSS_MAGNET_SPEED);
        }
        boss.stepTimer = BOSS_MAGNET_WAVE_INTERVAL_TICKS;
      }
      boss.stepTimer--;
      boss.activeTicks--;
      if (boss.activeTicks <= 0) endAttack(boss);
      return;
    }
    case 'sweepLaser': {
      if (boss.windupTicks > 0) {
        // 预警：起始列红线（laserCols 已装好）+ 扫向由 sweepDir 表达。
        boss.windupTicks--;
        if (boss.windupTicks === 0) boss.activeTicks = 1;
        return;
      }
      // 当前列先结算，再横移一步；扫出战场即结束（另一半场始终安全）。
      resolveLaserHits(state, boss);
      boss.sweepX += BOSS_SWEEP_SPEED * boss.sweepDir;
      const half = BOSS_LASER_WIDTH / 2;
      if (boss.sweepX < half || boss.sweepX > FIELD_WIDTH - half) {
        endAttack(boss);
        return;
      }
      boss.laserCols = [boss.sweepX];
      boss.activeTicks = 1; // 恒为“激活相”，供渲染层沿用粗激光画法
      return;
    }
    default:
      endAttack(boss);
  }
}

// 清空场上全部 Boss 弹幕（阶段切换的喘息窗口 / Boss 死亡时共用）。
function clearBossBullets(state: GameState): void {
  for (const b of state.bullets) {
    if (b.ownerId === BOSS_OWNER_ID) b.alive = false;
  }
}

// Boss 被击杀：清弹幕与激光，播一组错落的大爆炸，置 dead。
// 过关不在此判定 —— phase.ts 的 stageCleared 见到 boss.dead 后走既有 stageclear 延迟流程。
function killBoss(state: GameState, boss: BossState): void {
  boss.hp = 0;
  boss.dead = true;
  clearBossBullets(state);
  // 遗留地雷一并清场：过关延迟（stageclear 前的 180 帧）里踩雷送命毫无道理。
  state.mines = [];
  boss.stunTicks = 0;
  endAttack(boss);
  const count = BOSS_DEATH_EXPLOSION_MIN + state.rng.int(BOSS_DEATH_EXPLOSION_RANGE);
  for (let i = 0; i < count; i++) {
    // 32×32 大爆炸精灵，随机散落在 32×32 车体范围内（居中于取样点）。
    const px = boss.x + state.rng.int(boss.size);
    const py = boss.y + state.rng.int(boss.size);
    state.explosions.push({
      x: px - EXPLOSION_BIG_SIZE / 2,
      y: py - EXPLOSION_BIG_SIZE / 2,
      ticksLeft: EXPLOSION_BIG_TICKS,
      big: true,
    });
  }
  state.events.push('explosionBig');
}

// 每帧（playing 期间）调用一次：受击闪烁递减、追踪移动 / 破障、阶段转换、攻击状态机推进。
export function updateBoss(state: GameState): void {
  const boss = state.boss;
  if (!boss || boss.dead) return;

  // 受击白闪不受冻结 / 减速影响：Boss 无论如何都仍可被打。
  if (boss.hitFlash > 0) boss.hitFlash--;

  // timer（时钟）冻结：本帧完全不推进 —— 不移动、不破障、前摇 / 激光 / 波次计时全停。
  if (boss.freezeTicks > 0) {
    boss.freezeTicks--;
    boss.moving = false;
    return;
  }
  // hourglass（沙漏）半速：与小兵 enemySlowTicks 同款，仅偶数 tick 推进移动与攻击计时。
  if (boss.slowTicks > 0) {
    boss.slowTicks--;
    if (state.tick % 2 !== 0) {
      boss.moving = false;
      return;
    }
  }

  // 冲撞撞墙后的眩晕：本帧完全不推进（不移动、不布雷、不攻击），但照常挨打。
  // 这是「蓄力冲撞」留给玩家的核心反制窗口 —— 骗它撞钢，就能白打 90 帧。
  if (boss.stunTicks > 0) {
    boss.stunTicks--;
    boss.moving = false;
    return;
  }

  const target = nearestPlayer(state, boss);
  // 冲撞期间车体由 advanceCharge 独占驱动，不再叠加常规追踪移动。
  if (boss.attack === 'charge') boss.moving = false;
  else moveBoss(state, boss, target);

  // 被动技能（序号 ≥6）：移动状态下定时在车尾丢雷。
  updateMineLaying(state, boss);

  // 阶段转换（单向）：清一次场上 Boss 弹作为喘息窗口与视觉信号，并中止当前攻击。
  if (boss.phase === 1 && boss.hp < boss.maxHp * BOSS_PHASE2_HP_RATIO) {
    boss.phase = 2;
    applyBossArenaPhase2(state.level, state.stage);
    clearBossBullets(state);
    endAttack(boss);
  }

  // 狂暴（单向，仅第 BOSS_ENRAGE_ORDINAL 位 Boss）：残血 25% 以下永久提速。
  // 只改数值不打断当前攻击；新的攻击间隔在下一次 endAttack 时生效。
  if (
    !boss.enraged &&
    boss.ordinal >= BOSS_ENRAGE_ORDINAL &&
    boss.hp < boss.maxHp * BOSS_ENRAGE_HP_RATIO
  ) {
    boss.enraged = true;
    boss.attackTimer = Math.min(
      boss.attackTimer,
      bossAttackIntervalTicks(boss.phase, boss.ordinal, true),
    );
  }

  if (boss.attack === 'none') {
    boss.attackTimer--;
    if (boss.attackTimer <= 0) {
      const skills = bossSkillsFor(boss.ordinal);
      const pool = boss.phase === 2 ? skills.p2 : skills.p1;
      beginAttack(state, boss, pool[state.rng.int(pool.length)]);
    }
    return;
  }
  advanceAttack(state, boss);
}

// ── 被动技能：沿途布雷（Boss 序号 ≥6）──
// 只在“确实移动了”的帧推进计时：站桩输出的 Boss 不会平白铺满一地雷。
// 车尾 = moveDir 的反侧，因此雷总是落在 Boss 刚离开的位置，玩家追击时最容易踩到。
function updateMineLaying(state: GameState, boss: BossState): void {
  if (!bossMinesEnabled(boss.ordinal)) return;
  if (!boss.moving) return;
  if (boss.mineTimer > 0) {
    boss.mineTimer--;
    return;
  }
  if (state.mines.length >= BOSS_MINE_MAX) return; // 满仓：等场上有雷消失再补
  let x = boss.x + (boss.size - BOSS_MINE_SIZE) / 2;
  let y = boss.y + (boss.size - BOSS_MINE_SIZE) / 2;
  if (boss.moveDir === 'up') y = boss.y + boss.size - BOSS_MINE_SIZE;
  else if (boss.moveDir === 'down') y = boss.y;
  else if (boss.moveDir === 'left') x = boss.x + boss.size - BOSS_MINE_SIZE;
  else x = boss.x;
  state.mines.push({
    id: state.nextMineId++,
    x: Math.max(0, Math.min(FIELD_WIDTH - BOSS_MINE_SIZE, x)),
    y: Math.max(0, Math.min(FIELD_HEIGHT - BOSS_MINE_SIZE, y)),
    armTicks: BOSS_MINE_ARM_TICKS,
    lifeTicks: BOSS_MINE_LIFE_TICKS,
  });
  boss.mineTimer = BOSS_MINE_INTERVAL_TICKS;
}

// 一枚地雷起爆：留一朵小爆炸；仅“玩家踩中”这条路径会带走玩家。
// 子弹引爆（安全排雷）与到期自爆都不伤人 —— 主动排雷必须是稳赚的操作。
function detonateMine(state: GameState, mine: MineState, victim: TankState | null): void {
  state.explosions.push(
    makeSmallExplosion(mine.x + BOSS_MINE_SIZE / 2, mine.y + BOSS_MINE_SIZE / 2),
  );
  state.events.push('explosionSmall');
  if (victim) destroyPlayerTank(state, victim);
}

// 每帧推进全部地雷（普通关 / 护送关 mines 恒为空，直接返回）。
// 三条终结路径：玩家子弹引爆（安全）→ 寿命到期自爆（安全）→ 武装后被玩家碰触（致命）。
export function updateMines(state: GameState): void {
  if (state.mines.length === 0) return;
  const survivors: MineState[] = [];
  for (const mine of state.mines) {
    if (mine.armTicks > 0) mine.armTicks--;
    mine.lifeTicks--;

    // 玩家子弹引爆：子弹一并消亡，双方都不受伤（安全排雷）。
    let shot: BulletState | null = null;
    for (const b of state.bullets) {
      if (!b.alive || b.fromEnemy) continue;
      const hit = bulletHitRect(b);
      if (rectsOverlap(
        mine.x,
        mine.y,
        BOSS_MINE_SIZE,
        BOSS_MINE_SIZE,
        hit.left,
        hit.top,
        hit.right - hit.left,
        hit.bottom - hit.top,
      )) {
        shot = b;
        break;
      }
    }
    if (shot) {
      shot.alive = false;
      detonateMine(state, mine, null);
      continue;
    }
    if (mine.lifeTicks <= 0) {
      detonateMine(state, mine, null); // 到期自爆
      continue;
    }
    if (mine.armTicks <= 0) {
      const victims = playersInRect(state, mine.x, mine.y, BOSS_MINE_SIZE, BOSS_MINE_SIZE);
      if (victims.length > 0) {
        detonateMine(state, mine, victims[0]);
        continue;
      }
    }
    survivors.push(mine);
  }
  state.mines = survivors;
}

// 子弹伤害盒是否与 Boss 车体重叠；F 弹使用 16×8 连续热区。
function bulletHitsBoss(b: BulletState, boss: BossState): boolean {
  const hit = bulletHitRect(b);
  const r = bossRect(boss);
  return hit.left < r.x1 && hit.right > r.x0 && hit.top < r.y1 && hit.bottom > r.y0;
}

// 子弹 vs Boss。玩家弹扣血（激光 −2、其余 −1）并一律消亡（激光对 Boss 不贯穿，
// 避免逐帧多段扣血）；小兵弹被车体吸收（消弹、不受伤）；Boss 自己的弹幕直接放行。
export function resolveBulletBoss(state: GameState): void {
  const boss = state.boss;
  if (!boss || boss.dead) return;
  for (const b of state.bullets) {
    if (!b.alive) continue;
    if (b.ownerId === BOSS_OWNER_ID) continue;
    if (!bulletHitsBoss(b, boss)) continue;

    b.alive = false;
    // F 弹稍后统一生成大范围炎爆；其余子弹仍在命中点生成经典小火花。
    if (b.kind !== 'spiral') {
      state.explosions.push(makeSmallExplosion(b.x + BULLET_SIZE / 2, b.y + BULLET_SIZE / 2));
      state.events.push('explosionSmall');
    }
    if (b.fromEnemy) continue; // 吸收体：小兵弹不伤 Boss

    boss.hp -= b.kind === 'laser' ? BOSS_DAMAGE_LASER : BOSS_DAMAGE_NORMAL;
    boss.hitFlash = BOSS_HIT_FLASH_TICKS;
    if (boss.hp <= 0) {
      killBoss(state, boss);
      return;
    }
  }
}

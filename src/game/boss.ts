import {
  BOSS_SIZE,
  BOSS_X,
  BOSS_Y,
  BOSS_OWNER_ID,
  BOSS_DAMAGE_NORMAL,
  BOSS_DAMAGE_LASER,
  BOSS_HIT_FLASH_TICKS,
  BOSS_PHASE2_HP_RATIO,
  BOSS_ATTACK_INTERVAL_P1,
  BOSS_ATTACK_INTERVAL_P2,
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
  BOSS_BREACH_INTERVAL_TICKS,
  BOSS_BREACH_BULLET_SPEED,
  bossMaxHp,
  BULLET_SIZE,
  TANK_SIZE,
  FIELD_WIDTH,
  FIELD_HEIGHT,
  SUBTILE,
  EXPLOSION_BIG_TICKS,
  EXPLOSION_BIG_SIZE,
} from '../core/constants';
import type { Direction } from '../core/types';
import { TankState, createEnemy, isPlayerTank } from './tank';
import { BulletState, makeSmallExplosion } from './bullet';
import { destroyPlayerTank } from './death';
import { Cell, brickMaskOverlapsRect, getCell } from './level';
import type { GameState } from './state';

// Boss 关的核心逻辑（纯模拟层）：一切随机取自 state.rng，BossState 全部为可序列化的纯数据。
// Boss 不是 TankState —— 它是 32×32、可移动、只有玩家子弹能伤到的独立实体。

// Boss 当前攻击。'none' = 冷却中（attackTimer 递减）。
export type BossAttackKind = 'none' | 'laser' | 'radial' | 'burst' | 'spin' | 'dualLaser';

// 各阶段的攻击池（冷却结束时由 state.rng 等概率取一发动）。
const BOSS_ATTACKS_P1: ReadonlyArray<BossAttackKind> = ['laser', 'radial', 'burst'];
const BOSS_ATTACKS_P2: ReadonlyArray<BossAttackKind> = [
  'laser',
  'radial',
  'burst',
  'spin',
  'dualLaser',
];

// Boss 实体：纯数据、可序列化（无函数 / 类实例），随快照整体下发。
export interface BossState {
  hp: number;
  maxHp: number;
  phase: 1 | 2; // 阶段（hp < maxHp/2 时转 2，单向不回退）
  x: number; // 32×32 车体左上角
  y: number;
  size: number; // 车体边长（= BOSS_SIZE，随快照一并下发，渲染层不必再查常量）
  dir: Direction; // 车体 / 炮塔朝向（移动或破障方向）
  moveDir: Direction; // 当前追踪移动方向
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
  minionTimer: number; // 小兵补充倒计时
  minionsSpawned: number; // 已生成小兵计数（每第 4 只携带道具）
  dead: boolean; // 已被击杀（弹幕已清、大爆炸已播；过关判定据此）
}

// 建立一台 Boss：血量随人数放大，开局即在位（不走出生闪光），第一次攻击等一个完整冷却。
export function createBoss(playerCount: number): BossState {
  return {
    hp: bossMaxHp(playerCount),
    maxHp: bossMaxHp(playerCount),
    phase: 1,
    x: BOSS_X,
    y: BOSS_Y,
    size: BOSS_SIZE,
    dir: 'down',
    moveDir: 'down',
    moving: false,
    breachCooldown: 0,
    hitFlash: 0,
    attack: 'none',
    attackTimer: BOSS_ATTACK_INTERVAL_P1,
    windupTicks: 0,
    activeTicks: 0,
    stepTimer: 0,
    stepsLeft: 0,
    laserCols: [],
    laserHitPlayers: [],
    spinAngle: 0,
    minionTimer: BOSS_MINION_INTERVAL_TICKS,
    minionsSpawned: 0,
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

// 探测 Boss 沿某方向走一步后的 32×32 完整车体。砖墙（含残砖）与钢墙可破坏；
// 水、鹰巢、边界和坦克只能绕行。Boss 不碾压玩家 / 小兵，避免生成无法解开的重叠状态。
function probeBossMove(state: GameState, boss: BossState, dir: Direction): BossMoveProbe {
  let x = boss.x;
  let y = boss.y;
  if (dir === 'up') y -= BOSS_SPEED;
  else if (dir === 'down') y += BOSS_SPEED;
  else if (dir === 'left') x -= BOSS_SPEED;
  else x += BOSS_SPEED;

  if (x < 0 || y < 0 || x + boss.size > FIELD_WIDTH || y + boss.size > FIELD_HEIGHT) {
    return { x, y, blocked: true, destructible: false };
  }

  let blocked = false;
  let destructible = false;
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
          destructible = true;
        }
      } else if (cell === Cell.STEEL) {
        blocked = true;
        destructible = true;
      } else if (cell === Cell.WATER || cell === Cell.EAGLE) {
        blocked = true;
      }
    }
  }

  for (const tank of state.tanks) {
    if (!tank.alive) continue;
    if (bossOverlapsTank(x, y, boss.size, tank)) blocked = true;
  }
  return { x, y, blocked, destructible };
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
    steelPiercing: true,
  };
}

// 两枚激光分别从车体 1/4 与 3/4 线出膛。每枚激光开 16px 宽的破坏带，
// 合起来为 32px Boss 车体清出完整通路；激光沿途可连续击穿砖和钢。
function fireBreachVolley(state: GameState, boss: BossState, dir: Direction): void {
  state.bullets.push(
    makeBreachBullet(state, boss, dir, boss.size / 4),
    makeBreachBullet(state, boss, dir, (boss.size * 3) / 4),
  );
  boss.breachCooldown = BOSS_BREACH_INTERVAL_TICKS;
}

function moveBoss(state: GameState, boss: BossState, target: TankState | null): void {
  boss.moving = false;
  if (boss.breachCooldown > 0) boss.breachCooldown--;
  if (!target) return;

  for (const dir of bossMoveCandidates(boss, target)) {
    const probe = probeBossMove(state, boss, dir);
    if (!probe.blocked) {
      boss.x = probe.x;
      boss.y = probe.y;
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

// 速度向量的主轴朝向：子弹的地形开凿 / 前沿扫描一律按它定向（斜飞只体现在 vx/vy 上）。
function dominantDir(vx: number, vy: number): Direction {
  if (Math.abs(vx) > Math.abs(vy)) return vx < 0 ? 'left' : 'right';
  return vy < 0 ? 'up' : 'down';
}

// 从 Boss 车体外沿发射一发弹幕弹（fromEnemy 普通弹：只打玩家，玩家子弹可将其抵消）。
// 出膛半径取车体外接圆之外，确保任何角度都不会与自身重叠。
function fireBossBullet(state: GameState, boss: BossState, angleRad: number, speed: number): void {
  const cx = boss.x + boss.size / 2;
  const cy = boss.y + boss.size / 2;
  const radius = (boss.size / 2) * Math.SQRT2 + 2;
  const vx = Math.cos(angleRad) * speed;
  const vy = Math.sin(angleRad) * speed;
  const bullet: BulletState = {
    id: state.nextBulletId++,
    x: cx + Math.cos(angleRad) * radius - BULLET_SIZE / 2,
    y: cy + Math.sin(angleRad) * radius - BULLET_SIZE / 2,
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

// 把某个 x 坐标钳到“整条激光完全落在战场内”的中心范围。
function clampLaserCenter(x: number): number {
  const half = BOSS_LASER_WIDTH / 2;
  return Math.max(half, Math.min(FIELD_WIDTH - half, x));
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
    default:
      endAttack(boss);
      return;
  }
  boss.attack = attack;
}

// 攻击收尾：回到冷却，按当前阶段装填下一次攻击的间隔。
function endAttack(boss: BossState): void {
  boss.attack = 'none';
  boss.attackTimer = boss.phase === 2 ? BOSS_ATTACK_INTERVAL_P2 : BOSS_ATTACK_INTERVAL_P1;
  boss.windupTicks = 0;
  boss.activeTicks = 0;
  boss.stepTimer = 0;
  boss.stepsLeft = 0;
  boss.laserCols = [];
  boss.laserHitPlayers = [];
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
        destroyPlayerTank(state, t);
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

  if (boss.hitFlash > 0) boss.hitFlash--;

  const target = nearestPlayer(state, boss);
  moveBoss(state, boss, target);

  // 阶段转换（单向）：清一次场上 Boss 弹作为喘息窗口与视觉信号，并中止当前攻击。
  if (boss.phase === 1 && boss.hp < boss.maxHp * BOSS_PHASE2_HP_RATIO) {
    boss.phase = 2;
    clearBossBullets(state);
    endAttack(boss);
  }

  if (boss.attack === 'none') {
    boss.attackTimer--;
    if (boss.attackTimer <= 0) {
      const pool = boss.phase === 2 ? BOSS_ATTACKS_P2 : BOSS_ATTACKS_P1;
      beginAttack(state, boss, pool[state.rng.int(pool.length)]);
    }
    return;
  }
  advanceAttack(state, boss);
}

// 子弹 4×4 盒是否与 Boss 车体重叠。
function bulletHitsBoss(b: BulletState, boss: BossState): boolean {
  const r = bossRect(boss);
  return b.x < r.x1 && b.x + BULLET_SIZE > r.x0 && b.y < r.y1 && b.y + BULLET_SIZE > r.y0;
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
    state.explosions.push(makeSmallExplosion(b.x + BULLET_SIZE / 2, b.y + BULLET_SIZE / 2));
    state.events.push('explosionSmall');
    if (b.fromEnemy) continue; // 吸收体：小兵弹不伤 Boss

    boss.hp -= b.kind === 'laser' ? BOSS_DAMAGE_LASER : BOSS_DAMAGE_NORMAL;
    boss.hitFlash = BOSS_HIT_FLASH_TICKS;
    if (boss.hp <= 0) {
      killBoss(state, boss);
      return;
    }
  }
}

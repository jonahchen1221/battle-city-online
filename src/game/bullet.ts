import { Direction } from '../core/types';
import {
  SUBTILE,
  QUARTER,
  TANK_SIZE,
  BULLET_SIZE,
  BRICK_CARVE_WIDTH,
  BRICK_CARVE_DEPTH,
  BRICK_TL,
  BRICK_TR,
  BRICK_BL,
  BRICK_BR,
  EXPLOSION_SMALL_TICKS,
  STAR_BULLET_SPEED,
  PLAYER_MAX_BULLETS_UPGRADED,
} from '../core/constants';
import {
  Cell,
  LevelState,
  getCell,
  isSolidForBullet,
  removeBrickQuarters,
  removeSteel,
} from './level';
import { TankState, isPlayerTank } from './tank';
import type { ExplosionState, GameEvent } from './state';

// 子弹实体：纯数据、可序列化。x/y 为 4×4 包围盒左上角的战场相对像素坐标。
export interface BulletState {
  x: number;
  y: number;
  dir: Direction;
  speed: number; // px/tick
  ownerId: number;
  ownerPlayerIndex: number; // 射手的玩家序号（玩家弹为其 playerIndex，敌弹为 -1）：用于击杀记分归属
  fromEnemy: boolean; // 阵营：true=敌弹（只打玩家），false=玩家弹（只打敌人）
  alive: boolean;
  steelPiercing: boolean; // star 满级（3 级）玩家弹：可击穿钢块（击中钢块时整格清除）
}

const EPS = 1e-6;
const MUZZLE_OFFSET = (TANK_SIZE - BULLET_SIZE) / 2; // 6：让 4px 子弹在 16px 炮口居中

// 生成一个以 (cx, cy) 为中心的小爆炸（16×16，子弹消失时的火花）。
export function makeSmallExplosion(cx: number, cy: number): ExplosionState {
  return { x: cx - 8, y: cy - 8, ticksLeft: EXPLOSION_SMALL_TICKS, big: false };
}

// 从坦克炮口生成一发子弹（4×4，居中于坦克宽度、紧贴坦克盒外侧）。
// 速度取自该坦克（威力坦克更快；玩家 star 等级 ≥1 提速到 STAR_BULLET_SPEED）；阵营由是否玩家坦克决定。
export function spawnBullet(tank: TankState): BulletState {
  const isPlayer = isPlayerTank(tank);
  const speed = isPlayer && tank.level >= 1 ? STAR_BULLET_SPEED : tank.bulletSpeed;
  const base = {
    dir: tank.dir,
    speed,
    ownerId: tank.id,
    ownerPlayerIndex: isPlayer ? tank.playerIndex : -1,
    fromEnemy: !isPlayer,
    alive: true,
    steelPiercing: isPlayer && tank.level >= 3,
  };
  switch (tank.dir) {
    case 'up':
      return { x: tank.x + MUZZLE_OFFSET, y: tank.y - BULLET_SIZE, ...base };
    case 'down':
      return { x: tank.x + MUZZLE_OFFSET, y: tank.y + TANK_SIZE, ...base };
    case 'left':
      return { x: tank.x - BULLET_SIZE, y: tank.y + MUZZLE_OFFSET, ...base };
    case 'right':
      return { x: tank.x + TANK_SIZE, y: tank.y + MUZZLE_OFFSET, ...base };
  }
}

// 该坦克是否已有一发在场子弹（经典规则：每坦克同时仅一发）。敌方开火沿用此上限。
export function hasLiveBullet(bullets: BulletState[], ownerId: number): boolean {
  return bullets.some((b) => b.alive && b.ownerId === ownerId);
}

// 该坦克当前在场子弹数（玩家 star 等级 ≥2 时可双弹，故需计数而非布尔）。
export function liveBulletCount(bullets: BulletState[], ownerId: number): number {
  let n = 0;
  for (const b of bullets) if (b.alive && b.ownerId === ownerId) n++;
  return n;
}

// 该坦克同屏可存在的子弹上限：玩家 star 等级 ≥2 为 PLAYER_MAX_BULLETS_UPGRADED，否则 1。
export function maxBulletsFor(tank: TankState): number {
  return isPlayerTank(tank) && tank.level >= 2 ? PLAYER_MAX_BULLETS_UPGRADED : 1;
}

// 沿朝向推进一格步长。
function moveBullet(b: BulletState): void {
  switch (b.dir) {
    case 'up':
      b.y -= b.speed;
      break;
    case 'down':
      b.y += b.speed;
      break;
    case 'left':
      b.x -= b.speed;
      break;
    case 'right':
      b.x += b.speed;
      break;
  }
}

// 清除落在破坏条矩形 [sx0,sx1)×[sy0,sy1) 内的所有 4×4 象限（跨越子格边界时逐象限判定）。
// 象限中心落在矩形内即清除；非砖块格由 removeBrickQuarters 自动忽略。
function clearQuartersInRect(
  level: LevelState,
  sx0: number,
  sy0: number,
  sx1: number,
  sy1: number,
): void {
  const colStart = Math.floor(sx0 / SUBTILE);
  const colEnd = Math.floor((sx1 - EPS) / SUBTILE);
  const rowStart = Math.floor(sy0 / SUBTILE);
  const rowEnd = Math.floor((sy1 - EPS) / SUBTILE);

  const quarters: Array<{ bit: number; ox: number; oy: number }> = [
    { bit: BRICK_TL, ox: 0, oy: 0 },
    { bit: BRICK_TR, ox: QUARTER, oy: 0 },
    { bit: BRICK_BL, ox: 0, oy: QUARTER },
    { bit: BRICK_BR, ox: QUARTER, oy: QUARTER },
  ];

  for (let row = rowStart; row <= rowEnd; row++) {
    for (let col = colStart; col <= colEnd; col++) {
      const cellX = col * SUBTILE;
      const cellY = row * SUBTILE;
      let mask = 0;
      for (const q of quarters) {
        const cx = cellX + q.ox + QUARTER / 2; // 象限中心
        const cy = cellY + q.oy + QUARTER / 2;
        if (cx >= sx0 && cx < sx1 && cy >= sy0 && cy < sy1) {
          mask |= q.bit;
        }
      }
      if (mask !== 0) {
        removeBrickQuarters(level, col, row, mask);
      }
    }
  }
}

// 计算击穿破坏条矩形：以子弹中心为中心、垂直行进方向宽 BRICK_CARVE_WIDTH(16)、
// 沿行进方向纵深 BRICK_CARVE_DEPTH(8)，前沿贴齐子弹撞入的子格边界。砖块 / 钢块击穿共用同一几何。
function stripRect(b: BulletState): { sx0: number; sy0: number; sx1: number; sy1: number } {
  const cx = b.x + BULLET_SIZE / 2; // 子弹中心
  const cy = b.y + BULLET_SIZE / 2;
  const halfW = BRICK_CARVE_WIDTH / 2; // 8
  switch (b.dir) {
    case 'up': {
      const row = Math.floor(b.y / SUBTILE); // 前沿（顶边）所在子格行
      const sy0 = row * SUBTILE;
      return { sx0: cx - halfW, sy0, sx1: cx + halfW, sy1: sy0 + BRICK_CARVE_DEPTH };
    }
    case 'down': {
      const row = Math.floor((b.y + BULLET_SIZE - EPS) / SUBTILE); // 前沿（底边）所在行
      const sy0 = row * SUBTILE;
      return { sx0: cx - halfW, sy0, sx1: cx + halfW, sy1: sy0 + BRICK_CARVE_DEPTH };
    }
    case 'left': {
      const col = Math.floor(b.x / SUBTILE); // 前沿（左边）所在列
      const sx0 = col * SUBTILE;
      return { sx0, sy0: cy - halfW, sx1: sx0 + BRICK_CARVE_DEPTH, sy1: cy + halfW };
    }
    case 'right': {
      const col = Math.floor((b.x + BULLET_SIZE - EPS) / SUBTILE); // 前沿（右边）所在列
      const sx0 = col * SUBTILE;
      return { sx0, sy0: cy - halfW, sx1: sx0 + BRICK_CARVE_DEPTH, sy1: cy + halfW };
    }
  }
}

// 砖块击穿：清除破坏条覆盖的象限（4×4 单位）。
function carveStrip(b: BulletState, level: LevelState): void {
  const { sx0, sy0, sx1, sy1 } = stripRect(b);
  clearQuartersInRect(level, sx0, sy0, sx1, sy1);
}

// 钢块击穿（star 满级弹）：清除破坏条覆盖的整个钢块子格（不做象限，整格清空）。
// 只清除战场内确为 STEEL 的格（removeSteel 内部做边界 / 类型校验），故不破坏战场边界。
function carveSteelStrip(b: BulletState, level: LevelState): void {
  const { sx0, sy0, sx1, sy1 } = stripRect(b);
  const c0 = Math.floor(sx0 / SUBTILE);
  const c1 = Math.floor((sx1 - EPS) / SUBTILE);
  const r0 = Math.floor(sy0 / SUBTILE);
  const r1 = Math.floor((sy1 - EPS) / SUBTILE);
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      removeSteel(level, col, row);
    }
  }
}

// 判定子弹前沿覆盖的子格并结算地形碰撞。
// - 砖块：击穿（挖破坏条），子弹消失。
// - 钢块 / 鹰巢 / 边界：子弹消失，不破坏地形（威力弹与打鹰属后续任务）。
// - 水 / 树林 / 冰 / 空地：飞越。
function resolveBulletTerrain(b: BulletState, level: LevelState, events: GameEvent[]): void {
  let hitBrick = false;
  let hitSteel = false; // 战场内的钢块（可被 star 满级弹击穿）
  let hitHard = false; // 鹰巢 / 战场边界（永不被地形击穿逻辑破坏）

  // 前沿一线覆盖的子格（垂直行进方向取子弹 4px 宽度）。
  const scan = (col: number, row: number): void => {
    const type = getCell(level, col, row);
    if (!isSolidForBullet(type)) return;
    if (type === Cell.BRICK) {
      hitBrick = true;
    } else if (type === Cell.STEEL) {
      // getCell 对越界返回 STEEL；区分“战场内真实钢块”与“边界”。
      const inField = col >= 0 && row >= 0 && col < level.cols && row < level.rows;
      if (inField) hitSteel = true;
      else hitHard = true;
    } else {
      hitHard = true; // 鹰巢
    }
  };

  switch (b.dir) {
    case 'up': {
      const row = Math.floor(b.y / SUBTILE);
      const c0 = Math.floor(b.x / SUBTILE);
      const c1 = Math.floor((b.x + BULLET_SIZE - EPS) / SUBTILE);
      for (let c = c0; c <= c1; c++) scan(c, row);
      break;
    }
    case 'down': {
      const row = Math.floor((b.y + BULLET_SIZE - EPS) / SUBTILE);
      const c0 = Math.floor(b.x / SUBTILE);
      const c1 = Math.floor((b.x + BULLET_SIZE - EPS) / SUBTILE);
      for (let c = c0; c <= c1; c++) scan(c, row);
      break;
    }
    case 'left': {
      const col = Math.floor(b.x / SUBTILE);
      const r0 = Math.floor(b.y / SUBTILE);
      const r1 = Math.floor((b.y + BULLET_SIZE - EPS) / SUBTILE);
      for (let r = r0; r <= r1; r++) scan(col, r);
      break;
    }
    case 'right': {
      const col = Math.floor((b.x + BULLET_SIZE - EPS) / SUBTILE);
      const r0 = Math.floor(b.y / SUBTILE);
      const r1 = Math.floor((b.y + BULLET_SIZE - EPS) / SUBTILE);
      for (let r = r0; r <= r1; r++) scan(col, r);
      break;
    }
  }

  if (!hitBrick && !hitSteel && !hitHard) return; // 未命中实心地形，继续飞行

  b.alive = false;
  if (b.steelPiercing && hitSteel && !hitHard) {
    // star 满级弹击穿钢块：整格清除钢块，同一破坏条内的砖块照常挖除。
    carveSteelStrip(b, level);
    if (hitBrick) carveStrip(b, level);
    events.push('brickHit'); // 破坏音
  } else if (hitBrick && !hitSteel && !hitHard) {
    // 纯砖块命中：挖破坏条。
    carveStrip(b, level);
    events.push('brickHit');
  } else {
    events.push('steelHit'); // 钢块（未破钢）/ 鹰巢 / 边界：金属脆响
  }
}

// 推进所有在场子弹并结算地形碰撞（就地修改；死亡子弹由 update 清理）。
// 子弹撞地形消失时向 explosions 追加一个小爆炸火花。
export function advanceBullets(
  level: LevelState,
  bullets: BulletState[],
  explosions: ExplosionState[],
  events: GameEvent[],
): void {
  for (const b of bullets) {
    if (!b.alive) continue;
    moveBullet(b);
    resolveBulletTerrain(b, level, events);
    if (!b.alive) {
      explosions.push(makeSmallExplosion(b.x + BULLET_SIZE / 2, b.y + BULLET_SIZE / 2));
    }
  }
}

// 4×4 子弹 AABB 是否与 16×16 坦克 AABB 重叠。
function bulletHitsTank(b: BulletState, t: TankState): boolean {
  return (
    b.x < t.x + TANK_SIZE &&
    b.x + BULLET_SIZE > t.x &&
    b.y < t.y + TANK_SIZE &&
    b.y + BULLET_SIZE > t.y
  );
}

// 两发子弹的 4×4 盒是否重叠。
function bulletsOverlap(a: BulletState, b: BulletState): boolean {
  return (
    a.x < b.x + BULLET_SIZE &&
    a.x + BULLET_SIZE > b.x &&
    a.y < b.y + BULLET_SIZE &&
    a.y + BULLET_SIZE > b.y
  );
}

// 子弹 vs 子弹：对向（阵营不同）重叠即相互抵消（经典机制）；同阵营互相穿过。
// 抵消处生成一个小爆炸火花。
export function resolveBulletBullet(
  bullets: BulletState[],
  explosions: ExplosionState[],
  events: GameEvent[],
): void {
  for (let i = 0; i < bullets.length; i++) {
    const a = bullets[i];
    if (!a.alive) continue;
    for (let j = i + 1; j < bullets.length; j++) {
      const b = bullets[j];
      if (!b.alive) continue;
      if (a.fromEnemy === b.fromEnemy) continue; // 同阵营穿过
      if (!bulletsOverlap(a, b)) continue;
      a.alive = false;
      b.alive = false;
      explosions.push(
        makeSmallExplosion((a.x + b.x) / 2 + BULLET_SIZE / 2, (a.y + b.y) / 2 + BULLET_SIZE / 2),
      );
      events.push('explosionSmall');
      break;
    }
  }
}

// 子弹 vs 坦克命中判定（不含伤害结算）：
// 敌弹只命中玩家坦克（敌弹穿过敌人 —— 经典）；玩家弹命中敌方坦克，也命中**其他玩家坦克**
//（友军冻结：不扣血、不记击杀，仅冻结对方，结算见 update.ts resolveBulletTanks），但绝不命中射手自己。
export function bulletCanHit(b: BulletState, t: TankState): boolean {
  const isPlayer = isPlayerTank(t);
  // 出生护盾期间：敌弹 / 友军弹都从坦克身上直接穿过（既不伤人 / 不冻结，也不消失），经典表现。
  if (isPlayer && t.invulnTicks > 0) return false;
  if (b.fromEnemy) return isPlayer;
  // 玩家弹：射手自身的子弹永远穿过自己（出膛瞬间即与自身重叠）。
  return isPlayer ? b.ownerId !== t.id : true;
}

export { bulletHitsTank };

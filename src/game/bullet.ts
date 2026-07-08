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
} from '../core/constants';
import { Cell, LevelState, getCell, isSolidForBullet, removeBrickQuarters } from './level';
import { TankState } from './tank';
import type { ExplosionState, GameEvent } from './state';

// 子弹实体：纯数据、可序列化。x/y 为 4×4 包围盒左上角的战场相对像素坐标。
export interface BulletState {
  x: number;
  y: number;
  dir: Direction;
  speed: number; // px/tick
  ownerId: number;
  fromEnemy: boolean; // 阵营：true=敌弹（只打玩家），false=玩家弹（只打敌人）
  alive: boolean;
}

const EPS = 1e-6;
const MUZZLE_OFFSET = (TANK_SIZE - BULLET_SIZE) / 2; // 6：让 4px 子弹在 16px 炮口居中

// 生成一个以 (cx, cy) 为中心的小爆炸（16×16，子弹消失时的火花）。
export function makeSmallExplosion(cx: number, cy: number): ExplosionState {
  return { x: cx - 8, y: cy - 8, ticksLeft: EXPLOSION_SMALL_TICKS, big: false };
}

// 从坦克炮口生成一发子弹（4×4，居中于坦克宽度、紧贴坦克盒外侧）。
// 速度取自该坦克（威力坦克更快）；阵营由是否玩家坦克决定。
export function spawnBullet(tank: TankState): BulletState {
  const base = {
    dir: tank.dir,
    speed: tank.bulletSpeed,
    ownerId: tank.id,
    fromEnemy: tank.kind !== 'player1',
    alive: true,
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

// 该坦克是否已有一发在场子弹（经典规则：每坦克同时仅一发）。
export function hasLiveBullet(bullets: BulletState[], ownerId: number): boolean {
  return bullets.some((b) => b.alive && b.ownerId === ownerId);
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

// 砖块击穿：以子弹中心为中心、垂直行进方向宽 BRICK_CARVE_WIDTH(16)、
// 沿行进方向纵深 BRICK_CARVE_DEPTH(8) 的矩形，清除其覆盖的象限。
function carveStrip(b: BulletState, level: LevelState): void {
  const cx = b.x + BULLET_SIZE / 2; // 子弹中心
  const cy = b.y + BULLET_SIZE / 2;
  const halfW = BRICK_CARVE_WIDTH / 2; // 8
  let sx0: number;
  let sy0: number;
  let sx1: number;
  let sy1: number;
  switch (b.dir) {
    case 'up': {
      const row = Math.floor(b.y / SUBTILE); // 前沿（顶边）所在子格行
      sy0 = row * SUBTILE;
      sy1 = sy0 + BRICK_CARVE_DEPTH;
      sx0 = cx - halfW;
      sx1 = cx + halfW;
      break;
    }
    case 'down': {
      const row = Math.floor((b.y + BULLET_SIZE - EPS) / SUBTILE); // 前沿（底边）所在行
      sy0 = row * SUBTILE;
      sy1 = sy0 + BRICK_CARVE_DEPTH;
      sx0 = cx - halfW;
      sx1 = cx + halfW;
      break;
    }
    case 'left': {
      const col = Math.floor(b.x / SUBTILE); // 前沿（左边）所在列
      sx0 = col * SUBTILE;
      sx1 = sx0 + BRICK_CARVE_DEPTH;
      sy0 = cy - halfW;
      sy1 = cy + halfW;
      break;
    }
    case 'right': {
      const col = Math.floor((b.x + BULLET_SIZE - EPS) / SUBTILE); // 前沿（右边）所在列
      sx0 = col * SUBTILE;
      sx1 = sx0 + BRICK_CARVE_DEPTH;
      sy0 = cy - halfW;
      sy1 = cy + halfW;
      break;
    }
  }
  clearQuartersInRect(level, sx0, sy0, sx1, sy1);
}

// 判定子弹前沿覆盖的子格并结算地形碰撞。
// - 砖块：击穿（挖破坏条），子弹消失。
// - 钢块 / 鹰巢 / 边界：子弹消失，不破坏地形（威力弹与打鹰属后续任务）。
// - 水 / 树林 / 冰 / 空地：飞越。
function resolveBulletTerrain(b: BulletState, level: LevelState, events: GameEvent[]): void {
  let hitBrick = false;
  let hitSolidOther = false; // 钢块 / 鹰巢 / 边界

  // 前沿一线覆盖的子格（垂直行进方向取子弹 4px 宽度）。
  const scan = (col: number, row: number): void => {
    const type = getCell(level, col, row);
    if (!isSolidForBullet(type)) return;
    if (type === Cell.BRICK) hitBrick = true;
    else hitSolidOther = true;
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

  if (!hitBrick && !hitSolidOther) return; // 未命中实心地形，继续飞行

  b.alive = false;
  // 钢块/鹰巢/边界阻挡时不破坏砖块；仅纯砖块命中才挖破坏条。
  if (hitBrick && !hitSolidOther) {
    carveStrip(b, level);
    events.push('brickHit');
  } else {
    events.push('steelHit'); // 钢块 / 鹰巢 / 边界：金属脆响
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
// 敌弹只命中玩家坦克，玩家弹只命中敌方坦克（敌弹穿过敌人 —— 经典）。
export function bulletCanHit(b: BulletState, t: TankState): boolean {
  const isPlayer = t.kind === 'player1';
  // 出生护盾期间：敌弹从坦克身上直接穿过（既不伤人，也不消失），经典表现。
  if (isPlayer && t.invulnTicks > 0) return false;
  return b.fromEnemy ? isPlayer : !isPlayer;
}

export { bulletHitsTank };

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
  SPREAD_PELLET_COUNT,
  SPREAD_SPLAY_RAD,
  SPREAD_BULLET_SPEED,
  SPREAD_MAX_VOLLEYS,
  SPIRAL_BULLET_SPEED,
  SPIRAL_RADIUS,
  SPIRAL_PERIOD_TICKS,
  SPIRAL_MAX_BULLETS,
  LASER_BULLET_SPEED,
  LASER_MAX_BULLETS,
  MACHINE_BULLET_SPEED,
  MACHINE_MAX_BULLETS,
  FIELD_WIDTH,
  FIELD_HEIGHT,
} from '../core/constants';
import {
  Cell,
  LevelState,
  brickMaskOverlapsRect,
  getCell,
  isSolidForBullet,
  removeBrickQuarters,
  removeSteel,
} from './level';
import { TankState, isPlayerTank } from './tank';
import type { ExplosionState, GameEvent } from './state';

// 子弹种类（决定观感与特殊结算）：
// 'normal' = 经典弹（cannon / 机枪 / 敌弹，纯四方向）；'pellet' = 散弹粒（可斜飞）；
// 'spiral' = 螺旋弹（沿路径正弦摆动）；'laser' = 激光（穿敌人 / 穿砖块）。
export type BulletKind = 'normal' | 'pellet' | 'spiral' | 'laser';

export interface BulletViewportBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

// 子弹实体：纯数据、可序列化。x/y 为 4×4 包围盒左上角的战场相对像素坐标。
export interface BulletState {
  id: number; // 每发子弹唯一；同一射手多弹时供网络快照稳定匹配
  x: number;
  y: number;
  dir: Direction; // 主轴朝向：地形开凿 / 前沿扫描一律按它定向（斜飞的散弹粒亦然）
  speed: number; // px/tick（主轴标称速度；实际位移见 vx/vy）
  vx: number; // 实际速度向量 X 分量（px/tick）：normal 由 dir×speed 推出，行为与改动前一致
  vy: number; // 实际速度向量 Y 分量（px/tick）
  age: number; // 出膛以来的 tick 数（螺旋弹相位用）
  kind: BulletKind;
  ownerId: number;
  ownerPlayerIndex: number; // 射手的玩家序号（玩家弹为其 playerIndex，敌弹为 -1）：用于击杀记分归属
  fromEnemy: boolean; // 阵营：true=敌弹（只打玩家），false=玩家弹（只打敌人）
  attacksEagle: boolean; // 智能坦克弹为 false：不伤害普通鹰巢；护送车对所有子弹均无敌且会挡弹
  alive: boolean;
  // 大地图中记录开火瞬间的逻辑视口；子弹越过该固定边界即静默销毁。
  // 普通单屏关为 null，继续由地图实体边界按经典规则处理。
  viewportBounds: BulletViewportBounds | null;
  // 可击穿钢块（击中钢块时整格清除）。两条来源：star 满级（3 级）的 cannon 弹，或射手持有
  // drill 钻头（此时任何武器、任何等级都带破钢）。鹰巢与战场边界永不可穿。
  steelPiercing: boolean;
}

const EPS = 1e-6;
const MUZZLE_OFFSET = (TANK_SIZE - BULLET_SIZE) / 2; // 6：让 4px 子弹在 16px 炮口居中

// 生成一个以 (cx, cy) 为中心的小爆炸（16×16，子弹消失时的火花）。
export function makeSmallExplosion(cx: number, cy: number): ExplosionState {
  return { x: cx - 8, y: cy - 8, ticksLeft: EXPLOSION_SMALL_TICKS, big: false };
}

// 朝向的单位向量（屏幕坐标系：y 向下为正）。
function dirVector(dir: Direction): { x: number; y: number } {
  switch (dir) {
    case 'up':
      return { x: 0, y: -1 };
    case 'down':
      return { x: 0, y: 1 };
    case 'left':
      return { x: -1, y: 0 };
    case 'right':
      return { x: 1, y: 0 };
  }
}

// 垂直于朝向的单位向量（把 dirVector 顺时针旋转 90°）：螺旋弹的摆动轴。
function perpVector(dir: Direction): { x: number; y: number } {
  const v = dirVector(dir);
  return { x: -v.y, y: v.x };
}

// 炮口位置：4×4 弹体居中于坦克宽度、紧贴坦克盒外侧。
function muzzlePos(tank: TankState): { x: number; y: number } {
  switch (tank.dir) {
    case 'up':
      return { x: tank.x + MUZZLE_OFFSET, y: tank.y - BULLET_SIZE };
    case 'down':
      return { x: tank.x + MUZZLE_OFFSET, y: tank.y + TANK_SIZE };
    case 'left':
      return { x: tank.x - BULLET_SIZE, y: tank.y + MUZZLE_OFFSET };
    case 'right':
      return { x: tank.x + TANK_SIZE, y: tank.y + MUZZLE_OFFSET };
  }
}

// 从坦克炮口生成一发子弹（4×4）。angleRad 为相对 tank.dir 的偏角（散弹用；0 = 沿主轴）。
// dir 一律取 tank.dir —— 地形开凿与前沿扫描按主轴定向，斜飞只体现在 vx/vy 上。
function makeBullet(
  tank: TankState,
  id: number,
  kind: BulletKind,
  speed: number,
  steelPiercing: boolean,
  level?: LevelState,
  angleRad = 0,
): BulletState {
  const isPlayer = isPlayerTank(tank);
  const { x, y } = muzzlePos(tank);
  const v = dirVector(tank.dir);
  // 绕原点旋转 angleRad（屏幕坐标系，正角度为顺时针）。
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return {
    id,
    x,
    y,
    dir: tank.dir,
    speed,
    vx: (v.x * cos - v.y * sin) * speed,
    vy: (v.x * sin + v.y * cos) * speed,
    age: 0,
    kind,
    ownerId: tank.id,
    ownerPlayerIndex: isPlayer ? tank.playerIndex : -1,
    fromEnemy: !isPlayer,
    attacksEagle: tank.kind !== 'smart',
    alive: true,
    viewportBounds: level ? firingViewportBounds(tank, level) : null,
    steelPiercing,
  };
}

// 权威模拟不依赖某个客户端的平滑镜头，因此以射手为中心并钳在地图内，得到所有玩家一致的
// “开火瞬间屏幕”。这个矩形一经写进子弹便不再移动。
function firingViewportBounds(tank: TankState, level: LevelState): BulletViewportBounds | null {
  const worldWidth = level.cols * SUBTILE;
  const worldHeight = level.rows * SUBTILE;
  if (worldWidth <= FIELD_WIDTH && worldHeight <= FIELD_HEIGHT) return null;

  const maxLeft = Math.max(0, worldWidth - FIELD_WIDTH);
  const maxTop = Math.max(0, worldHeight - FIELD_HEIGHT);
  const centerX = tank.x + TANK_SIZE / 2;
  const centerY = tank.y + TANK_SIZE / 2;
  const left = Math.max(0, Math.min(maxLeft, centerX - FIELD_WIDTH / 2));
  const top = Math.max(0, Math.min(maxTop, centerY - FIELD_HEIGHT / 2));
  return { left, top, right: left + FIELD_WIDTH, bottom: top + FIELD_HEIGHT };
}

// 从坦克炮口生成一发经典弹（cannon / 敌弹）。
// 速度取自该坦克（威力坦克更快；敌我 star 等级 ≥1 均提速到 STAR_BULLET_SPEED）；阵营由是否玩家坦克决定。
export function spawnBullet(tank: TankState, bulletId: number, level?: LevelState): BulletState {
  const speed = tank.level >= 1 ? STAR_BULLET_SPEED : tank.bulletSpeed;
  // 破钢条件取“或”：star 满级（仅 cannon）或持有钻头（任何武器、任何等级）。
  return makeBullet(tank, bulletId, 'normal', speed, tank.level >= 3 || tank.drill, level);
}

// 按坦克当前武器生成一次开火的全部子弹（cannon / 机枪各一发，散弹一轮三发）。
// star 满级的破钢只作用于 cannon；drill 钻头则让**所有**武器的子弹都能击穿钢块。
export function spawnWeaponBullets(
  tank: TankState,
  firstBulletId: number,
  level?: LevelState,
): BulletState[] {
  const drill = tank.drill; // 钻头：本次开火的每一发都带破钢
  switch (tank.weapon) {
    case 'spread': {
      // 以主轴为中心对称展开：三发时即 −22.5° / 0° / +22.5°（dir 均为 tank.dir）。
      const mid = (SPREAD_PELLET_COUNT - 1) / 2;
      const out: BulletState[] = [];
      for (let i = 0; i < SPREAD_PELLET_COUNT; i++) {
        out.push(
          makeBullet(
            tank,
            firstBulletId + i,
            'pellet',
            SPREAD_BULLET_SPEED,
            drill,
            level,
            (i - mid) * SPREAD_SPLAY_RAD,
          ),
        );
      }
      return out;
    }
    case 'spiral':
      return [makeBullet(tank, firstBulletId, 'spiral', SPIRAL_BULLET_SPEED, drill, level)];
    case 'laser':
      return [makeBullet(tank, firstBulletId, 'laser', LASER_BULLET_SPEED, drill, level)];
    case 'machine':
      return [makeBullet(tank, firstBulletId, 'normal', MACHINE_BULLET_SPEED, drill, level)];
    default:
      return [spawnBullet(tank, firstBulletId, level)];
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

// 该坦克同屏可存在的子弹上限：
// cannon 沿用 star 规则（等级 ≥2 为 PLAYER_MAX_BULLETS_UPGRADED，否则 1）；
// 特殊武器各有自己的上限（散弹的“1”指一轮齐射 —— 三发全灭前不能再射）。
export function maxBulletsFor(tank: TankState): number {
  switch (tank.weapon) {
    case 'spread':
      return SPREAD_MAX_VOLLEYS;
    case 'spiral':
      return SPIRAL_MAX_BULLETS;
    case 'laser':
      return LASER_MAX_BULLETS;
    case 'machine':
      return MACHINE_MAX_BULLETS;
    default:
      return tank.level >= 2 ? PLAYER_MAX_BULLETS_UPGRADED : 1;
  }
}

// 按速度向量推进一帧。normal 弹的 vx/vy 由 dir×speed 推出，结果与纯四方向位移完全一致。
// 螺旋弹另叠加一个垂直于主轴的正弦增量：位移 = (sin((age+1)ω) − sin(age·ω))·R，
// 等价于横向偏移恒为 sin(age·ω)·R（幅度 ≤ SPIRAL_RADIUS），无需记录出膛原点。
function moveBullet(b: BulletState): void {
  b.x += b.vx;
  b.y += b.vy;
  if (b.kind === 'spiral') {
    const w = (2 * Math.PI) / SPIRAL_PERIOD_TICKS;
    const d = (Math.sin((b.age + 1) * w) - Math.sin(b.age * w)) * SPIRAL_RADIUS;
    const n = perpVector(b.dir);
    b.x += n.x * d;
    b.y += n.y * d;
  }
  b.age++;
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
// - 砖块：击穿（挖破坏条），子弹消失；激光例外 —— 开凿后继续飞（穿砖）。
// - 钢块 / 鹰巢 / 边界：子弹消失，不破坏地形（star 满级 cannon 弹可破战场内钢块）。
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
      if (brickMaskOverlapsRect(level, col, row, b.x, b.y, b.x + BULLET_SIZE, b.y + BULLET_SIZE)) {
        hitBrick = true;
      }
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

  if (b.steelPiercing && hitSteel && !hitHard) {
    // 破钢弹（star 满级 cannon / 钻头）击穿钢块：整格清除钢块，同一破坏条内的砖块照常挖除。
    // 激光带破钢时与其穿砖行为一致 —— 开凿后继续飞；其余破钢弹照旧一击即止。
    carveSteelStrip(b, level);
    if (hitBrick) carveStrip(b, level);
    events.push('brickHit'); // 破坏音
    if (b.kind !== 'laser') b.alive = false;
  } else if (hitBrick && !hitSteel && !hitHard) {
    // 纯砖块命中：挖破坏条。激光贯穿砖块，开凿后继续飞（可一路钻出通道）。
    carveStrip(b, level);
    events.push('brickHit');
    if (b.kind !== 'laser') b.alive = false;
  } else {
    events.push('steelHit'); // 钢块（未破钢）/ 鹰巢 / 边界：金属脆响
    b.alive = false;
  }
}

// 推进所有在场子弹并结算地形碰撞（就地修改；死亡子弹由 update 清理）。
// 子弹撞地形消失时追加小爆炸；大地图中越过其开火瞬间的视口则静默回收，
// 避免镜头移动改变既有子弹的射程，或让它在远端长时间占用射手弹槽。
export function advanceBullets(
  level: LevelState,
  bullets: BulletState[],
  explosions: ExplosionState[],
  events: GameEvent[],
): void {
  for (const b of bullets) {
    if (!b.alive) continue;
    moveBullet(b);
    const bounds = b.viewportBounds;
    if (
      bounds &&
      (b.x < bounds.left ||
        b.y < bounds.top ||
        b.x + BULLET_SIZE > bounds.right ||
        b.y + BULLET_SIZE > bounds.bottom)
    ) {
      b.alive = false;
      continue;
    }
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

// 子弹 vs 子弹（重叠即判定）：
// - 不同阵营（玩家弹 × 敌弹）：相互抵消（经典机制）。
// - 同为玩家弹但射手不同（多人合作友军火力）：也相互抵消 —— 队友可打掉你的弹幕。
// - 同一射手的玩家弹（star 双弹 / 机枪连发 / 散弹同轮）与敌弹 × 敌弹：互相穿过。
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
      if (a.fromEnemy === b.fromEnemy) {
        if (a.fromEnemy) continue; // 敌弹 × 敌弹：穿过
        if (a.ownerId === b.ownerId) continue; // 同一射手自己的弹：穿过
      }
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
  // 出生护盾或 helmet 护盾期间，对方子弹直接穿过（既不伤害也不消失）。
  if (t.invulnTicks > 0) return false;
  if (b.fromEnemy) return isPlayer;
  // 玩家弹：射手自身的子弹永远穿过自己（出膛瞬间即与自身重叠）。
  return isPlayer ? b.ownerId !== t.id : true;
}

export { bulletHitsTank };

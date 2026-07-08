import { Direction, InputState } from '../core/types';
import {
  SUBTILE,
  TANK_SIZE,
  FIELD_WIDTH,
  FIELD_HEIGHT,
  PLAYER_SPEED,
  PLAYER_SPAWN_POINTS,
  BULLET_SPEED,
  ENEMY_SPEED_BASIC,
  ENEMY_SPEED_FAST,
  ENEMY_SPEED_POWER,
  ENEMY_SPEED_ARMOR,
  ENEMY_HP_DEFAULT,
  ARMOR_HP,
  ENEMY_BULLET_SPEED_POWER,
  ENEMY_BULLET_SPEED_DEFAULT,
  ENEMY_SPAWN_POINTS,
  AI_DECISION_MIN_TICKS,
  PLAYER_INVULN_TICKS,
} from '../core/constants';
import { LevelState, getCell, isSolidForTank } from './level';

// 敌方坦克种类（用于计分/计数等以种类为键的表）。
export type EnemyKind = 'basic' | 'fast' | 'power' | 'armor';

// 坦克种类：玩家 + 四种敌方。移动/碰撞逻辑敌我复用，靠 kind 区分外观与属性。
// 玩家不再区分 player1/2/…，统一为 'player'，具体序号见 playerIndex。
export type TankKind = 'player' | EnemyKind;

// 坦克实体：纯数据、可序列化（无函数/类实例）。设计为敌我复用，靠 kind 区分。
// x/y 为 16×16 包围盒左上角的战场相对像素坐标（0..FIELD_WIDTH-16 / 0..FIELD_HEIGHT-16）。
export interface TankState {
  id: number;
  kind: TankKind;
  playerIndex: number; // 玩家序号 0..3（决定出生点/配色/输入映射）；敌人恒为 -1
  x: number;
  y: number;
  dir: Direction;
  moving: boolean; // 本帧是否有方向输入（用于履带动画；撞墙不动时仍为 true）
  speed: number; // px/tick
  bulletSpeed: number; // 该坦克子弹速度（px/tick）
  prevFire: boolean; // 上一帧开火键状态（边沿触发用）
  alive: boolean;
  hp: number; // 剩余血量：常规 1，装甲 4；≤0 即毁
  aiTicks: number; // 敌方 AI 决策倒计时（玩家不使用，恒为 0）
  invulnTicks: number; // 出生护盾剩余帧：>0 时敌弹穿过、不受伤（敌人恒为 0）
}

// 判断一台坦克是否为玩家坦克。
export function isPlayerTank(t: TankState): boolean {
  return t.kind === 'player';
}

// 建立一名玩家坦克：按 playerIndex 取出生点，出生朝上。
export function createPlayer(playerIndex: number, id: number): TankState {
  const p = PLAYER_SPAWN_POINTS[playerIndex];
  return {
    id,
    kind: 'player',
    playerIndex,
    x: p.x,
    y: p.y,
    dir: 'up',
    moving: false,
    speed: PLAYER_SPEED,
    bulletSpeed: BULLET_SPEED,
    prevFire: false,
    alive: true,
    hp: 1,
    aiTicks: 0,
    // 实体化即获无敌：开局直接入场、复活经出生闪光后入场，两条路径都从此值起算。
    invulnTicks: PLAYER_INVULN_TICKS,
  };
}

// 敌方各种类的移动速度。
function enemySpeed(kind: TankKind): number {
  switch (kind) {
    case 'fast':
      return ENEMY_SPEED_FAST;
    case 'power':
      return ENEMY_SPEED_POWER;
    case 'armor':
      return ENEMY_SPEED_ARMOR;
    default:
      return ENEMY_SPEED_BASIC;
  }
}

// 敌方各种类的子弹速度（仅威力坦克更快）。
function enemyBulletSpeed(kind: TankKind): number {
  return kind === 'power' ? ENEMY_BULLET_SPEED_POWER : ENEMY_BULLET_SPEED_DEFAULT;
}

// 敌方各种类的血量（仅装甲坦克为 4）。
function enemyHp(kind: TankKind): number {
  return kind === 'armor' ? ARMOR_HP : ENEMY_HP_DEFAULT;
}

// 建立一台敌方坦克：出生于三个出生点之一（0=左 / 1=中 / 2=右），朝下。
export function createEnemy(kind: TankKind, id: number, spawnIndex: number): TankState {
  const p = ENEMY_SPAWN_POINTS[spawnIndex % ENEMY_SPAWN_POINTS.length];
  return {
    id,
    kind,
    playerIndex: -1, // 敌人无玩家序号
    x: p.x,
    y: p.y,
    dir: 'down',
    moving: false,
    speed: enemySpeed(kind),
    bulletSpeed: enemyBulletSpeed(kind),
    prevFire: false,
    alive: true,
    hp: enemyHp(kind),
    aiTicks: AI_DECISION_MIN_TICKS,
    invulnTicks: 0, // 敌方无出生护盾
  };
}

const EPS = 1e-6;
const MAX_X = FIELD_WIDTH - TANK_SIZE; // 192
const MAX_Y = FIELD_HEIGHT - TANK_SIZE; // 192

function isVertical(dir: Direction): boolean {
  return dir === 'up' || dir === 'down';
}

// 多键同按时的优先级：上 > 下 > 左 > 右。无方向键返回 null。
function desiredDir(input: InputState): Direction | null {
  if (input.up) return 'up';
  if (input.down) return 'down';
  if (input.left) return 'left';
  if (input.right) return 'right';
  return null;
}

// 轴吸附：把坐标对齐到最近的 8px（SUBTILE）整数倍。
function snapAxis(v: number): number {
  return Math.round(v / SUBTILE) * SUBTILE;
}

// 检查一段水平区间 [xLeft, xRight) 在某子格行 row 上是否触及不可穿透地形。
function rowBlocked(level: LevelState, row: number, xLeft: number, xRight: number): boolean {
  const c0 = Math.floor(xLeft / SUBTILE);
  const c1 = Math.floor((xRight - EPS) / SUBTILE);
  for (let c = c0; c <= c1; c++) {
    if (isSolidForTank(getCell(level, c, row))) return true;
  }
  return false;
}

// 检查一段竖直区间 [yTop, yBottom) 在某子格列 col 上是否触及不可穿透地形。
function colBlocked(level: LevelState, col: number, yTop: number, yBottom: number): boolean {
  const r0 = Math.floor(yTop / SUBTILE);
  const r1 = Math.floor((yBottom - EPS) / SUBTILE);
  for (let r = r0; r <= r1; r++) {
    if (isSolidForTank(getCell(level, col, r))) return true;
  }
  return false;
}

// 两个 16×16 坦克盒是否严格重叠（紧贴相邻不算重叠，便于吸附贴合）。
function tanksOverlap(ax: number, ay: number, bx: number, by: number): boolean {
  return ax < bx + TANK_SIZE && ax + TANK_SIZE > bx && ay < by + TANK_SIZE && ay + TANK_SIZE > by;
}

// 沿当前朝向尽量前进：先按地形紧贴边缘，再对其他坦克做实心夹紧（紧贴其外侧停下）。
// others 为场上全部坦克（含自身与死者，内部跳过）；单轴移动，垂直轴坐标本帧不变。
function moveTank(tank: TankState, level: LevelState, others: TankState[]): void {
  const d = tank.speed;
  const { x, y } = tank;
  switch (tank.dir) {
    case 'up': {
      let ny = Math.max(0, y - d);
      const row = Math.floor(ny / SUBTILE); // 前沿（顶边）所在行
      if (rowBlocked(level, row, x, x + TANK_SIZE)) {
        ny = (row + 1) * SUBTILE; // 紧贴该行下边界
      }
      for (const o of others) {
        if (o === tank || !o.alive) continue;
        if (tanksOverlap(x, ny, o.x, o.y)) ny = Math.max(ny, o.y + TANK_SIZE); // 紧贴上方坦克
      }
      tank.y = ny;
      break;
    }
    case 'down': {
      let ny = Math.min(MAX_Y, y + d);
      const bottom = ny + TANK_SIZE;
      const row = Math.floor((bottom - EPS) / SUBTILE); // 前沿（底边）所在行
      if (rowBlocked(level, row, x, x + TANK_SIZE)) {
        ny = row * SUBTILE - TANK_SIZE; // 紧贴该行上边界
      }
      for (const o of others) {
        if (o === tank || !o.alive) continue;
        if (tanksOverlap(x, ny, o.x, o.y)) ny = Math.min(ny, o.y - TANK_SIZE); // 紧贴下方坦克
      }
      tank.y = ny;
      break;
    }
    case 'left': {
      let nx = Math.max(0, x - d);
      const col = Math.floor(nx / SUBTILE); // 前沿（左边）所在列
      if (colBlocked(level, col, y, y + TANK_SIZE)) {
        nx = (col + 1) * SUBTILE; // 紧贴该列右边界
      }
      for (const o of others) {
        if (o === tank || !o.alive) continue;
        if (tanksOverlap(nx, y, o.x, o.y)) nx = Math.max(nx, o.x + TANK_SIZE); // 紧贴左侧坦克
      }
      tank.x = nx;
      break;
    }
    case 'right': {
      let nx = Math.min(MAX_X, x + d);
      const right = nx + TANK_SIZE;
      const col = Math.floor((right - EPS) / SUBTILE); // 前沿（右边）所在列
      if (colBlocked(level, col, y, y + TANK_SIZE)) {
        nx = col * SUBTILE - TANK_SIZE; // 紧贴该列左边界
      }
      for (const o of others) {
        if (o === tank || !o.alive) continue;
        if (tanksOverlap(nx, y, o.x, o.y)) nx = Math.min(nx, o.x - TANK_SIZE); // 紧贴右侧坦克
      }
      tank.x = nx;
      break;
    }
  }
}

// 仅转向（含原版轴吸附），不移动。垂直↔水平切换时把上一条移动轴吸附到最近 8px；
// 反向（up<->down / left<->right）不吸附。允许原地转向（即使被墙挡住）。
export function turnTank(tank: TankState, desired: Direction): void {
  if (desired === tank.dir) return;
  if (isVertical(tank.dir) !== isVertical(desired)) {
    if (isVertical(tank.dir)) {
      tank.y = Math.min(MAX_Y, Math.max(0, snapAxis(tank.y)));
    } else {
      tank.x = Math.min(MAX_X, Math.max(0, snapAxis(tank.x)));
    }
  }
  tank.dir = desired;
}

// 应用一帧输入：转向（含轴吸附）+ 移动（含坦克互相实心）。不处理开火（由 update 编排）。
// tanks 为场上全部坦克，用于坦克对坦克碰撞夹紧。
export function applyInput(
  tank: TankState,
  input: InputState,
  level: LevelState,
  tanks: TankState[],
): void {
  const desired = desiredDir(input);
  if (desired === null) {
    // 无方向输入：原地不动，保持朝向。
    tank.moving = false;
    return;
  }

  turnTank(tank, desired);
  tank.moving = true;
  moveTank(tank, level, tanks);
}

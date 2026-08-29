import {
  BRICK_FULL,
  BULLET_SIZE,
  ESCORT_FIELD_COLS,
  ESCORT_FIELD_ROWS,
  ESCORT_HIT_INVULN_TICKS,
  ESCORT_MAX_HP,
  ESCORT_SIZE,
  ESCORT_SPEED,
  EXPLOSION_BIG_SIZE,
  EXPLOSION_BIG_TICKS,
  EXPLOSION_SMALL_TICKS,
  PLAYER_SPAWN_POINTS,
  SUBTILE,
  TANK_SIZE,
} from '../core/constants';
import type { Direction } from '../core/types';
import { Cell, type CellType, type LevelState, brickMaskOverlapsRect, getCell } from './level';
import type { GameState } from './state';

// 移动鹰巢的全部权威状态。只存数据，可随 GameState 直接进入网络快照。
export interface EscortState {
  x: number;
  y: number;
  route: EscortWaypoint[];
  routeIndex: number; // 当前目标节点；route[0] 是固定出生点
  dir: Direction;
  hp: number;
  maxHp: number;
  speed: number;
  moving: boolean;
  arrived: boolean;
  destroyed: boolean;
  hitInvulnTicks: number;
  shieldTicks: number;
}

export interface EscortWaypoint {
  x: number;
  y: number;
}

export interface EscortGuardSlot {
  side: 'left' | 'right';
  inward: Direction;
  x: number;
  y: number;
  width: number;
  height: number;
}

// 每个护卫位沿车身方向覆盖连续两个坦克格，给玩家留出跟车调整空间。
// 1–2 人局只启用左侧一位；3–4 人局启用左右两位，车辆转弯时标记一并旋转。
export function escortGuardSlots(escort: EscortState, playerCount = 1): EscortGuardSlot[] {
  const stripLength = TANK_SIZE * 2;
  const centeredX = escort.x + (ESCORT_SIZE - stripLength) / 2;
  const centeredY = escort.y + (ESCORT_SIZE - stripLength) / 2;
  let slots: [EscortGuardSlot, EscortGuardSlot];
  switch (escort.dir) {
    case 'up':
      slots = [
        { side: 'left', inward: 'right', x: escort.x - TANK_SIZE, y: centeredY, width: TANK_SIZE, height: stripLength },
        { side: 'right', inward: 'left', x: escort.x + ESCORT_SIZE, y: centeredY, width: TANK_SIZE, height: stripLength },
      ];
      break;
    case 'down':
      slots = [
        { side: 'left', inward: 'left', x: escort.x + ESCORT_SIZE, y: centeredY, width: TANK_SIZE, height: stripLength },
        { side: 'right', inward: 'right', x: escort.x - TANK_SIZE, y: centeredY, width: TANK_SIZE, height: stripLength },
      ];
      break;
    case 'left':
      slots = [
        { side: 'left', inward: 'up', x: centeredX, y: escort.y + ESCORT_SIZE, width: stripLength, height: TANK_SIZE },
        { side: 'right', inward: 'down', x: centeredX, y: escort.y - TANK_SIZE, width: stripLength, height: TANK_SIZE },
      ];
      break;
    case 'right':
      slots = [
        { side: 'left', inward: 'down', x: centeredX, y: escort.y - TANK_SIZE, width: stripLength, height: TANK_SIZE },
        { side: 'right', inward: 'up', x: centeredX, y: escort.y + ESCORT_SIZE, width: stripLength, height: TANK_SIZE },
      ];
      break;
  }
  return playerCount >= 3 ? slots : [slots[0]];
}

// 以玩家坦克中心进入两格标记带为准；同一护卫位只需一名玩家占据。
export function escortGuardOccupancy(state: GameState): boolean[] {
  const escort = state.escort;
  if (!escort) return [];
  const slots = escortGuardSlots(escort, state.playerCount);
  return slots.map((slot) =>
    state.tanks.some((tank) => {
      if (!tank.alive || tank.kind !== 'player') return false;
      const centerX = tank.x + TANK_SIZE / 2;
      const centerY = tank.y + TANK_SIZE / 2;
      return (
        centerX >= slot.x &&
        centerX <= slot.x + slot.width &&
        centerY >= slot.y &&
        centerY <= slot.y + slot.height
      );
    }),
  );
}

export function escortHasGuard(state: GameState): boolean {
  const occupied = escortGuardOccupancy(state);
  return occupied.length > 0 && occupied.every(Boolean);
}

export function isEscortStage(stage: number): boolean {
  return stage % 2 === 1;
}

const ESCORT_ROUTES: ReadonlyArray<ReadonlyArray<EscortWaypoint>> = [
  // 1：中央直路，教学版。
  [{ x: 304, y: 656 }, { x: 304, y: 16 }],
  // 3：先向西绕行，再横穿至东侧终点。
  [
    { x: 304, y: 656 }, { x: 304, y: 520 }, { x: 176, y: 520 },
    { x: 176, y: 320 }, { x: 400, y: 320 }, { x: 400, y: 16 },
  ],
  // 5：从西侧上行，经中部横路切回中央。
  [
    { x: 144, y: 656 }, { x: 144, y: 480 }, { x: 432, y: 480 },
    { x: 432, y: 240 }, { x: 304, y: 240 }, { x: 304, y: 16 },
  ],
  // 7：东侧起步的双折线。
  [
    { x: 464, y: 656 }, { x: 464, y: 560 }, { x: 240, y: 560 },
    { x: 240, y: 400 }, { x: 400, y: 400 }, { x: 400, y: 208 },
    { x: 304, y: 208 }, { x: 304, y: 16 },
  ],
  // 9：最终移动关，多次横穿地图。
  [
    { x: 304, y: 656 }, { x: 304, y: 584 }, { x: 112, y: 584 },
    { x: 112, y: 416 }, { x: 480, y: 416 }, { x: 480, y: 240 },
    { x: 208, y: 240 }, { x: 208, y: 80 }, { x: 304, y: 80 },
    { x: 304, y: 16 },
  ],
  // 11：终盘回形路线，长距离横移与连续转向交替出现。
  [
    { x: 304, y: 656 }, { x: 304, y: 600 }, { x: 496, y: 600 },
    { x: 496, y: 480 }, { x: 96, y: 480 }, { x: 96, y: 304 },
    { x: 384, y: 304 }, { x: 384, y: 144 }, { x: 240, y: 144 },
    { x: 240, y: 16 },
  ],
];

function escortVariant(stage: number): number {
  return Math.floor(((Math.max(1, stage) - 1) % 12) / 2);
}

export function escortRouteForStage(stage: number): EscortWaypoint[] {
  return ESCORT_ROUTES[escortVariant(stage)].map((point) => ({ ...point }));
}

function routeDirection(from: EscortWaypoint, to: EscortWaypoint): Direction {
  if (to.x < from.x) return 'left';
  if (to.x > from.x) return 'right';
  if (to.y < from.y) return 'up';
  return 'down';
}

function put(level: LevelState, col: number, row: number, cell: CellType): void {
  if (col < 0 || row < 0 || col >= level.cols || row >= level.rows) return;
  const idx = row * level.cols + col;
  level.cells[idx] = cell;
  level.brickMask[idx] = cell === Cell.BRICK ? BRICK_FULL : 0;
}

function fillRect(
  level: LevelState,
  col: number,
  row: number,
  width: number,
  height: number,
  cell: CellType,
): void {
  for (let r = row; r < row + height; r++) {
    for (let c = col; c < col + width; c++) put(level, c, r, cell);
  }
}

function carveRoute(level: LevelState, route: ReadonlyArray<EscortWaypoint>): void {
  const margin = TANK_SIZE;
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1];
    const b = route[i];
    const left = Math.floor((Math.min(a.x, b.x) - margin) / SUBTILE);
    const top = Math.floor((Math.min(a.y, b.y) - margin) / SUBTILE);
    const right = Math.ceil((Math.max(a.x, b.x) + ESCORT_SIZE + margin) / SUBTILE);
    const bottom = Math.ceil((Math.max(a.y, b.y) + ESCORT_SIZE + margin) / SUBTILE);
    fillRect(level, left, top, right - left, bottom - top, Cell.EMPTY);
  }
}

// 六套 80×90 子格移动地图。先布置各自地貌，再沿对应折线路线开出护送走廊。
export function createEscortLevel(stage = 1): LevelState {
  const size = ESCORT_FIELD_COLS * ESCORT_FIELD_ROWS;
  const level: LevelState = {
    cols: ESCORT_FIELD_COLS,
    rows: ESCORT_FIELD_ROWS,
    cells: new Array<CellType>(size).fill(Cell.EMPTY),
    brickMask: new Array<number>(size).fill(0),
    rev: 0,
  };

  const variant = escortVariant(stage);
  const route = escortRouteForStage(stage);
  switch (variant) {
    case 0:
      for (let row = 6; row < ESCORT_FIELD_ROWS - 8; row += 12) {
        fillRect(level, 6, row, 10, 2, row % 24 === 6 ? Cell.BRICK : Cell.TREES);
        fillRect(level, 64, row + 4, 10, 2, row % 24 === 6 ? Cell.TREES : Cell.BRICK);
        fillRect(level, 22, row + 2, 4, 2, Cell.STEEL);
        fillRect(level, 54, row + 6, 4, 2, Cell.STEEL);
      }
      fillRect(level, 0, 45, ESCORT_FIELD_COLS, 4, Cell.WATER);
      break;
    case 1:
      fillRect(level, 0, 44, ESCORT_FIELD_COLS, 5, Cell.WATER);
      fillRect(level, 28, 4, 4, 78, Cell.WATER);
      for (let row = 8; row < 82; row += 14) {
        fillRect(level, 5, row, 12, 3, Cell.TREES);
        fillRect(level, 60, row + 5, 14, 2, Cell.BRICK);
      }
      break;
    case 2:
      fillRect(level, 0, 34, ESCORT_FIELD_COLS, 4, Cell.WATER);
      fillRect(level, 0, 67, ESCORT_FIELD_COLS, 3, Cell.WATER);
      for (let col = 8; col < 72; col += 14) {
        fillRect(level, col, 12, 3, 10, col % 28 === 8 ? Cell.STEEL : Cell.TREES);
        fillRect(level, col + 4, 72, 5, 8, Cell.BRICK);
      }
      break;
    case 3:
      fillRect(level, 18, 0, 4, ESCORT_FIELD_ROWS, Cell.WATER);
      fillRect(level, 58, 0, 4, ESCORT_FIELD_ROWS, Cell.WATER);
      for (let row = 10; row < 82; row += 12) {
        fillRect(level, 4, row, 10, 2, Cell.BRICK);
        fillRect(level, 29, row + 4, 20, 2, Cell.TREES);
        fillRect(level, 66, row + 2, 9, 3, Cell.STEEL);
      }
      break;
    case 4:
      fillRect(level, 0, 28, ESCORT_FIELD_COLS, 4, Cell.WATER);
      fillRect(level, 0, 56, ESCORT_FIELD_COLS, 4, Cell.WATER);
      for (let row = 6; row < 86; row += 10) {
        fillRect(level, 8, row, 8, 3, Cell.STEEL);
        fillRect(level, 31, row + 3, 8, 2, Cell.BRICK);
        fillRect(level, 64, row, 9, 3, Cell.TREES);
      }
      break;
    default:
      fillRect(level, 0, 22, ESCORT_FIELD_COLS, 3, Cell.WATER);
      fillRect(level, 0, 52, ESCORT_FIELD_COLS, 4, Cell.WATER);
      fillRect(level, 36, 0, 5, ESCORT_FIELD_ROWS, Cell.ICE);
      for (let row = 8; row < 84; row += 12) {
        fillRect(level, 4, row, 12, 2, Cell.TREES);
        fillRect(level, 48, row + 4, 8, 3, Cell.STEEL);
        fillRect(level, 66, row, 10, 2, Cell.BRICK);
      }
      break;
  }

  carveRoute(level, route);

  // 每张图两道可被玩家清除的路线障碍；位置随路线变化。
  const roadblocks: ReadonlyArray<ReadonlyArray<[number, number, number, number]>> = [
    [[37, 62, 6, 2], [37, 31, 6, 2]],
    [[37, 73, 6, 2], [29, 64, 2, 6]],
    [[17, 70, 6, 2], [37, 59, 2, 6]],
    [[57, 76, 6, 2], [43, 69, 2, 6]],
    [[37, 77, 6, 2], [24, 72, 2, 6]],
    [[37, 79, 6, 2], [60, 62, 2, 6]],
  ];
  for (const [col, row, width, height] of roadblocks[variant]) {
    fillRect(level, col, row, width, height, Cell.BRICK);
  }
  return level;
}

export function createEscortState(_level: LevelState, stage = 1): EscortState {
  const route = escortRouteForStage(stage);
  const start = route[0];
  return {
    x: start.x,
    y: start.y,
    route,
    routeIndex: 1,
    dir: routeDirection(start, route[1]),
    hp: ESCORT_MAX_HP,
    maxHp: ESCORT_MAX_HP,
    speed: ESCORT_SPEED,
    moving: false,
    arrived: false,
    destroyed: false,
    hitInvulnTicks: 0,
    shieldTicks: 0,
  };
}

// 玩家始终在护送关开局时的固定出生区成扇形出生。
// 复活点不跟随已经前进的车队，避免阵亡变相成为向前传送。
export function escortPlayerSpawn(
  escort: EscortState | null,
  playerIndex: number,
  level: LevelState,
): { x: number; y: number } {
  if (!escort) return PLAYER_SPAWN_POINTS[playerIndex];
  const offsets = [-32, 48, -56, 72];
  const maxX = level.cols * SUBTILE - TANK_SIZE;
  const maxY = level.rows * SUBTILE - TANK_SIZE;
  const start = escort.route[0];
  let x = start.x;
  let y = start.y;
  const behind = ESCORT_SIZE + 8;
  if (escort.dir === 'up' || escort.dir === 'down') {
    x += offsets[playerIndex];
    y += escort.dir === 'up' ? behind : -behind;
  } else {
    x += escort.dir === 'left' ? behind : -behind;
    y += offsets[playerIndex];
  }
  return {
    x: Math.max(0, Math.min(maxX, x)),
    y: Math.max(0, Math.min(maxY, y)),
  };
}

function rectHitsSolid(level: LevelState, x: number, y: number, size: number): boolean {
  const eps = 1e-6;
  const c0 = Math.floor(x / SUBTILE);
  const c1 = Math.floor((x + size - eps) / SUBTILE);
  const r0 = Math.floor(y / SUBTILE);
  const r1 = Math.floor((y + size - eps) / SUBTILE);
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      const cell = getCell(level, col, row);
      if (cell === Cell.BRICK) {
        if (brickMaskOverlapsRect(level, col, row, x, y, x + size, y + size)) return true;
      } else if (cell === Cell.STEEL || cell === Cell.WATER || cell === Cell.EAGLE) {
        return true;
      }
    }
  }
  return false;
}

function overlaps(
  ax: number,
  ay: number,
  aw: number,
  ah: number,
  bx: number,
  by: number,
  bw: number,
  bh: number,
): boolean {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

// 1–2 人需占据唯一护卫位；3–4 人需同时占据左右两位。满足后车队才沿路线前进。
export function updateEscort(state: GameState): void {
  const escort = state.escort;
  if (!escort || escort.destroyed || escort.arrived) return;
  if (escort.hitInvulnTicks > 0) escort.hitInvulnTicks--;
  if (escort.shieldTicks > 0) escort.shieldTicks--;

  if (!escortHasGuard(state)) {
    escort.moving = false;
    return;
  }

  const target = escort.route[escort.routeIndex];
  if (!target) {
    escort.arrived = true;
    escort.moving = false;
    return;
  }
  escort.dir = routeDirection(escort, target);
  const dx = target.x - escort.x;
  const dy = target.y - escort.y;
  const nextX = escort.x + Math.sign(dx) * Math.min(Math.abs(dx), escort.speed);
  const nextY = escort.y + Math.sign(dy) * Math.min(Math.abs(dy), escort.speed);
  let blocked = rectHitsSolid(state.level, nextX, nextY, ESCORT_SIZE);
  if (!blocked) {
    blocked = state.tanks.some(
      (tank) =>
        tank.alive &&
        overlaps(nextX, nextY, ESCORT_SIZE, ESCORT_SIZE, tank.x, tank.y, TANK_SIZE, TANK_SIZE),
    );
  }
  escort.moving = !blocked;
  if (blocked) return;
  escort.x = nextX;
  escort.y = nextY;
  if (escort.x === target.x && escort.y === target.y) {
    escort.routeIndex++;
    const nextTarget = escort.route[escort.routeIndex];
    if (!nextTarget) {
      escort.arrived = true;
      escort.moving = false;
    } else {
      escort.dir = routeDirection(escort, nextTarget);
    }
  }
}

// 敌弹命中移动鹰巢：护盾期只拦截，否则扣 1 点耐久。
export function resolveEscortHits(state: GameState): void {
  const escort = state.escort;
  if (!escort || escort.destroyed || escort.arrived) return;
  for (const bullet of state.bullets) {
    // 智能坦克的 attacksEagle=false：它只猎杀玩家，不伤害任何基地目标（含护送车）。
    if (!bullet.alive || !bullet.fromEnemy || !bullet.attacksEagle) continue;
    if (
      !overlaps(
        bullet.x,
        bullet.y,
        BULLET_SIZE,
        BULLET_SIZE,
        escort.x,
        escort.y,
        ESCORT_SIZE,
        ESCORT_SIZE,
      )
    ) continue;

    bullet.alive = false;
    state.explosions.push({
      x: bullet.x - 6,
      y: bullet.y - 6,
      ticksLeft: EXPLOSION_SMALL_TICKS,
      big: false,
    });
    if (escort.shieldTicks > 0 || escort.hitInvulnTicks > 0) {
      state.events.push('steelHit');
      continue;
    }

    escort.hp--;
    escort.hitInvulnTicks = ESCORT_HIT_INVULN_TICKS;
    state.events.push('explosionSmall');
    if (escort.hp > 0) continue;

    escort.hp = 0;
    escort.destroyed = true;
    escort.moving = false;
    const off = (EXPLOSION_BIG_SIZE - ESCORT_SIZE) / 2;
    state.explosions.push({
      x: escort.x - off,
      y: escort.y - off,
      ticksLeft: EXPLOSION_BIG_TICKS,
      big: true,
    });
    state.events.push('eagleDeath');
    break;
  }
}

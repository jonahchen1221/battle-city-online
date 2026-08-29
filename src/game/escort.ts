import {
  BRICK_FULL,
  BULLET_SIZE,
  ESCORT_FIELD_COLS,
  ESCORT_FIELD_ROWS,
  ESCORT_SIZE,
  ESCORT_SPEED,
  ESCORT_TIME_LIMIT_TICKS,
  EXPLOSION_SMALL_TICKS,
  PLAYER_SPAWN_POINTS,
  SUBTILE,
  TANK_SIZE,
  stageGroup,
} from '../core/constants';
// 关卡类型判定统一在 constants.ts（见 stageKind）；此处原样再导出，调用方无需改导入路径。
export { isEscortStage } from '../core/constants';
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
  timeLeftTicks: number;
  timeLimitTicks: number;
  timeExpired: boolean;
  speed: number;
  moving: boolean;
  arrived: boolean;
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

// 以完整折线路程为分母，计算车辆已实际行驶的比例；停驶不会推进，转弯后累计前序路段。
export function escortProgress(escort: EscortState): number {
  if (escort.route.length < 2) return 1;
  let total = 0;
  for (let i = 1; i < escort.route.length; i++) {
    total +=
      Math.abs(escort.route[i].x - escort.route[i - 1].x) +
      Math.abs(escort.route[i].y - escort.route[i - 1].y);
  }
  if (total <= 0) return 1;

  const targetIndex = Math.min(Math.max(1, escort.routeIndex), escort.route.length - 1);
  let traveled = 0;
  for (let i = 1; i < targetIndex; i++) {
    traveled +=
      Math.abs(escort.route[i].x - escort.route[i - 1].x) +
      Math.abs(escort.route[i].y - escort.route[i - 1].y);
  }
  const segmentStart = escort.route[targetIndex - 1];
  const segmentEnd = escort.route[targetIndex];
  const segmentLength =
    Math.abs(segmentEnd.x - segmentStart.x) + Math.abs(segmentEnd.y - segmentStart.y);
  const segmentTraveled =
    Math.abs(escort.x - segmentStart.x) + Math.abs(escort.y - segmentStart.y);
  traveled += Math.min(segmentLength, segmentTraveled);
  return Math.max(0, Math.min(1, traveled / total));
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

// 十条护送路线，每个护送关独占一条；后期路线通过折返、环绕与反向钩形改变交战方向。
export const ESCORT_ROUTES: ReadonlyArray<ReadonlyArray<EscortWaypoint>> = [
  // 路线 1：中央直路，教学版。
  [{ x: 304, y: 656 }, { x: 304, y: 16 }],
  // 路线 2：先向西绕行，再横穿至东侧终点。
  [
    { x: 304, y: 656 }, { x: 304, y: 520 }, { x: 176, y: 520 },
    { x: 176, y: 320 }, { x: 400, y: 320 }, { x: 400, y: 16 },
  ],
  // 路线 3：从西侧上行，经中部横路切回中央。
  [
    { x: 144, y: 656 }, { x: 144, y: 480 }, { x: 432, y: 480 },
    { x: 432, y: 240 }, { x: 304, y: 240 }, { x: 304, y: 16 },
  ],
  // 路线 4：东侧起步的双折线。
  [
    { x: 464, y: 656 }, { x: 464, y: 560 }, { x: 240, y: 560 },
    { x: 240, y: 400 }, { x: 400, y: 400 }, { x: 400, y: 208 },
    { x: 304, y: 208 }, { x: 304, y: 16 },
  ],
  // 路线 5：多次横穿地图。
  [
    { x: 304, y: 656 }, { x: 304, y: 584 }, { x: 112, y: 584 },
    { x: 112, y: 416 }, { x: 480, y: 416 }, { x: 480, y: 240 },
    { x: 208, y: 240 }, { x: 208, y: 80 }, { x: 304, y: 80 },
    { x: 304, y: 16 },
  ],
  // 路线 6：回形路线，长距离横移与连续转向交替出现。
  [
    { x: 304, y: 656 }, { x: 304, y: 600 }, { x: 496, y: 600 },
    { x: 496, y: 480 }, { x: 96, y: 480 }, { x: 96, y: 304 },
    { x: 384, y: 304 }, { x: 384, y: 144 }, { x: 240, y: 144 },
    { x: 240, y: 16 },
  ],
  // 路线 7：蛇形峡谷，车队在四道高地间反复横切。
  [
    { x: 112, y: 656 }, { x: 112, y: 560 }, { x: 400, y: 560 },
    { x: 400, y: 448 }, { x: 176, y: 448 }, { x: 176, y: 336 },
    { x: 464, y: 336 }, { x: 464, y: 224 }, { x: 256, y: 224 },
    { x: 256, y: 128 }, { x: 368, y: 128 }, { x: 368, y: 16 },
  ],
  // 路线 8：群岛船坞，沿外侧港道左右摆渡后切入中央。
  [
    { x: 464, y: 656 }, { x: 144, y: 656 }, { x: 144, y: 480 },
    { x: 480, y: 480 }, { x: 480, y: 288 }, { x: 192, y: 288 },
    { x: 192, y: 128 }, { x: 336, y: 128 }, { x: 336, y: 16 },
  ],
  // 路线 9：风暴棋盘，在宽阔冰区和窄桥之间交替转向。
  [
    { x: 304, y: 656 }, { x: 480, y: 656 }, { x: 480, y: 520 },
    { x: 144, y: 520 }, { x: 144, y: 368 }, { x: 432, y: 368 },
    { x: 432, y: 240 }, { x: 224, y: 240 }, { x: 224, y: 96 },
    { x: 304, y: 96 }, { x: 304, y: 16 },
  ],
  // 路线 10：回钩堡垒，深入内环后向下折返，再从核心走廊突围。
  [
    { x: 464, y: 656 }, { x: 464, y: 544 }, { x: 176, y: 544 },
    { x: 176, y: 224 }, { x: 432, y: 224 }, { x: 432, y: 400 },
    { x: 288, y: 400 }, { x: 288, y: 112 }, { x: 368, y: 112 },
    { x: 368, y: 16 },
  ],
];

// 第 e 次护送（e = 组号 stageGroup）直接取第 e 条路线；取模仅为越界关号提供安全回卷。
function escortVariant(stage: number): number {
  return (stageGroup(stage) - 1) % ESCORT_ROUTES.length;
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

// 十套 80×90 子格移动地图。先布置各自地貌，再沿对应折线路线开出护送走廊。
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
      // 桥头争夺：三条河把纵向推进切成四段；中央车桥最快，左右小桥可供玩家包抄。
      for (const row of [18, 43, 68]) {
        fillRect(level, 0, row, ESCORT_FIELD_COLS, 4, Cell.WATER);
      }
      for (const [row, left, right] of [[18, 7, 65], [43, 13, 59], [68, 5, 67]]) {
        fillRect(level, left, row, 8, 4, Cell.EMPTY);
        fillRect(level, right, row, 8, 4, Cell.EMPTY);
        fillRect(level, left - 2, row - 2, 2, 8, Cell.STEEL);
        fillRect(level, right + 8, row - 2, 2, 8, Cell.STEEL);
      }
      for (const row of [6, 29, 54, 77]) {
        fillRect(level, 4, row, 12, 4, Cell.TREES);
        fillRect(level, 17, row + 1, 7, 2, Cell.BRICK);
        fillRect(level, 56, row + 1, 7, 2, Cell.BRICK);
        fillRect(level, 64, row, 12, 4, Cell.TREES);
        fillRect(level, 26, row + 2, 4, 3, Cell.STEEL);
        fillRect(level, 50, row - 1, 4, 3, Cell.STEEL);
      }
      fillRect(level, 27, 24, 26, 8, Cell.ICE);
      fillRect(level, 25, 49, 30, 8, Cell.ICE);
      break;
    case 1:
      // 运河折返：十字运河制造桥口争夺，转角堡垒可守也可被砖墙侧翼突破。
      fillRect(level, 0, 26, ESCORT_FIELD_COLS, 4, Cell.WATER);
      fillRect(level, 0, 57, ESCORT_FIELD_COLS, 4, Cell.WATER);
      fillRect(level, 24, 4, 4, 80, Cell.WATER);
      fillRect(level, 53, 8, 4, 76, Cell.WATER);
      for (const [col, row, width, height] of [
        [6, 26, 8, 4], [66, 26, 8, 4], [10, 57, 8, 4], [62, 57, 8, 4],
        [24, 10, 4, 8], [24, 70, 4, 8], [53, 15, 4, 8], [53, 68, 4, 8],
      ]) {
        fillRect(level, col, row, width, height, Cell.EMPTY);
      }
      for (const [col, row] of [[5, 8], [60, 9], [6, 66], [61, 68]]) {
        fillRect(level, col, row, 13, 5, Cell.TREES);
        fillRect(level, col + 3, row + 5, 7, 2, Cell.BRICK);
      }
      for (const [col, row] of [[31, 14], [43, 34], [31, 47], [42, 72]]) {
        fillRect(level, col, row, 7, 2, Cell.STEEL);
        fillRect(level, col, row + 2, 2, 7, Cell.STEEL);
        fillRect(level, col + 5, row + 2, 2, 7, Cell.BRICK);
      }
      fillRect(level, 31, 34, 18, 9, Cell.ICE);
      break;
    case 2:
      // 冰原交叉火力：大片冰面让转向有风险，钢柱切割射线，树林提供近距离伏击路线。
      fillRect(level, 0, 35, ESCORT_FIELD_COLS, 4, Cell.WATER);
      fillRect(level, 0, 69, ESCORT_FIELD_COLS, 3, Cell.WATER);
      fillRect(level, 20, 43, 40, 15, Cell.ICE);
      fillRect(level, 4, 10, 18, 8, Cell.ICE);
      fillRect(level, 58, 74, 17, 9, Cell.ICE);
      for (const col of [7, 23, 55, 71]) {
        fillRect(level, col, 21, 3, 11, Cell.STEEL);
        fillRect(level, col, 41, 3, 12, Cell.BRICK);
      }
      for (const [col, row, width] of [[3, 28, 16], [60, 27, 16], [4, 58, 19], [57, 59, 19]]) {
        fillRect(level, col, row, width, 5, Cell.TREES);
      }
      for (const [col, row] of [[27, 12], [46, 18], [8, 76], [29, 73]]) {
        fillRect(level, col, row, 10, 2, Cell.BRICK);
        fillRect(level, col + 4, row - 2, 2, 6, Cell.STEEL);
      }
      fillRect(level, 6, 35, 9, 4, Cell.EMPTY);
      fillRect(level, 65, 35, 9, 4, Cell.EMPTY);
      fillRect(level, 10, 69, 8, 3, Cell.EMPTY);
      fillRect(level, 62, 69, 8, 3, Cell.EMPTY);
      break;
    case 3:
      // 双河堡垒：两条纵河形成三条战线，横向桥口与中央树林让护卫必须轮流看守侧翼。
      fillRect(level, 17, 0, 4, ESCORT_FIELD_ROWS, Cell.WATER);
      fillRect(level, 59, 0, 4, ESCORT_FIELD_ROWS, Cell.WATER);
      fillRect(level, 0, 31, ESCORT_FIELD_COLS, 3, Cell.WATER);
      fillRect(level, 0, 62, ESCORT_FIELD_COLS, 3, Cell.WATER);
      for (const row of [10, 38, 72]) {
        fillRect(level, 17, row, 4, 8, Cell.EMPTY);
        fillRect(level, 59, row + 4, 4, 8, Cell.EMPTY);
      }
      for (const col of [5, 34, 68]) {
        fillRect(level, col, 31, 8, 3, Cell.EMPTY);
        fillRect(level, col + 2, 62, 8, 3, Cell.EMPTY);
      }
      for (const [col, row] of [[3, 7], [24, 12], [45, 8], [66, 15], [4, 69], [26, 75], [47, 70], [67, 78]]) {
        fillRect(level, col, row, 9, 3, Cell.BRICK);
        fillRect(level, col + 3, row + 3, 3, 3, Cell.STEEL);
      }
      fillRect(level, 26, 38, 28, 18, Cell.TREES);
      fillRect(level, 30, 43, 20, 8, Cell.ICE);
      break;
    case 4:
      // 分段要塞：三道壕沟与交错火力点组成推进阶段，砖翼可打穿、钢核必须绕行。
      for (const row of [20, 43, 66]) {
        fillRect(level, 0, row, ESCORT_FIELD_COLS, 4, Cell.WATER);
      }
      for (const [row, a, b] of [[20, 8, 63], [43, 14, 57], [66, 5, 68]]) {
        fillRect(level, a, row, 9, 4, Cell.EMPTY);
        fillRect(level, b, row, 8, 4, Cell.EMPTY);
      }
      for (const row of [7, 29, 52, 75]) {
        fillRect(level, 5, row, 9, 3, Cell.STEEL);
        fillRect(level, 14, row + 1, 12, 2, Cell.BRICK);
        fillRect(level, 54, row + 1, 12, 2, Cell.BRICK);
        fillRect(level, 66, row, 9, 3, Cell.STEEL);
        fillRect(level, 28, row - 1, 8, 5, Cell.TREES);
        fillRect(level, 44, row - 1, 8, 5, Cell.TREES);
      }
      fillRect(level, 18, 25, 14, 8, Cell.ICE);
      fillRect(level, 48, 49, 14, 8, Cell.ICE);
      fillRect(level, 20, 72, 40, 7, Cell.ICE);
      break;
    case 5:
      // 终局回廊：环形水障、冰庭院与内外两层掩体，长折线路线不断改变交战方向。
      fillRect(level, 7, 18, 66, 4, Cell.WATER);
      fillRect(level, 7, 65, 66, 4, Cell.WATER);
      fillRect(level, 7, 18, 4, 51, Cell.WATER);
      fillRect(level, 69, 18, 4, 51, Cell.WATER);
      for (const [col, row, width, height] of [
        [20, 18, 9, 4], [51, 18, 9, 4], [20, 65, 9, 4], [51, 65, 9, 4],
        [7, 31, 4, 9], [7, 50, 4, 9], [69, 31, 4, 9], [69, 50, 4, 9],
      ]) {
        fillRect(level, col, row, width, height, Cell.EMPTY);
      }
      fillRect(level, 19, 29, 42, 27, Cell.ICE);
      fillRect(level, 24, 34, 32, 17, Cell.TREES);
      for (const [col, row] of [[3, 7], [29, 8], [61, 7], [4, 75], [31, 78], [64, 74]]) {
        fillRect(level, col, row, 12, 3, Cell.BRICK);
        fillRect(level, col + 4, row + 3, 4, 3, Cell.STEEL);
      }
      for (const [col, row] of [[14, 25], [58, 25], [14, 55], [58, 55], [34, 14], [34, 70]]) {
        fillRect(level, col, row, 8, 2, Cell.STEEL);
        fillRect(level, col + 2, row + 2, 4, 5, Cell.BRICK);
      }
      break;
    case 6:
      // 蛇形峡谷：交错水崖把战场分层，车队每次横切都会暴露新的侧翼。
      for (const [row, fromLeft] of [[16, true], [35, false], [54, true], [73, false]] as const) {
        fillRect(level, fromLeft ? 0 : 48, row, 32, 7, Cell.WATER);
        fillRect(level, fromLeft ? 32 : 0, row + 2, 16, 3, Cell.ICE);
        fillRect(level, fromLeft ? 58 : 10, row - 3, 12, 4, Cell.TREES);
      }
      for (const [col, row] of [[8, 7], [34, 10], [60, 27], [14, 43], [48, 47], [8, 65], [58, 78]]) {
        fillRect(level, col, row, 10, 3, Cell.BRICK);
        fillRect(level, col + 3, row + 3, 4, 3, Cell.STEEL);
      }
      fillRect(level, 27, 24, 26, 8, Cell.ICE);
      fillRect(level, 24, 62, 30, 7, Cell.TREES);
      break;
    case 7:
      // 群岛船坞：大片水域分成四座战斗岛，树林码头遮挡桥头视线。
      for (const [col, row, width, height] of [
        [0, 12, 28, 17], [52, 8, 28, 20], [4, 42, 24, 18], [51, 45, 29, 17],
        [0, 73, 25, 17], [55, 70, 25, 20],
      ]) fillRect(level, col, row, width, height, Cell.WATER);
      for (const [col, row] of [[30, 8], [35, 29], [31, 52], [27, 74]]) {
        fillRect(level, col, row, 18, 7, Cell.ICE);
        fillRect(level, col - 4, row + 2, 4, 5, Cell.TREES);
        fillRect(level, col + 18, row + 1, 4, 6, Cell.TREES);
      }
      for (const [col, row] of [[6, 32], [58, 33], [8, 65], [60, 64], [34, 18], [36, 83]]) {
        fillRect(level, col, row, 12, 2, Cell.STEEL);
        fillRect(level, col + 3, row + 2, 6, 4, Cell.BRICK);
      }
      break;
    case 8:
      // 风暴棋盘：冰面方阵鼓励高速包抄，水渠和钢制棋子形成短促交火线。
      for (let row = 7; row <= 71; row += 16) {
        for (let col = 5; col <= 61; col += 14) {
          const even = ((row - 7) / 16 + (col - 5) / 14) % 2 === 0;
          fillRect(level, col, row, 10, 9, even ? Cell.ICE : Cell.TREES);
        }
      }
      for (const row of [24, 49, 76]) fillRect(level, 0, row, ESCORT_FIELD_COLS, 3, Cell.WATER);
      for (const col of [18, 40, 62]) fillRect(level, col, 0, 3, ESCORT_FIELD_ROWS, Cell.WATER);
      for (const [col, row] of [[8, 19], [28, 29], [50, 18], [66, 40], [9, 58], [35, 67], [57, 78]]) {
        fillRect(level, col, row, 8, 2, Cell.BRICK);
        fillRect(level, col + 2, row - 2, 4, 6, Cell.STEEL);
      }
      break;
    default:
      // 回钩堡垒：双层城墙围出内环，路线进入核心后反向折返，敌军可从外圈持续夹击。
      for (const [inset, thickness] of [[6, 4], [22, 3]] as const) {
        fillRect(level, inset, inset + 7, ESCORT_FIELD_COLS - inset * 2, thickness, Cell.WATER);
        fillRect(level, inset, ESCORT_FIELD_ROWS - inset - 7, ESCORT_FIELD_COLS - inset * 2, thickness, Cell.WATER);
        fillRect(level, inset, inset + 7, thickness, ESCORT_FIELD_ROWS - inset * 2 - 14, Cell.WATER);
        fillRect(level, ESCORT_FIELD_COLS - inset - thickness, inset + 7, thickness, ESCORT_FIELD_ROWS - inset * 2 - 14, Cell.WATER);
      }
      fillRect(level, 28, 31, 24, 27, Cell.ICE);
      fillRect(level, 32, 36, 16, 17, Cell.TREES);
      for (const [col, row] of [[3, 5], [29, 7], [61, 6], [5, 76], [31, 80], [63, 75], [13, 35], [57, 48]]) {
        fillRect(level, col, row, 12, 3, Cell.BRICK);
        fillRect(level, col + 4, row + 3, 4, 3, Cell.STEEL);
      }
      for (const [col, row] of [[16, 24], [56, 24], [16, 60], [56, 60]]) {
        fillRect(level, col, row, 8, 2, Cell.STEEL);
        fillRect(level, col + 2, row + 2, 4, 5, Cell.BRICK);
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
    [[49, 49, 6, 2], [44, 27, 2, 6]],
    [[17, 70, 6, 2], [40, 35, 2, 6]],
    [[59, 72, 6, 2], [31, 45, 2, 6]],
    [[21, 47, 6, 2], [53, 38, 6, 2]],
  ];
  for (const [col, row, width, height] of roadblocks[variant]) {
    fillRect(level, col, row, width, height, Cell.BRICK);
  }

  // 地形生成后再次保证四名玩家的固定初始/复活点为 2×2 空地；车辆起始走廊由 carveRoute 保证。
  const start = route[0];
  const startDir = routeDirection(start, route[1]);
  const offsets = [-32, 48, -56, 72];
  for (const offset of offsets) {
    const behind = ESCORT_SIZE + 8;
    const x = start.x + (startDir === 'up' || startDir === 'down' ? offset : startDir === 'left' ? behind : -behind);
    const y = start.y + (startDir === 'up' || startDir === 'down' ? (startDir === 'up' ? behind : -behind) : offset);
    fillRect(level, Math.floor(x / SUBTILE), Math.floor(y / SUBTILE), 2, 2, Cell.EMPTY);
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
    timeLeftTicks: ESCORT_TIME_LIMIT_TICKS,
    timeLimitTicks: ESCORT_TIME_LIMIT_TICKS,
    timeExpired: false,
    speed: ESCORT_SPEED,
    moving: false,
    arrived: false,
  };
}

// 玩家始终在护送关开局时的固定出生区成扇形出生。
// 复活点不跟随已经前进的车队，避免阵亡变相成为向前传送。
// 16×16 坦克落点的地形校验（仅地形：砖/钢/水/鹰巢算挡；坦克重叠交由出生闪光的
// 实体化重试处理）。坐标须已在场内。
function tankSpotClear(level: LevelState, x: number, y: number): boolean {
  const col0 = Math.floor(x / SUBTILE);
  const row0 = Math.floor(y / SUBTILE);
  const col1 = Math.floor((x + TANK_SIZE - 1) / SUBTILE);
  const row1 = Math.floor((y + TANK_SIZE - 1) / SUBTILE);
  for (let row = row0; row <= row1; row++) {
    for (let col = col0; col <= col1; col++) {
      const cell = getCell(level, col, row);
      if (cell === Cell.STEEL || cell === Cell.WATER || cell === Cell.EAGLE) return false;
      if (
        cell === Cell.BRICK &&
        brickMaskOverlapsRect(level, col, row, x, y, x + TANK_SIZE, y + TANK_SIZE)
      )
        return false;
    }
  }
  return true;
}

// 以某锚点（护送车位置）推导玩家落点：车尾方向退一个车位 + 按 playerIndex 横向错位。
function spawnBehind(
  anchorX: number,
  anchorY: number,
  dir: Direction,
  playerIndex: number,
): { x: number; y: number } {
  const offsets = [-32, 48, -56, 72];
  const behind = ESCORT_SIZE + 8;
  let x = anchorX;
  let y = anchorY;
  if (dir === 'up' || dir === 'down') {
    x += offsets[playerIndex];
    y += dir === 'up' ? behind : -behind;
  } else {
    x += dir === 'left' ? behind : -behind;
    y += offsets[playerIndex];
  }
  return { x, y };
}

// 玩家出生 / 阵亡重生落点：以护送车「当前位置」为锚（开局时即路线起点，行为不变），
// 重生因此始终落在车辆附近的同一屏内，而不是被送回路线起点。
// 主选 = 车尾错位点；被地形挡住时按由近及远的环形备选扫描；全部失败则回退主选（钳到场内）。
export function escortPlayerSpawn(
  escort: EscortState | null,
  playerIndex: number,
  level: LevelState,
): { x: number; y: number } {
  if (!escort) return PLAYER_SPAWN_POINTS[playerIndex];
  const maxX = level.cols * SUBTILE - TANK_SIZE;
  const maxY = level.rows * SUBTILE - TANK_SIZE;
  const align = (v: number, max: number): number =>
    Math.max(0, Math.min(max, Math.round(v / SUBTILE) * SUBTILE));

  const primary = spawnBehind(escort.x, escort.y, escort.dir, playerIndex);
  const candidates: Array<{ x: number; y: number }> = [primary];
  // 环形备选：围绕车辆中心由近及远（上/下/左/右/四角），保证仍在车辆附近同屏。
  const cx = escort.x + ESCORT_SIZE / 2 - TANK_SIZE / 2;
  const cy = escort.y + ESCORT_SIZE / 2 - TANK_SIZE / 2;
  for (const r of [40, 56, 72, 88]) {
    for (const [dx, dy] of [
      [0, r], [0, -r], [-r, 0], [r, 0],
      [-r, r], [r, r], [-r, -r], [r, -r],
    ]) {
      candidates.push({ x: cx + dx, y: cy + dy });
    }
  }
  for (const c of candidates) {
    const x = align(c.x, maxX);
    const y = align(c.y, maxY);
    if (tankSpotClear(level, x, y)) return { x, y };
  }
  return { x: align(primary.x, maxX), y: align(primary.y, maxY) };
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
  if (!escort || escort.timeExpired || escort.arrived) return;

  // 倒计时只在实际游玩帧推进；暂停 / 开场幕布已在 update.ts 更早返回。
  // 护送关拾取 shovel 时复用 shovelTicks 暂停计时，车辆本身始终无敌。
  if (state.shovelTicks <= 0) {
    escort.timeLeftTicks = Math.max(0, escort.timeLeftTicks - 1);
    if (escort.timeLeftTicks === 0) {
      escort.timeExpired = true;
      escort.moving = false;
      return;
    }
  }

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

// 护送车是所有子弹的无敌实体障碍：命中只会消弹并产生钢铁反馈，不存在伤害或得分收益。
export function resolveEscortHits(state: GameState): void {
  const escort = state.escort;
  if (!escort || escort.timeExpired || escort.arrived) return;
  for (const bullet of state.bullets) {
    if (!bullet.alive) continue;
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
    state.events.push('steelHit');
  }
}

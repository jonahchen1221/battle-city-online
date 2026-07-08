import { FIELD_COLS, FIELD_ROWS, BRICK_FULL } from '../core/constants';

// 地形子格类型。存为数字码，保证 LevelState 可序列化（无类实例、无函数）。
export const Cell = {
  EMPTY: 0,
  BRICK: 1,
  STEEL: 2,
  WATER: 3,
  TREES: 4,
  ICE: 5,
  EAGLE: 6,
} as const;

export type CellType = (typeof Cell)[keyof typeof Cell];

// 关卡的完整地形数据。纯数据（并列的数字数组），可直接做网络快照。
// - cells[i]      子格类型（CellType）
// - brickMask[i]  仅当该格为 BRICK 时有意义：存活的 4 个象限位（见 constants BRICK_*）
export interface LevelState {
  cols: number;
  rows: number;
  cells: CellType[];
  brickMask: number[];
}

// 行主序线性下标。
export function cellIndex(level: LevelState, col: number, row: number): number {
  return row * level.cols + col;
}

// 读取某格类型。越界一律视为不可穿透的边界（用 STEEL 表示：对坦克/子弹都实心）。
export function getCell(level: LevelState, col: number, row: number): CellType {
  if (col < 0 || row < 0 || col >= level.cols || row >= level.rows) {
    return Cell.STEEL;
  }
  return level.cells[cellIndex(level, col, row)];
}

// 读取砖块象限掩码（非砖块格返回 0）。
export function getBrickMask(level: LevelState, col: number, row: number): number {
  if (col < 0 || row < 0 || col >= level.cols || row >= level.rows) {
    return 0;
  }
  return level.brickMask[cellIndex(level, col, row)];
}

// 坦克不可穿透：砖、钢、水、鹰巢。可穿透：树林、冰面、空地。
export function isSolidForTank(cellType: CellType): boolean {
  return (
    cellType === Cell.BRICK ||
    cellType === Cell.STEEL ||
    cellType === Cell.WATER ||
    cellType === Cell.EAGLE
  );
}

// 子弹不可穿透：砖、钢、鹰巢。可穿透（飞越）：水、树林、冰面、空地。
export function isSolidForBullet(cellType: CellType): boolean {
  return cellType === Cell.BRICK || cellType === Cell.STEEL || cellType === Cell.EAGLE;
}

// 清除砖块的若干象限位。若清空则该格变为 EMPTY。返回是否有象限被真正清除。
// （子弹碰撞判定属于后续任务，此处仅提供数据操作。）
export function removeBrickQuarters(
  level: LevelState,
  col: number,
  row: number,
  mask: number,
): boolean {
  if (col < 0 || row < 0 || col >= level.cols || row >= level.rows) {
    return false;
  }
  const idx = cellIndex(level, col, row);
  if (level.cells[idx] !== Cell.BRICK) {
    return false;
  }
  const before = level.brickMask[idx];
  const after = before & ~mask & BRICK_FULL;
  if (after === before) {
    return false;
  }
  level.brickMask[idx] = after;
  if (after === 0) {
    level.cells[idx] = Cell.EMPTY;
  }
  return true;
}

// 就地设置某格类型（保持 cells / brickMask 不变量：砖块置满象限，其余清 0）。
// 供 shovel 道具钢化 / 恢复鹰巢护墙使用。越界忽略。
export function setCell(level: LevelState, col: number, row: number, cell: CellType): void {
  if (col < 0 || row < 0 || col >= level.cols || row >= level.rows) {
    return;
  }
  const idx = cellIndex(level, col, row);
  level.cells[idx] = cell;
  level.brickMask[idx] = cell === Cell.BRICK ? BRICK_FULL : 0;
}

// 清除一个钢块子格（整格，不做象限）：仅当该格确为 STEEL 时置空。返回是否有钢块被清除。
// 供 star 满级（3 级）玩家子弹击穿钢块使用。越界（含边界）返回 false，故不破坏战场边界。
export function removeSteel(level: LevelState, col: number, row: number): boolean {
  if (col < 0 || row < 0 || col >= level.cols || row >= level.rows) {
    return false;
  }
  const idx = cellIndex(level, col, row);
  if (level.cells[idx] !== Cell.STEEL) {
    return false;
  }
  level.cells[idx] = Cell.EMPTY;
  return true;
}

// 深拷贝，避免关卡实例共享同一份 STAGE 常量数据（破坏砖块会就地修改）。
export function cloneLevel(level: LevelState): LevelState {
  return {
    cols: level.cols,
    rows: level.rows,
    cells: level.cells.slice(),
    brickMask: level.brickMask.slice(),
  };
}

// 建立一张全空关卡（默认 26×26）。
export function createEmptyLevel(cols = FIELD_COLS, rows = FIELD_ROWS): LevelState {
  const size = cols * rows;
  return {
    cols,
    rows,
    cells: new Array<CellType>(size).fill(Cell.EMPTY),
    brickMask: new Array<number>(size).fill(0),
  };
}

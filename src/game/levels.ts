import { FIELD_COLS, FIELD_ROWS, BRICK_FULL } from '../core/constants';
import { Cell, CellType, LevelState } from './level';

// 关卡文本格式：FIELD_ROWS 行 × FIELD_COLS 字符。
//   . = 空地   B = 砖块   S = 钢块   W = 水   T = 树林   I = 冰   E = 鹰巢
const CHAR_TO_CELL: Record<string, CellType> = {
  '.': Cell.EMPTY,
  B: Cell.BRICK,
  S: Cell.STEEL,
  W: Cell.WATER,
  T: Cell.TREES,
  I: Cell.ICE,
  E: Cell.EAGLE,
};

export function parseLevel(rows: string[]): LevelState {
  if (rows.length !== FIELD_ROWS) {
    throw new Error(`Level must have ${FIELD_ROWS} rows, got ${rows.length}`);
  }
  const cells: CellType[] = new Array<CellType>(FIELD_COLS * FIELD_ROWS);
  const brickMask: number[] = new Array<number>(FIELD_COLS * FIELD_ROWS).fill(0);

  for (let row = 0; row < FIELD_ROWS; row++) {
    const line = rows[row];
    if (line.length !== FIELD_COLS) {
      throw new Error(`Row ${row} must have ${FIELD_COLS} chars, got ${line.length}`);
    }
    for (let col = 0; col < FIELD_COLS; col++) {
      const ch = line[col];
      const type = CHAR_TO_CELL[ch];
      if (type === undefined) {
        throw new Error(`Unknown map char '${ch}' at ${col},${row}`);
      }
      const idx = row * FIELD_COLS + col;
      cells[idx] = type;
      if (type === Cell.BRICK) {
        brickMask[idx] = BRICK_FULL;
      }
    }
  }

  return { cols: FIELD_COLS, rows: FIELD_ROWS, cells, brickMask };
}

// 经典 NES《坦克大战》第 1 关的复刻。
// - 对称的竖直砖块走廊（成对的 2 子格宽砖柱）
// - 下部中央的一段钢块
// - 底部中央的鹰巢（2×2 子格，列 12-13 行 24-25），外围经典砖墙护盾
//   （左、左上、上、右上、右）；护盾外的底行留空供玩家出生（约列 8 与列 16）。
// prettier-ignore
export const STAGE_1: LevelState = parseLevel([
  '..........................', // 0
  '..........................', // 1
  '..BB..BB..BB..BB..BB..BB..', // 2
  '..BB..BB..BB..BB..BB..BB..', // 3
  '..BB..BB..BB..BB..BB..BB..', // 4
  '..BB..BB..BB..BB..BB..BB..', // 5
  '..BB..BB..BB..BB..BB..BB..', // 6
  '..BB..BB..BB..BB..BB..BB..', // 7
  '..BB..BB..BB..BB..BB..BB..', // 8
  '..BB..BB..BB..BB..BB..BB..', // 9
  '..........................', // 10
  '..........................', // 11
  '..BB..BB..BB..BB..BB..BB..', // 12
  '..BB..BB..BB..BB..BB..BB..', // 13
  '..BB..BB..BB..BB..BB..BB..', // 14
  '..BB..BB..BB..BB..BB..BB..', // 15
  '..BB..BB..BB..BB..BB..BB..', // 16
  '..........................', // 17
  '............SS............', // 18
  '............SS............', // 19
  '..........................', // 20
  '..........................', // 21
  '..........................', // 22
  '...........BBBB...........', // 23
  '...........BEEB...........', // 24
  '...........BEEB...........', // 25
]);

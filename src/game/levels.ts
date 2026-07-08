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

// 经典 NES《坦克大战》第 1 关的复刻，放大到 40×30 子格（20×15 大格）以适配 1–4 人合作。
// - 对称的竖直砖块走廊：9 对 2 子格宽砖柱（列 3,7,…,35），成上、中两带。
// - 中场对称装饰：正中 2×2 钢块（列 19-20），两侧各一段 4 子格宽横向砖墙（列 8-11 / 28-31）。
// - 底部正中鹰巢（2×2 子格，列 19-20 行 28-29），外围 1 子格厚经典砖墙护盾
//   （顶排列 18-21 行 27，左右列 18 与 21 行 28-29）；四个玩家出生列（6/14/24/32）底行留空。
// prettier-ignore
export const STAGE_1: LevelState = parseLevel([
  '........................................', // 0
  '........................................', // 1
  '...BB..BB..BB..BB..BB..BB..BB..BB..BB...', // 2
  '...BB..BB..BB..BB..BB..BB..BB..BB..BB...', // 3
  '...BB..BB..BB..BB..BB..BB..BB..BB..BB...', // 4
  '...BB..BB..BB..BB..BB..BB..BB..BB..BB...', // 5
  '...BB..BB..BB..BB..BB..BB..BB..BB..BB...', // 6
  '...BB..BB..BB..BB..BB..BB..BB..BB..BB...', // 7
  '...BB..BB..BB..BB..BB..BB..BB..BB..BB...', // 8
  '...BB..BB..BB..BB..BB..BB..BB..BB..BB...', // 9
  '........................................', // 10
  '........................................', // 11
  '...BB..BB..BB..BB..BB..BB..BB..BB..BB...', // 12
  '...BB..BB..BB..BB..BB..BB..BB..BB..BB...', // 13
  '...BB..BB..BB..BB..BB..BB..BB..BB..BB...', // 14
  '...BB..BB..BB..BB..BB..BB..BB..BB..BB...', // 15
  '...BB..BB..BB..BB..BB..BB..BB..BB..BB...', // 16
  '...BB..BB..BB..BB..BB..BB..BB..BB..BB...', // 17
  '...BB..BB..BB..BB..BB..BB..BB..BB..BB...', // 18
  '........................................', // 19
  '........BBBB.......SS.......BBBB........', // 20
  '........BBBB.......SS.......BBBB........', // 21
  '........................................', // 22
  '........................................', // 23
  '........................................', // 24
  '........................................', // 25
  '........................................', // 26
  '..................BBBB..................', // 27
  '..................BEEB..................', // 28
  '..................BEEB..................', // 29
]);

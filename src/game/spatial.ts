// 逻辑层的轻量均匀网格。它只保存实体数组下标，不进入 GameState，也不会影响序列化或确定性。
//
// 与 Map<cell, number[]> 相比，这里每个格子只记一条链表的头结点；链表节点复用内部数组，
// 每帧 reset 时不制造成百上千个短命小数组，避免实体密集时 GC 抖动。

const DEFAULT_CELL_SIZE = 16;
const EPS = 1e-6;

function cellKey(col: number, row: number): number {
  // 游戏坐标只会落在很小的范围内；各取有符号坐标的低 16 位可组成稳定整数 key。
  return ((col & 0xffff) << 16) ^ (row & 0xffff);
}

export class SpatialGrid {
  private readonly cellSize: number;
  private readonly heads = new Map<number, number>();
  private readonly entryItems: number[] = [];
  private readonly entryNext: number[] = [];
  private readonly seen: number[] = [];
  private readonly candidates: number[] = [];
  private entryCount = 0;
  private queryStamp = 0;

  constructor(cellSize = DEFAULT_CELL_SIZE) {
    this.cellSize = cellSize;
  }

  reset(): void {
    this.heads.clear();
    this.entryCount = 0;
  }

  insert(itemIndex: number, x: number, y: number, width: number, height: number): void {
    const c0 = Math.floor(x / this.cellSize);
    const c1 = Math.floor((x + width - EPS) / this.cellSize);
    const r0 = Math.floor(y / this.cellSize);
    const r1 = Math.floor((y + height - EPS) / this.cellSize);
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const key = cellKey(col, row);
        const entry = this.entryCount++;
        this.entryItems[entry] = itemIndex;
        this.entryNext[entry] = this.heads.get(key) ?? -1;
        this.heads.set(key, entry);
      }
    }
  }

  // 返回与矩形共享至少一个网格格子的实体下标。结果已去重并按原数组下标升序排列，
  // 因而窄相位仍严格沿用旧版双重循环的结算次序。
  query(x: number, y: number, width: number, height: number, minIndex = 0): readonly number[] {
    this.candidates.length = 0;
    this.queryStamp++;
    if (this.queryStamp >= Number.MAX_SAFE_INTEGER) {
      this.seen.length = 0;
      this.queryStamp = 1;
    }
    const stamp = this.queryStamp;
    const c0 = Math.floor(x / this.cellSize);
    const c1 = Math.floor((x + width - EPS) / this.cellSize);
    const r0 = Math.floor(y / this.cellSize);
    const r1 = Math.floor((y + height - EPS) / this.cellSize);

    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        let entry = this.heads.get(cellKey(col, row)) ?? -1;
        while (entry >= 0) {
          const itemIndex = this.entryItems[entry];
          if (itemIndex >= minIndex && this.seen[itemIndex] !== stamp) {
            this.seen[itemIndex] = stamp;
            this.candidates.push(itemIndex);
          }
          entry = this.entryNext[entry];
        }
      }
    }

    this.candidates.sort((a, b) => a - b);
    return this.candidates;
  }
}

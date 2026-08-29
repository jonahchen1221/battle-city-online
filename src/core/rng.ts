// 可播种的确定性随机数（mulberry32）。
// 游戏逻辑一律使用注入的 Rng，禁止直接调用 Math.random —— 联机版要求各端模拟可复现。
export interface Rng {
  next(): number; // [0, 1)
  int(maxExclusive: number): number;
  // 当前 mulberry32 内部状态。关卡检查点用它恢复完全相同的后续随机序列。
  getState(): number;
}

export function createRng(seed: number): Rng {
  let s = seed >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (maxExclusive: number) => Math.floor(next() * maxExclusive),
    getState: () => s,
  };
}

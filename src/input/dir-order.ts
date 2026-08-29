import { Direction } from '../core/types';

export type Dir = Direction;

export const DIRS: readonly Dir[] = ['up', 'down', 'left', 'right'];

// “后按的方向生效”队列。键盘与手柄共用：游戏层对多方向并按取固定优先级，
// 只有输入层知道按下先后，故在这里把顺序折叠成唯一的生效方向。
export class DirOrder {
  // 方向按下顺序（旧 → 新），队尾为当前生效方向。
  private order: Dir[] = [];
  // 每个方向当前按住的物理来源（W 与 ↑ 同映射 'up'、十字键与摇杆同映射一个方向），
  // 须全部松开才算离手。
  private sources = new Map<Dir, Set<string>>();

  press(dir: Dir, sourceId: string): void {
    const set = this.sources.get(dir) ?? new Set<string>();
    this.sources.set(dir, set);
    set.add(sourceId);
    // 移到队尾（最新）；已在队列中说明是同方向的另一来源。
    this.order = this.order.filter((d) => d !== dir);
    this.order.push(dir);
  }

  release(dir: Dir, sourceId: string): void {
    const set = this.sources.get(dir);
    if (!set) return;
    set.delete(sourceId);
    if (set.size === 0) this.order = this.order.filter((d) => d !== dir);
  }

  latest(): Dir | undefined {
    return this.order[this.order.length - 1];
  }

  // 清空全部按下状态（窗口失焦等场景：浏览器不保证补发 keyup）。
  clear(): void {
    this.order = [];
    this.sources.clear();
  }
}

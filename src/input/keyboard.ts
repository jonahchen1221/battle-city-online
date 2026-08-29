import { InputState, emptyInput } from '../core/types';

// 键位：方向键 / WASD 移动，Space 或 J 开火，Enter 开始
const KEY_MAP: Record<string, keyof InputState> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  KeyW: 'up',
  KeyS: 'down',
  KeyA: 'left',
  KeyD: 'right',
  Space: 'fire',
  KeyJ: 'fire',
  Enter: 'start',
  KeyP: 'pause',
};

type Dir = 'up' | 'down' | 'left' | 'right';

const DIRS: readonly Dir[] = ['up', 'down', 'left', 'right'];

function isDir(field: keyof InputState): field is Dir {
  return (DIRS as readonly string[]).includes(field);
}

export class Keyboard {
  private state: InputState = emptyInput();
  // 方向键按下顺序（旧 → 新）。快照只上报最新按下的方向：后按的键生效，
  // 松开后回落到仍按住的键（游戏层对多方向并按取固定优先级，顺序信息只有这里知道）。
  private dirOrder: Dir[] = [];
  // 每个方向当前按住的物理键（W 与 ↑ 同映射 'up'，须全部松开才算离手）。
  private dirCodes = new Map<Dir, Set<string>>();

  constructor(target: Window = window) {
    target.addEventListener('keydown', (e) => this.handle(e, true));
    target.addEventListener('keyup', (e) => this.handle(e, false));
  }

  private handle(e: KeyboardEvent, pressed: boolean): void {
    const field = KEY_MAP[e.code];
    if (field === undefined) return;
    e.preventDefault();
    // 忽略按住时的系统自动重复：否则旧方向会被反复顶回“最新”而盖掉后按的键。
    if (pressed && e.repeat) return;
    if (!isDir(field)) {
      this.state[field] = pressed;
      return;
    }
    const codes = this.dirCodes.get(field) ?? new Set<string>();
    this.dirCodes.set(field, codes);
    if (pressed) {
      codes.add(e.code);
      // 移到队尾（最新）；已在队列中说明是同方向的另一物理键或自动重复。
      this.dirOrder = this.dirOrder.filter((d) => d !== field);
      this.dirOrder.push(field);
    } else {
      codes.delete(e.code);
      if (codes.size === 0) this.dirOrder = this.dirOrder.filter((d) => d !== field);
    }
  }

  snapshot(): InputState {
    const snap = { ...this.state };
    for (const d of DIRS) snap[d] = false;
    const latest = this.dirOrder[this.dirOrder.length - 1];
    if (latest !== undefined) snap[latest] = true;
    return snap;
  }

  // 窗口失焦 / 页面隐藏时浏览器不保证继续派发 keyup。统一清空物理键与逻辑键状态，
  // 避免回到页面后仍沿失焦前的方向移动（开火 / 暂停等按键也一并释放）。
  reset(): void {
    this.state = emptyInput();
    this.dirOrder = [];
    this.dirCodes.clear();
  }
}

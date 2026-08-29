import { InputState, emptyInput } from '../core/types';
import { DirOrder, DIRS, Dir } from './dir-order';

// 键位：方向键 / WASD 移动，Space 或 J 开火，C 冲刺，Enter 开始
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
  KeyC: 'dash',
  Enter: 'start',
  KeyP: 'pause',
};

function isDir(field: keyof InputState): field is Dir {
  return (DIRS as readonly string[]).includes(field);
}

// 非方向的动作键（开火 / 冲刺 / 开始 / 暂停）。
type ActionField = Exclude<keyof InputState, Dir>;

export class Keyboard {
  private state: InputState = emptyInput();
  // 方向来源用物理键码（e.code）标识：W 与 ↑ 同映射 'up'，须全部松开才算离手。
  private dirs = new DirOrder();
  // 快速点按锁存：keydown 与 keyup 都落在两次快照之间的轻点（<1 逻辑帧）不再整次丢失，
  // 至少生效一帧。方向只锁存最近一次按下（与“后按生效”一致）；动作键逐键锁存。
  private tapDir: Dir | null = null;
  private tappedActions = new Set<ActionField>();

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
      if (pressed) this.tappedActions.add(field);
      return;
    }
    if (pressed) {
      this.dirs.press(field, e.code);
      this.tapDir = field;
    } else {
      this.dirs.release(field, e.code);
    }
  }

  snapshot(): InputState {
    const snap = { ...this.state };
    // 动作键：快照间隙内点按过的键本帧至少为真一次（即使已松开）。
    for (const a of this.tappedActions) snap[a] = true;
    this.tappedActions.clear();
    for (const d of DIRS) snap[d] = false;
    const latest = this.dirs.latest();
    if (latest !== undefined) {
      snap[latest] = true;
    } else if (this.tapDir !== null) {
      // 全部方向已松开，但最近一次按下还没被任何快照见过：补报一帧。
      snap[this.tapDir] = true;
    }
    this.tapDir = null;
    return snap;
  }

  // 窗口失焦 / 页面隐藏时浏览器不保证继续派发 keyup。统一清空物理键与逻辑键状态，
  // 避免回到页面后仍沿失焦前的方向移动（开火 / 暂停等按键也一并释放）。
  reset(): void {
    this.state = emptyInput();
    this.dirs.clear();
    this.tapDir = null;
    this.tappedActions.clear();
  }
}

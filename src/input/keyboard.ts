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
};

export class Keyboard {
  private state: InputState = emptyInput();

  constructor(target: Window = window) {
    target.addEventListener('keydown', (e) => this.handle(e, true));
    target.addEventListener('keyup', (e) => this.handle(e, false));
  }

  private handle(e: KeyboardEvent, pressed: boolean): void {
    const field = KEY_MAP[e.code];
    if (field === undefined) return;
    e.preventDefault();
    this.state[field] = pressed;
  }

  snapshot(): InputState {
    return { ...this.state };
  }
}

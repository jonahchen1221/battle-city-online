import { InputState, emptyInput } from '../core/types';
import { DirOrder, DIRS, Dir } from './dir-order';

// 通用 PC 手柄支持（浏览器原生 Gamepad API，无外部依赖）。
//
// 取值方式为轮询：Gamepad API 不发按键事件，必须每帧读一次 navigator.getGamepads()。
// 故 poll() 由 App.tick() 每逻辑帧调用一次（不分画面），snapshot() / takeMenuEdges()
// 只读已缓存的状态，保证同一帧内多次取值一致。

// 标准布局（"standard" mapping）按键索引。非标准手柄也照此尽力映射——
// 多数 XInput/DInput 手柄在 Chrome 下都被归一化成这套顺序，错也不至于更糟。
const BTN_A = 0;
const BTN_B = 1;
const BTN_X = 2;
const BTN_SELECT = 8;
const BTN_START = 9;
const BTN_DPAD: Record<number, Dir> = { 12: 'up', 13: 'down', 14: 'left', 15: 'right' };
const FIRE_BUTTONS = [BTN_A, BTN_B, BTN_X];

// 左摇杆死区。坦克只有 4 向，故取较大的死区把斜推也压成单一主轴方向，避免边缘抖动来回切向。
const STICK_DEADZONE = 0.5;
const AXIS_X = 0;
const AXIS_Y = 1;

// 摇杆来源 id 与十字键分开：两者可同时按住，须各自独立计入 DirOrder。
const SRC_DPAD = 'dpad';
const SRC_STICK = 'stick';

// 菜单画面是事件驱动的（键盘走 keydown），手柄没有事件，只能由逐帧轮询产出“按下沿”。
export interface MenuEdges {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean; // 十字键或摇杆方向的按下沿
  confirm: boolean; // A（button 0）按下沿
  back: boolean; // B（button 1）按下沿
  start: boolean; // Start（button 9）按下沿
}

function emptyEdges(): MenuEdges {
  return { up: false, down: false, left: false, right: false, confirm: false, back: false, start: false };
}

export class GamepadInput {
  private padIndex: number | null = null;
  private dirs = new DirOrder();
  private prevButtons: boolean[] = [];
  private stickDir: Dir | null = null;
  private fire = false;
  private start = false;
  private pause = false;
  // 累积的按下沿，takeMenuEdges() 取走后清空：消费方跳帧也不会漏掉一次按下。
  private edges: MenuEdges = emptyEdges();

  constructor(target: Window = window) {
    // 只认第一个连上的手柄；它拔出后由下一次 poll() 的懒扫描接管剩下的。
    target.addEventListener('gamepadconnected', (e) => {
      if (this.padIndex === null) this.padIndex = e.gamepad.index;
    });
    target.addEventListener('gamepaddisconnected', (e) => {
      if (this.padIndex === e.gamepad.index) this.reset();
    });
  }

  poll(): void {
    const pad = this.activePad();
    if (!pad) {
      // 手柄拔出 / 尚未出现：清掉一切按住态，否则坦克会保持最后一个方向一直走。
      if (this.padIndex !== null || this.prevButtons.length > 0) this.reset();
      return;
    }
    this.padIndex = pad.index;

    // ── 按键（含十字键按下沿）──
    const buttons = pad.buttons;
    for (const [idxStr, dir] of Object.entries(BTN_DPAD)) {
      const i = Number(idxStr);
      const now = pressed(buttons[i]);
      const was = this.prevButtons[i] ?? false;
      if (now && !was) {
        this.dirs.press(dir, SRC_DPAD);
        this.edges[dir] = true;
      } else if (!now && was) {
        this.dirs.release(dir, SRC_DPAD);
      }
    }
    if (edge(buttons[BTN_A], this.prevButtons[BTN_A])) this.edges.confirm = true;
    if (edge(buttons[BTN_B], this.prevButtons[BTN_B])) this.edges.back = true;
    if (edge(buttons[BTN_START], this.prevButtons[BTN_START])) this.edges.start = true;

    this.prevButtons = buttons.map((b) => pressed(b));

    // ── 左摇杆：主轴（绝对值大者）胜出，折成单一方向 ──
    const dir = stickDirection(pad.axes[AXIS_X] ?? 0, pad.axes[AXIS_Y] ?? 0);
    if (dir !== this.stickDir) {
      if (this.stickDir) this.dirs.release(this.stickDir, SRC_STICK);
      if (dir) {
        this.dirs.press(dir, SRC_STICK);
        this.edges[dir] = true; // 由无方向 / 其他方向切入 = 一次按下沿
      }
      this.stickDir = dir;
    }

    // ── 电平量（非边沿）：开火 / 开始 / 暂停 ──
    this.fire = FIRE_BUTTONS.some((i) => pressed(buttons[i]));
    this.start = pressed(buttons[BTN_START]);
    this.pause = pressed(buttons[BTN_SELECT]);
  }

  snapshot(): InputState {
    const snap = emptyInput();
    for (const d of DIRS) snap[d] = false;
    const latest = this.dirs.latest();
    if (latest !== undefined) snap[latest] = true;
    snap.fire = this.fire;
    snap.start = this.start;
    snap.pause = this.pause;
    return snap;
  }

  // 取走并清空累积的按下沿。菜单画面每帧调用，未用到的沿直接丢弃，
  // 保证切画面时不会重放上一个画面残留的按下。
  takeMenuEdges(): MenuEdges {
    const out = this.edges;
    this.edges = emptyEdges();
    return out;
  }

  // 选定当前生效的手柄：只认第一个。Chrome 要按一下键才会在 getGamepads() 里露面，
  // 且数组内可能有空洞，故每帧懒扫描；某些环境甚至没有 navigator.getGamepads。
  private activePad(): Gamepad | null {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return null;
    const pads = navigator.getGamepads();
    if (this.padIndex !== null) {
      const pad = pads[this.padIndex];
      if (pad) return pad;
    }
    for (const pad of pads) if (pad) return pad;
    return null;
  }

  private reset(): void {
    this.padIndex = null;
    this.dirs = new DirOrder();
    this.prevButtons = [];
    this.stickDir = null;
    this.fire = false;
    this.start = false;
    this.pause = false;
  }
}

// 兼容模拟扳机 / 压感键：pressed 不可靠时用 value 兜底。
function pressed(btn: GamepadButton | undefined): boolean {
  return btn !== undefined && (btn.pressed || btn.value > 0.5);
}

function edge(btn: GamepadButton | undefined, was: boolean | undefined): boolean {
  return pressed(btn) && !(was ?? false);
}

// 摇杆 → 单一方向：两轴都在死区内为无方向，否则取绝对值较大的那一轴。
function stickDirection(ax: number, ay: number): Dir | null {
  const absX = Math.abs(ax);
  const absY = Math.abs(ay);
  if (absX < STICK_DEADZONE && absY < STICK_DEADZONE) return null;
  if (absX >= absY) return ax > 0 ? 'right' : 'left';
  return ay > 0 ? 'down' : 'up';
}

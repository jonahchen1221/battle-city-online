import { RENDER_SCALE, NATIVE_WIDTH, NATIVE_HEIGHT } from './core/constants';
import { startLoop } from './core/loop';
import { Keyboard } from './input/keyboard';
import { createGameState } from './game/state';
import { update } from './game/update';
import { Renderer } from './render/renderer';
import { Sfx } from './audio/sfx';

const canvas = document.getElementById('game') as HTMLCanvasElement;
canvas.style.width = `${NATIVE_WIDTH * RENDER_SCALE}px`;
canvas.style.height = `${NATIVE_HEIGHT * RENDER_SCALE}px`;

const keyboard = new Keyboard();
const renderer = new Renderer(canvas);
const state = createGameState(20260708);

// 音频层（游戏层之外的唯一音频触点）：首次用户手势时解锁 AudioContext。
const sfx = new Sfx();
window.addEventListener('keydown', () => sfx.unlock());

// 开发模式调试钩子：控制台可读游戏状态（生产构建剔除）
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__state = state;
}

startLoop(
  () => {
    update(state, [keyboard.snapshot()]);
    // 逐帧抽干游戏层产生的音效事件并播放，随后清空（唯一音频触点）。
    for (const e of state.events) sfx.play(e);
    state.events.length = 0;
  },
  (alpha) => renderer.draw(state, alpha),
);

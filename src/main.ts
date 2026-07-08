import { ART_SCALE, NATIVE_WIDTH, NATIVE_HEIGHT } from './core/constants';
import { startLoop } from './core/loop';
import { Keyboard } from './input/keyboard';
import { createGameState } from './game/state';
import { update } from './game/update';
import { Renderer } from './render/renderer';
import { Sfx } from './audio/sfx';

const canvas = document.getElementById('game') as HTMLCanvasElement;

// 画布内部分辨率固定为 512×448（原生 × 美术倍数）；显示尺寸取能放进视口的最大整数 CSS 倍率。
const CANVAS_W = NATIVE_WIDTH * ART_SCALE; // 512
const CANVAS_H = NATIVE_HEIGHT * ART_SCALE; // 448
function fitCanvasToViewport(): void {
  const k = Math.max(
    1,
    Math.min(
      Math.floor((window.innerWidth - 32) / CANVAS_W),
      Math.floor((window.innerHeight - 32) / CANVAS_H),
    ),
  );
  canvas.style.width = `${CANVAS_W * k}px`;
  canvas.style.height = `${CANVAS_H * k}px`;
}

const keyboard = new Keyboard();
const renderer = new Renderer(canvas);
fitCanvasToViewport();
window.addEventListener('resize', fitCanvasToViewport);
const state = createGameState(20260708);

// 音频层（游戏层之外的唯一音频触点）：首次用户手势时解锁 AudioContext。
const sfx = new Sfx();
window.addEventListener('keydown', () => sfx.unlock());

// 开发模式调试钩子：控制台可读游戏状态 + 手动步进（生产构建剔除）。
// __step(n)：不依赖 rAF 地推进 n 个逻辑帧并重绘一次——rAF 被节流（页签不可见）时用于调试/验证。
if (import.meta.env.DEV) {
  const w = window as unknown as Record<string, unknown>;
  w.__state = state;
  w.__step = (n = 1) => {
    for (let i = 0; i < n; i++) {
      update(state, [keyboard.snapshot()]);
      for (const e of state.events) sfx.play(e);
      state.events.length = 0;
    }
    renderer.draw(state, 0);
  };
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

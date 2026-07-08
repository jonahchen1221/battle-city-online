import { ART_SCALE, NATIVE_WIDTH, NATIVE_HEIGHT } from './core/constants';
import { startLoop } from './core/loop';
import { Keyboard } from './input/keyboard';
import { resetGameState } from './game/state';
import { update } from './game/update';
import { Renderer } from './render/renderer';
import { Sfx } from './audio/sfx';
import { App } from './client/app';

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

// 音频层（游戏层之外的唯一音频触点）：首次用户手势时解锁 AudioContext。
const sfx = new Sfx();
window.addEventListener('keydown', () => sfx.unlock());

// 应用状态机：标题 / 房间码 / 大厅 / 本地游戏 / 联机游戏。循环钩子按当前画面分发。
const app = new App(canvas, renderer, keyboard, sfx);

// 开发模式调试钩子：本地游戏路径沿用原 __state / __step / __newGame（作用于本地局）；
// 追加 __screen（当前画面名）与 __net（联机客户端）供集成测试。生产构建剔除。
if (import.meta.env.DEV) {
  const w = window as unknown as Record<string, unknown>;
  const state = app.localGameState;
  w.__state = state;
  // __newGame(playerCount, seed?)：就地重开一局指定人数的本地游戏（多人逻辑联机前的本地验证用）。
  w.__newGame = (playerCount = 1, seed = 20260708) => {
    state.playerCount = playerCount;
    resetGameState(state, seed);
  };
  // __step(n)：不依赖 rAF 地推进 n 个逻辑帧并重绘本地局一次。
  w.__step = (n = 1) => {
    for (let i = 0; i < n; i++) {
      update(state, [keyboard.snapshot()]);
      for (const e of state.events) sfx.play(e);
      state.events.length = 0;
    }
    renderer.draw(state, 0);
  };
  w.__screen = () => app.currentScreen;
  w.__net = app.netClient;
  // __appTick(n)：手动驱动 app 主循环 n 次并重绘（rAF 被节流时的联机路径调试用）。
  w.__appTick = (n = 1) => {
    for (let i = 0; i < n; i++) app.tick();
    app.render(0);
  };
}

startLoop(
  () => app.tick(),
  (alpha) => app.render(alpha),
);

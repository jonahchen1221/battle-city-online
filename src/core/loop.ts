import { TICKS_PER_SECOND } from './constants';

// 固定时间步长主循环：逻辑严格按 60Hz 推进，渲染跟随 rAF。
// alpha 为两次逻辑帧之间的插值系数，渲染层可用它做平滑（联机插值同理）。
export function startLoop(update: () => void, render: (alpha: number) => void): void {
  const STEP_MS = 1000 / TICKS_PER_SECOND;
  const MAX_ACCUM_MS = 250; // 页签切走后回来不追帧，避免死亡螺旋
  let accumulator = 0;
  let last = performance.now();

  const frame = (now: number): void => {
    accumulator = Math.min(accumulator + (now - last), MAX_ACCUM_MS);
    last = now;
    while (accumulator >= STEP_MS) {
      update();
      accumulator -= STEP_MS;
    }
    render(accumulator / STEP_MS);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

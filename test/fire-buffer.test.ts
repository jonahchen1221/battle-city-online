import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameState } from '../src/game/state';
import { update } from '../src/game/update';
import { emptyInput, InputState } from '../src/core/types';
import { FIRE_BUFFER_TICKS } from '../src/core/constants';

function fireInput(): InputState {
  const input = emptyInput();
  input.fire = true;
  return input;
}

function liveBullets(state: ReturnType<typeof createGameState>): number {
  return state.bullets.filter((b) => b.alive).length;
}

test('a fire press while the bullet slot is full is buffered and fires when it frees', () => {
  const state = createGameState(1, 1, 2);
  state.phase = 'playing';

  update(state, [fireInput()]); // 第一发
  assert.equal(liveBullets(state), 1);

  update(state, [emptyInput()]); // 松开
  update(state, [fireInput()]); // 在场子弹未消：本次按下沿被缓冲而非丢弃
  assert.equal(liveBullets(state), 1);

  // 子弹消亡后，缓冲窗口内无需再按即自动补发。
  for (const b of state.bullets) b.alive = false;
  update(state, [emptyInput()]);
  assert.equal(liveBullets(state), 1);
});

test('a buffered press expires after FIRE_BUFFER_TICKS', () => {
  const state = createGameState(1, 1, 2);
  state.phase = 'playing';

  update(state, [fireInput()]);
  assert.equal(liveBullets(state), 1);
  update(state, [emptyInput()]);
  update(state, [fireInput()]); // 缓冲装填

  // 让缓冲完整流逝（期间弹位一直被占）。
  for (let i = 0; i < FIRE_BUFFER_TICKS; i++) update(state, [fireInput()]); // 按住不产生新边沿
  for (const b of state.bullets) b.alive = false;
  update(state, [fireInput()]); // 仍按住：无边沿、缓冲已过期 → 不开火
  assert.equal(liveBullets(state), 0);

  update(state, [emptyInput()]);
  update(state, [fireInput()]); // 松开再按：新边沿正常开火
  assert.equal(liveBullets(state), 1);
});

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
  const state = createGameState(1, 1, 1);
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

test('holding fire shoots again as soon as the bullet slot frees', () => {
  const state = createGameState(1, 1, 1);
  state.phase = 'playing';

  update(state, [fireInput()]);
  assert.equal(liveBullets(state), 1);

  // 无需松开再按；弹位释放后的下一帧自动补发。
  for (const b of state.bullets) b.alive = false;
  update(state, [fireInput()]);
  assert.equal(liveBullets(state), 1);
});

test('a released buffered press expires after FIRE_BUFFER_TICKS', () => {
  const state = createGameState(1, 1, 1);
  state.phase = 'playing';

  update(state, [fireInput()]);
  assert.equal(liveBullets(state), 1);
  update(state, [emptyInput()]);
  update(state, [fireInput()]); // 弹位占满时再次轻点，装填缓冲

  // 松开开火键，让轻点缓冲在弹位持续占用期间完整流逝。
  for (let i = 0; i < FIRE_BUFFER_TICKS; i++) update(state, [emptyInput()]);
  for (const b of state.bullets) b.alive = false;
  update(state, [emptyInput()]);
  assert.equal(liveBullets(state), 0);

  update(state, [fireInput()]); // 松开再按：新按下沿正常开火
  assert.equal(liveBullets(state), 1);
});

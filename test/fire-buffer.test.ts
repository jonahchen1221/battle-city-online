import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameState } from '../src/game/state';
import { update } from '../src/game/update';
import { emptyInput, InputState } from '../src/core/types';
import { FIRE_BUFFER_TICKS, PLAYER_FIRE_INTERVAL_TICKS } from '../src/core/constants';

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

  // 把冷却推进到输入缓冲可以覆盖的窗口，期间子弹仍占用弹位。
  for (let i = 0; i < PLAYER_FIRE_INTERVAL_TICKS - 2; i++) {
    update(state, [emptyInput()]);
  }
  update(state, [fireInput()]); // 在场子弹未消：本次按下沿被缓冲而非丢弃
  assert.equal(liveBullets(state), 1);

  // 子弹消亡后，剩余冷却走完即兑现缓冲，无需再按。
  for (const b of state.bullets) b.alive = false;
  update(state, [emptyInput()]);
  assert.equal(liveBullets(state), 1);
});

test('holding fire cannot exceed the minimum fire interval after a close-range bullet reset', () => {
  const state = createGameState(1, 1, 1);
  state.phase = 'playing';

  update(state, [fireInput()]);
  assert.equal(liveBullets(state), 1);
  const nextBulletId = state.nextBulletId;

  // 模拟贴脸命中：开火当帧后子弹立即消亡，但长按不能在下一帧补发。
  for (const b of state.bullets) b.alive = false;
  for (let i = 1; i < PLAYER_FIRE_INTERVAL_TICKS; i++) {
    update(state, [fireInput()]);
    assert.equal(state.nextBulletId, nextBulletId);
    assert.equal(liveBullets(state), 0);
  }

  // 从上一次开火起恰好间隔 PLAYER_FIRE_INTERVAL_TICKS 帧后才允许补发。
  update(state, [fireInput()]);
  assert.equal(state.nextBulletId, nextBulletId + 1);
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

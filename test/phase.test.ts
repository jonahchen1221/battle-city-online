import test from 'node:test';
import assert from 'node:assert/strict';
import { updatePhase } from '../src/game/phase';
import { createGameState } from '../src/game/state';

test('game over overrides an armed stage clear when the eagle dies during the delay', () => {
  const state = createGameState(42, 1, 2); // 普通鹰巢关
  state.phase = 'playing';
  state.enemyQueue = [];
  state.spawning = [];
  state.tanks = state.tanks.filter((tank) => tank.kind === 'player');

  updatePhase(state);
  assert.equal(state.pendingResult, 'stageclear');

  state.eagleDestroyed = true;
  updatePhase(state);

  assert.equal(state.pendingResult, 'gameover');
});

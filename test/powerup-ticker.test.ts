import test from 'node:test';
import assert from 'node:assert/strict';

import { tryPickupPowerup } from '../src/game/powerup';
import { createGameState } from '../src/game/state';

test('powerup pickup emits the collector and kind for the marquee', () => {
  const state = createGameState(42, 2);
  const player = state.tanks[1];
  state.events.length = 0;
  state.powerups.push({ kind: 'timer', x: player.x, y: player.y });

  tryPickupPowerup(state);

  assert.deepEqual(state.events, [
    { type: 'powerupPicked', playerIndex: 1, kind: 'timer' },
    'powerupPickup',
  ]);
  assert.equal(state.powerups.length, 0);
});

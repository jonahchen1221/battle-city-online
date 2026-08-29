import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HELMET_INVULN_TICKS,
  PLAYER_MAX_LEVEL,
  POWERUP_SCORE,
} from '../src/core/constants';
import { tryPickupPowerup } from '../src/game/powerup';
import { createGameState } from '../src/game/state';

function collectStarWithShield(invulnTicks: number) {
  const state = createGameState(42, 1);
  const player = state.tanks[0];
  player.level = PLAYER_MAX_LEVEL;
  player.invulnTicks = invulnTicks;
  state.powerups = [{ kind: 'star', x: player.x, y: player.y }];

  tryPickupPowerup(state);

  return { state, player };
}

test('a star grants a full shield when the player cannot level up and has no shield', () => {
  const { state, player } = collectStarWithShield(0);

  assert.equal(player.level, PLAYER_MAX_LEVEL);
  assert.equal(player.invulnTicks, HELMET_INVULN_TICKS);
  assert.equal(state.scoreByPlayer[0], POWERUP_SCORE);
  assert.equal(state.powerups.length, 0);
});

test('a star does not refresh a max-level player shield that is still active', () => {
  const remainingShieldTicks = 123;
  const { player } = collectStarWithShield(remainingShieldTicks);

  assert.equal(player.level, PLAYER_MAX_LEVEL);
  assert.equal(player.invulnTicks, remainingShieldTicks);
});

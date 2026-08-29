import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAYER_HP_LEVEL_3,
  PLAYER_MAX_LEVEL,
  POWERUP_SCORE,
} from '../src/core/constants';
import { tryPickupPowerup } from '../src/game/powerup';
import { createGameState } from '../src/game/state';

function collectStarWithArmor(hp: number) {
  const state = createGameState(42, 1);
  const player = state.tanks[0];
  player.level = PLAYER_MAX_LEVEL;
  player.hp = hp;
  player.invulnTicks = 0;
  state.powerups = [{ kind: 'star', x: player.x, y: player.y }];

  tryPickupPowerup(state);

  return { state, player };
}

test('a star restores the one-hit armor shield when a max-level player has lost it', () => {
  const { state, player } = collectStarWithArmor(PLAYER_HP_LEVEL_3 - 1);

  assert.equal(player.level, PLAYER_MAX_LEVEL);
  assert.equal(player.hp, PLAYER_HP_LEVEL_3);
  assert.equal(player.invulnTicks, 0);
  assert.equal(state.scoreByPlayer[0], POWERUP_SCORE);
  assert.equal(state.powerups.length, 0);
});

test('a star does not stack another armor shield on a fully armored max-level player', () => {
  const { player } = collectStarWithArmor(PLAYER_HP_LEVEL_3);

  assert.equal(player.level, PLAYER_MAX_LEVEL);
  assert.equal(player.hp, PLAYER_HP_LEVEL_3);
  assert.equal(player.invulnTicks, 0);
});

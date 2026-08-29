import test from 'node:test';
import assert from 'node:assert/strict';
import { bulletCanHit, spawnBullet } from '../src/game/bullet';
import { tryPickupPowerup } from '../src/game/powerup';
import { createGameState } from '../src/game/state';
import { createEnemy } from '../src/game/tank';
import { PLAYER_FREEZE_TICKS } from '../src/core/constants';
import { update } from '../src/game/update';
import { emptyInput } from '../src/core/types';

function stateWithEnemy() {
  const state = createGameState(42, 1);
  const enemy = createEnemy('basic', 2, 0);
  Object.assign(enemy, { x: 32, y: 32 });
  state.tanks.push(enemy);
  state.events.length = 0;
  return { state, enemy };
}

test('enemy tank picks up a personal powerup without awarding player score', () => {
  const { state, enemy } = stateWithEnemy();
  state.phase = 'playing';
  state.enemyQueue = [];
  state.neutralQueue = [];
  state.enemyFreezeTicks = 2;
  state.powerups.push({ kind: 'helmet', x: enemy.x, y: enemy.y });

  update(state, [emptyInput()]);

  assert.equal(state.powerups.length, 0);
  assert.ok(enemy.invulnTicks > 0);
  assert.equal(bulletCanHit(spawnBullet(state.tanks[0], 1), enemy), false);
  assert.equal(state.scoreByPlayer[0], 0);
  assert.deepEqual(state.events, [
    { type: 'powerupPicked', playerIndex: -1, kind: 'helmet' },
    'powerupPickup',
  ]);
});

test('enemy clock freezes the player faction', () => {
  const { state, enemy } = stateWithEnemy();
  const player = state.tanks[0];
  state.powerups.push({ kind: 'timer', x: enemy.x, y: enemy.y });

  tryPickupPowerup(state, 'enemy');

  assert.equal(state.playerFreezeTicks, PLAYER_FREEZE_TICKS);
  assert.equal(state.enemyFreezeTicks, 0);

  state.phase = 'playing';
  state.enemyQueue = [];
  state.neutralQueue = [];
  state.enemyFreezeTicks = 2;
  Object.assign(player, { x: 96, y: 96 });
  const xBefore = player.x;
  const input = emptyInput();
  input.right = true;
  update(state, [input]);
  assert.equal(player.x, xBefore);
});

test('enemy grenade destroys players through the normal life and respawn flow', () => {
  const { state, enemy } = stateWithEnemy();
  const player = state.tanks[0];
  const livesBefore = state.livesByPlayer[0];
  state.powerups.push({ kind: 'grenade', x: enemy.x, y: enemy.y });

  tryPickupPowerup(state, 'enemy');

  assert.equal(player.alive, false);
  assert.equal(state.livesByPlayer[0], livesBefore - 1);
  assert.equal(state.spawning[0]?.tank.playerIndex, 0);
  assert.ok(state.events.includes('playerDeath'));
});

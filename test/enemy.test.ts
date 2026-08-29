import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameState } from '../src/game/state';
import { createEnemy } from '../src/game/tank';
import { enrageLastEnemy, updateEnemies } from '../src/game/enemy';
import { ENEMY_BERSERK_BULLET_SPEED, ENEMY_BERSERK_SPEED } from '../src/core/constants';

test('enemy waits in spawn flash while its spawn point is occupied', () => {
  const state = createGameState(42, 1);
  const occupant = createEnemy('fast', 2, 0);
  const incoming = createEnemy('basic', 3, 2);
  Object.assign(occupant, { x: 188, y: 0, dir: 'left' });

  state.phase = 'playing';
  state.tanks = [occupant];
  state.spawning = [{ tank: incoming, ticksLeft: 1 }];
  state.enemyQueue = [];
  state.enemyFreezeTicks = 1;

  updateEnemies(state, state.level);

  assert.deepEqual(state.tanks.map((tank) => tank.id), [occupant.id]);
  assert.equal(state.spawning[0]?.tank.id, incoming.id);
  assert.equal(state.spawning[0]?.ticksLeft, 1);

  occupant.x = 160;
  updateEnemies(state, state.level);

  assert.deepEqual(state.tanks.map((tank) => tank.id), [occupant.id, incoming.id]);
  assert.equal(state.spawning.length, 0);
  assert.deepEqual({ x: incoming.x, y: incoming.y }, { x: 200, y: 0 });
});

test('the last remaining enemy of the stage becomes berserk', () => {
  const state = createGameState(42, 1);
  const last = createEnemy('basic', 9, 0);
  state.phase = 'playing';
  state.tanks = [last];
  state.spawning = [];
  state.enemyQueue = [];
  state.enemyFreezeTicks = 1;

  updateEnemies(state, state.level);

  assert.equal(last.berserk, true);
  assert.equal(last.speed, ENEMY_BERSERK_SPEED);
  assert.equal(last.bulletSpeed, ENEMY_BERSERK_BULLET_SPEED);
});

test('berserk does not trigger while another enemy is still queued or alive', () => {
  const state = createGameState(42, 1);
  const a = createEnemy('basic', 9, 0);
  const b = createEnemy('fast', 10, 1);
  state.phase = 'playing';
  state.tanks = [a, b];
  state.spawning = [];
  state.enemyQueue = [];
  state.enemyFreezeTicks = 1;

  updateEnemies(state, state.level);
  assert.equal(a.berserk, false);
  assert.equal(b.berserk, false);

  state.tanks = [a];
  state.enemyQueue = ['armor'];
  enrageLastEnemy(state);
  assert.equal(a.berserk, false);
});

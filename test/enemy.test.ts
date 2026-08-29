import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameState } from '../src/game/state';
import { createEnemy } from '../src/game/tank';
import { updateEnemies } from '../src/game/enemy';

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

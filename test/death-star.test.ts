import test from 'node:test';
import assert from 'node:assert/strict';
import { TANK_SIZE } from '../src/core/constants';
import { emptyInput } from '../src/core/types';
import { spawnBullet } from '../src/game/bullet';

import { createEmptyLevel } from '../src/game/level';

import { createGameState, nextStage } from '../src/game/state';
import { createEnemy } from '../src/game/tank';
import { update } from '../src/game/update';

test('smart tank killed by a player bullet drops a star at its death position', () => {
  const state = createGameState(2, 1, 2);
  const player = state.tanks[0];
  const smart = createEnemy('smart', 20, 0);
  state.phase = 'playing';
  state.level = createEmptyLevel();
  Object.assign(player, { x: 32, y: 64, dir: 'up' as const });
  Object.assign(smart, { x: 32, y: 48, dir: 'down' as const });
  state.tanks = [player, smart];
  state.spawning = [];
  state.enemyQueue = [];
  state.neutralQueue = [];
  state.powerups = [];
  state.bullets = [spawnBullet(player, state.nextBulletId++, state.level)];

  update(state, [emptyInput()]);

  assert.equal(smart.alive, false);
  assert.deepEqual(state.powerups, [{ kind: 'star', x: 32, y: 48 }]);
});

test('next stage gives the previous stage top scorer a fixed star', () => {
  const state = createGameState(4, 4, 1);
  state.scoreByPlayer = [100, 900, 500, 300];
  state.stageScoreStart = [0, 0, 0, 0];

  nextStage(state);

  assert.equal(state.stage, 2);
  const mvpSpawn = state.spawning.find(({ tank }) => tank.playerIndex === 1)?.tank;
  assert.ok(mvpSpawn);
  assert.deepEqual(state.powerups, [
    { kind: 'star', x: mvpSpawn.x, y: Math.max(0, mvpSpawn.y - TANK_SIZE) },
  ]);
});

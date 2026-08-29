import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameState } from '../src/game/state';
import { updateEnemies } from '../src/game/enemy';
import { canTankOccupy, isPlayerTank } from '../src/game/tank';
import {
  ENEMIES_PER_SPAWN_POINT,
  ENEMY_SPAWN_POINTS,
  spawnClusterXs,
  TANK_SIZE,
} from '../src/core/constants';

test('each spawn point flashes five enemies together along the top row', () => {
  const state = createGameState(20260829, 1);
  state.phase = 'playing';
  state.enemyFreezeTicks = 0;
  updateEnemies(state, state.level);

  const enemies = state.spawning.filter((s) => !isPlayerTank(s.tank));
  const expected = ENEMY_SPAWN_POINTS.length * ENEMIES_PER_SPAWN_POINT;
  assert.equal(enemies.length, expected);
  assert.equal(state.enemyQueue.length, 0);

  const expectedXs = ENEMY_SPAWN_POINTS.flatMap((_, i) => [...spawnClusterXs(i)]);
  const xs = enemies.map((s) => s.tank.x).sort((a, b) => a - b);
  assert.deepEqual(xs, expectedXs);
  for (const s of enemies) {
    assert.equal(s.tank.y, 0);
    assert.ok(canTankOccupy(s.tank, s.tank.x, s.tank.y, state.level, []), `(${s.tank.x},${s.tank.y}) 不可通行`);
  }

  const ids = new Set(enemies.map((s) => s.tank.id));
  assert.equal(ids.size, expected);
  // 齐射簇宽度：每点 5 台 × 16px，四点铺满 320px 顶行且互不重叠。
  for (let i = 1; i < xs.length; i++) {
    assert.ok(xs[i] >= xs[i - 1] + TANK_SIZE, `重叠或乱序：${xs[i - 1]} → ${xs[i]}`);
  }
});

test('spawn is deterministic for the same seed', () => {
  function spots(seed: number): Array<{ x: number; y: number }> {
    const state = createGameState(seed, 1);
    state.phase = 'playing';
    updateEnemies(state, state.level);
    return state.spawning
      .filter((s) => !isPlayerTank(s.tank))
      .map((s) => ({ x: s.tank.x, y: s.tank.y }));
  }
  assert.deepEqual(spots(7), spots(7));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameState } from '../src/game/state';
import { createEnemy } from '../src/game/tank';
import { updateEnemies } from '../src/game/enemy';
import { Cell, createEmptyLevel, removeBrickQuarters, setCell } from '../src/game/level';
import { spawnBullet } from '../src/game/bullet';
import { resolveEagleHit } from '../src/game/phase';
import {
  BRICK_TL,
  BRICK_TR,
  EAGLE_COL,
  EAGLE_ROW,
  STAGE_ENEMY_TOTAL,
  SUBTILE,
} from '../src/core/constants';

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

test('smart enemy uses pathfinding to close the distance to the nearest player', () => {
  const state = createGameState(42, 1);
  const player = state.tanks[0];
  const smart = createEnemy('smart', 2, 0);
  Object.assign(player, { x: 32, y: 64 });
  Object.assign(smart, { x: 0, y: 0, dir: 'down' });
  state.phase = 'playing';
  state.level = createEmptyLevel();
  state.tanks = [player, smart];
  state.spawning = [];
  state.enemyQueue = [];

  const before = Math.abs(player.x - smart.x) + Math.abs(player.y - smart.y);
  updateEnemies(state, state.level);
  const after = Math.abs(player.x - smart.x) + Math.abs(player.y - smart.y);

  assert.ok(after < before, `expected smart tank to approach player: ${before} -> ${after}`);
});

test('smart enemy aims and fires immediately when a player enters its firing lane', () => {
  const state = createGameState(42, 1);
  const player = state.tanks[0];
  const smart = createEnemy('smart', 2, 0);
  Object.assign(player, { x: 40, y: 120 });
  Object.assign(smart, { x: 40, y: 40, dir: 'right' });
  state.phase = 'playing';
  state.level = createEmptyLevel();
  state.tanks = [player, smart];
  state.spawning = [];
  state.enemyQueue = [];

  updateEnemies(state, state.level);

  assert.equal(smart.dir, 'down');
  assert.equal(state.bullets.length, 1);
  assert.equal(state.bullets[0].ownerId, smart.id);
  assert.equal(state.bullets[0].attacksEagle, false);
});

test('smart enemy backs away from a half-brick snap point instead of getting stuck', () => {
  const state = createGameState(42, 1);
  const player = state.tanks[0];
  const smart = createEnemy('smart', 2, 0);
  const level = createEmptyLevel();
  // 残砖从 y=148 开始；坦克停在 y=132 时恰好贴边，但向右转会尝试吸附到 y=136 并压入残砖。
  for (const col of [5, 6]) {
    setCell(level, col, 18, Cell.BRICK);
    removeBrickQuarters(level, col, 18, BRICK_TL | BRICK_TR);
  }
  Object.assign(player, { x: 96, y: 132 });
  Object.assign(smart, { x: 40, y: 132, dir: 'down' });
  state.phase = 'playing';
  state.level = level;
  state.tanks = [player, smart];
  state.spawning = [];
  state.enemyQueue = [];

  updateEnemies(state, level);
  assert.equal(smart.dir, 'up');
  assert.ok(smart.y < 132, `expected recovery step, got y=${smart.y}`);

  updateEnemies(state, level);
  assert.equal(smart.dir, 'right');
  assert.equal(state.bullets[0]?.ownerId, smart.id);
});

test('smart enemy neither fires down the eagle lane nor damages the eagle with its bullets', () => {
  const state = createGameState(42, 1);
  const player = state.tanks[0];
  const smart = createEnemy('smart', 2, 0);
  const eagleX = EAGLE_COL * SUBTILE;
  const eagleY = EAGLE_ROW * SUBTILE;
  Object.assign(player, { x: eagleX, y: eagleY });
  Object.assign(smart, { x: eagleX, y: eagleY - 64, dir: 'down' });
  state.phase = 'playing';
  state.level = createEmptyLevel();
  state.tanks = [player, smart];
  state.spawning = [];
  state.enemyQueue = [];

  updateEnemies(state, state.level);
  assert.equal(state.bullets.length, 0);

  Object.assign(smart, { x: eagleX, y: eagleY - 16, dir: 'down' });
  const bullet = spawnBullet(smart, state.nextBulletId++);
  state.bullets = [bullet];
  resolveEagleHit(state);

  assert.equal(bullet.attacksEagle, false);
  assert.equal(state.eagleDestroyed, false);

  const basic = createEnemy('basic', 3, 0);
  Object.assign(basic, { x: eagleX, y: eagleY - 16, dir: 'down' });
  state.bullets = [spawnBullet(basic, state.nextBulletId++)];
  resolveEagleHit(state);
  assert.equal(state.eagleDestroyed, true, 'traditional enemy bullets should keep classic behavior');
});

test('stage enemy queues include smart tanks without changing the configured total', () => {
  const expectedSmartCounts = [4, 5, 6, 7, 8];
  for (let stage = 1; stage <= 5; stage++) {
    const state = createGameState(42, 1, stage);
    assert.equal(state.enemyQueue.length, STAGE_ENEMY_TOTAL);
    assert.equal(
      state.enemyQueue.filter((kind) => kind === 'smart').length,
      expectedSmartCounts[stage - 1],
    );
  }
});

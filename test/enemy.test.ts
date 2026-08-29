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
  ESCORT_ENEMY_RECYCLE_TICKS,
  STAGE_ENEMY_TOTAL,
  SUBTILE,
} from '../src/core/constants';

test('escort-stage traditional enemies steer back toward the convoy combat zone', () => {
  const state = createGameState(100, 1, 1);
  const player = state.tanks[0];
  const basic = createEnemy('basic', 2, 0);
  const escort = state.escort!;
  Object.assign(basic, { x: 16, y: escort.y - 96, dir: 'left', aiTicks: 30 });
  state.phase = 'playing';
  state.tanks = [player, basic];
  state.spawning = [];
  state.enemyQueue = [];

  updateEnemies(state, state.level);

  assert.equal(basic.dir, 'right');
  assert.ok(basic.x > 16);
});

test('a hidden traditional enemy far behind the escort is recycled ahead with a spawn flash', () => {
  const state = createGameState(101, 1, 1);
  const player = state.tanks[0];
  const basic = createEnemy('basic', 2, 0);
  const escort = state.escort!;
  escort.y = 300;
  Object.assign(player, { x: escort.x, y: escort.y });
  Object.assign(basic, {
    x: 40,
    y: escort.y + 200,
    escortFarTicks: ESCORT_ENEMY_RECYCLE_TICKS - 1,
  });
  const bullet = spawnBullet(basic, state.nextBulletId++, state.level);
  state.phase = 'playing';
  state.tanks = [player, basic];
  state.spawning = [];
  state.enemyQueue = [];
  state.bullets = [bullet];

  updateEnemies(state, state.level);

  assert.equal(state.tanks.some((tank) => tank.id === basic.id), false);
  assert.equal(state.spawning[0]?.tank.id, basic.id);
  assert.ok(state.spawning[0]!.tank.y < escort.y);
  assert.equal(bullet.alive, false);
});

test('traditional enemy movement remains un-leashed on normal stages', () => {
  const state = createGameState(102, 1, 2);
  const player = state.tanks[0];
  const basic = createEnemy('basic', 2, 0);
  Object.assign(basic, { x: 40, y: 40, dir: 'left', aiTicks: 30 });
  state.phase = 'playing';
  state.level = createEmptyLevel();
  state.tanks = [player, basic];
  state.spawning = [];
  state.enemyQueue = [];

  updateEnemies(state, state.level);

  assert.equal(basic.dir, 'left');
  assert.ok(basic.x < 40);
  assert.equal(basic.escortFarTicks, 0);
});

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

test('smart enemy detours toward an eligible nearby powerup', () => {
  const state = createGameState(42, 1);
  const player = state.tanks[0];
  const smart = createEnemy('smart', 2, 0);
  Object.assign(player, { x: 240, y: 160 });
  Object.assign(smart, { x: 0, y: 0, dir: 'down', aiTicks: 0 });
  state.phase = 'playing';
  state.level = createEmptyLevel();
  state.tanks = [player, smart];
  state.spawning = [];
  state.enemyQueue = [];
  state.powerups = [{ kind: 'helmet', x: 64, y: 0 }];

  updateEnemies(state, state.level);

  assert.ok(smart.x > 0, `expected smart tank to seek helmet, got (${smart.x}, ${smart.y})`);
  assert.equal(smart.y, 0);
});

test('smart enemy keeps seeking powerups while no player tank is alive', () => {
  const state = createGameState(42, 1);
  const smart = createEnemy('smart', 2, 0);
  Object.assign(smart, { x: 0, y: 0, dir: 'down', aiTicks: 0 });
  state.phase = 'playing';
  state.level = createEmptyLevel();
  state.tanks = [smart];
  state.spawning = [];
  state.enemyQueue = [];
  state.powerups = [{ kind: 'helmet', x: 64, y: 0 }];

  updateEnemies(state, state.level);

  assert.ok(smart.x > 0, `expected smart tank to keep seeking helmet, got x=${smart.x}`);
});

test('only the closest smart enemy claims a nearby powerup', () => {
  const state = createGameState(42, 1);
  const player = state.tanks[0];
  const farther = createEnemy('smart', 2, 0);
  const closer = createEnemy('smart', 3, 0);
  Object.assign(player, { x: 0, y: 200 });
  Object.assign(farther, { x: 0, y: 0, dir: 'down', aiTicks: 0 });
  Object.assign(closer, { x: 48, y: 0, dir: 'down', aiTicks: 0 });
  state.phase = 'playing';
  state.level = createEmptyLevel();
  state.tanks = [player, farther, closer];
  state.spawning = [];
  state.enemyQueue = [];
  state.powerups = [{ kind: 'helmet', x: 80, y: 0 }];

  updateEnemies(state, state.level);

  assert.equal(farther.x, 0);
  assert.ok(closer.x > 48, `expected closest smart tank to claim helmet, got x=${closer.x}`);
});

test('smart enemy prioritizes a player in its firing lane over a nearby powerup', () => {
  const state = createGameState(42, 1);
  const player = state.tanks[0];
  const smart = createEnemy('smart', 2, 0);
  Object.assign(player, { x: 40, y: 120 });
  Object.assign(smart, { x: 40, y: 40, dir: 'right', aiTicks: 0 });
  state.phase = 'playing';
  state.level = createEmptyLevel();
  state.tanks = [player, smart];
  state.spawning = [];
  state.enemyQueue = [];
  state.powerups = [{ kind: 'helmet', x: 88, y: 40 }];

  updateEnemies(state, state.level);

  assert.equal(smart.dir, 'down');
  assert.equal(smart.x, 40);
  assert.equal(state.bullets[0]?.ownerId, smart.id);
});

test('smart enemy turns in place at a half-brick snap point and fires immediately', () => {
  const state = createGameState(42, 1);
  const player = state.tanks[0];
  const smart = createEnemy('smart', 2, 0);
  const level = createEmptyLevel();
  // 残砖从 y=148 开始；坦克停在 y=132 时向右转的吸附位（y=136）会压入残砖。
  // 转向不再被整帧拒绝：放弃吸附、原地转车头，当帧即可瞄准开火，不会卡死也无需倒车脱困。
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
  assert.equal(smart.dir, 'right');
  assert.deepEqual({ x: smart.x, y: smart.y }, { x: 40, y: 132 }); // 原地转向，未吸附进残砖
  assert.equal(state.bullets[0]?.ownerId, smart.id);
});

test('smart enemy neither fires down the eagle lane nor damages the eagle with its bullets', () => {
  const state = createGameState(42, 1, 2); // 普通鹰巢关；第 1 关暂作护送测试关
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

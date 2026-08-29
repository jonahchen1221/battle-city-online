import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameState } from '../src/game/state';
import { createEnemy } from '../src/game/tank';
import { updateEnemies } from '../src/game/enemy';
import { update } from '../src/game/update';
import { emptyInput } from '../src/core/types';
import { Cell, createEmptyLevel, setCell } from '../src/game/level';
import { spawnBullet } from '../src/game/bullet';
import { resolveEagleHit } from '../src/game/phase';
import {
  EAGLE_COL,
  EAGLE_ROW,
  ESCORT_ENEMY_RECYCLE_TICKS,
  ESCORT_STOPPED_SPAWN_DIVISOR,
  SMART_AI_FIRE_COOLDOWN_TICKS,
  STAGE_ENEMY_TOTAL,
  SUBTILE,
  SMART_AI_STUCK_TICKS,
} from '../src/core/constants';

test('escort stages refill their enemy composition while normal stages stay finite', () => {
  const escortState = createGameState(104, 1, 20);
  escortState.phase = 'playing';
  escortState.level = createEmptyLevel(escortState.level.cols, escortState.level.rows);
  escortState.enemyQueue = [];
  escortState.enemySpawnTimer = 0;
  escortState.spawning = [];
  escortState.tanks = [escortState.tanks[0]];
  escortState.escort!.moving = true;

  updateEnemies(escortState, escortState.level);

  assert.equal(escortState.spawning.filter((spawn) => spawn.tank.kind !== 'player').length, 1);
  assert.equal(escortState.enemyQueue.length, STAGE_ENEMY_TOTAL - 1);

  const normalState = createGameState(105, 1, 19);
  normalState.phase = 'playing';
  normalState.level = createEmptyLevel();
  normalState.enemyQueue = [];
  normalState.enemySpawnTimer = 0;
  normalState.spawning = [];
  normalState.tanks = [normalState.tanks[0]];

  updateEnemies(normalState, normalState.level);

  assert.equal(normalState.spawning.length, 0);
  assert.equal(normalState.enemyQueue.length, 0);
});

test('enemy waits in spawn flash while its spawn point is occupied', () => {
  const state = createGameState(42, 1, 1);
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

test('smart enemy plans around another tank instead of entering a blocked lane', () => {
  const state = createGameState(77, 1, 1);
  const player = state.tanks[0];
  const blocker = createEnemy('basic', 2, 0);
  const smart = createEnemy('smart', 3, 0);
  Object.assign(player, { x: 160, y: 160 });
  Object.assign(blocker, { x: 32, y: 32, speed: 0, dir: 'down' as const, aiTicks: 999 });
  Object.assign(smart, { x: 16, y: 32, dir: 'right' as const, aiTicks: 0 });
  state.phase = 'playing';
  state.level = createEmptyLevel();
  state.tanks = [player, blocker, smart];
  state.spawning = [];
  state.enemyQueue = [];

  for (let tick = 0; tick < SMART_AI_STUCK_TICKS; tick++) {
    updateEnemies(state, state.level);
  }

  assert.notEqual(smart.y, 32, 'smart tank should leave the blocked horizontal lane');
  assert.equal(smart.x, 16);
  assert.equal(smart.smartStuckTicks, 0);

  const detourY = smart.y;
  for (let tick = 0; tick < 4; tick++) updateEnemies(state, state.level);
  assert.ok(Math.abs(smart.y - 32) >= Math.abs(detourY - 32), 'detour should not jitter back');
});

test('smart enemy ignores collision epsilon when every escape direction is sealed', () => {
  const state = createGameState(78, 1, 1);
  const player = state.tanks[0];
  const smart = createEnemy('smart', 2, 0);
  const level = createEmptyLevel();
  // 智能坦克位于左上角：上/左是边界，右/下各有两格钢墙。碰撞二分会产生约 1e-6px
  // 的容差残值，但这不是真实移动，不能据此启动 24 帧脱困。
  for (const row of [0, 1]) setCell(level, 2, row, Cell.STEEL);
  for (const col of [0, 1]) setCell(level, col, 2, Cell.STEEL);
  Object.assign(player, { x: 64, y: 64 });
  Object.assign(smart, { x: 0, y: 0, dir: 'right' as const, aiTicks: 0 });
  state.phase = 'playing';
  state.level = level;
  state.tanks = [player, smart];
  state.spawning = [];
  state.enemyQueue = [];

  for (let tick = 0; tick < SMART_AI_STUCK_TICKS; tick++) {
    updateEnemies(state, level);
  }

  assert.deepEqual({ x: smart.x, y: smart.y }, { x: 0, y: 0 });
  assert.equal(smart.smartEscapeTicks, 0);
});

test('smart enemy takes a real detour when tanks block a corner', () => {
  const state = createGameState(88, 1, 1);
  const player = state.tanks[0];
  const stationary = (id: number, x: number, y: number) => {
    const tank = createEnemy('basic', id, 0);
    Object.assign(tank, { x, y, speed: 0, aiTicks: 999 });
    return tank;
  };
  const front = stationary(2, 64, 16);
  const above = stationary(3, 48, 0);
  const below = stationary(5, 48, 32);
  const smart = createEnemy('smart', 4, 0);
  Object.assign(player, { x: 144, y: 80 });
  Object.assign(smart, { x: 32, y: 16, dir: 'right' as const, aiTicks: 0 });
  state.phase = 'playing';
  state.level = createEmptyLevel();
  state.tanks = [player, front, above, below, smart];
  state.spawning = [];
  state.enemyQueue = [];

  // 旧逻辑无视动态占位，会在 x=29.25..48、y=16 之间永久往返；动态 A* 应在抵达
  // 死角前就选择下方通路，并越过正前方阻挡者。
  for (let tick = 0; tick < 120; tick++) updateEnemies(state, state.level);

  assert.ok(smart.y > 32, `expected a vertical detour, got (${smart.x}, ${smart.y})`);
  assert.ok(smart.x > front.x, `expected to pass the front blocker, got x=${smart.x}`);
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

test('smart enemy fires through destructible brick when a player is aligned', () => {
  const state = createGameState(42, 1);
  const player = state.tanks[0];
  const smart = createEnemy('smart', 2, 0);
  Object.assign(player, { x: 40, y: 120 });
  Object.assign(smart, { x: 40, y: 40, dir: 'down', aiTicks: 0 });
  state.phase = 'playing';
  state.level = createEmptyLevel();
  for (const col of [5, 6]) setCell(state.level, col, 8, Cell.BRICK);
  state.tanks = [player, smart];
  state.spawning = [];
  state.enemyQueue = [];

  updateEnemies(state, state.level);

  assert.deepEqual({ x: smart.x, y: smart.y }, { x: 40, y: 40 });
  assert.equal(state.bullets[0]?.ownerId, smart.id);
});

test('smart enemy routes around an indestructible steel wall instead of camping and firing', () => {
  const state = createGameState(42, 1);
  const player = state.tanks[0];
  const smart = createEnemy('smart', 2, 0);
  Object.assign(player, { x: 40, y: 120 });
  Object.assign(smart, { x: 40, y: 40, dir: 'down', aiTicks: 0 });
  state.phase = 'playing';
  state.level = createEmptyLevel();
  for (const col of [5, 6]) setCell(state.level, col, 8, Cell.STEEL);
  state.tanks = [player, smart];
  state.spawning = [];
  state.enemyQueue = [];

  for (let tick = 0; tick < 120; tick++) updateEnemies(state, state.level);

  assert.ok(smart.y >= 72, `expected smart tank to pass the wall, got (${smart.x}, ${smart.y})`);
  assert.notEqual(smart.x, 40, 'smart tank should leave the blocked firing lane to go around steel');
});

test('smart enemy does not fire through the escort and routes around it', () => {
  const state = createGameState(43, 1, 2);
  const player = state.tanks[0];
  const smart = createEnemy('smart', 2, 0);
  const escort = state.escort!;
  const startX = escort.x + 8;
  Object.assign(player, { x: escort.x + 8, y: escort.y + 48 });
  Object.assign(smart, { x: startX, y: escort.y - 16, dir: 'down', aiTicks: 0 });
  state.phase = 'playing';
  state.level = createEmptyLevel(state.level.cols, state.level.rows);
  state.tanks = [player, smart];
  state.spawning = [];
  state.enemyQueue = ['basic'];
  state.enemySpawnTimer = 999;

  for (let tick = 0; tick < SMART_AI_STUCK_TICKS; tick++) {
    updateEnemies(state, state.level);
  }

  assert.equal(state.bullets.length, 0);
  assert.equal(smart.fireCooldown, 0);
  assert.notEqual(smart.x, startX, 'smart tank should sidestep instead of remaining aim-locked');
});

test('smart enemy may shoot a player who stands before the escort on the same ray', () => {
  const state = createGameState(43, 1, 2);
  const player = state.tanks[0];
  const smart = createEnemy('smart', 2, 0);
  const escort = state.escort!;
  Object.assign(player, { x: escort.x + 8, y: escort.y - 32 });
  Object.assign(smart, { x: escort.x + 8, y: escort.y - 64, dir: 'down', aiTicks: 0 });
  state.phase = 'playing';
  state.level = createEmptyLevel(state.level.cols, state.level.rows);
  state.tanks = [player, smart];
  state.spawning = [];
  state.enemyQueue = ['basic'];
  state.enemySpawnTimer = 999;

  updateEnemies(state, state.level);

  assert.equal(state.bullets[0]?.ownerId, smart.id);
});

test('smart enemy keeps a minimum cooldown after its previous bullet disappears', () => {
  const state = createGameState(44, 1, 1);
  const player = state.tanks[0];
  const smart = createEnemy('smart', 2, 0);
  Object.assign(player, { x: 40, y: 120 });
  Object.assign(smart, { x: 40, y: 40, dir: 'down', aiTicks: 0 });
  state.phase = 'playing';
  state.level = createEmptyLevel();
  state.tanks = [player, smart];
  state.spawning = [];
  state.enemyQueue = [];

  update(state, [emptyInput()]);
  assert.equal(state.bullets.length, 1);
  assert.equal(smart.fireCooldown, SMART_AI_FIRE_COOLDOWN_TICKS);

  state.bullets[0].alive = false;
  for (let tick = 0; tick < SMART_AI_FIRE_COOLDOWN_TICKS - 1; tick++) {
    update(state, [emptyInput()]);
    assert.equal(state.bullets.length, 0);
  }

  update(state, [emptyInput()]);
  assert.equal(state.bullets.length, 1);
  assert.equal(state.bullets[0].ownerId, smart.id);
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

test('smart enemy neither fires down the eagle lane nor damages the eagle with its bullets', () => {
  const state = createGameState(42, 1, 1); // 第 1 关为普通鹰巢关（护送关是每组第 2 关）
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

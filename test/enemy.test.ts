import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameState } from '../src/game/state';
import { createEnemy } from '../src/game/tank';
import { updateEnemies } from '../src/game/enemy';
import { update } from '../src/game/update';
import { emptyInput } from '../src/core/types';
import { Cell, createEmptyLevel, removeBrickQuarters, setCell } from '../src/game/level';
import { spawnBullet } from '../src/game/bullet';
import { resolveEagleHit } from '../src/game/phase';
import {
  BRICK_TL,
  BRICK_TR,
  EAGLE_COL,
  EAGLE_ROW,
  ESCORT_ENEMY_RECYCLE_TICKS,
  ESCORT_STOPPED_SPAWN_DIVISOR,
  SMART_AI_FIRE_COOLDOWN_TICKS,
  SMART_AI_STUCK_TICKS,
  STAGE_ENEMY_TOTAL,
  SUBTILE,
} from '../src/core/constants';

test('escort-stage traditional enemies steer back toward the convoy combat zone', () => {
  const state = createGameState(100, 1, 2);
  state.level = createEmptyLevel(state.level.cols, state.level.rows);
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
  const state = createGameState(101, 1, 2);
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

test('a hidden smart enemy far behind the escort is also recycled ahead', () => {
  const state = createGameState(103, 1, 20);
  const player = state.tanks[0];
  const smart = createEnemy('smart', 2, 0);
  const escort = state.escort!;
  escort.y = 300;
  Object.assign(player, { x: escort.x, y: escort.y });
  Object.assign(smart, {
    x: 40,
    y: escort.y + 200,
    escortFarTicks: ESCORT_ENEMY_RECYCLE_TICKS - 1,
  });
  state.phase = 'playing';
  state.tanks = [player, smart];
  state.spawning = [];
  state.enemyQueue = [];
  escort.arrived = true; // 本用例只验证回收，避免持续增援器同时补入新坦克。

  updateEnemies(state, state.level);

  assert.equal(state.tanks.some((tank) => tank.id === smart.id), false);
  const recycled = state.spawning.find((spawn) => spawn.tank.id === smart.id);
  assert.ok(recycled);
  assert.ok(recycled.tank.y < escort.y);
});

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

test('escort reinforcement timer advances more slowly while the convoy is stopped', () => {
  const state = createGameState(106, 1, 20);
  state.phase = 'playing';
  state.level = createEmptyLevel(state.level.cols, state.level.rows);
  state.enemySpawnTimer = 4;
  state.escort!.moving = false;
  state.tick = 1;

  updateEnemies(state, state.level);
  assert.equal(state.enemySpawnTimer, 4);

  state.tick = ESCORT_STOPPED_SPAWN_DIVISOR;
  updateEnemies(state, state.level);
  assert.equal(state.enemySpawnTimer, 3);

  state.escort!.moving = true;
  state.tick++;
  updateEnemies(state, state.level);
  assert.equal(state.enemySpawnTimer, 2);
});

test('traditional enemy movement remains un-leashed on normal stages', () => {
  const state = createGameState(102, 1, 1);
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

test('hourglass halves smart enemy aimed-fire cadence', () => {
  const shotsInSixtyTicks = (slowed: boolean): number => {
    const state = createGameState(45, 1, 1);
    const player = state.tanks[0];
    const smart = createEnemy('smart', 2, 0);
    Object.assign(player, { x: 40, y: 200 });
    Object.assign(smart, { x: 40, y: 40, dir: 'down', aiTicks: 0 });
    state.phase = 'playing';
    state.level = createEmptyLevel();
    state.tanks = [player, smart];
    state.spawning = [];
    state.enemyQueue = [];
    state.enemySlowTicks = slowed ? 120 : 0;
    const firstBulletId = state.nextBulletId;

    for (let tick = 0; tick < 60; tick++) {
      update(state, [emptyInput()]);
      // 立即移除本帧炮弹，只测冷却节拍，不让“同时在场一发”的弹位上限干扰结果。
      for (const bullet of state.bullets) bullet.alive = false;
    }
    return state.nextBulletId - firstBulletId;
  };

  assert.equal(shotsInSixtyTicks(false), 3);
  assert.equal(shotsInSixtyTicks(true), 2);
});

test('timer freeze pauses smart enemy fire cooldown', () => {
  const state = createGameState(46, 1, 1);
  const player = state.tanks[0];
  const smart = createEnemy('smart', 2, 0);
  Object.assign(player, { x: 40, y: 200 });
  Object.assign(smart, { x: 40, y: 40, dir: 'down', fireCooldown: 10 });
  state.phase = 'playing';
  state.level = createEmptyLevel();
  state.tanks = [player, smart];
  state.spawning = [];
  state.enemyQueue = [];
  state.enemyFreezeTicks = 5;

  for (let tick = 0; tick < 4; tick++) update(state, [emptyInput()]);
  assert.equal(smart.fireCooldown, 10);

  update(state, [emptyInput()]);
  assert.equal(smart.fireCooldown, 9, 'cooldown should resume on the first unfrozen action tick');
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

// 编成按“组号 t”取（第 t 组的普通关关号是 3t-2、护送关是 3t-1，两者共用第 t 档编成）。
test('stage enemy queues include smart tanks without changing the configured total', () => {
  const expectedSmartCounts = [4, 5, 6, 7, 8];
  for (let group = 1; group <= 5; group++) {
    for (const stage of [group * 3 - 2, group * 3 - 1]) {
      const state = createGameState(42, 1, stage);
      assert.equal(state.enemyQueue.length, STAGE_ENEMY_TOTAL, `第 ${stage} 关队列长度`);
      assert.equal(
        state.enemyQueue.filter((kind) => kind === 'smart').length,
        expectedSmartCounts[group - 1],
        `第 ${stage} 关（第 ${group} 组）智能坦克数`,
      );
    }
  }
  // Boss 关不走有限队列。
  assert.equal(createGameState(42, 1, 3).enemyQueue.length, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameState } from '../src/game/state';
import { createEnemy, createPlayer } from '../src/game/tank';
import { updateEnemies } from '../src/game/enemy';
import { update } from '../src/game/update';
import { emptyInput } from '../src/core/types';
import { Cell, createEmptyLevel, setCell } from '../src/game/level';
import { spawnBullet, spawnWeaponBullets } from '../src/game/bullet';
import { resolveEagleHit } from '../src/game/phase';
import {
  EAGLE_COL,
  EAGLE_ROW,
  ESCORT_SIZE,
  ESCORT_ENEMY_RECYCLE_TICKS,
  ESCORT_STOPPED_SPAWN_DIVISOR,
  SMART_AI_FIRE_COOLDOWN_TICKS,
  SMART_AI_LEAD_LOOKAHEAD_TICKS,
  SMART_AI_TURN_FIRE_DELAY_TICKS,
  STAGE_ENEMY_TOTAL,
  SUBTILE,
  TANK_SIZE,
  SMART_AI_STUCK_TICKS,
} from '../src/core/constants';

test('escort stages refill their enemy composition while normal stages stay finite', () => {
  const escortState = createGameState(104, 1, 18);
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

  const normalState = createGameState(105, 1, 17);
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

test('double-river escort reinforcements materialize on alternating vehicle flanks', () => {
  const state = createGameState(114, 1, 14);
  state.phase = 'playing';
  state.level = createEmptyLevel(state.level.cols, state.level.rows);
  state.enemyQueue = ['basic', 'basic'];
  state.enemySpawnTimer = 0;
  state.spawning = [];
  Object.assign(state.tanks[0], { x: 0, y: state.level.rows * SUBTILE - TANK_SIZE });
  Object.assign(state.escort!, { x: 304, y: 352, dir: 'up' as const });

  updateEnemies(state, state.level);
  const left = state.spawning[0].tank;
  assert.ok(
    left.x + TANK_SIZE / 2 < state.escort!.x + ESCORT_SIZE / 2,
    'first reinforcement should enter from the left',
  );

  state.enemySpawnTimer = 0;
  updateEnemies(state, state.level);
  const right = state.spawning[1].tank;
  assert.ok(
    right.x + TANK_SIZE / 2 > state.escort!.x + ESCORT_SIZE / 2,
    'second reinforcement should enter from the right',
  );
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

test('smart enemies split across opposite flanks and reach clear firing positions', () => {
  const state = createGameState(125, 1, 1);
  const player = state.tanks[0];
  const leftFlanker = createEnemy('smart', 4, 0);
  const rightFlanker = createEnemy('smart', 5, 0);
  Object.assign(player, { x: 160, y: 160, invulnTicks: 9999 });
  Object.assign(leftFlanker, { x: 128, y: 48, aiTicks: 0 });
  Object.assign(rightFlanker, { x: 192, y: 48, aiTicks: 0 });
  state.phase = 'playing';
  state.level = createEmptyLevel();
  state.tanks = [player, leftFlanker, rightFlanker];
  state.spawning = [];
  state.enemyQueue = [];
  const firstBulletId = state.nextBulletId;

  for (let tick = 0; tick < 240; tick++) update(state, [emptyInput()]);

  assert.ok(leftFlanker.smartGoalX < player.x);
  assert.equal(leftFlanker.smartGoalY, player.y);
  assert.ok(rightFlanker.smartGoalX > player.x);
  assert.equal(rightFlanker.smartGoalY, player.y);
  assert.deepEqual(
    { x: leftFlanker.x, y: leftFlanker.y },
    { x: leftFlanker.smartGoalX, y: leftFlanker.smartGoalY },
  );
  assert.deepEqual(
    { x: rightFlanker.x, y: rightFlanker.y },
    { x: rightFlanker.smartGoalX, y: rightFlanker.smartGoalY },
  );
  assert.ok(state.nextBulletId > firstBulletId, 'both flanks should produce real firing lanes');
});

test('smart enemy abandons its preferred flank when steel blocks that firing lane', () => {
  const state = createGameState(126, 1, 1);
  const player = state.tanks[0];
  const smart = createEnemy('smart', 4, 0); // id 4 默认偏好玩家左侧。
  const level = createEmptyLevel();
  Object.assign(player, { x: 160, y: 160 });
  Object.assign(smart, { x: 128, y: 48, aiTicks: 0 });
  // 封死玩家左侧的横向弹道，但保留右侧与上下两条可达射线。
  for (const row of [20, 21]) setCell(level, 18, row, Cell.STEEL);
  state.phase = 'playing';
  state.level = level;
  state.tanks = [player, smart];
  state.spawning = [];
  state.enemyQueue = [];

  updateEnemies(state, level);

  assert.ok(smart.smartGoalX > player.x, `expected clear right flank, goal=${smart.smartGoalX}`);
  assert.equal(smart.smartGoalY, player.y);
});

test('smart enemy predicts an incoming player bullet and sidesteps its firing lane', () => {
  const state = createGameState(120, 1, 1);
  const player = state.tanks[0];
  const smart = createEnemy('smart', 2, 0);
  Object.assign(player, { x: 80, y: 160, dir: 'up' as const });
  Object.assign(smart, { x: 80, y: 80, dir: 'down' as const, aiTicks: 0 });
  state.phase = 'playing';
  state.level = createEmptyLevel();
  state.tanks = [player, smart];
  state.spawning = [];
  state.enemyQueue = [];
  state.bullets = [spawnBullet(player, state.nextBulletId++, state.level)];

  updateEnemies(state, state.level);

  assert.ok(smart.x < 80, `expected an even-id smart tank to dodge left, got x=${smart.x}`);
  assert.equal(smart.y, 80);
  assert.equal(smart.dir, 'left');
  assert.equal(state.bullets.length, 1, 'dodging should take priority over aimed fire');

  for (let tick = 0; tick < 40; tick++) update(state, [emptyInput()]);
  assert.equal(smart.alive, true, 'smart tank should stay out of the lane until the bullet passes');
});

test('smart enemy picks the open dodge side when the other side is walled off', () => {
  const state = createGameState(121, 1, 1);
  const player = state.tanks[0];
  const smart = createEnemy('smart', 2, 0);
  const level = createEmptyLevel();
  for (const row of [10, 11]) setCell(level, 9, row, Cell.STEEL);
  Object.assign(player, { x: 80, y: 160, dir: 'up' as const });
  Object.assign(smart, { x: 80, y: 80, dir: 'down' as const, aiTicks: 0 });
  state.phase = 'playing';
  state.level = level;
  state.tanks = [player, smart];
  state.spawning = [];
  state.enemyQueue = [];
  state.bullets = [spawnBullet(player, state.nextBulletId++, level)];

  updateEnemies(state, level);

  assert.ok(smart.x > 80, `expected the smart tank to use the open right side, got x=${smart.x}`);
  assert.equal(smart.dir, 'right');
});

test('smart enemy does not dodge one projectile into the path of another', () => {
  const state = createGameState(123, 1, 1);
  const player = state.tanks[0];
  const leftShooter = createPlayer(1, 9);
  const smart = createEnemy('smart', 2, 0);
  Object.assign(player, { x: 80, y: 160, dir: 'up' as const });
  Object.assign(leftShooter, { x: 70, y: 160, dir: 'up' as const, level: 1 });
  Object.assign(smart, { x: 80, y: 80, dir: 'down' as const, aiTicks: 0 });
  state.phase = 'playing';
  state.level = createEmptyLevel();
  state.tanks = [player, smart];
  state.spawning = [];
  state.enemyQueue = [];
  state.bullets = [
    spawnBullet(player, state.nextBulletId++, state.level),
    spawnBullet(leftShooter, state.nextBulletId++, state.level),
  ];

  updateEnemies(state, state.level);

  assert.ok(smart.x > 80, `expected the smart tank to avoid the second bullet on its left, got x=${smart.x}`);
  assert.equal(smart.dir, 'right');
});

test('smart enemy does not dodge a player bullet that an enemy shot will intercept', () => {
  const state = createGameState(137, 1, 1);
  const player = state.tanks[0];
  const interceptor = createEnemy('basic', 3, 0);
  const smart = createEnemy('smart', 4, 0);
  Object.assign(player, { x: 80, y: 160, dir: 'up' as const, fireCooldown: 999 });
  Object.assign(interceptor, { x: 80, y: 40, dir: 'down' as const, aiTicks: 999 });
  Object.assign(smart, {
    x: 80,
    y: 80,
    dir: 'down' as const,
    aiTicks: 5,
    fireCooldown: 999,
  });
  state.phase = 'playing';
  state.level = createEmptyLevel();
  state.tanks = [player, interceptor, smart];
  state.spawning = [];
  state.enemyQueue = [];
  state.bullets = [
    spawnBullet(player, state.nextBulletId++, state.level),
    spawnBullet(interceptor, state.nextBulletId++, state.level),
  ];

  updateEnemies(state, state.level);

  assert.equal(smart.smartEscapeTicks, 0);
  assert.equal(smart.x, 80, 'the forecast interception should prevent a phantom side-step');
});

test('smart enemy trusts solid cover instead of dodging a bullet that will hit steel', () => {
  const state = createGameState(122, 1, 1);
  const player = state.tanks[0];
  const smart = createEnemy('smart', 2, 0);
  const level = createEmptyLevel();
  for (const col of [10, 11]) setCell(level, col, 15, Cell.STEEL);
  Object.assign(player, { x: 80, y: 160, dir: 'up' as const });
  Object.assign(smart, { x: 80, y: 80, dir: 'down' as const, aiTicks: 0 });
  state.phase = 'playing';
  state.level = level;
  state.tanks = [smart]; // 射手可以已阵亡；它留下的在场炮弹仍需独立判断。
  state.spawning = [];
  state.enemyQueue = [];
  state.bullets = [spawnBullet(player, state.nextBulletId++, level)];

  updateEnemies(state, level);

  assert.deepEqual({ x: smart.x, y: smart.y }, { x: 80, y: 80 });
  assert.equal(smart.moving, false);
});

test('smart enemy dodges the real wide heat lane of an incoming spiral shot', () => {
  const state = createGameState(127, 1, 1);
  const player = state.tanks[0];
  const smart = createEnemy('smart', 2, 0);
  Object.assign(player, { x: 64, y: 160, dir: 'up' as const, weapon: 'spiral' as const });
  // 逻辑核心只覆盖 x=70..74，车体从 x=77 开始；只有 F 弹真实的 16px 热区会命中。
  Object.assign(smart, { x: 77, y: 80, dir: 'down' as const, aiTicks: 5 });
  state.phase = 'playing';
  state.level = createEmptyLevel();
  state.tanks = [player, smart];
  state.spawning = [];
  state.enemyQueue = [];
  state.bullets = spawnWeaponBullets(player, state.nextBulletId, state.level);
  state.nextBulletId += state.bullets.length;

  updateEnemies(state, state.level);

  assert.ok(smart.x > 77, `expected a dodge away from the wide heat lane, got x=${smart.x}`);
  assert.equal(smart.y, 80);
  assert.equal(smart.dir, 'right');
});

test('smart enemy predicts a spiral blast where the core will hit brick cover', () => {
  const state = createGameState(128, 1, 1);
  const player = state.tanks[0];
  const smart = createEnemy('smart', 2, 0);
  const level = createEmptyLevel();
  setCell(level, 10, 14, Cell.BRICK);
  setCell(level, 11, 14, Cell.BRICK);
  Object.assign(player, { x: 80, y: 160, dir: 'up' as const, weapon: 'spiral' as const });
  // x=96 恰好在直飞热区之外，但仍落在核心撞砖后的 24x24 炎爆边缘内。
  Object.assign(smart, { x: 96, y: 96, dir: 'down' as const, aiTicks: 5 });
  state.phase = 'playing';
  state.level = level;
  state.tanks = [player, smart];
  state.spawning = [];
  state.enemyQueue = [];
  state.bullets = spawnWeaponBullets(player, state.nextBulletId, level);
  state.nextBulletId += state.bullets.length;

  updateEnemies(state, level);

  assert.ok(smart.x > 96, `expected a dodge away from the predicted blast, got x=${smart.x}`);
  assert.equal(smart.dir, 'right');
});

test('smart enemy dodges a spiral blast triggered by a front-line tank', () => {
  const state = createGameState(133, 1, 1);
  const player = state.tanks[0];
  const blocker = createEnemy('basic', 2, 0);
  const smart = createEnemy('smart', 4, 0);
  Object.assign(player, {
    x: 80,
    y: 48,
    dir: 'down' as const,
    weapon: 'spiral' as const,
    fireCooldown: 999,
    invulnTicks: 9999,
  });
  Object.assign(blocker, { x: 80, y: 104, dir: 'down' as const });
  // 智能坦克恰好在 F 核心热区之外，但位于前排坦克被命中后的 24px 炎爆内。
  Object.assign(smart, { x: 96, y: 104, dir: 'up' as const, aiTicks: 0 });
  state.phase = 'playing';
  state.level = createEmptyLevel();
  state.tanks = [player, blocker, smart];
  state.spawning = [];
  state.enemyQueue = [];
  const bullet = spawnWeaponBullets(player, state.nextBulletId++, state.level)[0];
  Object.assign(bullet, { y: 74, prevY: 74 });
  state.bullets = [bullet];

  for (let tick = 0; tick < 10; tick++) update(state, [emptyInput()]);

  assert.equal(blocker.alive, false, 'front-line tank should trigger the real F blast');
  assert.equal(smart.alive, true, 'smart tank should leave the neighboring blast before impact');
  assert.ok(smart.x > 100, `expected a right dodge out of the blast, got x=${smart.x}`);
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

test('smart enemy turns a blocked corner into a reachable firing position', () => {
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

  // 不必再执着于穿过正前方车阵：左侧纵向移动即可抵达对玩家的横向火力位。
  for (let tick = 0; tick < 120; tick++) updateEnemies(state, state.level);

  assert.ok(smart.y > 32, `expected a vertical detour, got (${smart.x}, ${smart.y})`);
  assert.ok(smart.smartGoalX < player.x);
  assert.equal(smart.smartGoalY, player.y);
  assert.ok(state.bullets.some((bullet) => bullet.ownerId === smart.id));
});

test('smart enemy waits about 150ms between turning to aim and firing', () => {
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
  assert.equal(smart.smartTurnFireTicks, SMART_AI_TURN_FIRE_DELAY_TICKS);
  assert.equal(state.bullets.length, 0);

  for (let ticksLeft = SMART_AI_TURN_FIRE_DELAY_TICKS - 1; ticksLeft > 0; ticksLeft--) {
    updateEnemies(state, state.level);
    assert.equal(smart.smartTurnFireTicks, ticksLeft);
    assert.equal(state.bullets.length, 0);
  }

  updateEnemies(state, state.level);
  assert.equal(smart.smartTurnFireTicks, 0);
  assert.equal(state.bullets.length, 1);
  assert.equal(state.bullets[0].ownerId, smart.id);
  assert.equal(state.bullets[0].attacksEagle, false);
});

test('smart enemy leads a moving player through a future firing-lane intersection', () => {
  const state = createGameState(129, 1, 1);
  const player = state.tanks[0];
  const smart = createEnemy('smart', 2, 0);
  Object.assign(player, { x: 40, y: 120, dir: 'right' as const, moving: true });
  Object.assign(smart, { x: 80, y: 0, dir: 'down' as const, aiTicks: 5 });
  state.phase = 'playing';
  state.level = createEmptyLevel();
  state.tanks = [player, smart];
  state.spawning = [];
  state.enemyQueue = [];

  updateEnemies(state, state.level);

  assert.deepEqual({ x: smart.x, y: smart.y }, { x: 80, y: 0 });
  assert.equal(state.bullets[0]?.ownerId, smart.id);
  assert.equal(state.bullets[0]?.dir, 'down');
});

test('smart enemy lead shot is aligned to the real update order and reaches the moving player', () => {
  const state = createGameState(134, 1, 1);
  const player = state.tanks[0];
  const smart = createEnemy('smart', 2, 0);
  Object.assign(player, {
    x: 40,
    y: 120,
    dir: 'right' as const,
    moving: true,
    hp: 2,
    invulnTicks: 0,
  });
  Object.assign(smart, { x: 80, y: 0, dir: 'down' as const, aiTicks: 5 });
  state.phase = 'playing';
  state.level = createEmptyLevel();
  state.tanks = [player, smart];
  state.spawning = [];
  state.enemyQueue = [];
  state.powerups = [];
  const input = { ...emptyInput(), right: true };

  for (let tick = 0; tick < 60 && player.hp === 2; tick++) update(state, [input]);

  assert.equal(player.alive, true);
  assert.equal(player.hp, 1, 'the forecast shot should hit rather than merely leave the muzzle');
});

test('smart enemy does not fire a one-tick-overled edge shot', () => {
  const state = createGameState(138, 1, 1);
  const player = state.tanks[0];
  const smart = createEnemy('smart', 2, 0);
  // 玩家本帧先移动到 x=24.75；弹道第 20 帧应对比玩家再移动 19 次的位置 x=10.5。
  // 若错误地多推进一次到 x=9.75，就会把擦过右缘的必空弹误判为命中。
  Object.assign(player, {
    x: 25.5,
    y: 40.75,
    dir: 'left' as const,
    moving: true,
    invulnTicks: 0,
  });
  Object.assign(smart, { x: 0, y: 0, dir: 'down' as const, aiTicks: 5 });
  state.phase = 'playing';
  state.level = createEmptyLevel();
  state.tanks = [player, smart];
  state.spawning = [];
  state.enemyQueue = [];
  state.powerups = [];

  update(state, [{ ...emptyInput(), left: true }]);

  assert.equal(player.x, 24.75);
  assert.equal(state.bullets.some((bullet) => bullet.ownerId === smart.id), false);
});

test('smart enemy respects player half-speed when deciding whether a lead shot can connect', () => {
  const state = createGameState(135, 1, 1);
  const player = state.tanks[0];
  const smart = createEnemy('smart', 2, 0);
  Object.assign(player, { x: 40, y: 120, dir: 'right' as const, moving: true });
  Object.assign(smart, { x: 80, y: 0, dir: 'down' as const, aiTicks: 5 });
  state.phase = 'playing';
  state.level = createEmptyLevel();
  state.tanks = [player, smart];
  state.spawning = [];
  state.enemyQueue = [];
  state.powerups = [];
  state.tick = 1; // 下一帧为偶数行动帧：玩家确实移动，但后续预测仍必须按隔帧半速。
  state.playerSlowTicks = SMART_AI_LEAD_LOOKAHEAD_TICKS;

  update(state, [{ ...emptyInput(), right: true }]);

  assert.equal(player.moving, true);
  assert.equal(state.bullets.some((bullet) => bullet.ownerId === smart.id), false);
});

test('smart enemy leaves a readied player gun line while its own weapon is reloading', () => {
  const state = createGameState(130, 1, 1);
  const player = state.tanks[0];
  const smart = createEnemy('smart', 2, 0);
  Object.assign(player, { x: 80, y: 160, dir: 'up' as const, fireCooldown: 0 });
  Object.assign(smart, {
    x: 80,
    y: 80,
    dir: 'down' as const,
    aiTicks: 5,
    fireCooldown: SMART_AI_FIRE_COOLDOWN_TICKS,
  });
  state.phase = 'playing';
  state.level = createEmptyLevel();
  state.tanks = [player, smart];
  state.spawning = [];
  state.enemyQueue = [];

  updateEnemies(state, state.level);

  assert.ok(smart.x < 80, `expected an even-id tank to leave the aimed lane to the left, got x=${smart.x}`);
  assert.equal(smart.y, 80);
  assert.equal(smart.dir, 'left');
  assert.equal(state.bullets.length, 0, 'gun-line awareness must not invent a player projectile');
});

test('smart enemies with colliding id-based preferences reserve different crossfire flanks', () => {
  const state = createGameState(131, 1, 1);
  const player = state.tanks[0];
  const first = createEnemy('smart', 4, 0);
  const second = createEnemy('smart', 8, 0);
  Object.assign(player, { x: 160, y: 160, invulnTicks: 9999 });
  Object.assign(first, { x: 128, y: 48, aiTicks: 0 });
  Object.assign(second, { x: 192, y: 48, aiTicks: 0 });
  state.phase = 'playing';
  state.level = createEmptyLevel();
  state.tanks = [player, first, second];
  state.spawning = [];
  state.enemyQueue = [];

  updateEnemies(state, state.level);

  assert.ok(first.smartGoalX < player.x, `first role should reserve the left flank: ${first.smartGoalX}`);
  assert.ok(second.smartGoalX > player.x, `second role should reserve the right flank: ${second.smartGoalX}`);
  assert.equal(first.smartGoalY, player.y);
  assert.equal(second.smartGoalY, player.y);
});

test('smart enemies balance comparable targets instead of dogpiling one multiplayer lane', () => {
  const state = createGameState(132, 2, 1);
  const players = state.tanks.filter((tank) => tank.kind === 'player');
  const first = createEnemy('smart', 4, 0);
  const second = createEnemy('smart', 8, 0);
  Object.assign(players[0], { x: 0, y: 160, invulnTicks: 9999 });
  Object.assign(players[1], { x: 304, y: 160, invulnTicks: 9999 });
  Object.assign(first, { x: 128, y: 48, aiTicks: 0 });
  Object.assign(second, { x: 192, y: 48, aiTicks: 0 });
  state.phase = 'playing';
  state.level = createEmptyLevel();
  state.tanks = [players[0], players[1], first, second];
  state.spawning = [];
  state.enemyQueue = [];

  updateEnemies(state, state.level);

  const goalDistance = (tank: typeof first, player: typeof players[number]): number =>
    Math.abs(tank.smartGoalX - player.x) + Math.abs(tank.smartGoalY - player.y);
  assert.ok(goalDistance(first, players[0]) <= 112);
  assert.ok(goalDistance(first, players[1]) > 112);
  assert.ok(goalDistance(second, players[1]) <= 112);
  assert.ok(goalDistance(second, players[0]) > 112);
});

test('smart enemy keeps a stable multiplayer target near the load-balancing boundary', () => {
  const state = createGameState(136, 2, 1);
  const players = state.tanks.filter((tank) => tank.kind === 'player');
  Object.assign(players[0], { x: 64, y: 96, invulnTicks: 9999, fireCooldown: 9999 });
  Object.assign(players[1], { x: 40, y: 128, invulnTicks: 9999, fireCooldown: 9999 });
  const starts = [[256, 128], [280, 208], [168, 216]] as const;
  const smarts = starts.map(([x, y], index) => {
    const tank = createEnemy('smart', 10 + index, index);
    Object.assign(tank, { x, y, aiTicks: 0, fireCooldown: 9999 });
    return tank;
  });
  state.phase = 'playing';
  state.level = createEmptyLevel();
  state.tanks = [...players, ...smarts];
  state.spawning = [];
  state.enemyQueue = [];
  state.powerups = [];
  const tracked = smarts[1];
  let previousTarget = -1;
  let switches = 0;

  for (let tick = 0; tick < 280; tick++) {
    update(state, [emptyInput(), emptyInput()]);
    if (previousTarget >= 0 && tracked.smartTargetId !== previousTarget) switches++;
    previousTarget = tracked.smartTargetId;
  }

  assert.ok(switches <= 1, `target lock should prevent 12-tick ping-pong, switches=${switches}`);
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
  // 玩家炮口朝下，避免本用例被“装填期主动离开玩家枪线”的新战术分支干扰。
  Object.assign(player, { x: 40, y: 120, dir: 'down' as const });
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

test('smart enemy can sustain a close-range duel after its shots intercept player fire', () => {
  const state = createGameState(124, 1, 1);
  const player = state.tanks[0];
  const smart = createEnemy('smart', 2, 0);
  const level = createEmptyLevel();
  // 把智能坦克夹在一格宽的射击巷中：这里没有安全侧移，只能正面对消玩家炮弹。
  for (const row of [10, 11]) {
    setCell(level, 9, row, Cell.STEEL);
    setCell(level, 12, row, Cell.STEEL);
  }
  Object.assign(player, { x: 80, y: 120, dir: 'up' as const, invulnTicks: 0 });
  Object.assign(smart, { x: 80, y: 80, dir: 'down' as const, aiTicks: 0 });
  state.phase = 'playing';
  state.level = level;
  state.tanks = [player, smart];
  state.spawning = [];
  state.enemyQueue = [];
  const heldFire = { ...emptyInput(), fire: true };
  const firstBulletId = state.nextBulletId;

  for (let tick = 0; tick < 40; tick++) update(state, [heldFire]);

  const playerShots = state.events.filter((event) => event === 'playerFire').length;
  const smartShots = state.nextBulletId - firstBulletId - playerShots;
  assert.equal(smart.alive, true, 'smart tank should keep parrying instead of dying during reload');
  assert.ok(
    playerShots >= 3 && smartShots >= 3,
    `expected repeated fire from both sides, player=${playerShots}, smart=${smartShots}`,
  );

  // 玩家停止补射后，智能坦克仍会继续机动；转向后的短暂瞄准等待不应把 AI 锁死。
  const stoppedAt = { x: smart.x, y: smart.y };
  for (let tick = 0; tick < 120; tick++) update(state, [emptyInput()]);
  assert.equal(smart.alive, true);
  assert.notDeepEqual({ x: smart.x, y: smart.y }, stoppedAt);
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

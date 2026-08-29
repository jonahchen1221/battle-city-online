import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ESCORT_FIELD_COLS,
  ESCORT_FIELD_ROWS,
  ESCORT_REPAIR_AMOUNT,
  STAGE_COUNT,
  TANK_SIZE,
  stageKind,
} from '../src/core/constants';
import { createGameState } from '../src/game/state';
import {
  ESCORT_ROUTES,
  escortGuardSlots,
  escortHasGuard,
  escortRouteForStage,
  updateEscort,
  resolveEscortHits,
} from '../src/game/escort';
import { Cell, setCell } from '../src/game/level';
import { createEmptyLevel } from '../src/game/level';
import { applyInput, createEnemy } from '../src/game/tank';
import { spawnBullet } from '../src/game/bullet';
import { tryPickupPowerup } from '../src/game/powerup';
import { updatePhase } from '../src/game/phase';
import { destroyPlayerTank } from '../src/game/death';
import { emptyInput } from '../src/core/types';

// 三段循环下的护送关号：每组第 2 关。前六次护送各用一条路线。
const ESCORT_STAGES = [2, 5, 8, 11, 14, 17];

test('escort stages sit second in every cycle, with six distinct escort maps and routes', () => {
  const movingStages = ESCORT_STAGES.map((stage) => createGameState(stage, 1, stage));
  for (let stage = 1; stage <= STAGE_COUNT; stage++) {
    const state = createGameState(stage, 1, stage);
    assert.equal(Boolean(state.escort), stageKind(stage) === 'escort', `stage ${stage}`);
    if (stageKind(stage) !== 'escort') {
      assert.equal(state.level.cols, 40);
      assert.equal(state.level.rows, 30);
    }
  }
  // 十次护送轮换六条路线：第 7–10 次回头复用第 1–4 条。
  for (let e = 1; e <= 10; e++) {
    const stage = e * 3 - 1;
    assert.equal(stageKind(stage), 'escort');
    assert.deepEqual(
      escortRouteForStage(stage),
      ESCORT_ROUTES[(e - 1) % ESCORT_ROUTES.length].map((p) => ({ ...p })),
      `第 ${e} 次护送（第 ${stage} 关）应取第 ${((e - 1) % ESCORT_ROUTES.length) + 1} 条路线`,
    );
  }
  for (const state of movingStages) {
    assert.equal(state.level.cols, ESCORT_FIELD_COLS);
    assert.equal(state.level.rows, ESCORT_FIELD_ROWS);
    for (let i = 0; i < state.escort!.route.length; i++) {
      const point = state.escort!.route[i];
      assert.ok(point.x >= 0 && point.x + 32 <= ESCORT_FIELD_COLS * 8);
      assert.ok(point.y >= 0 && point.y + 32 <= ESCORT_FIELD_ROWS * 8);
      if (i === 0) continue;
      const previous = state.escort!.route[i - 1];
      assert.notDeepEqual(point, previous);
      assert.ok(point.x === previous.x || point.y === previous.y, '路线节点必须正交连接');
    }
  }
  assert.equal(new Set(movingStages.map((state) => state.level.cells.join(','))).size, 6);
  assert.equal(new Set(movingStages.map((state) => JSON.stringify(state.escort!.route))).size, 6);
});

test('a turning escort switches direction at a waypoint and rotates its guard slots', () => {
  const state = createGameState(13, 1, 5); // 第 2 次护送 → 第 2 条路线（含转弯）
  const escort = state.escort!;
  const player = state.tanks[0];
  const corner = escort.route[1];
  Object.assign(escort, {
    x: corner.x,
    y: corner.y + escort.speed,
    routeIndex: 1,
    dir: 'up' as const,
  });
  let guard = escortGuardSlots(escort)[0];
  Object.assign(player, { x: guard.x, y: guard.y });

  updateEscort(state);
  assert.deepEqual({ x: escort.x, y: escort.y }, corner);
  assert.equal(escort.routeIndex, 2);
  assert.equal(escort.dir, 'left');

  guard = escortGuardSlots(escort)[0];
  Object.assign(player, { x: guard.x, y: guard.y });
  updateEscort(state);
  assert.ok(escort.x < corner.x);
});

test('all six escort routes can be completed through every turn', () => {
  for (const stage of ESCORT_STAGES) {
    const state = createGameState(200 + stage, 1, stage);
    const escort = state.escort!;
    const player = state.tanks[0];
    state.level = createEmptyLevel(ESCORT_FIELD_COLS, ESCORT_FIELD_ROWS);
    for (let tick = 0; tick < 10000 && !escort.arrived; tick++) {
      const guard = escortGuardSlots(escort)[0];
      Object.assign(player, { x: guard.x, y: guard.y });
      updateEscort(state);
    }
    assert.equal(escort.arrived, true, `stage ${stage} route did not finish`);
    assert.deepEqual(
      { x: escort.x, y: escort.y },
      escort.route.at(-1),
      `stage ${stage} did not stop at its final waypoint`,
    );
  }
});

test('the mobile eagle stops at a brick roadblock and resumes as soon as it is cleared', () => {
  const state = createGameState(2, 1, 2);
  const escort = state.escort!;
  state.tanks = state.tanks.filter((tank) => tank.kind === 'player');
  escort.y = 504; // 第一道路障位于 y=496..512，车头恰好贴住下边。
  const guard = escortGuardSlots(escort)[0];
  Object.assign(state.tanks[0], { x: guard.x, y: guard.y });

  updateEscort(state);
  assert.equal(escort.y, 504);
  assert.equal(escort.moving, false);

  for (let row = 62; row <= 63; row++) {
    for (let col = 37; col <= 42; col++) setCell(state.level, col, row, Cell.EMPTY);
  }
  updateEscort(state);
  assert.ok(escort.y < 504);
  assert.equal(escort.moving, true);
});

test('any tank standing in front stops the escort before their boxes overlap', () => {
  const state = createGameState(9, 2, 2);
  const escort = state.escort!;
  const guard = state.tanks[0];
  const player = state.tanks[1];
  escort.y = 440;
  const guardSlot = escortGuardSlots(escort)[0];
  Object.assign(guard, { x: guardSlot.x, y: guardSlot.y });
  Object.assign(player, { x: escort.x, y: escort.y - 16 });

  updateEscort(state);
  assert.equal(escort.y, 440);
  assert.equal(escort.moving, false);

  player.x = escort.x - 64;
  updateEscort(state);
  assert.ok(escort.y < 440);
  assert.equal(escort.moving, true);
});

test('the escort moves only while its single-player guard slot is occupied', () => {
  const state = createGameState(12, 1, 2);
  const escort = state.escort!;
  const player = state.tanks[0];
  Object.assign(player, { x: escort.x - 80, y: escort.y + 48 });
  const startY = escort.y;

  updateEscort(state);
  assert.equal(escort.y, startY);
  assert.equal(escort.moving, false);

  const guard = escortGuardSlots(escort, state.playerCount)[0];
  Object.assign(player, { x: guard.x, y: guard.y });
  updateEscort(state);
  assert.ok(escort.y < startY);
  assert.equal(escort.moving, true);
});

test('guard slots scale from one required two-cell strip to two simultaneously occupied strips', () => {
  for (const playerCount of [1, 2]) {
    const state = createGameState(300 + playerCount, playerCount, 2);
    const escort = state.escort!;
    state.level = createEmptyLevel(ESCORT_FIELD_COLS, ESCORT_FIELD_ROWS);
    const slots = escortGuardSlots(escort, playerCount);
    assert.equal(slots.length, 1);
    assert.equal(slots[0].width * slots[0].height, 2 * TANK_SIZE * TANK_SIZE);
    Object.assign(state.tanks[0], { x: slots[0].x, y: slots[0].y });
    assert.equal(escortHasGuard(state), true);
    const before = escort.y;
    updateEscort(state);
    assert.ok(escort.y < before, `${playerCount}P convoy should move with one guard`);
  }

  for (const playerCount of [3, 4]) {
    const state = createGameState(400 + playerCount, playerCount, 2);
    const escort = state.escort!;
    state.level = createEmptyLevel(ESCORT_FIELD_COLS, ESCORT_FIELD_ROWS);
    const slots = escortGuardSlots(escort, playerCount);
    assert.equal(slots.length, 2);
    for (const slot of slots) {
      assert.equal(slot.width * slot.height, 2 * TANK_SIZE * TANK_SIZE);
    }

    Object.assign(state.tanks[0], { x: slots[0].x, y: slots[0].y });
    assert.equal(escortHasGuard(state), false);
    const stoppedAt = escort.y;
    updateEscort(state);
    assert.equal(escort.y, stoppedAt, `${playerCount}P convoy should wait for the second guard`);

    Object.assign(state.tanks[1], { x: slots[1].x, y: slots[1].y });
    assert.equal(escortHasGuard(state), true);
    updateEscort(state);
    assert.ok(escort.y < stoppedAt, `${playerCount}P convoy should move with both guards`);
  }
});

test('players can move through the expanded world but cannot drive through the escort', () => {
  const state = createGameState(8, 1, 2);
  const player = state.tanks[0];
  Object.assign(player, { x: 400, y: 600, dir: 'right' as const });
  const right = emptyInput();
  right.right = true;
  applyInput(player, right, state.level, state.tanks, state.escort ?? undefined);
  assert.ok(player.x > 400, `expected movement beyond the classic 320px field, got x=${player.x}`);

  const escort = state.escort!;
  Object.assign(player, { x: escort.x, y: escort.y + 32, dir: 'up' as const });
  const before = player.y;
  applyInput(player, { ...emptyInput(), up: true }, state.level, state.tanks, escort);
  assert.equal(player.y, before);
});

test('players respawn at the original escort-stage spawn after the convoy has moved', () => {
  const state = createGameState(10, 1, 2);
  const player = state.tanks[0];
  const originalSpawn = { x: player.x, y: player.y };
  state.escort!.y = 320;

  destroyPlayerTank(state, player);

  const respawn = state.spawning[0]!.tank;
  assert.deepEqual({ x: respawn.x, y: respawn.y }, originalSpawn);
});

test('enemy bullets damage the escort once per hit window, while wrench repairs it', () => {
  const state = createGameState(3, 1, 2);
  const escort = state.escort!;
  const enemy = createEnemy('basic', 99, 0);
  Object.assign(enemy, { x: escort.x, y: escort.y - 16, dir: 'down' as const });
  const bullet = spawnBullet(enemy, state.nextBulletId++);
  bullet.x = escort.x + 8;
  bullet.y = escort.y;
  state.bullets = [bullet];
  const before = escort.hp;

  resolveEscortHits(state);
  assert.equal(escort.hp, before - 1);
  assert.equal(bullet.alive, false);

  const player = state.tanks.find((tank) => tank.kind === 'player')!;
  escort.hp = 4;
  state.powerups = [{ kind: 'wrench', x: player.x, y: player.y }];
  tryPickupPowerup(state, 'player');
  assert.equal(escort.hp, 4 + ESCORT_REPAIR_AMOUNT);
});

test('smart tank bullets ignore the escort', () => {
  const state = createGameState(11, 1, 2);
  const escort = state.escort!;
  const smart = createEnemy('smart', 99, 0);
  Object.assign(smart, { x: escort.x, y: escort.y - 16, dir: 'down' as const });
  const bullet = spawnBullet(smart, state.nextBulletId++, state.level);
  bullet.x = escort.x + 8;
  bullet.y = escort.y;
  state.bullets = [bullet];
  const before = escort.hp;

  resolveEscortHits(state);

  assert.equal(escort.hp, before);
  assert.equal(bullet.alive, true);
});

test('escort arrival clears the stage and destruction has failure priority', () => {
  const state = createGameState(4, 1, 2);
  const escort = state.escort!;
  state.phase = 'playing';
  escort.arrived = true;
  updatePhase(state);
  assert.equal(state.pendingResult, 'stageclear');

  escort.destroyed = true;
  updatePhase(state);
  assert.equal(state.pendingResult, 'gameover');
});

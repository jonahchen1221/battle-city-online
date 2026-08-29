import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ESCORT_FIELD_COLS,
  ESCORT_FIELD_ROWS,
  STAGE_COUNT,
  ESCORT_TIME_BONUS_TICKS,
  ESCORT_TIME_LIMIT_TICKS,
  SHOVEL_TICKS,
  TANK_SIZE,
  stageKind,
} from '../src/core/constants';
import { createGameState } from '../src/game/state';
import {
  ESCORT_ROUTES,
  escortGuardSlots,
  escortHasGuard,
  escortRouteForStage,
  escortProgress,
  updateEscort,
  resolveEscortHits,
} from '../src/game/escort';
import { Cell, getCell, isSolidForTank, setCell } from '../src/game/level';
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

test('each escort map has dense mixed terrain and safe four-player spawn positions', () => {
  for (const stage of ESCORT_STAGES) {
    const state = createGameState(100 + stage, 4, stage);
    const tacticalCells = [Cell.BRICK, Cell.STEEL, Cell.WATER, Cell.TREES, Cell.ICE];
    const counts = tacticalCells.map(
      (cell) => state.level.cells.filter((candidate) => candidate === cell).length,
    );
    assert.ok(counts.every((count) => count > 0), `stage ${stage} should use all terrain types`);
    assert.ok(
      counts.reduce((sum, count) => sum + count, 0) >= 1000,
      `stage ${stage} should have enough terrain to create tactical lanes`,
    );

    for (const tank of state.tanks) {
      const col = Math.floor(tank.x / 8);
      const row = Math.floor(tank.y / 8);
      for (let dr = 0; dr < 2; dr++) {
        for (let dc = 0; dc < 2; dc++) {
          assert.equal(
            isSolidForTank(getCell(state.level, col + dc, row + dr)),
            false,
            `stage ${stage} player ${tank.playerIndex + 1} spawn should be clear`,
          );
        }
      }
    }
  }
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

test('escort progress accumulates traveled distance across turns', () => {
  const escort = createGameState(18, 1, 5).escort!;
  assert.equal(escortProgress(escort), 0);

  const first = escort.route[0];
  const second = escort.route[1];
  const third = escort.route[2];
  const firstLength = Math.abs(second.x - first.x) + Math.abs(second.y - first.y);
  const secondLength = Math.abs(third.x - second.x) + Math.abs(third.y - second.y);
  const total = escort.route.slice(1).reduce((distance, point, index) => {
    const previous = escort.route[index];
    return distance + Math.abs(point.x - previous.x) + Math.abs(point.y - previous.y);
  }, 0);

  escort.routeIndex = 2;
  escort.x = second.x + (third.x - second.x) / 2;
  escort.y = second.y + (third.y - second.y) / 2;
  assert.equal(escortProgress(escort), (firstLength + secondLength / 2) / total);

  const goal = escort.route.at(-1)!;
  escort.x = goal.x;
  escort.y = goal.y;
  escort.routeIndex = escort.route.length;
  escort.arrived = true;
  assert.equal(escortProgress(escort), 1);
});

test('all six tactical escort maps can be completed after destructible roadblocks are cleared', () => {
  for (const stage of ESCORT_STAGES) {
    const state = createGameState(200 + stage, 1, stage);
    const escort = state.escort!;
    const player = state.tanks[0];
    for (let row = 0; row < state.level.rows; row++) {
      for (let col = 0; col < state.level.cols; col++) {
        if (getCell(state.level, col, row) === Cell.BRICK) {
          setCell(state.level, col, row, Cell.EMPTY);
        }
      }
    }
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
  state.level = createEmptyLevel(ESCORT_FIELD_COLS, ESCORT_FIELD_ROWS);
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

test('players respawn near the convoy after it has moved (not the route start)', () => {
  const state = createGameState(10, 1, 2);
  const player = state.tanks[0];
  const originalSpawn = { x: player.x, y: player.y };
  state.escort!.y = 320;

  destroyPlayerTank(state, player);

  // 重生点跟随车辆当前位置（同屏），不再回路线起点附近的初始出生位。
  const respawn = state.spawning[0]!.tank;
  assert.ok(Math.abs(respawn.y - 320) <= 160, `重生应在车辆附近，实际 y=${respawn.y}`);
  assert.ok(Math.abs(respawn.y - originalSpawn.y) > 100, '不应回到初始出生位');
});

test('enemy bullets are blocked without affecting time, while wrench adds time', () => {
  const state = createGameState(3, 1, 2);
  const escort = state.escort!;
  const enemy = createEnemy('basic', 99, 0);
  Object.assign(enemy, { x: escort.x, y: escort.y - 16, dir: 'down' as const });
  const bullet = spawnBullet(enemy, state.nextBulletId++);
  bullet.x = escort.x + 8;
  bullet.y = escort.y;
  state.bullets = [bullet];
  escort.timeLeftTicks = 60 * 60;
  const before = escort.timeLeftTicks;

  resolveEscortHits(state);
  assert.equal(escort.timeLeftTicks, before);
  assert.equal(bullet.alive, false);

  const player = state.tanks.find((tank) => tank.kind === 'player')!;
  state.powerups = [{ kind: 'wrench', x: player.x, y: player.y }];
  tryPickupPowerup(state, 'player');
  assert.equal(escort.timeLeftTicks, before + ESCORT_TIME_BONUS_TICKS);
});

test('smart tank bullets are blocked by the escort without damaging it', () => {
  const state = createGameState(11, 1, 2);
  const escort = state.escort!;
  const smart = createEnemy('smart', 99, 0);
  Object.assign(smart, { x: escort.x, y: escort.y - 16, dir: 'down' as const });
  const bullet = spawnBullet(smart, state.nextBulletId++, state.level);
  bullet.x = escort.x + 8;
  bullet.y = escort.y;
  state.bullets = [bullet];
  const before = escort.timeLeftTicks;

  resolveEscortHits(state);

  assert.equal(escort.timeLeftTicks, before);
  assert.equal(bullet.alive, false);
});

test('player bullets are blocked by the escort without damaging it', () => {
  const state = createGameState(12, 1, 2);
  const escort = state.escort!;
  const player = state.tanks[0];
  const bullet = spawnBullet(player, state.nextBulletId++, state.level);
  bullet.x = escort.x + 8;
  bullet.y = escort.y;
  state.bullets = [bullet];
  const before = escort.timeLeftTicks;

  resolveEscortHits(state);

  assert.equal(escort.timeLeftTicks, before);
  assert.equal(bullet.alive, false);
});

test('escort countdown advances during play, pauses for shovel, and expires into game over', () => {
  const state = createGameState(14, 1, 2);
  const escort = state.escort!;
  state.phase = 'playing';
  escort.timeLeftTicks = 2;

  state.shovelTicks = SHOVEL_TICKS;
  updateEscort(state);
  assert.equal(escort.timeLeftTicks, 2);

  state.shovelTicks = 0;
  updateEscort(state);
  assert.equal(escort.timeLeftTicks, 1);
  assert.equal(escort.timeExpired, false);
  updateEscort(state);
  assert.equal(escort.timeLeftTicks, 0);
  assert.equal(escort.timeExpired, true);

  updatePhase(state);
  assert.equal(state.pendingResult, 'gameover');
});

test('escort arrival clears the stage and time expiry has failure priority', () => {
  const state = createGameState(4, 1, 2);
  const escort = state.escort!;
  state.phase = 'playing';
  escort.arrived = true;
  updatePhase(state);
  assert.equal(state.pendingResult, 'stageclear');

  escort.timeExpired = true;
  updatePhase(state);
  assert.equal(state.pendingResult, 'gameover');
});

test('new escort stages start with the full countdown and no health fields', () => {
  const escort = createGameState(15, 1, 2).escort!;
  assert.equal(escort.timeLeftTicks, ESCORT_TIME_LIMIT_TICKS);
  assert.equal(escort.timeLimitTicks, ESCORT_TIME_LIMIT_TICKS);
  assert.equal('hp' in escort, false);
  assert.equal('maxHp' in escort, false);
});

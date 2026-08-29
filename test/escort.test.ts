import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ESCORT_FIELD_COLS,
  ESCORT_FIELD_ROWS,
  ESCORT_TIME_BONUS_TICKS,
  SHOVEL_TICKS,
  TANK_SIZE,
} from '../src/core/constants';
import { createGameState } from '../src/game/state';
import {
  escortGuardSlots,
  escortHasGuard,
  updateEscort,
  resolveEscortHits,
} from '../src/game/escort';
import { Cell, getCell, setCell } from '../src/game/level';
import { createEmptyLevel } from '../src/game/level';
import { createEnemy } from '../src/game/tank';
import { spawnBullet } from '../src/game/bullet';
import { tryPickupPowerup } from '../src/game/powerup';
import { updatePhase } from '../src/game/phase';

// 四段循环下的护送关号：每组第 2 关，十次护送各用一张独立地图与路线。
const ESCORT_STAGES = [2, 6, 10, 14, 18, 22, 26, 30, 34, 38];

test('all ten tactical escort maps can be completed after destructible roadblocks are cleared', () => {
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

test('disconnected tanks neither count as guards nor keep the multiplayer guard requirement', () => {
  const state = createGameState(23, 3, 2);
  const escort = state.escort!;
  const guard = escortGuardSlots(escort, 1)[0];
  Object.assign(state.tanks[0], { x: guard.x, y: guard.y });
  // 其余两台坦克仍保留在模拟中供重连，但已不可操控。
  const activePlayers = [true, false, false];

  assert.equal(escortHasGuard(state, activePlayers), true);
  const beforeY = escort.y;
  updateEscort(state, activePlayers);
  assert.ok(escort.y < beforeY);
});

test('guard slots scale from one full-speed strip to two independently contributing strips', () => {
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
    assert.equal(escortHasGuard(state), true);
    const oneGuardAt = escort.y;
    updateEscort(state);
    assert.equal(
      oneGuardAt - escort.y,
      escort.speed / 2,
      `${playerCount}P convoy should move at half speed with one guard`,
    );

    Object.assign(state.tanks[1], { x: slots[1].x, y: slots[1].y });
    assert.equal(escortHasGuard(state), true);
    const bothGuardsAt = escort.y;
    updateEscort(state);
    assert.equal(
      bothGuardsAt - escort.y,
      escort.speed,
      `${playerCount}P convoy should move at full speed with both guards`,
    );
  }
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

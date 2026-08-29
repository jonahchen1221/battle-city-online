import test from 'node:test';
import assert from 'node:assert/strict';
import {
  interpolateBulletPositions,
  predictLocalPlayerTank,
  snapshotInterpolationWindow,
} from '../src/client/app';
import { spawnWeaponBullets } from '../src/game/bullet';
import { createPlayer } from '../src/game/tank';
import { createGameState } from '../src/game/state';
import { emptyInput } from '../src/core/types';

test('catch-up snapshots with the same arrival time are spaced by authoritative tick', () => {
  const snapshots = [
    { snap: { tick: 3 }, arrival: 50 },
    { snap: { tick: 6 }, arrival: 200 },
    { snap: { tick: 9 }, arrival: 200 },
    { snap: { tick: 12 }, arrival: 200 },
  ];

  const first = snapshotInterpolationWindow(snapshots, 200, 90);
  assert.deepEqual(
    { fromIndex: first.fromIndex, toIndex: first.toIndex },
    { fromIndex: 1, toIndex: 2 },
  );
  assert.ok(Math.abs(first.alpha - 0.2) < 1e-9);

  const later = snapshotInterpolationWindow(snapshots, 250, 90);
  assert.deepEqual(
    { fromIndex: later.fromIndex, toIndex: later.toIndex },
    { fromIndex: 2, toIndex: 3 },
  );
  assert.ok(Math.abs(later.alpha - 0.2) < 1e-9);
});

test('multiple bullets from one owner interpolate independently by bullet id', () => {
  const tank = createPlayer(0, 1);
  tank.weapon = 'spread';
  const from = spawnWeaponBullets(tank, 10).map((bullet, index) => ({
    ...bullet,
    x: index * 100,
    y: index * 20,
  }));
  const to = from.map((bullet) => ({ ...bullet, x: bullet.x + 20, y: bullet.y + 10 }));

  const interpolated = interpolateBulletPositions(from, to, 0.5);

  assert.deepEqual(interpolated.map((bullet) => bullet.id), [10, 11, 12]);
  assert.deepEqual(
    interpolated.map((bullet) => ({ x: bullet.x, y: bullet.y })),
    [
      { x: 10, y: 5 },
      { x: 110, y: 25 },
      { x: 210, y: 45 },
    ],
  );
});

test('local player prediction fills 120Hz render frames without mutating authority', () => {
  const state = createGameState(7);
  state.level.cells.fill(0);
  state.level.brickMask.fill(0);
  const tank = createPlayer(0, 1);
  Object.assign(tank, { x: 100, y: 100, dir: 'right' as const });
  const input = emptyInput();
  input.right = true;

  const halfway = predictLocalPlayerTank(tank, input, state.level, [tank], 1000 / 120);
  assert.ok(Math.abs(halfway.x - 100.375) < 1e-9);
  assert.equal(halfway.y, 100);
  assert.equal(tank.x, 100);
  assert.equal(tank.speed, 0.75);

  const capped = predictLocalPlayerTank(tank, input, state.level, [tank], 100);
  assert.ok(Math.abs(capped.x - 100.75) < 1e-9);

  const released = predictLocalPlayerTank(tank, emptyInput(), state.level, [tank], 1000 / 60);
  assert.equal(released.x, 100);
});

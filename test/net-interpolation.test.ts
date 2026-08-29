import test from 'node:test';
import assert from 'node:assert/strict';
import { interpolateBulletPositions, snapshotInterpolationWindow } from '../src/client/app';
import { spawnWeaponBullets } from '../src/game/bullet';
import { createPlayer } from '../src/game/tank';

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

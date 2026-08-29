import test from 'node:test';
import assert from 'node:assert/strict';
import { interpolateTankPositions, snapshotInterpolationWindow } from '../src/client/app';
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

test('a perpendicular tank turn snaps the lateral axis instead of visibly drifting', () => {
  const from = createPlayer(0, 1);
  Object.assign(from, { x: 32, y: 100, dir: 'up' as const });
  const to = { ...from, x: 32.75, y: 104, dir: 'right' as const };

  const [interpolated] = interpolateTankPositions([from], [to], 0.5);

  assert.equal(interpolated.x, 32.375, '沿新行驶方向继续平滑插值');
  assert.equal(interpolated.y, 104, '垂直轴立即采用转向后的吸附位置，不画出侧滑过程');
  assert.equal(interpolated.dir, 'right');
});

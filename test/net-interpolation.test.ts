import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotInterpolationWindow } from '../src/client/app';

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

import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyInput } from '../src/core/types';
import { createEmptyLevel } from '../src/game/level';
import { applyInput, createEnemy, createPlayer } from '../src/game/tank';

test('perpendicular turn is rejected when axis snap would overlap another tank', () => {
  const level = createEmptyLevel();
  const tank = createPlayer(0, 1);
  const blocker = createPlayer(1, 2);
  Object.assign(tank, { x: 32, y: 100, dir: 'up' });
  Object.assign(blocker, { x: 33, y: 116.5, dir: 'up' });
  const input = emptyInput();
  input.right = true;

  applyInput(tank, input, level, [tank, blocker]);

  assert.deepEqual(
    { x: tank.x, y: tank.y, dir: tank.dir },
    { x: 32, y: 100, dir: 'up' },
  );
});

test('perpendicular turn still snaps and moves when the target lane is clear', () => {
  const level = createEmptyLevel();
  const tank = createPlayer(0, 1);
  Object.assign(tank, { x: 32, y: 100, dir: 'up' });
  const input = emptyInput();
  input.right = true;

  applyInput(tank, input, level, [tank]);

  assert.deepEqual(
    { x: tank.x, y: tank.y, dir: tank.dir },
    { x: 32.75, y: 104, dir: 'right' },
  );
});

test('an overlapping tank behind cannot push a moving tank in the opposite direction', () => {
  const level = createEmptyLevel();
  const tank = createEnemy('fast', 1, 0);
  const blocker = createEnemy('basic', 2, 0);
  Object.assign(tank, { x: 188, y: 0, dir: 'left' });
  Object.assign(blocker, { x: 200, y: 0, dir: 'down' });
  const input = emptyInput();
  input.left = true;

  applyInput(tank, input, level, [tank, blocker]);

  assert.equal(tank.x, 187);
  assert.equal(tank.y, 0);
});

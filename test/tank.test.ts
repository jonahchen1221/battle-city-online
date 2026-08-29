import test from 'node:test';
import assert from 'node:assert/strict';
import { BRICK_BL, BRICK_BR, BRICK_TL, BRICK_TR } from '../src/core/constants';
import { emptyInput } from '../src/core/types';
import { Cell, createEmptyLevel, removeBrickQuarters, setCell } from '../src/game/level';
import { applyInput, canTankOccupy, createPlayer } from '../src/game/tank';

test('perpendicular turn falls back to turning in place when the axis snap is blocked', () => {
  const level = createEmptyLevel();
  const tank = createPlayer(0, 1);
  const blocker = createPlayer(1, 2);
  Object.assign(tank, { x: 32, y: 100, dir: 'up' });
  Object.assign(blocker, { x: 33, y: 116.5, dir: 'up' });
  const input = emptyInput();
  input.right = true;

  applyInput(tank, input, level, [tank, blocker]);

  // 吸附位（32,104）被 blocker 占用：放弃吸附但车头立即右转，并从原位（未对齐）继续右移。
  assert.deepEqual(
    { x: tank.x, y: tank.y, dir: tank.dir },
    { x: 32.75, y: 100, dir: 'right' },
  );
});

test('tank collision follows surviving brick quarters instead of the whole subtile', () => {
  const level = createEmptyLevel();
  setCell(level, 5, 5, Cell.BRICK);
  removeBrickQuarters(level, 5, 5, BRICK_TL | BRICK_TR);
  const tank = createPlayer(0, 1);

  // Candidate box ends exactly where the surviving bottom quarters begin.
  assert.equal(canTankOccupy(tank, 40, 28, level, [tank]), true);
  assert.equal(canTankOccupy(tank, 40, 29, level, [tank]), false);

  Object.assign(tank, { x: 40, y: 27.5, dir: 'down' });
  const input = emptyInput();
  input.down = true;
  applyInput(tank, input, level, [tank]);
  assert.ok(Math.abs(tank.y - 28) < 1e-6, `expected y=28, got ${tank.y}`);

  // Keep the imported bottom-bit constants tied to the intended surviving mask.
  const idx = 5 * level.cols + 5;
  assert.equal(level.brickMask[idx], BRICK_BL | BRICK_BR);
});

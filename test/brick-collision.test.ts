import test from 'node:test';
import assert from 'node:assert/strict';
import { BRICK_BR, BRICK_TL, BRICK_TR } from '../src/core/constants';
import type { BulletState } from '../src/game/bullet';
import { advanceBullets } from '../src/game/bullet';
import { Cell, createEmptyLevel, removeBrickQuarters, setCell } from '../src/game/level';

test('a bullet passes through destroyed brick quarters without erasing surviving quarters', () => {
  const level = createEmptyLevel();
  setCell(level, 5, 5, Cell.BRICK);
  removeBrickQuarters(level, 5, 5, BRICK_TL | BRICK_TR);
  const maskBefore = level.brickMask[5 * level.cols + 5];
  const bullet: BulletState = {
    id: 1,
    x: 36,
    y: 40,
    prevX: 36,
    prevY: 40,
    dir: 'right',
    speed: 2,
    vx: 2,
    vy: 0,
    age: 0,
    kind: 'normal',
    ownerId: 1,
    ownerPlayerIndex: 0,
    fromEnemy: false,
    attacksEagle: true,
    alive: true,
    viewportBounds: null,
    steelPiercing: false,
  };
  const explosions: Parameters<typeof advanceBullets>[2] = [];
  const events: Parameters<typeof advanceBullets>[3] = [];

  advanceBullets(level, [bullet], explosions, events);

  assert.equal(bullet.alive, true);
  assert.equal(level.brickMask[5 * level.cols + 5], maskBefore);
  assert.deepEqual(explosions, []);
  assert.deepEqual(events, []);
});

function rightwardLaser(x: number): BulletState {
  return {
    id: 1,
    x,
    y: 42,
    prevX: x,
    prevY: 42,
    dir: 'right',
    speed: 8,
    vx: 8,
    vy: 0,
    age: 0,
    kind: 'laser',
    ownerId: 1,
    ownerPlayerIndex: 0,
    fromEnemy: false,
    attacksEagle: true,
    alive: true,
    viewportBounds: null,
    steelPiercing: false,
  };
}

test('a laser cannot tunnel through a half brick between its 8px movement endpoints', () => {
  const level = createEmptyLevel();
  setCell(level, 5, 5, Cell.BRICK);
  removeBrickQuarters(level, 5, 5, BRICK_TR | BRICK_BR); // 只留下左半砖 [40,44)
  const bullet = rightwardLaser(36); // 本帧从 [36,40) 跨到 [44,48)

  advanceBullets(level, [bullet], [], []);

  assert.equal(level.cells[5 * level.cols + 5], Cell.EMPTY);
  assert.equal(bullet.alive, true, '激光打穿半砖后应继续飞行');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { BRICK_TL, BRICK_TR } from '../src/core/constants';
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

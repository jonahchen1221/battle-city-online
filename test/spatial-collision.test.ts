import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BulletState,
  makeSmallExplosion,
  resolveBulletBullet,
} from '../src/game/bullet';
import { emptyInput } from '../src/core/types';
import { createGameState } from '../src/game/state';
import { createEnemy, createPlayer } from '../src/game/tank';
import { update } from '../src/game/update';
import type { ExplosionState, GameEvent } from '../src/game/state';

function bruteResolve(
  bullets: BulletState[],
  explosions: ExplosionState[],
  events: GameEvent[],
): void {
  for (let i = 0; i < bullets.length; i++) {
    const a = bullets[i];
    if (!a.alive) continue;
    for (let j = i + 1; j < bullets.length; j++) {
      const b = bullets[j];
      if (!b.alive) continue;
      if (a.fromEnemy === b.fromEnemy) {
        if (a.fromEnemy) continue;
        if (a.ownerId === b.ownerId) continue;
      }
      const overlap =
        a.x < b.x + 4 && a.x + 4 > b.x && a.y < b.y + 4 && a.y + 4 > b.y;
      if (!overlap) continue;
      a.alive = false;
      b.alive = false;
      explosions.push(makeSmallExplosion((a.x + b.x) / 2 + 2, (a.y + b.y) / 2 + 2));
      events.push('explosionSmall');
      break;
    }
  }
}

function randomBullets(seed: number, count: number): BulletState[] {
  let value = seed >>> 0;
  const next = (): number => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value;
  };
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    x: (next() % 4000) / 10 - 40,
    y: (next() % 3200) / 10 - 40,
    dir: 'up',
    speed: 2,
    vx: 0,
    vy: -2,
    age: 0,
    kind: 'normal',
    ownerId: next() % 8,
    ownerPlayerIndex: next() % 4,
    fromEnemy: (next() & 1) === 0,
    alive: (next() % 7) !== 0,
    steelPiercing: false,
  }));
}

test('spatial bullet broad phase matches the original ordered pair scan', () => {
  for (let seed = 1; seed <= 80; seed++) {
    const source = randomBullets(seed, 120);
    const expectedBullets = source.map((bullet) => ({ ...bullet }));
    const actualBullets = source.map((bullet) => ({ ...bullet }));
    const expectedExplosions: ExplosionState[] = [];
    const actualExplosions: ExplosionState[] = [];
    const expectedEvents: GameEvent[] = [];
    const actualEvents: GameEvent[] = [];

    bruteResolve(expectedBullets, expectedExplosions, expectedEvents);
    resolveBulletBullet(actualBullets, actualExplosions, actualEvents);

    assert.deepEqual(
      actualBullets.map((bullet) => bullet.alive),
      expectedBullets.map((bullet) => bullet.alive),
      `alive mismatch for seed ${seed}`,
    );
    assert.deepEqual(actualExplosions, expectedExplosions, `explosion mismatch for seed ${seed}`);
    assert.deepEqual(actualEvents, expectedEvents, `event mismatch for seed ${seed}`);
  }
});

test('spatial candidates retain array order when several bullets overlap', () => {
  const bullets = randomBullets(42, 3);
  Object.assign(bullets[0], { x: 15, y: 15, fromEnemy: false, ownerId: 1, alive: true });
  Object.assign(bullets[1], { x: 17, y: 15, fromEnemy: true, ownerId: 2, alive: true });
  Object.assign(bullets[2], { x: 16, y: 16, fromEnemy: true, ownerId: 3, alive: true });

  resolveBulletBullet(bullets, [], []);

  assert.deepEqual(bullets.map((bullet) => bullet.alive), [false, false, true]);
});

test('bullet-to-tank broad phase detects overlaps across a grid boundary', () => {
  const state = createGameState(7);
  const player = createPlayer(0, 1);
  const enemy = createEnemy('basic', 2, 0);
  Object.assign(player, { x: 200, y: 200, invulnTicks: 1000 });
  Object.assign(enemy, { x: 15, y: 15 });
  state.phase = 'playing';
  state.tanks = [player, enemy];
  state.spawning = [];
  state.enemyQueue = [];
  state.enemyFreezeTicks = 1000;
  state.neutralQueue = [];
  state.level.cells.fill(0);
  state.level.brickMask.fill(0);
  state.bullets = [{
    id: 1,
    x: 17,
    y: 16,
    dir: 'up',
    speed: 0,
    vx: 0,
    vy: 0,
    age: 0,
    kind: 'normal',
    ownerId: player.id,
    ownerPlayerIndex: 0,
    fromEnemy: false,
    alive: true,
    steelPiercing: false,
  }];

  update(state, [emptyInput()]);

  assert.equal(state.tanks.some((tank) => tank.id === enemy.id), false);
  assert.equal(state.scoreByPlayer[0], 100);
});

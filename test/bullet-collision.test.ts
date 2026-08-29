import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceBullets,
  resolveBulletBullet,
  spawnBullet,
  spawnWeaponBullets,
} from '../src/game/bullet';
import { createEmptyLevel } from '../src/game/level';
import { createEnemy, createPlayer } from '../src/game/tank';

test('a fast laser cannot tunnel through an opposing bullet between ticks', () => {
  const level = createEmptyLevel(40, 30);
  const player = createPlayer(0, 1);
  player.weapon = 'laser';
  player.dir = 'right';
  const enemy = createEnemy('power', 2, 0);
  enemy.dir = 'left';

  const laser = spawnWeaponBullets(player, 1, level)[0];
  const enemyBullet = spawnBullet(enemy, 2, level);
  Object.assign(laser, { x: 0, y: 20, prevX: 0, prevY: 20 });
  Object.assign(enemyBullet, { x: 15, y: 20, prevX: 15, prevY: 20 });
  const bullets = [laser, enemyBullet];
  const explosions: Parameters<typeof advanceBullets>[2] = [];
  const events: Parameters<typeof advanceBullets>[3] = [];

  // 第一帧两弹边缘恰好相贴；第二帧的终点已经交叉。只查终点会导致穿透。
  advanceBullets(level, bullets, explosions, events);
  resolveBulletBullet(bullets, explosions, events);
  assert.equal(laser.alive, true);
  assert.equal(enemyBullet.alive, true);

  advanceBullets(level, bullets, explosions, events);
  resolveBulletBullet(bullets, explosions, events);
  assert.equal(laser.alive, false);
  assert.equal(enemyBullet.alive, false);
  assert.equal(explosions.length, 1);
  assert.deepEqual(events, ['explosionSmall']);
});

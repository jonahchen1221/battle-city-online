import test from 'node:test';
import assert from 'node:assert/strict';
import { BULLET_SPEED } from '../src/core/constants';
import { advanceBullets, spawnBullet } from '../src/game/bullet';
import { createEmptyLevel } from '../src/game/level';
import { createPlayer } from '../src/game/tank';

test('a bullet silently expires at the screen edge captured when it was fired', () => {
  const level = createEmptyLevel(80, 90);
  const player = createPlayer(0, 1);
  Object.assign(player, { x: 320, y: 600, dir: 'up' as const });
  const bullet = spawnBullet(player, 1, level);
  const explosions: Parameters<typeof advanceBullets>[2] = [];
  const events: Parameters<typeof advanceBullets>[3] = [];
  const fireTimeTop = bullet.viewportBounds!.top;
  const ticksToEdge = (bullet.y - fireTimeTop) / BULLET_SPEED;

  for (let i = 0; i < ticksToEdge; i++) advanceBullets(level, [bullet], explosions, events);
  assert.equal(bullet.alive, true);

  // 开火后玩家和镜头即使移动，已保存的边界也不随之改变。
  player.y = 300;
  advanceBullets(level, [bullet], explosions, events);
  assert.equal(bullet.alive, false);
  assert.equal(explosions.length, 0, '射程回收不应在空中制造爆炸');
  assert.equal(events.length, 0);
});

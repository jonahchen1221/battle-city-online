import test from 'node:test';
import assert from 'node:assert/strict';
import { ENEMY_SCORE, SPIRAL_BULLET_SPEED, SPIRAL_GUARD_HITS } from '../src/core/constants';
import { emptyInput } from '../src/core/types';
import {
  advanceBullets,
  bulletHitsTank,
  resolveBulletBullet,
  spawnBullet,
  spawnWeaponBullets,
} from '../src/game/bullet';
import { resolveBulletBoss } from '../src/game/boss';
import { Cell, createEmptyLevel, getCell, setCell } from '../src/game/level';
import { createGameState } from '../src/game/state';
import { createEnemy, createPlayer } from '../src/game/tank';
import { resolveSpiralBlasts, update } from '../src/game/update';

function makePlayerFlame() {
  const player = createPlayer(0, 1);
  player.weapon = 'spiral';
  player.x = 80;
  player.y = 80;
  player.dir = 'up';
  const [bullet] = spawnWeaponBullets(player, 1, createEmptyLevel());
  return { player, bullet };
}

test('F core flies straight at 3px/tick while keeping one bullet guard', () => {
  const { bullet } = makePlayerFlame();
  const startX = bullet.x;
  const startY = bullet.y;

  advanceBullets(createEmptyLevel(), [bullet], [], []);

  assert.equal(bullet.speed, SPIRAL_BULLET_SPEED);
  assert.equal(bullet.spiralGuard, SPIRAL_GUARD_HITS);
  assert.equal(bullet.x, startX);
  assert.equal(bullet.y, startY - SPIRAL_BULLET_SPEED);
  assert.equal(bullet.age, 1);
});

test('F uses a continuous 16px heat lane instead of its old 4px moving box', () => {
  const { bullet } = makePlayerFlame();
  Object.assign(bullet, { x: 100, y: 100, vx: 0, vy: 0, dir: 'up' as const });
  const target = createEnemy('basic', 2, 0);
  Object.assign(target, { x: 109, y: 98 });

  assert.equal(bulletHitsTank(bullet, target), true, '热区边缘应能命中准星附近的坦克');
  target.x = 110;
  assert.equal(bulletHitsTank(bullet, target), false, '热区外的目标不应被凭空吸中');
});

test('F burns one opposing bullet, shrinks, then detonates on the next collision', () => {
  const { bullet } = makePlayerFlame();
  const enemy = createEnemy('smart', 2, 0);
  Object.assign(enemy, { x: 80, y: 80, dir: 'up' as const });
  const first = spawnBullet(enemy, 2);
  Object.assign(first, { x: bullet.x, y: bullet.y, vx: 0, vy: 0 });
  const explosions: ReturnType<typeof import('../src/game/bullet').makeSmallExplosion>[] = [];
  const events: Array<'explosionSmall'> = [];

  resolveBulletBullet([bullet, first], explosions, events);
  assert.equal(bullet.alive, true);
  assert.equal(bullet.spiralGuard, 0);
  assert.equal(first.alive, false);

  const second = spawnBullet(enemy, 3);
  Object.assign(second, { x: bullet.x, y: bullet.y, vx: 0, vy: 0 });
  resolveBulletBullet([bullet, second], explosions, events);
  assert.equal(bullet.alive, false);
  assert.equal(second.alive, false);
});

test('F direct hit detonates once and damages nearby enemies in its 24px blast', () => {
  const state = createGameState(41, 1, 1);
  state.phase = 'playing';
  state.level = createEmptyLevel();
  state.enemyQueue = [];
  state.spawning = [];
  state.neutralTimer = 9999;
  state.enemyFreezeTicks = 10;

  const player = state.tanks[0];
  Object.assign(player, { x: 32, y: 160, weapon: 'spiral' as const, dir: 'up' as const });
  const direct = createEnemy('basic', 2, 0);
  const splash = createEnemy('basic', 3, 0);
  Object.assign(direct, { x: 100, y: 100 });
  Object.assign(splash, { x: 112, y: 100 });
  state.tanks = [player, direct, splash];

  const [bullet] = spawnWeaponBullets(player, 1, state.level);
  Object.assign(bullet, { x: 100, y: 106, vx: 0, vy: 0, dir: 'up' as const });
  state.bullets = [bullet];

  update(state, [emptyInput()]);

  assert.equal(direct.alive, false);
  assert.equal(splash.alive, false);
  assert.equal(state.scoreByPlayer[0], ENEMY_SCORE.basic * 2);
  assert.equal(state.bullets.length, 0);
});

test('F blast clears nearby brick cells but never removes steel', () => {
  const state = createGameState(42, 1, 1);
  state.level = createEmptyLevel();
  state.tanks = [];
  setCell(state.level, 12, 12, Cell.BRICK);
  setCell(state.level, 13, 12, Cell.STEEL);

  const { bullet } = makePlayerFlame();
  Object.assign(bullet, { x: 100, y: 100, alive: false, spiralDetonate: true });
  state.bullets = [bullet];
  resolveSpiralBlasts(state);

  assert.equal(getCell(state.level, 12, 12), Cell.EMPTY);
  assert.equal(getCell(state.level, 13, 12), Cell.STEEL);
  assert.equal(state.explosions.some((e) => e.big), true);
});

test('enemy F direct hit costs a player only one damage step, not core plus blast', () => {
  const state = createGameState(43, 1, 1);
  state.phase = 'playing';
  state.level = createEmptyLevel();
  state.enemyQueue = [];
  state.spawning = [];
  state.neutralTimer = 9999;
  state.enemyFreezeTicks = 10;

  const player = state.tanks[0];
  Object.assign(player, { x: 100, y: 100, level: 1, hp: 2, armor: 0, invulnTicks: 0 });
  const smart = createEnemy('smart', 2, 0);
  Object.assign(smart, { x: 32, y: 32, weapon: 'spiral' as const, dir: 'down' as const });
  state.tanks = [player, smart];

  const [bullet] = spawnWeaponBullets(smart, 1, state.level);
  Object.assign(bullet, { x: 100, y: 106, vx: 0, vy: 0, dir: 'up' as const });
  state.bullets = [bullet];

  update(state, [emptyInput()]);

  assert.equal(player.alive, true);
  assert.equal(player.hp, 1);
});

test('F heat lane also gives Boss collisions the widened aim tolerance', () => {
  const state = createGameState(44, 1, 3);
  assert.ok(state.boss);
  Object.assign(state.boss, { x: 100, y: 100 });
  const hp = state.boss.hp;
  const { bullet } = makePlayerFlame();
  Object.assign(bullet, { x: 91, y: 112, vx: 0, vy: 0, dir: 'up' as const });
  state.bullets = [bullet];

  resolveBulletBoss(state);

  assert.equal(bullet.alive, false);
  assert.equal(state.boss.hp, hp - 1);
});

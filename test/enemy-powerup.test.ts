import test from 'node:test';
import assert from 'node:assert/strict';
import { bulletCanHit, maxBulletsFor, spawnBullet } from '../src/game/bullet';
import { createEmptyLevel } from '../src/game/level';
import { tryPickupPowerup } from '../src/game/powerup';
import { createGameState } from '../src/game/state';
import { createEnemy, createPlayer } from '../src/game/tank';
import {
  BULLET_SPEED,
  PLAYER_MAX_LEVEL,
  PLAYER_FREEZE_TICKS,
  PLAYER_SPEED,
  PLAYER_SPEED_UPGRADED,
  STAR_BULLET_SPEED,
} from '../src/core/constants';
import { update } from '../src/game/update';
import { emptyInput } from '../src/core/types';

function stateWithEnemy() {
  const state = createGameState(42, 1);
  const enemy = createEnemy('basic', 2, 0);
  Object.assign(enemy, { x: 32, y: 32 });
  state.tanks.push(enemy);
  state.events.length = 0;
  return { state, enemy };
}

test('enemy tank picks up a personal powerup without awarding player score', () => {
  const { state, enemy } = stateWithEnemy();
  state.phase = 'playing';
  state.enemyQueue = [];
  state.neutralQueue = [];
  state.enemyFreezeTicks = 2;
  state.powerups.push({ kind: 'helmet', x: enemy.x, y: enemy.y });

  update(state, [emptyInput()]);

  assert.equal(state.powerups.length, 0);
  assert.ok(enemy.invulnTicks > 0);
  assert.equal(bulletCanHit(spawnBullet(state.tanks[0], 1), enemy), false);
  assert.equal(state.scoreByPlayer[0], 0);
  assert.deepEqual(state.events, [
    { type: 'powerupPicked', playerIndex: -1, kind: 'helmet' },
    'powerupPickup',
  ]);
});

test('enemy clock freezes the player faction', () => {
  const { state, enemy } = stateWithEnemy();
  const player = state.tanks[0];
  state.powerups.push({ kind: 'timer', x: enemy.x, y: enemy.y });

  tryPickupPowerup(state, 'enemy');

  assert.equal(state.playerFreezeTicks, PLAYER_FREEZE_TICKS);
  assert.equal(state.enemyFreezeTicks, 0);

  state.phase = 'playing';
  state.enemyQueue = [];
  state.neutralQueue = [];
  state.enemyFreezeTicks = 2;
  Object.assign(player, { x: 96, y: 96 });
  const xBefore = player.x;
  const input = emptyInput();
  input.right = true;
  update(state, [input]);
  assert.equal(player.x, xBefore);
});

test('smart tank starts with player combat stats and uses the exact player star route', () => {
  const state = createGameState(43, 1);
  const smart = createEnemy('smart', 2, 0);
  const playerTemplate = createPlayer(0, 99);
  Object.assign(smart, { x: 32, y: 32 });
  state.tanks.push(smart);

  assert.deepEqual(
    {
      speed: smart.speed,
      bulletSpeed: smart.bulletSpeed,
      hp: smart.hp,
      armor: smart.armor,
      level: smart.level,
      weapon: smart.weapon,
    },
    {
      speed: playerTemplate.speed,
      bulletSpeed: playerTemplate.bulletSpeed,
      hp: playerTemplate.hp,
      armor: playerTemplate.armor,
      level: playerTemplate.level,
      weapon: playerTemplate.weapon,
    },
  );
  assert.equal(smart.speed, PLAYER_SPEED);
  assert.equal(smart.bulletSpeed, BULLET_SPEED);

  const giveStar = (): void => {
    state.powerups.push({ kind: 'star', x: smart.x, y: smart.y });
    tryPickupPowerup(state, 'enemy');
  };

  giveStar();
  assert.deepEqual(
    { level: smart.level, speed: smart.speed, hp: smart.hp, armor: smart.armor },
    { level: 1, speed: PLAYER_SPEED_UPGRADED, hp: 2, armor: 0 },
  );
  assert.equal(spawnBullet(smart, 1).speed, STAR_BULLET_SPEED);

  giveStar();
  assert.equal(smart.level, 2);
  assert.equal(smart.hp, 2);
  assert.equal(maxBulletsFor(smart), 2);
  assert.equal(spawnBullet(smart, 2).steelPiercing, true);

  giveStar();
  assert.equal(smart.level, PLAYER_MAX_LEVEL);
  assert.equal(smart.armor, 1);
  assert.equal(spawnBullet(smart, 3).steelPiercing, true);

  // 与玩家一致：满级且外甲完好时仍会吃掉星星，但不会继续叠甲。
  giveStar();
  assert.equal(smart.level, PLAYER_MAX_LEVEL);
  assert.equal(smart.armor, 1);
  assert.deepEqual(state.powerups, []);
});

test('a level-three smart tank loses and restores armor like a player', () => {
  const state = createGameState(44, 1);
  const player = state.tanks[0];
  const smart = createEnemy('smart', 2, 0);
  Object.assign(player, { x: 96, y: 160, invulnTicks: 9999 });
  Object.assign(smart, { x: 32, y: 32 });
  state.phase = 'playing';
  state.level = createEmptyLevel();
  state.tanks = [player, smart];
  state.spawning = [];
  state.enemyQueue = [];
  state.neutralQueue = [];
  state.enemyFreezeTicks = 10;

  for (let i = 0; i < PLAYER_MAX_LEVEL; i++) {
    state.powerups.push({ kind: 'star', x: smart.x, y: smart.y });
    tryPickupPowerup(state, 'enemy');
  }
  assert.deepEqual({ hp: smart.hp, armor: smart.armor }, { hp: 2, armor: 1 });

  const hit = spawnBullet(player, state.nextBulletId++, state.level);
  Object.assign(hit, {
    x: smart.x + 6,
    y: smart.y + 6,
    prevX: smart.x + 6,
    prevY: smart.y + 6,
    vx: 0,
    vy: 0,
  });
  state.bullets = [hit];
  update(state, [emptyInput()]);

  assert.equal(smart.alive, true);
  assert.deepEqual({ hp: smart.hp, armor: smart.armor }, { hp: 2, armor: 0 });

  state.powerups.push({ kind: 'star', x: smart.x, y: smart.y });
  tryPickupPowerup(state, 'enemy');
  assert.deepEqual({ level: smart.level, hp: smart.hp, armor: smart.armor }, {
    level: PLAYER_MAX_LEVEL,
    hp: 2,
    armor: 1,
  });
});

test('enemy grenade destroys players through the normal life and respawn flow', () => {
  const { state, enemy } = stateWithEnemy();
  const player = state.tanks[0];
  const livesBefore = state.livesByPlayer[0];
  state.powerups.push({ kind: 'grenade', x: enemy.x, y: enemy.y });

  tryPickupPowerup(state, 'enemy');

  assert.equal(player.alive, false);
  assert.equal(state.livesByPlayer[0], livesBefore - 1);
  assert.equal(state.spawning[0]?.tank.playerIndex, 0);
  assert.ok(state.events.includes('playerDeath'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { bulletCanHit, spawnBullet } from '../src/game/bullet';
import { tryPickupPowerup, type PowerupKind } from '../src/game/powerup';
import { createGameState } from '../src/game/state';
import { createEnemy } from '../src/game/tank';
import {
  SMART_BOOTS_TICKS,
  SMART_GHOST_TICKS,
  SMART_HELMET_TICKS,
  PLAYER_FREEZE_TICKS,
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

test('enemy star upgrade changes its actual cannon projectile', () => {
  const { state, enemy } = stateWithEnemy();
  state.powerups.push({ kind: 'star', x: enemy.x, y: enemy.y });

  tryPickupPowerup(state, 'enemy');
  const bullet = spawnBullet(enemy, 1);

  assert.equal(enemy.level, 1);
  assert.equal(bullet.speed, STAR_BULLET_SPEED);
  assert.equal(bullet.fromEnemy, true);
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

test('smart enemy ignores battle-swinging powerups even when overlapping them', () => {
  const state = createGameState(42, 1, 2);
  const smart = createEnemy('smart', 2, 0);
  Object.assign(smart, { x: 32, y: 32 });
  state.tanks.push(smart);
  const excluded: PowerupKind[] = [
    'grenade',
    'tank',
    'timer',
    'shovel',
    'wpnLaser',
    'wpnMachine',
    'hourglass',
  ];
  state.powerups = excluded.map((kind) => ({ kind, x: smart.x, y: smart.y }));

  tryPickupPowerup(state, 'enemy');

  assert.deepEqual(state.powerups.map((powerup) => powerup.kind), excluded);
  assert.equal(state.tanks[0].alive, true);
  assert.equal(state.playerFreezeTicks, 0);
  assert.equal(state.enemyQueue.length, 20);
});

test('smart enemy personal powerups use reduced durations and hard upgrade caps', () => {
  const state = createGameState(42, 1);
  const smart = createEnemy('smart', 2, 0);
  Object.assign(smart, { x: 32, y: 32 });
  state.tanks.push(smart);
  state.powerups = [
    { kind: 'star', x: smart.x, y: smart.y },
    { kind: 'star', x: smart.x, y: smart.y },
    { kind: 'helmet', x: smart.x, y: smart.y },
    { kind: 'boots', x: smart.x, y: smart.y },
    { kind: 'ghost', x: smart.x, y: smart.y },
    { kind: 'wrench', x: smart.x, y: smart.y },
    { kind: 'wrench', x: smart.x, y: smart.y },
  ];

  tryPickupPowerup(state, 'enemy');

  assert.equal(smart.level, 1);
  assert.equal(smart.invulnTicks, SMART_HELMET_TICKS);
  assert.equal(smart.speedBoostTicks, SMART_BOOTS_TICKS);
  assert.equal(smart.ghostTicks, SMART_GHOST_TICKS);
  assert.equal(smart.hp, 2);
  assert.deepEqual(state.powerups.map((powerup) => powerup.kind), ['star', 'wrench']);
});

test('smart enemy takes one balanced special weapon and leaves later replacements', () => {
  const state = createGameState(42, 1);
  const smart = createEnemy('smart', 2, 0);
  Object.assign(smart, { x: 32, y: 32 });
  state.tanks.push(smart);
  state.powerups = [
    { kind: 'wpnSpread', x: smart.x, y: smart.y },
    { kind: 'wpnSpiral', x: smart.x, y: smart.y },
  ];

  tryPickupPowerup(state, 'enemy');

  assert.equal(smart.weapon, 'spread');
  assert.deepEqual(state.powerups.map((powerup) => powerup.kind), ['wpnSpiral']);
});

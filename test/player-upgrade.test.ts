import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BULLET_SPEED,
  PLAYER_DAMAGE_FLASH_TICKS,
  PLAYER_SPEED,
  PLAYER_SPEED_UPGRADED,
  STAR_BULLET_SPEED,
} from '../src/core/constants';
import { emptyInput } from '../src/core/types';
import { maxBulletsFor, spawnBullet } from '../src/game/bullet';
import { damagePlayerTank } from '../src/game/death';
import { tryPickupPowerup } from '../src/game/powerup';
import { createGameState, nextStage, type GameState } from '../src/game/state';
import { createEnemy, isPlayerTank } from '../src/game/tank';
import { update } from '../src/game/update';

function playerOf(state: GameState) {
  return state.tanks.find(isPlayerTank)!;
}

function giveStar(state: GameState): void {
  const player = playerOf(state);
  state.powerups.push({ kind: 'star', x: player.x, y: player.y });
  tryPickupPowerup(state, 'player');
}

test('player stars follow the speed, firepower, and armor route', () => {
  const state = createGameState(1, 1, 2);
  const player = playerOf(state);

  assert.deepEqual(
    { level: player.level, speed: player.speed, hp: player.hp, armor: player.armor },
    { level: 0, speed: PLAYER_SPEED, hp: 1, armor: 0 },
  );
  assert.equal(spawnBullet(player, 1).speed, BULLET_SPEED);
  assert.equal(maxBulletsFor(player), 1);

  giveStar(state);
  assert.deepEqual(
    { level: player.level, speed: player.speed, hp: player.hp, armor: player.armor },
    { level: 1, speed: PLAYER_SPEED_UPGRADED, hp: 2, armor: 0 },
  );
  assert.equal(spawnBullet(player, 2).speed, STAR_BULLET_SPEED);

  giveStar(state);
  assert.equal(player.level, 2);
  assert.equal(player.hp, 2);
  assert.equal(maxBulletsFor(player), 2);
  assert.equal(spawnBullet(player, 3).steelPiercing, true);

  giveStar(state);
  assert.deepEqual(
    { level: player.level, hp: player.hp, armor: player.armor },
    { level: 3, hp: 2, armor: 1 },
  );

  // 满级继续拾星会被消耗，但属性完全不变，也不会补回任何耐久。
  damagePlayerTank(state, player);
  assert.equal(player.armor, 0);
  giveStar(state);
  assert.deepEqual(
    { level: player.level, hp: player.hp, armor: player.armor },
    { level: 3, hp: 2, armor: 0 },
  );
});

test('damaged upgrades add only newly unlocked durability and never heal body hp', () => {
  const state = createGameState(2, 1, 2);
  const player = playerOf(state);

  giveStar(state); // 1 级：2 hp
  damagePlayerTank(state, player);
  assert.equal(player.alive, true);
  assert.equal(player.hp, 1);
  assert.equal(player.hitFlashTicks, PLAYER_DAMAGE_FLASH_TICKS);
  assert.equal(state.explosions.length, 1);

  giveStar(state); // 2 级不增加耐久
  assert.deepEqual({ level: player.level, hp: player.hp }, { level: 2, hp: 1 });

  giveStar(state); // 3 级只装一层独立护甲
  assert.deepEqual(
    { level: player.level, hp: player.hp, armor: player.armor },
    { level: 3, hp: 1, armor: 1 },
  );

  damagePlayerTank(state, player); // 护甲先碎，残血车体不受伤
  assert.deepEqual(
    { alive: player.alive, hp: player.hp, armor: player.armor },
    { alive: true, hp: 1, armor: 0 },
  );
  assert.equal(state.explosions.length, 3, '破甲应产生两簇火花');
  assert.ok(state.events.includes('steelHit'));

  damagePlayerTank(state, player);
  assert.equal(player.alive, false);
  assert.equal(player.hp, 0);
  assert.deepEqual(state.powerups, []);
});

test('level zero still dies from one hit', () => {
  const state = createGameState(3, 1, 2);
  const player = playerOf(state);

  damagePlayerTank(state, player);

  assert.equal(player.alive, false);
  assert.equal(player.hp, 0);
});

test('stage transition preserves damage and broken armor instead of silently healing', () => {
  const state = createGameState(4, 1, 2);
  const player = playerOf(state);
  giveStar(state);
  giveStar(state);
  giveStar(state);
  damagePlayerTank(state, player); // armor 1 -> 0
  damagePlayerTank(state, player); // hp 2 -> 1

  nextStage(state);

  const carried = state.spawning.find((spawn) => isPlayerTank(spawn.tank))!.tank;
  assert.deepEqual(
    {
      level: carried.level,
      speed: carried.speed,
      hp: carried.hp,
      armor: carried.armor,
    },
    {
      level: 3,
      speed: PLAYER_SPEED_UPGRADED,
      hp: 1,
      armor: 0,
    },
  );
});

test('holding fire across a level three armor break retriggers the cannon next tick', () => {
  const state = createGameState(5, 1, 2);
  const player = playerOf(state);
  giveStar(state);
  giveStar(state);
  giveStar(state);
  player.invulnTicks = 0;
  state.phase = 'playing';
  state.spawning = [];
  state.enemyQueue = [];
  state.neutralQueue = [];

  const enemy = createEnemy('basic', 20, 0);
  enemy.x = player.x;
  enemy.y = player.y - 32;
  state.tanks.push(enemy);
  const hit = spawnBullet(enemy, state.nextBulletId++, state.level);
  Object.assign(hit, {
    x: player.x + 6,
    y: player.y - 3,
    dir: 'down' as const,
    vx: 0,
    vy: hit.speed,
  });
  state.bullets = [hit];
  state.enemyFreezeTicks = 10;
  player.prevFire = true; // 复现受击前一直按住开火键的情况。
  const heldFire = { ...emptyInput(), fire: true };

  update(state, [heldFire]);
  assert.deepEqual(
    { alive: player.alive, hp: player.hp, armor: player.armor, freeze: player.freezeTicks },
    { alive: true, hp: 2, armor: 0, freeze: 0 },
  );
  assert.equal(player.prevFire, false, '非致命受击应释放旧的开火按下沿');

  update(state, [heldFire]);

  assert.ok(
    state.bullets.some((bullet) => bullet.ownerId === player.id),
    '护甲破裂后的下一次开火按下应正常生成玩家炮弹',
  );
});

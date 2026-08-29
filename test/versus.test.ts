import test from 'node:test';
import assert from 'node:assert/strict';
import { PLAYER_INVULN_TICKS } from '../src/core/constants';
import { emptyInput } from '../src/core/types';
import { onVersusEnemyKilled } from '../src/game/death';
import { updateEnemies } from '../src/game/enemy';
import { Cell } from '../src/game/level';
import { nextStage, createGameState } from '../src/game/state';
import { isPlayerTank } from '../src/game/tank';
import { updatePhase, resolveEagleHit } from '../src/game/phase';
import { spawnBullet } from '../src/game/bullet';
import { update } from '../src/game/update';
import { tryPickupPowerup } from '../src/game/powerup';

test('versus creates one smart opponent per player with matching independent lives', () => {
  const state = createGameState(301, 3, 4);
  const enemies = state.tanks.filter((tank) => !isPlayerTank(tank));

  assert.equal(state.boss, null);
  assert.equal(state.escort, null);
  assert.equal(state.enemyQueue.length, 0);
  assert.deepEqual(state.versusLivesByEnemy, [5, 5, 5]);
  assert.deepEqual(state.versusLivesByEnemy, state.livesByPlayer);
  assert.equal(enemies.length, 3);
  assert.deepEqual(enemies.map((tank) => tank.kind), ['smart', 'smart', 'smart']);
  assert.deepEqual(enemies.map((tank) => tank.versusIndex), [0, 1, 2]);
  assert.deepEqual(enemies.map((tank) => tank.id), [4, 5, 6]);
  assert.ok(enemies.every((tank) => tank.invulnTicks === PLAYER_INVULN_TICKS));
  assert.equal(state.level.cells.includes(Cell.EAGLE), false, 'versus arenas must not contain a base');
});

test('a versus opponent spends only its own life and respawns in the same stable slot', () => {
  const state = createGameState(302, 1, 4);
  state.phase = 'playing';
  const player = state.tanks.find(isPlayerTank)!;
  const enemy = state.tanks.find((tank) => !isPlayerTank(tank))!;
  enemy.invulnTicks = 0;
  player.invulnTicks = 9999;

  const bullet = spawnBullet(player, state.nextBulletId++, state.level);
  Object.assign(bullet, {
    x: enemy.x + 6,
    y: enemy.y + 6,
    prevX: enemy.x + 6,
    prevY: enemy.y + 6,
    vx: 0,
    vy: 0,
  });
  state.bullets = [bullet];
  update(state, [emptyInput()]);

  assert.deepEqual(state.versusLivesByEnemy, [2]);
  const respawn = state.spawning.find((spawn) => spawn.tank.versusIndex === 0);
  assert.ok(respawn);
  assert.equal(respawn.tank.id, enemy.id);
  assert.equal(respawn.tank.invulnTicks, PLAYER_INVULN_TICKS);

  for (let tick = 0; tick < 60; tick++) updateEnemies(state, state.level);
  const revived = state.tanks.find((tank) => tank.versusIndex === 0);
  assert.ok(revived);
  assert.equal(revived.id, enemy.id);
});

test('versus victory requires every AI life to be exhausted, while player elimination still loses', () => {
  const win = createGameState(303, 1, 4);
  win.phase = 'playing';
  const opponent = win.tanks.find((tank) => !isPlayerTank(tank))!;
  win.versusLivesByEnemy[0] = 1;
  opponent.alive = false;
  onVersusEnemyKilled(win, opponent);
  win.tanks = win.tanks.filter((tank) => tank.alive);
  updatePhase(win);
  assert.deepEqual(win.versusLivesByEnemy, [0]);
  assert.equal(win.pendingResult, 'stageclear');

  const notYet = createGameState(304, 1, 4);
  notYet.phase = 'playing';
  notYet.tanks = notYet.tanks.filter(isPlayerTank);
  notYet.spawning = [];
  updatePhase(notYet);
  assert.equal(notYet.pendingResult, null, 'an unspent AI life must prevent an empty-field clear');

  const loss = createGameState(305, 1, 4);
  loss.phase = 'playing';
  loss.livesByPlayer[0] = 0;
  loss.tanks = loss.tanks.filter((tank) => !isPlayerTank(tank));
  loss.spawning = [];
  updatePhase(loss);
  assert.equal(loss.pendingResult, 'gameover');
});

test('versus ignores the classic eagle coordinates and follows Boss in the stage cycle', () => {
  const state = createGameState(306, 2, 3);
  nextStage(state);
  assert.equal(state.stage, 4);
  assert.equal(state.boss, null);
  assert.equal(state.escort, null);
  assert.deepEqual(state.versusLivesByEnemy, state.livesByPlayer);
  assert.equal(state.spawning.filter((spawn) => spawn.tank.versusIndex >= 0).length, 2);

  const player = state.spawning.find((spawn) => isPlayerTank(spawn.tank))!.tank;
  const bullet = spawnBullet(player, state.nextBulletId++, state.level);
  Object.assign(bullet, { x: 152, y: 224, prevX: 152, prevY: 224 });
  state.bullets = [bullet];
  resolveEagleHit(state);
  assert.equal(state.eagleDestroyed, false);
  assert.equal(bullet.alive, true);
});

test('versus smart tanks keep one-to-one targets before helping another lane', () => {
  const state = createGameState(307, 2, 4);
  const players = state.tanks.filter(isPlayerTank).sort((a, b) => a.playerIndex - b.playerIndex);
  const enemies = state.tanks
    .filter((tank) => !isPlayerTank(tank))
    .sort((a, b) => a.versusIndex - b.versusIndex);
  // 刻意交叉摆位：每台 AI 都离“另一名玩家”更近。
  Object.assign(players[0], { x: 40, y: 200, invulnTicks: 9999 });
  Object.assign(players[1], { x: 264, y: 40, invulnTicks: 9999 });
  Object.assign(enemies[0], { x: 224, y: 40, aiTicks: 0 });
  Object.assign(enemies[1], { x: 80, y: 200, aiTicks: 0 });
  state.phase = 'playing';

  updateEnemies(state, state.level);

  const axialDistance = (tank: typeof enemies[number], target: typeof players[number]): number =>
    Math.abs(tank.smartGoalX - target.x) + Math.abs(tank.smartGoalY - target.y);
  assert.ok(axialDistance(enemies[0], players[0]) <= 112);
  assert.ok(axialDistance(enemies[1], players[1]) <= 112);
});

test('versus AI life-up augments its own slot instead of creating an extra queued enemy', () => {
  const state = createGameState(308, 2, 4);
  const enemy = state.tanks.find((tank) => tank.versusIndex === 1)!;
  state.powerups = [{ kind: 'tank', x: enemy.x, y: enemy.y }];

  tryPickupPowerup(state, 'enemy');

  assert.deepEqual(state.versusLivesByEnemy, [5, 6]);
  assert.equal(state.enemyQueue.length, 0);
  assert.equal(state.tanks.filter((tank) => !isPlayerTank(tank)).length, 2);
});

test('versus simulation remains deterministic for the same seed and inputs', () => {
  const run = (): string => {
    const state = createGameState(309, 2, 4);
    state.phase = 'playing';
    for (let tick = 0; tick < 360; tick++) update(state, [emptyInput(), emptyInput()]);
    const {
      rng: _rng,
      events: _events,
      stageStartCheckpoint: _stageStartCheckpoint,
      ...serializable
    } = state;
    return JSON.stringify(serializable);
  };

  assert.equal(run(), run());
});

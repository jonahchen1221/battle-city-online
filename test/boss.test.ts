import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyInput, type Direction } from '../src/core/types';
import {
  BOSS_STAGES,
  BOSS_SIZE,
  BOSS_X,
  BOSS_Y,
  BOSS_OWNER_ID,
  BOSS_SPEED,
  BOSS_SPEED_SOLO_P2,
  BOSS_BREACH_INTERVAL_TICKS,
  BOSS_LASER_WINDUP_TICKS,
  BOSS_LASER_ACTIVE_TICKS,
  BOSS_SPIN_BULLETS,
  BOSS_SPIN_WAVES,
  BOSS_SPIN_WAVE_INTERVAL_TICKS,
  BOSS_MINION_MAX,
  BOSS_MINION_INTERVAL_TICKS,
  BOSS_MINION_CARRIER_EVERY,
  BOSS_FREEZE_TICKS,
  BOSS_SLOW_TICKS,
  BULLET_SIZE,
  FIELD_COLS,
  FIELD_ROWS,
  PLAYER_SPAWN_POINTS,
  STAGE_COUNT,
  SUBTILE,
  TANK_SIZE,
  isBossStage,
  stageKind,
  bossMaxHp,
} from '../src/core/constants';
import { createGameState, nextStage, type GameState } from '../src/game/state';
import { update } from '../src/game/update';
import { bossBlockerTanks, updateBoss, resolveBulletBoss } from '../src/game/boss';
import { updateEnemies } from '../src/game/enemy';
import {
  BOSS_NEUTRAL_WEAPONS,
  NEUTRAL_POWERUP_KINDS,
  tryPickupPowerup,
  type PowerupKind,
} from '../src/game/powerup';
import { isPlayerTank, type TankState } from '../src/game/tank';
import type { BulletState } from '../src/game/bullet';
import { Cell, createEmptyLevel, getCell, setCell } from '../src/game/level';
import { BOSS_ARENAS } from '../src/game/levels';

// 三段循环下的代表关号：Boss A = 第 3 关（组 1）、Boss B / 最终战 = 第 30 关（组 10）。
const BOSS_A_STAGE = 3;
const BOSS_B_STAGE = STAGE_COUNT; // 30

// ── 测试工具 ──

// 进入某关的可推进状态（跳过 stagestart 幕布），并给全体玩家挂上长效护盾，
// 使“Boss 机制”类用例不会被偶发的小兵弹打断（护盾只影响受伤，不影响 Boss 逻辑本身）。
function playingAt(seed: number, playerCount: number, stage: number): GameState {
  const state = createGameState(seed, playerCount, stage);
  state.phase = 'playing';
  state.phaseTicks = 0;
  for (const tank of state.tanks) tank.invulnTicks = 1_000_000;
  return state;
}

const noInputs = (playerCount: number): ReturnType<typeof emptyInput>[] =>
  Array.from({ length: playerCount }, () => emptyInput());

// 一发停在 Boss 车体正中的玩家子弹（kind 决定伤害：laser −2，其余 −1）。
function playerBulletOnBoss(id: number, kind: BulletState['kind']): BulletState {
  return {
    id,
    x: BOSS_X + BOSS_SIZE / 2 - BULLET_SIZE / 2,
    y: BOSS_Y + BOSS_SIZE / 2 - BULLET_SIZE / 2,
    dir: 'up',
    speed: 2,
    vx: 0,
    vy: -2,
    age: 0,
    kind,
    ownerId: 1,
    ownerPlayerIndex: 0,
    fromEnemy: false,
    attacksEagle: true,
    alive: true,
    viewportBounds: null,
    steelPiercing: false,
  };
}

// 把一枚道具直接放到 1P 脚下并触发拾取（走完整的 applyPowerupEffect 路径）。
function pickUpAsPlayer(state: GameState, kind: PowerupKind): void {
  const player = state.tanks.find(isPlayerTank)!;
  state.powerups.push({ kind, x: player.x, y: player.y });
  tryPickupPowerup(state, 'player');
}

function enemiesOnField(state: GameState): number {
  let n = 0;
  for (const s of state.spawning) if (!isPlayerTank(s.tank)) n++;
  for (const t of state.tanks) if (t.alive && !isPlayerTank(t)) n++;
  return n;
}

// ── 关卡序列 ──

test('30 关三段循环：每组第 3 关为 Boss 关，通关第 30 关回到第 1 关（普通关）', () => {
  assert.equal(STAGE_COUNT, 30);
  assert.deepEqual([...BOSS_STAGES], [3, 6, 9, 12, 15, 18, 21, 24, 27, 30]);
  for (let stage = 1; stage <= STAGE_COUNT; stage++) {
    assert.equal(isBossStage(stage), stage % 3 === 0, `第 ${stage} 关 isBossStage`);
  }
  // 回卷关号同样归一：第 31 关 = 第 1 关（普通），第 33 关 = 第 3 关（Boss）。
  assert.equal(isBossStage(31), false);
  assert.equal(isBossStage(33), true);

  const state = createGameState(1, 1, STAGE_COUNT);
  assert.ok(state.boss, '第 30 关应有 Boss');
  assert.equal(state.escort, null, 'Boss 关不应同时是护送关');
  nextStage(state);
  assert.equal(state.stage, 1);
  assert.equal(state.boss, null, '第 1 关是普通关，回卷后不应生成 Boss');
  assert.equal(state.escort, null, '第 1 关不是护送关');
  assert.equal(state.level.cols, FIELD_COLS);
});

test('三类关的 createGameState 冒烟：boss / escort 互斥，地图尺寸各就各位', () => {
  const normal = createGameState(7, 1, 1);
  assert.equal(stageKind(1), 'normal');
  assert.equal(normal.boss, null);
  assert.equal(normal.escort, null);
  assert.equal(normal.level.cols, FIELD_COLS);
  assert.equal(normal.level.rows, FIELD_ROWS);
  assert.ok(normal.enemyQueue.length > 0, '普通关走有限出生队列');

  const escort = createGameState(7, 1, 2);
  assert.equal(stageKind(2), 'escort');
  assert.equal(escort.boss, null);
  assert.ok(escort.escort, '护送关应有移动鹰巢');
  assert.equal(escort.level.cols, FIELD_COLS * 2);
  assert.equal(escort.level.rows, FIELD_ROWS * 3);
  assert.ok(escort.enemyQueue.length > 0, '护送关沿用有限出生队列');

  const boss = createGameState(7, 1, 3);
  assert.equal(stageKind(3), 'boss');
  assert.ok(boss.boss, 'Boss 关应有 Boss');
  assert.equal(boss.escort, null);
  assert.equal(boss.level.cols, FIELD_COLS);
  assert.equal(boss.level.rows, FIELD_ROWS);
  assert.equal(boss.enemyQueue.length, 0, 'Boss 关不走有限出生队列');
});

test('Boss 竞技场：无鹰巢、Boss 空域留空、玩家出生位是空地', () => {
  for (let i = 0; i < BOSS_ARENAS.length; i++) {
    const level = BOSS_ARENAS[i];
    const name = `竞技场 ${'AB'[i]}`;
    for (let row = 0; row < FIELD_ROWS; row++) {
      for (let col = 0; col < FIELD_COLS; col++) {
        assert.notEqual(getCell(level, col, row), Cell.EAGLE, `${name} 不应有鹰巢`);
      }
    }
    // Boss 车体覆盖的子格必须全空（否则 Boss 会与地形重叠）。
    for (let row = BOSS_Y / SUBTILE; row < (BOSS_Y + BOSS_SIZE) / SUBTILE; row++) {
      for (let col = BOSS_X / SUBTILE; col < (BOSS_X + BOSS_SIZE) / SUBTILE; col++) {
        assert.equal(getCell(level, col, row), Cell.EMPTY, `${name} Boss 空域 (${col},${row})`);
      }
    }
    for (const p of PLAYER_SPAWN_POINTS) {
      const col0 = p.x / SUBTILE;
      const row0 = p.y / SUBTILE;
      for (let row = row0; row <= row0 + 1; row++) {
        for (let col = col0; col <= col0 + 1; col++) {
          assert.equal(getCell(level, col, row), Cell.EMPTY, `${name} 出生位 (${col},${row})`);
        }
      }
    }
  }
});

// ── Boss 生成 ──

test('Boss 只在 Boss 关生成，血量随人数放大', () => {
  assert.equal(createGameState(1, 1, 4).boss, null, '普通关不应有 Boss');
  assert.equal(createGameState(1, 1, 7).boss, null, '普通关不应有 Boss');
  assert.equal(createGameState(1, 1, 5).boss, null, '护送关不应有 Boss');

  const solo = createGameState(1, 1, BOSS_A_STAGE).boss;
  assert.ok(solo);
  assert.equal(solo.hp, 100);
  assert.equal(solo.maxHp, 100);
  assert.equal(solo.phase, 1);
  assert.equal(solo.dead, false);
  assert.equal(solo.x, BOSS_X);
  assert.equal(solo.y, BOSS_Y);

  const trio = createGameState(1, 3, BOSS_A_STAGE).boss;
  assert.ok(trio);
  assert.equal(trio.hp, 220); // 100 + 2×60
  assert.equal(bossMaxHp(4), 280);

  // 跨关进入 Boss 关时同样生成（第 29 关护送 → 第 30 关最终战）。
  const state = createGameState(1, 2, BOSS_B_STAGE - 1);
  assert.equal(state.boss, null);
  nextStage(state);
  assert.equal(state.stage, BOSS_B_STAGE);
  assert.equal(state.escort, null, '进入 Boss 关时护送目标必须清空');
  assert.equal(state.boss?.maxHp, 160);
});

test('Boss 车体为普通坦克的 2×2，并以四个实心格参与坦克碰撞', () => {
  const boss = createGameState(2, 1, BOSS_A_STAGE).boss!;
  assert.equal(BOSS_SIZE, TANK_SIZE * 2);
  assert.equal(boss.size, TANK_SIZE * 2);

  const blockers = bossBlockerTanks(boss);
  assert.equal(blockers.length, 4);
  assert.deepEqual(
    blockers.map((t) => [t.x, t.y]),
    [
      [boss.x, boss.y],
      [boss.x + TANK_SIZE, boss.y],
      [boss.x, boss.y + TANK_SIZE],
      [boss.x + TANK_SIZE, boss.y + TANK_SIZE],
    ],
  );
});

test('Boss 可在空场上向四个方向追踪玩家（多人局全速）', () => {
  const cases: Array<{ playerX: number; playerY: number; dir: Direction }> = [
    { playerX: 144, playerY: 0, dir: 'up' },
    { playerX: 144, playerY: 208, dir: 'down' },
    { playerX: 0, playerY: 96, dir: 'left' },
    { playerX: 288, playerY: 96, dir: 'right' },
  ];
  for (const c of cases) {
    // 单机局一阶段 Boss 定点不动（另见单机减压用例），因此追踪方向用双人局验证。
    const state = playingAt(3, 2, BOSS_A_STAGE);
    state.level = createEmptyLevel();
    const boss = state.boss!;
    boss.x = 144;
    boss.y = 96;
    for (const player of state.tanks.filter(isPlayerTank)) {
      player.x = c.playerX;
      player.y = c.playerY;
    }
    const before = { x: boss.x, y: boss.y };

    updateBoss(state);

    assert.equal(boss.dir, c.dir);
    assert.equal(boss.moveDir, c.dir);
    assert.equal(boss.moving, true);
    if (c.dir === 'up') assert.equal(boss.y, before.y - BOSS_SPEED);
    if (c.dir === 'down') assert.equal(boss.y, before.y + BOSS_SPEED);
    if (c.dir === 'left') assert.equal(boss.x, before.x - BOSS_SPEED);
    if (c.dir === 'right') assert.equal(boss.x, before.x + BOSS_SPEED);
  }
});

test('Boss 遇到砖墙会停下并发射双发破障激光，清出 32px 通路后继续移动', () => {
  const state = playingAt(4, 2, BOSS_A_STAGE);
  state.level = createEmptyLevel();
  const boss = state.boss!;
  const wallRow = (boss.y + boss.size) / SUBTILE;
  const wallCol = boss.x / SUBTILE;
  for (let col = wallCol; col < wallCol + boss.size / SUBTILE; col++) {
    setCell(state.level, col, wallRow, Cell.BRICK);
  }
  const startY = boss.y;

  update(state, noInputs(2));

  assert.equal(boss.y, startY, '破障开火帧应先停下，不直接穿墙');
  assert.equal(boss.moving, false);
  assert.equal(boss.breachCooldown, BOSS_BREACH_INTERVAL_TICKS);
  const breachShots = state.bullets.filter((b) => b.ownerId === BOSS_OWNER_ID && b.kind === 'laser');
  assert.equal(breachShots.length, 2);
  assert.ok(
    breachShots.every((b) => b.dir === 'down' && !b.steelPiercing),
    '破障激光不再穿钢',
  );
  for (let col = wallCol; col < wallCol + boss.size / SUBTILE; col++) {
    assert.equal(getCell(state.level, col, wallRow), Cell.EMPTY, `砖墙 (${col},${wallRow}) 应被击穿`);
  }

  update(state, noInputs(2));
  assert.equal(boss.y, startY + BOSS_SPEED, '通路清开后下一帧应继续追踪移动');
  assert.equal(boss.moving, true);
});

test('破障激光打在钢块上即消亡，钢块保留；Boss 改为绕行且不会卡死', () => {
  const state = playingAt(41, 2, BOSS_A_STAGE);
  state.level = createEmptyLevel();
  const boss = state.boss!;
  const brickRow = (boss.y + boss.size) / SUBTILE;
  const steelRow = brickRow + 1;
  const wallCol = boss.x / SUBTILE;
  const cols = boss.size / SUBTILE;
  for (let col = wallCol; col < wallCol + cols; col++) {
    setCell(state.level, col, brickRow, Cell.BRICK);
    setCell(state.level, col, steelRow, Cell.STEEL);
  }

  // 首帧发射破障弹（砖墙可破），随后激光穿砖继续飞、撞上钢块即消亡。
  for (let i = 0; i < 20; i++) update(state, noInputs(2));

  for (let col = wallCol; col < wallCol + cols; col++) {
    assert.equal(getCell(state.level, col, steelRow), Cell.STEEL, `钢块 (${col},${steelRow}) 应保留`);
  }
  assert.equal(
    state.bullets.filter((b) => b.alive && b.ownerId === BOSS_OWNER_ID && b.kind === 'laser').length,
    0,
    '破障激光撞钢后应已消亡',
  );

  // 钢墙对 Boss 是永久障碍：不再对它开火，改走别的方向（也不会原地卡死）。
  const bossX = boss.x;
  const bossY = boss.y;
  boss.breachCooldown = 0;
  state.bullets = [];
  for (const player of state.tanks.filter(isPlayerTank)) {
    player.x = boss.x;
    player.y = 208; // 正下方，逼 Boss 一直想往下走
  }
  for (let i = 0; i < 30; i++) update(state, noInputs(2));
  assert.equal(
    state.bullets.filter((b) => b.ownerId === BOSS_OWNER_ID && b.kind === 'laser').length,
    0,
    '钢墙不可破，Boss 不应再浪费破障激光',
  );
  assert.ok(boss.x !== bossX || boss.y !== bossY, 'Boss 应绕行而不是卡在钢墙前');
});

test('单机减压：一阶段 Boss 定点不动（也不破障），二阶段起慢速追踪', () => {
  const state = playingAt(42, 1, BOSS_A_STAGE);
  state.level = createEmptyLevel();
  const boss = state.boss!;
  const startX = boss.x;
  const startY = boss.y;
  const player = state.tanks.find(isPlayerTank)!;
  player.x = boss.x;
  player.y = 208; // 正下方

  // 一阶段：正下方有砖墙也不动、不开破障。
  const wallRow = (boss.y + boss.size) / SUBTILE;
  for (let col = boss.x / SUBTILE; col < (boss.x + boss.size) / SUBTILE; col++) {
    setCell(state.level, col, wallRow, Cell.BRICK);
  }
  for (let i = 0; i < 60; i++) updateBoss(state);
  assert.equal(boss.x, startX);
  assert.equal(boss.y, startY);
  assert.equal(boss.moving, false);
  assert.equal(
    state.bullets.filter((b) => b.ownerId === BOSS_OWNER_ID && b.kind === 'laser').length,
    0,
    '单机一阶段不应发射破障激光',
  );

  // 二阶段：以 BOSS_SPEED_SOLO_P2 追踪（此处先把砖墙清掉，单独验证移动）。
  for (let col = boss.x / SUBTILE; col < (boss.x + boss.size) / SUBTILE; col++) {
    setCell(state.level, col, wallRow, Cell.EMPTY);
  }
  boss.phase = 2;
  updateBoss(state);
  assert.equal(boss.moving, true);
  assert.equal(boss.dir, 'down');
  assert.equal(boss.y, startY + BOSS_SPEED_SOLO_P2);
  assert.ok(BOSS_SPEED_SOLO_P2 < BOSS_SPEED, '单机二阶段应慢于多人局');
});

// ── 伤害结算 ──

test('玩家弹对 Boss：普通弹 −1、激光 −2，且一律消亡；小兵弹被吸收不扣血', () => {
  const state = playingAt(11, 1, BOSS_A_STAGE);
  const boss = state.boss!;
  const before = boss.hp;

  const normal = playerBulletOnBoss(101, 'normal');
  state.bullets = [normal];
  resolveBulletBoss(state);
  assert.equal(boss.hp, before - 1);
  assert.equal(normal.alive, false, '普通弹命中 Boss 后应消亡');
  assert.ok(boss.hitFlash > 0, '命中应触发白闪');

  const laser = playerBulletOnBoss(102, 'laser');
  state.bullets = [laser];
  resolveBulletBoss(state);
  assert.equal(boss.hp, before - 3); // −1 −2
  assert.equal(laser.alive, false, '激光对 Boss 不贯穿，应消亡');

  // 小兵弹（fromEnemy）：消弹但不扣血。
  const minionShot = playerBulletOnBoss(103, 'normal');
  minionShot.fromEnemy = true;
  minionShot.ownerId = 5;
  minionShot.ownerPlayerIndex = -1;
  state.bullets = [minionShot];
  resolveBulletBoss(state);
  assert.equal(boss.hp, before - 3, '小兵弹不应伤到 Boss');
  assert.equal(minionShot.alive, false, '小兵弹应被车体吸收');
});

test('hp 掉到半血以下进入 phase 2，并清空场上 Boss 弹幕', () => {
  const state = playingAt(12, 1, BOSS_A_STAGE);
  const boss = state.boss!;
  boss.hp = boss.maxHp / 2 + 1;

  // 先塞两发 Boss 弹幕与一发玩家弹：阶段切换只应清掉 Boss 自己的弹。
  const bossShot = playerBulletOnBoss(201, 'normal');
  bossShot.fromEnemy = true;
  bossShot.ownerId = BOSS_OWNER_ID;
  bossShot.x = 8;
  bossShot.y = 8;
  const playerShot = playerBulletOnBoss(202, 'normal');
  playerShot.x = 8;
  playerShot.y = 200;
  state.bullets = [bossShot, playerShot];

  updateBoss(state);
  assert.equal(boss.phase, 1, '仍在半血之上时不应转阶段');

  boss.hp = boss.maxHp / 2 - 1;
  updateBoss(state);
  assert.equal(boss.phase, 2);
  assert.equal(bossShot.alive, false, '阶段切换应清空 Boss 弹幕');
  assert.equal(playerShot.alive, true, '玩家子弹不受阶段切换影响');

  // 单向：血量被拉回也不回退。
  boss.hp = boss.maxHp;
  updateBoss(state);
  assert.equal(boss.phase, 2);
});

test('Boss 死亡：清弹幕、播大爆炸，随后走既有 stageclear 流程', () => {
  const state = playingAt(13, 1, BOSS_A_STAGE);
  const boss = state.boss!;
  boss.hp = 1;

  const bossShot = playerBulletOnBoss(301, 'normal');
  bossShot.fromEnemy = true;
  bossShot.ownerId = BOSS_OWNER_ID;
  bossShot.x = 8;
  bossShot.y = 8;
  const killer = playerBulletOnBoss(302, 'normal');
  state.bullets = [bossShot, killer];

  resolveBulletBoss(state);
  assert.equal(boss.dead, true);
  assert.equal(boss.hp, 0);
  assert.equal(bossShot.alive, false, 'Boss 死亡应清空其弹幕');
  const bigs = state.explosions.filter((e) => e.big).length;
  assert.ok(bigs >= 3 && bigs <= 5, `大爆炸数应为 3–5，实得 ${bigs}`);

  // 之后不再有小兵补充，且延迟结束即进入 stageclear。
  state.bullets = [];
  state.tanks = state.tanks.filter(isPlayerTank);
  state.spawning = [];
  for (let i = 0; i < 400 && state.phase === 'playing'; i++) update(state, noInputs(1));
  assert.equal(state.phase, 'stageclear');
});

// ── 攻击 ──

test('Boss 会周期性发动弹幕攻击（fromEnemy 普通弹，玩家可抵消）', () => {
  const state = playingAt(21, 1, BOSS_A_STAGE);
  let seen = 0;
  for (let i = 0; i < 900 && seen === 0; i++) {
    update(state, noInputs(1));
    seen = state.bullets.filter((b) => b.alive && b.ownerId === BOSS_OWNER_ID).length;
  }
  assert.ok(seen > 0, '推进 900 帧后应至少出现一发 Boss 弹幕');
  for (const b of state.bullets) {
    if (b.ownerId !== BOSS_OWNER_ID) continue;
    assert.equal(b.fromEnemy, true, 'Boss 弹幕必须是敌方阵营弹（可被玩家子弹抵消）');
    assert.ok(b.speed <= 2.5, `弹速应 ≤2.5，实得 ${b.speed}`);
  }
});

test('垂直激光：前摇期间不伤人，激活期间同一玩家只结算一次', () => {
  const state = playingAt(22, 1, BOSS_A_STAGE);
  const boss = state.boss!;
  const player = state.tanks[0];
  player.invulnTicks = 0; // 本用例专门验证激光伤害
  player.x = 160;
  player.y = 200;
  state.livesByPlayer[0] = 9;

  // 直接装填一次锁定该玩家列的激光（纯数据，等价于 beginAttack('laser')）。
  boss.attack = 'laser';
  boss.laserCols = [player.x + TANK_SIZE / 2];
  boss.laserHitPlayers = [];
  boss.windupTicks = BOSS_LASER_WINDUP_TICKS;
  boss.activeTicks = 0;

  for (let i = 0; i < BOSS_LASER_WINDUP_TICKS; i++) updateBoss(state);
  assert.equal(player.alive, true, '前摇期间不应伤人');
  assert.equal(state.livesByPlayer[0], 9);
  assert.equal(boss.activeTicks, BOSS_LASER_ACTIVE_TICKS, '前摇结束应转入激活相');

  // 激活相：站在目标列的玩家被结算恰好一次（此后其坦克已死，不会再扣）。
  for (let i = 0; i < BOSS_LASER_ACTIVE_TICKS; i++) updateBoss(state);
  assert.equal(player.alive, false, '站在激光列内的玩家应被击毁');
  assert.equal(state.livesByPlayer[0], 8, '同一次激光至多结算一次');
  assert.equal(boss.attack, 'none', '激光结束后应回到冷却');
});

test('phase 2 的 16 向旋转弹幕：2 波、每波 16 发、波间 30 帧', () => {
  const state = playingAt(23, 1, BOSS_A_STAGE);
  const boss = state.boss!;
  boss.phase = 2;
  boss.attack = 'spin';
  boss.stepsLeft = BOSS_SPIN_WAVES;
  boss.stepTimer = 0;
  state.bullets = [];

  const startAngle = boss.spinAngle;
  updateBoss(state); // 第一波
  assert.equal(state.bullets.length, BOSS_SPIN_BULLETS);
  assert.notEqual(boss.spinAngle, startAngle, '每波起始角应偏转');

  // 波间 30 帧：前 29 帧不出弹，第 30 帧打出下一波。
  for (let i = 0; i < BOSS_SPIN_WAVE_INTERVAL_TICKS - 1; i++) updateBoss(state);
  assert.equal(state.bullets.length, BOSS_SPIN_BULLETS);
  updateBoss(state); // 第二波
  assert.equal(state.bullets.length, BOSS_SPIN_BULLETS * 2);

  assert.equal(state.bullets.length, BOSS_SPIN_BULLETS * BOSS_SPIN_WAVES);
  assert.equal(boss.attack, 'none', '两波打完应回到冷却');
});

// ── 小兵 ──

test('Boss 关小兵：场上至多 2 只、按间隔补充、每第 2 只携带道具', () => {
  const state = playingAt(31, 1, BOSS_A_STAGE);
  const boss = state.boss!;

  // 每次强制放行一只，检查种类池与携带者节奏。
  const carriers: boolean[] = [];
  for (let i = 0; i < 8; i++) {
    boss.minionTimer = 0;
    state.spawning = state.spawning.filter((s) => isPlayerTank(s.tank));
    state.tanks = state.tanks.filter(isPlayerTank);
    updateEnemies(state, state.level);
    const spawned = state.spawning.find((s) => !isPlayerTank(s.tank));
    assert.ok(spawned, `第 ${i + 1} 只小兵应已进入出生闪光`);
    assert.ok(
      spawned.tank.kind === 'basic' || spawned.tank.kind === 'fast',
      `Boss 关 A 的小兵种类应为 basic/fast，实得 ${spawned.tank.kind}`,
    );
    assert.equal(boss.minionTimer, BOSS_MINION_INTERVAL_TICKS, '补充后应重置为固定间隔');
    carriers.push(spawned.tank.carriesPowerup);
  }
  assert.equal(BOSS_MINION_CARRIER_EVERY, 2);
  assert.equal(BOSS_MINION_INTERVAL_TICKS, 400);
  assert.deepEqual(
    carriers,
    [false, true, false, true, false, true, false, true],
    `每第 ${BOSS_MINION_CARRIER_EVERY} 只小兵携带道具`,
  );

  // 场上数量上限：连续推进期间敌军（含出生闪光）不得超过 2。
  const run = playingAt(32, 1, BOSS_A_STAGE);
  let peak = 0;
  for (let i = 0; i < 1500; i++) {
    update(run, noInputs(1));
    peak = Math.max(peak, enemiesOnField(run));
  }
  assert.ok(peak > 0, '推进 1500 帧后应已补充过小兵');
  assert.ok(peak <= BOSS_MINION_MAX, `场上小兵峰值 ${peak} 超过上限 ${BOSS_MINION_MAX}`);
});

test('Boss 关 B（最终战）的小兵为 power / smart', () => {
  const state = playingAt(33, 1, BOSS_B_STAGE);
  const boss = state.boss!;
  const kinds = new Set<TankState['kind']>();
  for (let i = 0; i < 8; i++) {
    boss.minionTimer = 0;
    state.spawning = state.spawning.filter((s) => isPlayerTank(s.tank));
    state.tanks = state.tanks.filter(isPlayerTank);
    updateEnemies(state, state.level);
    const spawned = state.spawning.find((s) => !isPlayerTank(s.tank));
    assert.ok(spawned);
    kinds.add(spawned.tank.kind);
  }
  for (const kind of kinds) {
    assert.ok(kind === 'power' || kind === 'smart', `实得 ${kind}`);
  }
});

// ── 中立道具（Boss 关专属池 + 对 Boss 的控制效果）──

test('Boss 关中立道具队列：2 星 + 头盔 + 战靴 + 1 件随机武器', () => {
  for (const stage of BOSS_STAGES) {
    for (const seed of [1, 7, 99, 12345]) {
      const queue = createGameState(seed, 1, stage).neutralQueue;
      const count = (kind: PowerupKind): number => queue.filter((k) => k === kind).length;
      assert.equal(queue.length, 5, `第 ${stage} 关 / seed ${seed} 的中立队列长度`);
      assert.equal(count('star'), 2, '两枚星');
      assert.equal(count('helmet'), 1, '一枚头盔');
      assert.equal(count('boots'), 1, '一双战靴');
      assert.equal(
        queue.filter((k) => BOSS_NEUTRAL_WEAPONS.includes(k)).length,
        1,
        '恰一件随机武器',
      );
    }
  }

  // 普通关维持原 5 种中立池。
  const normal = createGameState(1, 1, 4).neutralQueue;
  assert.deepEqual([...normal].sort(), [...NEUTRAL_POWERUP_KINDS].sort());

  // 护送关同样用普通池（只是把扳手换到队首，见 state.ts）。
  const escort = createGameState(1, 1, 2).neutralQueue;
  assert.deepEqual([...escort].sort(), [...NEUTRAL_POWERUP_KINDS].sort());
  assert.equal(escort[0], 'wrench', '护送关首枚中立道具固定为扳手');

  // 跨关进入 Boss 关时同样切换到专属池（第 2 关护送 → 第 3 关 Boss）。
  const state = createGameState(5, 1, BOSS_A_STAGE - 1);
  nextStage(state);
  assert.equal(state.stage, BOSS_A_STAGE);
  assert.equal(state.neutralQueue.length, 5);
  assert.equal(state.neutralQueue.filter((k) => k === 'star').length, 2);
});

test('时钟（timer）冻结 Boss 2 秒：期间不动、攻击计时全停，仍可被打', () => {
  const state = playingAt(51, 2, BOSS_A_STAGE);
  state.level = createEmptyLevel();
  const boss = state.boss!;
  const timerBefore = boss.attackTimer;
  const pos = { x: boss.x, y: boss.y };

  pickUpAsPlayer(state, 'timer');
  assert.equal(BOSS_FREEZE_TICKS, 120);
  assert.equal(boss.freezeTicks, BOSS_FREEZE_TICKS);

  // 冻结期间照样吃伤害（并触发白闪）。
  const hpBefore = boss.hp;
  state.bullets = [playerBulletOnBoss(501, 'normal')];
  resolveBulletBoss(state);
  assert.equal(boss.hp, hpBefore - 1, '冻结中的 Boss 仍可被打');
  assert.ok(boss.hitFlash > 0);

  for (let i = 0; i < BOSS_FREEZE_TICKS; i++) {
    state.tick++;
    updateBoss(state);
  }
  assert.equal(boss.attackTimer, timerBefore, '冻结期间攻击计时完全不推进');
  assert.equal(boss.x, pos.x, '冻结期间不移动');
  assert.equal(boss.y, pos.y);
  assert.equal(boss.moving, false);
  assert.equal(boss.hitFlash, 0, 'hitFlash 照常递减');
  assert.equal(boss.freezeTicks, 0, '120 帧后解冻');

  state.tick++;
  updateBoss(state);
  assert.equal(boss.attackTimer, timerBefore - 1, '解冻后攻击计时恢复推进');
  assert.equal(boss.moving, true, '解冻后恢复移动');
});

test('沙漏（hourglass）令 Boss 半速 12 秒：同样帧数内攻击计时只推进一半', () => {
  const state = playingAt(52, 2, BOSS_A_STAGE);
  state.level = createEmptyLevel();
  const boss = state.boss!;
  const before = boss.attackTimer;

  pickUpAsPlayer(state, 'hourglass');
  assert.equal(BOSS_SLOW_TICKS, 720);
  assert.equal(boss.slowTicks, BOSS_SLOW_TICKS);

  for (let i = 0; i < 60; i++) {
    state.tick++;
    updateBoss(state);
  }
  assert.equal(boss.attackTimer, before - 30, '半速：60 帧只推进 30 帧的攻击计时');
  assert.equal(boss.slowTicks, BOSS_SLOW_TICKS - 60, '减速时长按真实帧数递减');

  // 对照组：不吃沙漏时同样 60 帧推进满 60 帧。
  const ref = playingAt(52, 2, BOSS_A_STAGE);
  ref.level = createEmptyLevel();
  for (let i = 0; i < 60; i++) {
    ref.tick++;
    updateBoss(ref);
  }
  assert.equal(ref.boss!.attackTimer, before - 60);
});

// ── 确定性 ──

test('同 seed 同输入序列：Boss 关跑两遍得到完全一致的 state', () => {
  const script = (tick: number) => {
    const input = emptyInput();
    input.left = tick % 120 < 40;
    input.right = tick % 120 >= 60 && tick % 120 < 100;
    input.fire = tick % 7 === 0;
    return [input];
  };
  const run = (): string => {
    const state = createGameState(2024, 1, BOSS_A_STAGE);
    state.phase = 'playing';
    for (let tick = 0; tick < 800; tick++) {
      update(state, script(tick));
      state.events.length = 0; // 事件队列由调用方逐帧清空（与 main.ts 一致）
    }
    // rng 是闭包（JSON 中为空对象），其余字段全部为纯数据。
    return JSON.stringify(state);
  };
  assert.equal(run(), run());
});

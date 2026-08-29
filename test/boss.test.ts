import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyInput } from '../src/core/types';
import {
  BOSS_STAGES,
  BOSS_SIZE,
  BOSS_X,
  BOSS_Y,
  BOSS_OWNER_ID,
  BOSS_SPEED,
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
  BULLET_SIZE,
  FIELD_COLS,
  FIELD_ROWS,
  STAGE_COUNT,
  SUBTILE,
  TANK_SIZE,
  isBossStage,
  stageKind,
  bossMaxHp,
  BOSS_WALL_SPACING,
  BOSS_WALL_GAP_SLOTS,
  BOSS_CHARGE_WARN_TICKS,
  BOSS_CHARGE_SPEED,
  BOSS_CHARGE_STUN_STEEL_TICKS,
  BOSS_CHARGE_STUN_SOFT_TICKS,
  BOSS_MORTAR_COUNT,
  BOSS_MORTAR_FUSE_TICKS,
  BOSS_MORTAR_BLAST,
  BOSS_SUMMON_COUNT,
  BOSS_ENEMY_HARD_CAP,
  BOSS_MINE_SIZE,
  BOSS_MINE_MAX,
  BOSS_MINE_ARM_TICKS,
  BOSS_MINE_LIFE_TICKS,
  BOSS_MINE_INTERVAL_TICKS,
  BOSS_MAGNET_WARN_TICKS,
  BOSS_MAGNET_TICKS,
  BOSS_MAGNET_BULLETS,
  BOSS_SWEEP_WARN_TICKS,
  BOSS_SWEEP_SPEED,
  BOSS_LASER_WIDTH,
  SPAWN_FLASH_TICKS,
  FIELD_WIDTH,
  FIELD_HEIGHT,
} from '../src/core/constants';
import { createGameState, nextStage, type GameState } from '../src/game/state';
import { update } from '../src/game/update';
import { startBossAttack, updateBoss, updateMines, resolveBulletBoss } from '../src/game/boss';
import { updateEnemies } from '../src/game/enemy';
import { tryPickupPowerup, type PowerupKind } from '../src/game/powerup';
import { createEnemy, isPlayerTank } from '../src/game/tank';
import type { BulletState } from '../src/game/bullet';
import { Cell, createEmptyLevel, getCell, setCell } from '../src/game/level';

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
    prevX: BOSS_X + BOSS_SIZE / 2 - BULLET_SIZE / 2,
    prevY: BOSS_Y + BOSS_SIZE / 2 - BULLET_SIZE / 2,
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

// ── Boss 生成 ──

test('Boss 只在 Boss 关生成，血量随人数与序号放大', () => {
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
  // 第 10 位 Boss、双人局：100 + 10×9 + 60 = 250。
  assert.equal(state.boss?.ordinal, 10);
  assert.equal(state.boss?.maxHp, 250);
});

test('Boss 遇到砖墙会停下并发射双发破障激光，清出 32px 通路后继续移动', () => {
  const state = playingAt(4, 2, BOSS_A_STAGE);
  state.level = createEmptyLevel();
  const boss = state.boss!;
  const wallRow = (boss.y + boss.size) / SUBTILE;
  const wallCol = boss.x / SUBTILE;
  // 砖墙横贯全场：A* 寻路会绕开只有车宽的小段砖墙（见钢墙绕行用例），
  // 只有确实无路可绕时才会选择穿砖路径并触发破障。
  for (let col = 0; col < state.level.cols; col++) {
    setCell(state.level, col, wallRow, Cell.BRICK);
  }
  // 场景手术（换图 + 砌墙）后清除移动方向承诺：它是 playingAt 预热帧在旧地图上留下的。
  boss.moveCommitTicks = 0;
  // 玩家摆到 Boss 正下方（目标列已对齐）：A* 对未对齐目标会先横移对齐再穿墙（整体最优），
  // 本用例要验证的是“穿墙是第一步”时立即停下破障。
  for (const player of state.tanks.filter(isPlayerTank)) {
    player.x = boss.x + (boss.size - TANK_SIZE) / 2;
    player.y = boss.y + boss.size + SUBTILE * 4;
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

// ── 新技能（按 Boss 序号解锁）──

test('弹幕墙：整排 16px 间隔的子弹，随机留一个 32px 缺口，朝目标半场飞', () => {
  // 第 6 关 = 第 2 位 Boss（弹幕墙解锁关）。
  const state = playingAt(61, 1, 6);
  state.level = createEmptyLevel();
  const boss = state.boss!;
  boss.x = 144;
  boss.y = 48;
  const player = state.tanks.find(isPlayerTank)!;
  player.x = 160;
  player.y = 208; // 正下方 → 齐射朝下
  state.bullets = [];

  startBossAttack(state, boss, 'bulletWall');

  const slots = FIELD_WIDTH / BOSS_WALL_SPACING; // 20
  assert.equal(state.bullets.length, slots - BOSS_WALL_GAP_SLOTS, '缺口恰好吃掉两个弹位');
  const present = new Set<number>();
  for (const b of state.bullets) {
    assert.equal(b.ownerId, BOSS_OWNER_ID);
    assert.equal(b.fromEnemy, true, '弹幕墙必须可被玩家子弹抵消');
    assert.ok(b.vy > 0 && b.vx === 0, '目标在下方 → 全部垂直朝下');
    assert.equal(b.y, boss.y + boss.size, '自 Boss 车体下沿出膛');
    const cx = b.x + BULLET_SIZE / 2;
    assert.equal((cx - BOSS_WALL_SPACING / 2) % BOSS_WALL_SPACING, 0, `弹位未对齐：${cx}`);
    present.add((cx - BOSS_WALL_SPACING / 2) / BOSS_WALL_SPACING);
  }
  // 缺口：恰好两个**连续**弹位缺席。
  const missing: number[] = [];
  for (let i = 0; i < slots; i++) if (!present.has(i)) missing.push(i);
  assert.equal(missing.length, BOSS_WALL_GAP_SLOTS);
  assert.equal(missing[1], missing[0] + 1, `缺口必须连续，实得 ${missing.join(',')}`);

  // 目标在上方时改为朝上齐射（自车体上沿出膛）。
  player.y = 8;
  state.bullets = [];
  startBossAttack(state, boss, 'bulletWall');
  assert.ok(state.bullets.every((b) => b.vy < 0), '目标在上方 → 全部垂直朝上');
});

test('蓄力冲撞：预警 45 帧后 4px/帧冲锋，粉碎沿途砖块、碾毁玩家，撞钢眩晕 90 帧', () => {
  // 第 9 关 = 第 3 位 Boss（冲撞解锁关）。双人局：一名诱饵、一名挡在路上。
  const state = playingAt(62, 2, 9);
  state.level = createEmptyLevel();
  const boss = state.boss!;
  boss.x = 0;
  boss.y = 96; // 车体占 rows 12–15
  const players = state.tanks.filter(isPlayerTank).sort((a, b) => a.playerIndex - b.playerIndex);
  players[0].x = 300;
  players[0].y = 96; // 诱饵：同一行的右侧，护盾保留
  players[1].x = 100;
  players[1].y = 96; // 挡路者：会被碾毁
  players[1].invulnTicks = 0;
  state.livesByPlayer[1] = 5;

  // 沿途砖块（cols 8-9 / rows 12-13）与终点钢墙（cols 20-21 / rows 12-15）。
  for (const col of [8, 9]) for (const row of [12, 13]) setCell(state.level, col, row, Cell.BRICK);
  for (const col of [20, 21]) {
    for (let row = 12; row <= 15; row++) setCell(state.level, col, row, Cell.STEEL);
  }

  startBossAttack(state, boss, 'charge');
  assert.equal(boss.attack, 'charge');
  assert.equal(boss.chargeDir, 'right', '与 Boss 更接近对齐的是横轴');
  assert.equal(boss.windupTicks, BOSS_CHARGE_WARN_TICKS);

  // 预警相：整整 45 帧不移动（这是玩家唯一的让位窗口）。
  for (let i = 0; i < BOSS_CHARGE_WARN_TICKS; i++) updateBoss(state);
  assert.equal(boss.x, 0, '预警期间车体不得移动');
  assert.equal(boss.windupTicks, 0);

  // 冲锋首帧：整整 4px。
  updateBoss(state);
  assert.equal(boss.x, BOSS_CHARGE_SPEED);

  // 一路冲到钢墙前停下：新位置若与钢块重叠即刹停，故最后落点为 128（128+32=160=钢墙左沿）。
  for (let i = 0; i < 60 && boss.attack === 'charge'; i++) updateBoss(state);
  assert.equal(boss.attack, 'none', '撞停后应回到冷却');
  assert.equal(boss.x, 128, '车体应紧贴钢墙外沿');
  assert.equal(boss.stunTicks, BOSS_CHARGE_STUN_STEEL_TICKS, '撞钢眩晕 90 帧');
  assert.ok(BOSS_CHARGE_STUN_STEEL_TICKS > BOSS_CHARGE_STUN_SOFT_TICKS);

  // 沿途砖块整格粉碎，钢墙原样保留。
  for (const col of [8, 9]) {
    for (const row of [12, 13]) {
      assert.equal(getCell(state.level, col, row), Cell.EMPTY, `砖块 (${col},${row}) 应被粉碎`);
    }
  }
  assert.equal(getCell(state.level, 20, 12), Cell.STEEL, '钢墙不可粉碎');
  // 挡在路上的玩家被碾毁。
  assert.equal(players[1].alive, false, '被冲撞碾到的玩家应被击毁');
  assert.equal(state.livesByPlayer[1], 4);

  // 眩晕期：不移动、不攻击，但照常挨打 —— 这是核心反制窗口。
  const stunPos = { x: boss.x, y: boss.y };
  const hpBefore = boss.hp;
  state.bullets = [playerBulletOnBoss(601, 'normal')];
  state.bullets[0].x = boss.x + boss.size / 2;
  state.bullets[0].y = boss.y + boss.size / 2;
  resolveBulletBoss(state);
  assert.equal(boss.hp, hpBefore - 1, '眩晕中的 Boss 仍可被扣血');
  const timerBefore = boss.attackTimer;
  for (let i = 0; i < BOSS_CHARGE_STUN_STEEL_TICKS; i++) updateBoss(state);
  assert.equal(boss.x, stunPos.x, '眩晕期间不移动');
  assert.equal(boss.y, stunPos.y);
  assert.equal(boss.attackTimer, timerBefore, '眩晕期间攻击计时完全不推进');
  assert.equal(boss.stunTicks, 0, '90 帧后解除眩晕');
});

test('迫击炮雨：4 个落点、48 帧引信，起爆清砖并击毁站桩玩家（钢不毁）', () => {
  // 第 12 关 = 第 4 位 Boss（迫击炮解锁关）。
  const state = playingAt(64, 1, 12);
  state.level = createEmptyLevel();
  const boss = state.boss!;
  const player = state.tanks.find(isPlayerTank)!;
  player.invulnTicks = 0;
  player.x = 160;
  player.y = 160;
  state.livesByPlayer[0] = 5;

  // 落点规划：恒为 4 个，引信一致。
  startBossAttack(state, boss, 'mortar');
  assert.equal(boss.mortarMarks.length, BOSS_MORTAR_COUNT);
  for (const mark of boss.mortarMarks) {
    assert.equal(mark.ticksLeft, BOSS_MORTAR_FUSE_TICKS);
    assert.ok(mark.x >= 0 && mark.x + BOSS_MORTAR_BLAST <= FIELD_WIDTH, '落点不得越界');
    assert.ok(mark.y >= 0 && mark.y + BOSS_MORTAR_BLAST <= FIELD_HEIGHT);
  }

  // 起爆结算走确定性路径：手工装填一个正中玩家的落点，四周铺砖与钢。
  boss.mortarMarks = [{ x: player.x, y: player.y, ticksLeft: BOSS_MORTAR_FUSE_TICKS }];
  const brickCells = [
    [20, 20],
    [21, 20],
    [20, 21],
    [21, 21],
  ];
  for (const [col, row] of brickCells) setCell(state.level, col, row, Cell.BRICK);
  setCell(state.level, 22, 20, Cell.STEEL); // 判定盒外的钢块：不该被波及

  for (let i = 0; i < BOSS_MORTAR_FUSE_TICKS - 1; i++) updateBoss(state);
  assert.equal(player.alive, true, '引信走完前不伤人');
  assert.equal(getCell(state.level, 20, 20), Cell.BRICK, '引信走完前不清砖');

  updateBoss(state); // 第 48 帧起爆
  assert.equal(player.alive, false, '站在标记里的玩家应被击毁');
  assert.equal(state.livesByPlayer[0], 4);
  for (const [col, row] of brickCells) {
    assert.equal(getCell(state.level, col, row), Cell.EMPTY, `砖块 (${col},${row}) 应整格清除`);
  }
  assert.equal(getCell(state.level, 22, 20), Cell.STEEL, '钢块不毁');
  assert.equal(boss.mortarMarks.length, 0);
  assert.equal(boss.attack, 'none', '炸完回到冷却');
});

test('召唤援军：两侧各闪现一只小兵，且全场敌军不超过硬上限 6 只', () => {
  // 第 15 关 = 第 5 位 Boss（召唤解锁关）。
  const state = playingAt(65, 1, 15);
  state.level = createEmptyLevel();
  const boss = state.boss!;
  state.spawning = state.spawning.filter((s) => isPlayerTank(s.tank));
  state.tanks = state.tanks.filter(isPlayerTank);

  startBossAttack(state, boss, 'summon');
  assert.equal(enemiesOnField(state), BOSS_SUMMON_COUNT, '一次召唤放两只');
  assert.equal(boss.attack, 'none', '即时召唤，随即回到冷却');
  const summoned = state.spawning.filter((s) => !isPlayerTank(s.tank));
  assert.equal(summoned.length, BOSS_SUMMON_COUNT);
  for (const s of summoned) {
    assert.equal(s.ticksLeft, SPAWN_FLASH_TICKS, '召唤同样走出生闪光');
    assert.ok(
      s.tank.kind === 'basic' || s.tank.kind === 'fast',
      `种类应取当前关小兵池，实得 ${s.tank.kind}`,
    );
  }
  // 硬上限：先把场上塞到 5 只，再召唤只能补进 1 只。
  const filler = playingAt(66, 1, 15);
  filler.level = createEmptyLevel();
  filler.spawning = filler.spawning.filter((s) => isPlayerTank(s.tank));
  filler.tanks = filler.tanks.filter(isPlayerTank);
  for (let i = 0; i < BOSS_ENEMY_HARD_CAP - 1; i++) {
    const dummy = createEnemy('basic', 100 + i, 0);
    dummy.x = i * 24;
    dummy.y = 200;
    filler.tanks.push(dummy);
  }
  assert.equal(enemiesOnField(filler), BOSS_ENEMY_HARD_CAP - 1);
  startBossAttack(filler, filler.boss!, 'summon');
  assert.equal(enemiesOnField(filler), BOSS_ENEMY_HARD_CAP, '超出硬上限的部分不放');
});

test('沿途布雷：移动时定时铺雷，武装后触之即死；子弹引爆与到期自爆都不伤人', () => {
  // 第 18 关 = 第 6 位 Boss（布雷解锁关）。双人局保证 Boss 一阶段就会移动。
  const state = playingAt(67, 2, 18);
  state.level = createEmptyLevel();
  const boss = state.boss!;
  assert.equal(boss.ordinal, 6);
  for (const p of state.tanks.filter(isPlayerTank)) {
    p.x = boss.x;
    p.y = 208; // 正下方，逼 Boss 一路向下
  }

  // 铺设：移动状态 + 计时归零 → 车尾（此时在上方）落一枚雷。
  boss.mineTimer = 0;
  updateBoss(state);
  assert.equal(boss.moving, true);
  assert.equal(state.mines.length, 1, '移动中应铺下一枚雷');
  const laid = state.mines[0];
  assert.equal(laid.armTicks, BOSS_MINE_ARM_TICKS);
  assert.equal(laid.lifeTicks, BOSS_MINE_LIFE_TICKS);
  assert.equal(boss.mineTimer, BOSS_MINE_INTERVAL_TICKS, '铺完重置为固定间隔');

  // 未解锁的 Boss（序号 <6）永不布雷。
  const early = playingAt(68, 2, 9); // 第 3 位
  early.level = createEmptyLevel();
  for (const p of early.tanks.filter(isPlayerTank)) {
    p.x = early.boss!.x;
    p.y = 208;
  }
  early.boss!.mineTimer = 0;
  for (let i = 0; i < 200; i++) updateBoss(early);
  assert.equal(early.mines.length, 0, '第 3 位 Boss 不该布雷');

  // 武装：60 帧后 armTicks 归零。
  const arm = playingAt(69, 1, 18);
  arm.level = createEmptyLevel();
  arm.mines = [{ id: 1, x: 100, y: 100, armTicks: BOSS_MINE_ARM_TICKS, lifeTicks: BOSS_MINE_LIFE_TICKS }];
  for (let i = 0; i < BOSS_MINE_ARM_TICKS; i++) updateMines(arm);
  assert.equal(arm.mines[0].armTicks, 0, '60 帧后武装完毕');

  // 触雷：武装后的雷碰到玩家即爆，玩家阵亡、雷消失。
  const trip = playingAt(70, 1, 18);
  trip.level = createEmptyLevel();
  const victim = trip.tanks.find(isPlayerTank)!;
  victim.invulnTicks = 0;
  victim.x = 100;
  victim.y = 100;
  trip.livesByPlayer[0] = 5;
  trip.mines = [{ id: 1, x: 104, y: 104, armTicks: 0, lifeTicks: 100 }];
  updateMines(trip);
  assert.equal(victim.alive, false, '踩到武装地雷即毁');
  assert.equal(trip.livesByPlayer[0], 4);
  assert.equal(trip.mines.length, 0, '爆炸后地雷消失');

  // 未武装的雷踩上去无害。
  const safe = playingAt(71, 1, 18);
  safe.level = createEmptyLevel();
  const walker = safe.tanks.find(isPlayerTank)!;
  walker.invulnTicks = 0;
  walker.x = 100;
  walker.y = 100;
  safe.mines = [{ id: 1, x: 104, y: 104, armTicks: 10, lifeTicks: 100 }];
  updateMines(safe);
  assert.equal(walker.alive, true, '未武装的地雷不该伤人');
  assert.equal(safe.mines.length, 1);

  // 子弹引爆（安全排雷）：即便玩家正踩在上面也不受伤，子弹一并消亡。
  const defuse = playingAt(72, 1, 18);
  defuse.level = createEmptyLevel();
  const sapper = defuse.tanks.find(isPlayerTank)!;
  sapper.invulnTicks = 0;
  sapper.x = 100;
  sapper.y = 100;
  defuse.mines = [{ id: 1, x: 104, y: 104, armTicks: 0, lifeTicks: 100 }];
  const shot = playerBulletOnBoss(701, 'normal');
  shot.x = 104;
  shot.y = 104;
  defuse.bullets = [shot];
  updateMines(defuse);
  assert.equal(defuse.mines.length, 0, '被子弹引爆');
  assert.equal(shot.alive, false, '引爆的子弹一并消亡');
  assert.equal(sapper.alive, true, '安全排雷不该炸到自己人');

  // 到期自爆：240 帧后自行消失，不伤人。
  const expire = playingAt(73, 1, 18);
  expire.level = createEmptyLevel();
  const bystander = expire.tanks.find(isPlayerTank)!;
  bystander.invulnTicks = 0;
  bystander.x = 200;
  bystander.y = 200;
  expire.mines = [{ id: 1, x: 100, y: 100, armTicks: 0, lifeTicks: BOSS_MINE_LIFE_TICKS }];
  for (let i = 0; i < BOSS_MINE_LIFE_TICKS; i++) updateMines(expire);
  assert.equal(expire.mines.length, 0, `${BOSS_MINE_LIFE_TICKS} 帧后应自爆消失`);
  assert.equal(bystander.alive, true);

  // 场上上限：满 6 枚时不再铺设。
  const full = playingAt(74, 2, 18);
  full.level = createEmptyLevel();
  for (const p of full.tanks.filter(isPlayerTank)) {
    p.x = full.boss!.x;
    p.y = 208;
  }
  full.mines = Array.from({ length: BOSS_MINE_MAX }, (_, i) => ({
    id: i + 1,
    x: 8 + i * 16,
    y: 8,
    armTicks: BOSS_MINE_ARM_TICKS,
    lifeTicks: BOSS_MINE_LIFE_TICKS,
  }));
  full.boss!.mineTimer = 0;
  updateBoss(full);
  assert.equal(full.mines.length, BOSS_MINE_MAX, `上限 ${BOSS_MINE_MAX} 枚，不得超发`);
  assert.equal(BOSS_MINE_SIZE, 8);
});

test('磁力牵引：预警 30 帧后把玩家拉向 Boss、每 30 帧一圈弹幕，且绝不穿墙', () => {
  // 第 21 关 = 第 7 位 Boss（磁力解锁关）。
  const state = playingAt(75, 1, 21);
  state.level = createEmptyLevel();
  const boss = state.boss!;
  boss.x = 144;
  boss.y = 96;
  const player = state.tanks.find(isPlayerTank)!;
  player.x = 144;
  player.y = 208; // 远在正下方
  state.bullets = [];

  startBossAttack(state, boss, 'magnet');
  assert.equal(boss.windupTicks, BOSS_MAGNET_WARN_TICKS);
  for (let i = 0; i < BOSS_MAGNET_WARN_TICKS; i++) updateBoss(state);
  assert.equal(player.y, 208, '预警期间还没有牵引');
  assert.equal(state.bullets.length, 0, '预警期间不出弹');
  assert.equal(boss.activeTicks, BOSS_MAGNET_TICKS, '预警结束转入牵引相');

  for (let i = 0; i < BOSS_MAGNET_TICKS; i++) updateBoss(state);
  assert.ok(player.y < 208 - 15, `玩家应被明显拉近，实得 y=${player.y}`);
  assert.equal(state.bullets.length, BOSS_MAGNET_BULLETS * 3, '90 帧内放三圈 8 向弹幕');
  assert.equal(boss.attack, 'none', '牵引结束回到冷却');

  // 不穿墙：玩家与 Boss 之间横一道钢墙时，牵引只能把人贴到墙前。
  const walled = playingAt(76, 1, 21);
  walled.level = createEmptyLevel();
  const wboss = walled.boss!;
  wboss.x = 144;
  wboss.y = 96;
  const wplayer = walled.tanks.find(isPlayerTank)!;
  wplayer.x = 144;
  wplayer.y = 208;
  for (let col = 16; col <= 23; col++) {
    for (const row of [24, 25]) setCell(walled.level, col, row, Cell.STEEL);
  }
  startBossAttack(walled, wboss, 'magnet');
  for (let i = 0; i < BOSS_MAGNET_WARN_TICKS + BOSS_MAGNET_TICKS; i++) updateBoss(walled);
  assert.equal(wplayer.y, 208, '钢墙挡住牵引，玩家停在墙前而不是被拖穿');
});

test('横扫激光：扫过目标列只结算一次，另一半场的玩家全程安全', () => {
  // 第 24 关 = 第 8 位 Boss（横扫解锁关）。
  const state = playingAt(77, 2, 24);
  state.level = createEmptyLevel();
  const boss = state.boss!;
  boss.x = 144;
  boss.y = 48; // 车体中心列 x=160
  const players = state.tanks.filter(isPlayerTank).sort((a, b) => a.playerIndex - b.playerIndex);
  players[0].x = 240; // 右半场：会被扫到
  players[0].y = 200;
  players[0].invulnTicks = 0;
  players[1].x = 40; // 左半场：始终安全
  players[1].y = 200;
  players[1].invulnTicks = 0;
  state.livesByPlayer[0] = 5;
  state.livesByPlayer[1] = 5;

  startBossAttack(state, boss, 'sweepLaser');
  // 扫向由 rng 选中的目标决定；本用例固定为向右，专测命中与去重。
  boss.sweepDir = 1;
  boss.sweepX = 160;
  boss.laserCols = [boss.sweepX];
  assert.equal(boss.windupTicks, BOSS_SWEEP_WARN_TICKS);

  for (let i = 0; i < BOSS_SWEEP_WARN_TICKS; i++) updateBoss(state);
  assert.equal(players[0].alive, true, '预警期间不伤人');
  assert.ok(boss.activeTicks > 0, '预警结束进入激活相');

  const maxTicks = Math.ceil(FIELD_WIDTH / BOSS_SWEEP_SPEED) + 10;
  for (let i = 0; i < maxTicks && boss.attack === 'sweepLaser'; i++) updateBoss(state);
  assert.equal(boss.attack, 'none', '扫完该半场即结束');
  assert.equal(players[0].alive, false, '右半场的玩家应被扫中');
  assert.equal(state.livesByPlayer[0], 4, '同一次横扫至多结算一次');
  assert.equal(players[1].alive, true, '左半场的玩家全程安全');
  assert.equal(state.livesByPlayer[1], 5);
  assert.equal(BOSS_LASER_WIDTH, 16);
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

  // 有水普通关维持原 5 种中立池。
  const normal = createGameState(1, 1, 7).neutralQueue;
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyInput } from '../src/core/types';
import {
  BOSS_STAGES,
  BOSS_SIZE,
  BOSS_X,
  BOSS_Y,
  BOSS_OWNER_ID,
  BOSS_LASER_WINDUP_TICKS,
  BOSS_LASER_ACTIVE_TICKS,
  BOSS_SPIN_BULLETS,
  BOSS_SPIN_WAVES,
  BOSS_SPIN_WAVE_INTERVAL_TICKS,
  BOSS_MINION_MAX,
  BOSS_MINION_INTERVAL_TICKS,
  BOSS_MINION_CARRIER_EVERY,
  BULLET_SIZE,
  FIELD_COLS,
  FIELD_ROWS,
  PLAYER_SPAWN_POINTS,
  STAGE_COUNT,
  SUBTILE,
  TANK_SIZE,
  isBossStage,
  bossMaxHp,
} from '../src/core/constants';
import { createGameState, nextStage, type GameState } from '../src/game/state';
import { update } from '../src/game/update';
import { updateBoss, resolveBulletBoss } from '../src/game/boss';
import { updateEnemies } from '../src/game/enemy';
import { isPlayerTank, type TankState } from '../src/game/tank';
import type { BulletState } from '../src/game/bullet';
import { Cell, getCell } from '../src/game/level';
import { STAGES } from '../src/game/levels';

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
    steelPiercing: false,
  };
}

function enemiesOnField(state: GameState): number {
  let n = 0;
  for (const s of state.spawning) if (!isPlayerTank(s.tank)) n++;
  for (const t of state.tanks) if (t.alive && !isPlayerTank(t)) n++;
  return n;
}

// ── 关卡序列 ──

test('12 关循环：第 6 / 12 关为 Boss 关，通关第 12 关回到第 1 关', () => {
  assert.equal(STAGE_COUNT, 12);
  assert.deepEqual([...BOSS_STAGES], [6, 12]);
  for (let stage = 1; stage <= STAGE_COUNT; stage++) {
    assert.equal(isBossStage(stage), stage === 6 || stage === 12, `第 ${stage} 关 isBossStage`);
  }
  // 回卷关号同样归一：第 13 关 = 第 1 关（普通），第 18 关 = 第 6 关（Boss）。
  assert.equal(isBossStage(13), false);
  assert.equal(isBossStage(18), true);

  const state = createGameState(1, 1, STAGE_COUNT);
  assert.ok(state.boss, '第 12 关应有 Boss');
  nextStage(state);
  assert.equal(state.stage, 1);
  assert.equal(state.boss, null, '回到第 1 关后 Boss 应清空');
});

test('Boss 竞技场：无鹰巢、Boss 空域留空、玩家出生位是空地', () => {
  for (const stage of BOSS_STAGES) {
    const level = STAGES[stage - 1];
    for (let row = 0; row < FIELD_ROWS; row++) {
      for (let col = 0; col < FIELD_COLS; col++) {
        assert.notEqual(getCell(level, col, row), Cell.EAGLE, `第 ${stage} 关不应有鹰巢`);
      }
    }
    // Boss 车体覆盖的子格必须全空（否则 Boss 会与地形重叠）。
    for (let row = BOSS_Y / SUBTILE; row < (BOSS_Y + BOSS_SIZE) / SUBTILE; row++) {
      for (let col = BOSS_X / SUBTILE; col < (BOSS_X + BOSS_SIZE) / SUBTILE; col++) {
        assert.equal(getCell(level, col, row), Cell.EMPTY, `第 ${stage} 关 Boss 空域 (${col},${row})`);
      }
    }
    for (const p of PLAYER_SPAWN_POINTS) {
      const col0 = p.x / SUBTILE;
      const row0 = p.y / SUBTILE;
      for (let row = row0; row <= row0 + 1; row++) {
        for (let col = col0; col <= col0 + 1; col++) {
          assert.equal(getCell(level, col, row), Cell.EMPTY, `第 ${stage} 关出生位 (${col},${row})`);
        }
      }
    }
  }
});

// ── Boss 生成 ──

test('Boss 只在 Boss 关生成，血量随人数放大', () => {
  assert.equal(createGameState(1, 1, 5).boss, null, '普通关不应有 Boss');
  assert.equal(createGameState(1, 1, 7).boss, null, '普通关不应有 Boss');

  const solo = createGameState(1, 1, 6).boss;
  assert.ok(solo);
  assert.equal(solo.hp, 100);
  assert.equal(solo.maxHp, 100);
  assert.equal(solo.phase, 1);
  assert.equal(solo.dead, false);
  assert.equal(solo.x, BOSS_X);
  assert.equal(solo.y, BOSS_Y);

  const trio = createGameState(1, 3, 6).boss;
  assert.ok(trio);
  assert.equal(trio.hp, 220); // 100 + 2×60
  assert.equal(bossMaxHp(4), 280);

  // 跨关进入 Boss 关时同样生成（第 11 关 → 第 12 关）。
  const state = createGameState(1, 2, 11);
  assert.equal(state.boss, null);
  nextStage(state);
  assert.equal(state.stage, 12);
  assert.equal(state.boss?.maxHp, 160);
});

// ── 伤害结算 ──

test('玩家弹对 Boss：普通弹 −1、激光 −2，且一律消亡；小兵弹被吸收不扣血', () => {
  const state = playingAt(11, 1, 6);
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
  const state = playingAt(12, 1, 6);
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
  const state = playingAt(13, 1, 6);
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
  const state = playingAt(21, 1, 6);
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
  const state = playingAt(22, 1, 6);
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

test('phase 2 的 16 向旋转弹幕：3 波、每波 16 发、波间 30 帧', () => {
  const state = playingAt(23, 1, 6);
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

  for (let i = 0; i < BOSS_SPIN_WAVE_INTERVAL_TICKS; i++) updateBoss(state); // 第三波
  assert.equal(state.bullets.length, BOSS_SPIN_BULLETS * BOSS_SPIN_WAVES);
  assert.equal(boss.attack, 'none', '三波打完应回到冷却');
});

// ── 小兵 ──

test('Boss 关小兵：场上至多 2 只、按间隔补充、每第 4 只携带道具', () => {
  const state = playingAt(31, 1, 6);
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
  assert.deepEqual(
    carriers,
    [false, false, false, true, false, false, false, true],
    `每第 ${BOSS_MINION_CARRIER_EVERY} 只小兵携带道具`,
  );

  // 场上数量上限：连续推进期间敌军（含出生闪光）不得超过 2。
  const run = playingAt(32, 1, 6);
  let peak = 0;
  for (let i = 0; i < 1500; i++) {
    update(run, noInputs(1));
    peak = Math.max(peak, enemiesOnField(run));
  }
  assert.ok(peak > 0, '推进 1500 帧后应已补充过小兵');
  assert.ok(peak <= BOSS_MINION_MAX, `场上小兵峰值 ${peak} 超过上限 ${BOSS_MINION_MAX}`);
});

test('Boss 关 B（最终战）的小兵为 power / smart', () => {
  const state = playingAt(33, 1, 12);
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
    const state = createGameState(2024, 1, 6);
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

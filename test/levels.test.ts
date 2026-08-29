import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FIELD_COLS,
  FIELD_ROWS,
  FIELD_HEIGHT,
  PLAYER_SPAWN_POINTS,
  STAGE_COUNT,
  STAGE_CYCLE,
  STAGE_GROUP_COUNT,
  BOSS_STAGES,
  STAGE_ENEMY_MIX,
  STAGE_ENEMY_TOTAL,
  SUBTILE,
  TANK_SIZE,
  BOSS_X,
  BOSS_Y,
  BOSS_SIZE,
  ENEMY_SPAWN_INTERVAL_MIN,
  enemySpawnIntervalForStage,
  normalizeStage,
  stageGroup,
  stageKind,
} from '../src/core/constants';
import { Cell, LevelState, getCell, isSolidForTank } from '../src/game/level';
import { BOSS_ARENAS, STAGES, bossArenaForStage, normalLevelForStage } from '../src/game/levels';

// 全部 40×30 战场原型：十张普通图 + 两张 Boss 竞技场（护送关是 80×90 世界，另见 escort.test.ts）。
const ARENAS: Array<{ name: string; level: LevelState }> = [
  ...STAGES.map((level, i) => ({ name: `普通图 ${i + 1}（第 ${i * STAGE_CYCLE + 1} 关）`, level })),
  ...BOSS_ARENAS.map((level, i) => ({ name: `Boss 竞技场 ${'AB'[i]}`, level })),
];

// 敌军出生只取上半场（y ≤ FIELD_HEIGHT/2 − TANK_SIZE，见 enemy.ts pickSpawnSpot）。
const UPPER_ROWS = FIELD_HEIGHT / 2 / SUBTILE; // 15：子格行 0..14
const UPPER_SPAWN_ROW_MAX = (FIELD_HEIGHT / 2 - TANK_SIZE) / SUBTILE; // 13：16px 车体左上角所在行上限

// 16×16 坦克能否整个落在子格 (col,row) 处（占 2×2 子格，全部对坦克可通行）。
function tankFits(level: LevelState, col: number, row: number): boolean {
  if (col < 0 || row < 0 || col > FIELD_COLS - 2 || row > FIELD_ROWS - 2) return false;
  for (let r = row; r <= row + 1; r++) {
    for (let c = col; c <= col + 1; c++) {
      if (isSolidForTank(getCell(level, c, r))) return false;
    }
  }
  return true;
}

// 从四个玩家出生点出发做 BFS（步长一个子格），返回全部可达的坦克落位。
function reachableFromSpawns(level: LevelState): Set<number> {
  const key = (col: number, row: number): number => row * FIELD_COLS + col;
  const seen = new Set<number>();
  const queue: Array<[number, number]> = [];
  for (const p of PLAYER_SPAWN_POINTS) {
    const col = p.x / SUBTILE;
    const row = p.y / SUBTILE;
    if (!tankFits(level, col, row) || seen.has(key(col, row))) continue;
    seen.add(key(col, row));
    queue.push([col, row]);
  }
  for (let head = 0; head < queue.length; head++) {
    const [col, row] = queue[head];
    for (const [dc, dr] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nc = col + dc;
      const nr = row + dr;
      if (seen.has(key(nc, nr)) || !tankFits(level, nc, nr)) continue;
      seen.add(key(nc, nr));
      queue.push([nc, nr]);
    }
  }
  return seen;
}

test('三段循环：30 关、10 张普通图 + 2 张 Boss 竞技场，全部被 parseLevel 解析成 40×30', () => {
  assert.equal(STAGE_COUNT, 30);
  assert.equal(STAGE_CYCLE, 3);
  assert.equal(STAGE_GROUP_COUNT, 10);
  assert.equal(STAGES.length, STAGE_GROUP_COUNT);
  assert.equal(BOSS_ARENAS.length, 2);
  assert.deepEqual([...BOSS_STAGES], [3, 6, 9, 12, 15, 18, 21, 24, 27, 30]);
  for (const { name, level } of ARENAS) {
    assert.equal(level.cols, FIELD_COLS, `${name} 列数`);
    assert.equal(level.rows, FIELD_ROWS, `${name} 行数`);
    assert.equal(level.cells.length, FIELD_COLS * FIELD_ROWS, `${name} 格数`);
  }
});

test('普通图按组号取，Boss 竞技场按组号奇偶交替取 A/B', () => {
  for (let t = 1; t <= STAGE_GROUP_COUNT; t++) {
    const normalStage = t * STAGE_CYCLE - 2;
    const bossStage = t * STAGE_CYCLE;
    assert.equal(stageKind(normalStage), 'normal', `第 ${normalStage} 关应为普通关`);
    assert.equal(stageKind(bossStage), 'boss', `第 ${bossStage} 关应为 Boss 关`);
    assert.equal(stageGroup(normalStage), t);
    assert.equal(stageGroup(bossStage), t);
    assert.equal(normalLevelForStage(normalStage), STAGES[t - 1], `第 ${normalStage} 关取第 ${t} 张图`);
    assert.equal(
      bossArenaForStage(bossStage),
      BOSS_ARENAS[t % 2 === 1 ? 0 : 1],
      `第 ${bossStage} 关竞技场 ${t % 2 === 1 ? 'A' : 'B'}`,
    );
  }
  // 回卷关号同样归一：第 31 关 = 第 1 关。
  assert.equal(normalLevelForStage(STAGE_COUNT + 1), STAGES[0]);
  assert.equal(bossArenaForStage(STAGE_COUNT + STAGE_CYCLE), BOSS_ARENAS[0]);
});

test('每张普通图都有位于底部正中的 2×2 鹰巢', () => {
  for (let i = 0; i < STAGES.length; i++) {
    const level = STAGES[i];
    let eagleCells = 0;
    for (let row = 0; row < FIELD_ROWS; row++) {
      for (let col = 0; col < FIELD_COLS; col++) {
        if (getCell(level, col, row) === Cell.EAGLE) eagleCells++;
      }
    }
    assert.equal(eagleCells, 4, `第 ${i + 1} 张图鹰巢格数`);
    for (const [col, row] of [
      [19, 28],
      [20, 28],
      [19, 29],
      [20, 29],
    ]) {
      assert.equal(getCell(level, col, row), Cell.EAGLE, `第 ${i + 1} 张图 (${col},${row}) 不是鹰巢`);
    }
  }
});

test('Boss 竞技场没有鹰巢、留出 Boss 初始空域、且下半场有掩体', () => {
  for (let i = 0; i < BOSS_ARENAS.length; i++) {
    const level = BOSS_ARENAS[i];
    const stage = `竞技场 ${'AB'[i]}`;
    // 1) 全图不得出现任何鹰巢格。
    for (let row = 0; row < FIELD_ROWS; row++) {
      for (let col = 0; col < FIELD_COLS; col++) {
        assert.notEqual(getCell(level, col, row), Cell.EAGLE, `${stage} (${col},${row}) 出现鹰巢`);
      }
    }
    // 2) Boss 车体（cols 17–22 / rows 6–11）及其一格外扩边距必须全空。
    const c0 = BOSS_X / SUBTILE;
    const r0 = BOSS_Y / SUBTILE;
    const c1 = (BOSS_X + BOSS_SIZE) / SUBTILE - 1;
    const r1 = (BOSS_Y + BOSS_SIZE) / SUBTILE - 1;
    for (let row = r0 - 1; row <= r1 + 1; row++) {
      for (let col = c0 - 1; col <= c1 + 1; col++) {
        assert.equal(
          getCell(level, col, row),
          Cell.EMPTY,
          `${stage} Boss 空域 (${col},${row}) 被占`,
        );
      }
    }
    // 3) 下半场（rows 15..29）必须存在掩体，否则弹幕无处可躲。
    let cover = 0;
    for (let row = FIELD_ROWS / 2; row < FIELD_ROWS; row++) {
      for (let col = 0; col < FIELD_COLS; col++) {
        const cell = getCell(level, col, row);
        if (cell === Cell.BRICK || cell === Cell.STEEL) cover++;
      }
    }
    assert.ok(cover >= 40, `${stage} 下半场掩体仅 ${cover} 格`);
  }
  // 竞技场 B（最终战所用）的掩体应严格少于竞技场 A。
  const coverOf = (level: LevelState): number => {
    let n = 0;
    for (let row = FIELD_ROWS / 2; row < FIELD_ROWS; row++) {
      for (let col = 0; col < FIELD_COLS; col++) {
        const cell = getCell(level, col, row);
        if (cell === Cell.BRICK || cell === Cell.STEEL) n++;
      }
    }
    return n;
  };
  assert.ok(coverOf(BOSS_ARENAS[1]) < coverOf(BOSS_ARENAS[0]), '竞技场 B 的掩体应比 A 更少');
});

test('每张 40×30 战场的四个玩家出生位都是空地', () => {
  for (const { name, level } of ARENAS) {
    for (const p of PLAYER_SPAWN_POINTS) {
      const col0 = p.x / SUBTILE;
      const row0 = p.y / SUBTILE;
      for (let row = row0; row <= row0 + 1; row++) {
        for (let col = col0; col <= col0 + 1; col++) {
          assert.equal(getCell(level, col, row), Cell.EMPTY, `${name} 出生位 (${col},${row}) 被占`);
        }
      }
    }
  }
});

test('每张 40×30 战场上半场的空格占比 ≥15%（保证敌军随机出生有落点）', () => {
  for (const { name, level } of ARENAS) {
    let empty = 0;
    for (let row = 0; row < UPPER_ROWS; row++) {
      for (let col = 0; col < FIELD_COLS; col++) {
        if (getCell(level, col, row) === Cell.EMPTY) empty++;
      }
    }
    const ratio = empty / (UPPER_ROWS * FIELD_COLS);
    assert.ok(ratio >= 0.15, `${name} 上半场空格仅 ${(ratio * 100).toFixed(1)}%`);
  }
});

test('每张 40×30 战场都连通：上半场每个可站位都能从玩家出生点走到（不会把敌军困死）', () => {
  for (const { name, level } of ARENAS) {
    const reachable = reachableFromSpawns(level);
    let free = 0;
    let reached = 0;
    const orphans: string[] = [];
    for (let row = 0; row <= UPPER_SPAWN_ROW_MAX; row++) {
      for (let col = 0; col <= FIELD_COLS - 2; col++) {
        if (!tankFits(level, col, row)) continue;
        free++;
        if (reachable.has(row * FIELD_COLS + col)) reached++;
        else orphans.push(`(${col},${row})`);
      }
    }
    assert.ok(free > 0, `${name} 上半场没有任何可站位`);
    assert.equal(reached, free, `${name} 上半场有死袋：${orphans.slice(0, 8).join(' ')}`);
  }
});

test('STAGE_ENEMY_MIX：十档编成总数一致，硬骨头随组号单调不减', () => {
  assert.equal(STAGE_ENEMY_MIX.length, STAGE_GROUP_COUNT);
  const hardOf = (i: number): number =>
    STAGE_ENEMY_MIX[i]
      .filter((m) => m.kind === 'power' || m.kind === 'armor')
      .reduce((sum, m) => sum + m.count, 0);

  let prevHard = -1;
  for (let i = 0; i < STAGE_ENEMY_MIX.length; i++) {
    const mix = STAGE_ENEMY_MIX[i];
    assert.ok(mix.length > 0, `第 ${i + 1} 组编成不应为空`);
    const total = mix.reduce((sum, m) => sum + m.count, 0);
    assert.equal(total, STAGE_ENEMY_TOTAL, `第 ${i + 1} 组敌军总数`);
    for (const m of mix) assert.ok(m.count > 0, `第 ${i + 1} 组不应写入 count=0 的编成项`);
    const hard = hardOf(i);
    assert.ok(hard >= prevHard, `第 ${i + 1} 组威力+装甲 ${hard} 低于上一组 ${prevHard}`);
    prevHard = hard;
  }

  // 最后一组（第 10 组 = 第 28 关）必须是硬骨头最多的一档。
  const lastHard = hardOf(STAGE_ENEMY_MIX.length - 1);
  for (let i = 0; i < STAGE_ENEMY_MIX.length - 1; i++) {
    assert.ok(lastHard > hardOf(i), `第 10 组威力+装甲应严格多于第 ${i + 1} 组`);
  }
});

test('stageKind：1..30 严格按普通 → 护送 → Boss 循环，第 30 关后回卷第 1 关', () => {
  const sequence = Array.from({ length: STAGE_COUNT }, (_, i) => stageKind(i + 1));
  const expected = Array.from({ length: STAGE_COUNT }, (_, i) => {
    const slot = (i + 1) % STAGE_CYCLE;
    return slot === 1 ? 'normal' : slot === 2 ? 'escort' : 'boss';
  });
  assert.deepEqual(sequence, expected);
  assert.deepEqual(sequence.slice(0, 6), [
    'normal',
    'escort',
    'boss',
    'normal',
    'escort',
    'boss',
  ]);
  assert.equal(sequence.filter((k) => k === 'normal').length, STAGE_GROUP_COUNT);
  assert.equal(sequence.filter((k) => k === 'escort').length, STAGE_GROUP_COUNT);
  assert.equal(sequence.filter((k) => k === 'boss').length, STAGE_GROUP_COUNT);
  assert.equal(sequence[STAGE_COUNT - 1], 'boss', '第 30 关是最终战');

  // 回卷：第 31 关 = 第 1 关，第 60 关 = 第 30 关；组号一并归一。
  for (let stage = 1; stage <= STAGE_COUNT; stage++) {
    assert.equal(normalizeStage(stage + STAGE_COUNT), stage);
    assert.equal(stageKind(stage + STAGE_COUNT), stageKind(stage), `第 ${stage + 30} 关类型`);
    assert.equal(stageGroup(stage + STAGE_COUNT), stageGroup(stage), `第 ${stage + 30} 关组号`);
  }
  assert.equal(stageKind(STAGE_COUNT + 1), 'normal');
  assert.equal(stageGroup(STAGE_COUNT + 1), 1);
});

test('敌军出生间隔随关号单调不增，且不低于下限', () => {
  let prev = Infinity;
  for (let stage = 1; stage <= STAGE_COUNT; stage++) {
    const interval = enemySpawnIntervalForStage(stage);
    assert.ok(interval <= prev, `第 ${stage} 关出生间隔 ${interval} 比上一关还长`);
    assert.ok(
      interval >= ENEMY_SPAWN_INTERVAL_MIN,
      `第 ${stage} 关出生间隔 ${interval} 低于下限`,
    );
    prev = interval;
  }
  assert.equal(enemySpawnIntervalForStage(1), 190);
  assert.equal(enemySpawnIntervalForStage(10), ENEMY_SPAWN_INTERVAL_MIN);
  assert.equal(enemySpawnIntervalForStage(STAGE_COUNT), ENEMY_SPAWN_INTERVAL_MIN);
});

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
  SUBTILE,
  TANK_SIZE,
  normalizeStage,
  stageGroup,
  stageKind,
} from '../src/core/constants';
import { LevelState, getCell, isSolidForTank } from '../src/game/level';
import { BOSS_ARENAS, STAGES } from '../src/game/levels';

// 全部 40×30 战场原型：十张普通图 + 十张 Boss 竞技场（护送关是 80×90 世界，另见 escort.test.ts）。
const ARENAS: Array<{ name: string; level: LevelState }> = [
  ...STAGES.map((level, i) => ({ name: `普通图 ${i + 1}（第 ${i * STAGE_CYCLE + 1} 关）`, level })),
  ...BOSS_ARENAS.map((level, i) => ({
    name: `Boss 竞技场 ${i + 1}（第 ${(i + 1) * STAGE_CYCLE} 关）`,
    level,
  })),
];

// 敌军出生只取上半场（y ≤ FIELD_HEIGHT/2 − TANK_SIZE，见 enemy.ts pickSpawnSpot）。
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

test('三段循环：30 关、10 张普通图 + 10 张 Boss 竞技场，全部被 parseLevel 解析成 40×30', () => {
  assert.equal(STAGE_COUNT, 30);
  assert.equal(STAGE_CYCLE, 3);
  assert.equal(STAGE_GROUP_COUNT, 10);
  assert.equal(STAGES.length, STAGE_GROUP_COUNT);
  assert.equal(BOSS_ARENAS.length, STAGE_GROUP_COUNT);
  assert.deepEqual([...BOSS_STAGES], [3, 6, 9, 12, 15, 18, 21, 24, 27, 30]);
  for (const { name, level } of ARENAS) {
    assert.equal(level.cols, FIELD_COLS, `${name} 列数`);
    assert.equal(level.rows, FIELD_ROWS, `${name} 行数`);
    assert.equal(level.cells.length, FIELD_COLS * FIELD_ROWS, `${name} 格数`);
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

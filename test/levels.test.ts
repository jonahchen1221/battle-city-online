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
import { Cell, LevelState, getCell, isSolidForTank } from '../src/game/level';
import {
  BOSS_ARENAS,
  BOSS_ARENA_CONFIGS,
  STAGES,
  VERSUS_ARENAS,
} from '../src/game/levels';

// 全部 40×30 战场原型：普通图 + Boss 竞技场 + 对战图（护送关是 80×90 世界）。
const ARENAS: Array<{ name: string; level: LevelState }> = [
  ...STAGES.map((level, i) => ({ name: `普通图 ${i + 1}（第 ${i * STAGE_CYCLE + 1} 关）`, level })),
  ...BOSS_ARENAS.map((level, i) => ({
    name: `Boss 竞技场 ${i + 1}（第 ${i * STAGE_CYCLE + 3} 关）`,
    level,
  })),
  ...VERSUS_ARENAS.map((level, i) => ({
    name: `对战竞技场 ${i + 1}`,
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
function reachableFromSpawns(
  level: LevelState,
  spawns: ReadonlyArray<{ x: number; y: number }> = PLAYER_SPAWN_POINTS,
): Set<number> {
  const key = (col: number, row: number): number => row * FIELD_COLS + col;
  const seen = new Set<number>();
  const queue: Array<[number, number]> = [];
  for (const p of spawns) {
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

// Boss 的 A* 把砖视为高代价可破坏地形，仅钢、水、鹰巢和边界是永久阻挡。
function bossFits(level: LevelState, col: number, row: number): boolean {
  if (col < 0 || row < 0 || col > FIELD_COLS - 4 || row > FIELD_ROWS - 4) return false;
  for (let r = row; r < row + 4; r++) {
    for (let c = col; c < col + 4; c++) {
      const cell = getCell(level, c, r);
      if (cell === Cell.STEEL || cell === Cell.WATER || cell === Cell.EAGLE) return false;
    }
  }
  return true;
}

function reachableFromBossSpawn(
  level: LevelState,
  spawn: { x: number; y: number },
): Set<number> {
  const cols = FIELD_COLS - 3;
  const key = (col: number, row: number): number => row * cols + col;
  const startCol = spawn.x / SUBTILE;
  const startRow = spawn.y / SUBTILE;
  const seen = new Set<number>([key(startCol, startRow)]);
  const queue: Array<[number, number]> = [[startCol, startRow]];
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
      if (seen.has(key(nc, nr)) || !bossFits(level, nc, nr)) continue;
      seen.add(key(nc, nr));
      queue.push([nc, nr]);
    }
  }
  return seen;
}

test('四段循环：40 关、10 张普通图 + 10 张 Boss 图 + 6 张对战图', () => {
  assert.equal(STAGE_COUNT, 40);
  assert.equal(STAGE_CYCLE, 4);
  assert.equal(STAGE_GROUP_COUNT, 10);
  assert.equal(STAGES.length, STAGE_GROUP_COUNT);
  assert.equal(BOSS_ARENAS.length, STAGE_GROUP_COUNT);
  assert.equal(VERSUS_ARENAS.length, 6);
  assert.deepEqual([...BOSS_STAGES], [3, 7, 11, 15, 19, 23, 27, 31, 35, 39]);
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

test('Boss 竞技场使用不同构图，且配置中的玩家与 32px Boss 入场区均有效', () => {
  let symmetricArenas = 0;
  for (let i = 0; i < BOSS_ARENAS.length; i++) {
    const level = BOSS_ARENAS[i];
    const config = BOSS_ARENA_CONFIGS[i];

    let symmetric = true;
    for (let row = 0; row < FIELD_ROWS && symmetric; row++) {
      for (let col = 0; col < FIELD_COLS / 2; col++) {
        if (getCell(level, col, row) !== getCell(level, FIELD_COLS - 1 - col, row)) {
          symmetric = false;
          break;
        }
      }
    }
    if (symmetric) symmetricArenas++;

    for (const [playerIndex, spawn] of config.playerSpawns.entries()) {
      assert.equal(
        tankFits(level, spawn.x / SUBTILE, spawn.y / SUBTILE),
        true,
        `Boss 图 ${i + 1} 的 ${playerIndex + 1}P 配置出生点必须可站立`,
      );
      assert.equal(
        tankFits(level, spawn.x / SUBTILE, spawn.y / SUBTILE - 2),
        true,
        `Boss 图 ${i + 1} 的 ${playerIndex + 1}P 前方必须能投放 MVP 奖励`,
      );
    }
    const playerReachable = reachableFromSpawns(level, [config.playerSpawns[0]]);
    for (const spawn of config.playerSpawns) {
      assert.ok(
        playerReachable.has((spawn.y / SUBTILE) * FIELD_COLS + spawn.x / SUBTILE),
        `Boss 图 ${i + 1} 的玩家出生席必须处于同一可达区域`,
      );
    }

    const bossCol = config.bossSpawn.x / SUBTILE;
    const bossRow = config.bossSpawn.y / SUBTILE;
    for (let row = bossRow; row < bossRow + 4; row++) {
      for (let col = bossCol; col < bossCol + 4; col++) {
        const cell = getCell(level, col, row);
        assert.notEqual(cell, Cell.STEEL, `Boss 图 ${i + 1} Boss 入场区不可含钢`);
        assert.notEqual(cell, Cell.WATER, `Boss 图 ${i + 1} Boss 入场区不可含水`);
        assert.notEqual(cell, Cell.EAGLE, `Boss 图 ${i + 1} Boss 入场区不可含鹰巢`);
      }
    }
    const bossReachable = reachableFromBossSpawn(level, config.bossSpawn);
    const bossNavCols = FIELD_COLS - 3;
    const reaches = (predicate: (col: number, row: number) => boolean): boolean =>
      [...bossReachable].some((position) =>
        predicate(position % bossNavCols, (position / bossNavCols) | 0),
      );
    assert.ok(reaches((col) => col <= 2), `Boss 图 ${i + 1} 的 32px Boss 到不了左翼`);
    assert.ok(reaches((col) => col >= FIELD_COLS - 6), `Boss 图 ${i + 1} 的 32px Boss 到不了右翼`);
    assert.ok(reaches((_col, row) => row >= FIELD_ROWS - 6), `Boss 图 ${i + 1} 的 Boss 到不了下半场`);
  }
  assert.ok(symmetricArenas <= 3, `完整左右镜像竞技场过多：${symmetricArenas}`);
});

test('相邻 Boss 竞技场的地形与阻挡轮廓保持足够差异', () => {
  for (let i = 0; i < BOSS_ARENAS.length - 1; i++) {
    const a = BOSS_ARENAS[i];
    const b = BOSS_ARENAS[i + 1];
    let exact = 0;
    let solidIntersection = 0;
    let solidUnion = 0;
    for (let cell = 0; cell < a.cells.length; cell++) {
      if (a.cells[cell] === b.cells[cell]) exact++;
      const aSolid = isSolidForTank(a.cells[cell]);
      const bSolid = isSolidForTank(b.cells[cell]);
      if (aSolid && bSolid) solidIntersection++;
      if (aSolid || bSolid) solidUnion++;
    }
    const exactRatio = exact / a.cells.length;
    const solidJaccard = solidIntersection / solidUnion;
    assert.ok(exactRatio < 0.85, `Boss 图 ${i + 1}/${i + 2} 逐格过于相似：${exactRatio}`);
    assert.ok(
      solidJaccard < 0.65,
      `Boss 图 ${i + 1}/${i + 2} 阻挡轮廓过于相似：${solidJaccard}`,
    );
  }
});

test('六张对战竞技场均无鹰巢，上下双方出生席位全部可站立', () => {
  const enemySpawnCols = [0, 13, 25, 38];
  for (let i = 0; i < VERSUS_ARENAS.length; i++) {
    const level = VERSUS_ARENAS[i];
    assert.equal(level.cells.includes(Cell.EAGLE), false, `对战图 ${i + 1} 不应有鹰巢`);
    for (const col of enemySpawnCols) {
      assert.equal(tankFits(level, col, 0), true, `对战图 ${i + 1} AI 出生席 ${col}`);
    }
    for (const spawn of PLAYER_SPAWN_POINTS) {
      assert.equal(
        tankFits(level, spawn.x / SUBTILE, spawn.y / SUBTILE),
        true,
        `对战图 ${i + 1} 玩家出生席`,
      );
    }
  }
});

test('stageKind：1..40 严格按普通 → 护送 → Boss → 对战循环', () => {
  const sequence = Array.from({ length: STAGE_COUNT }, (_, i) => stageKind(i + 1));
  const expected = Array.from({ length: STAGE_COUNT }, (_, i) => {
    const slot = (i + 1) % STAGE_CYCLE;
    return slot === 1 ? 'normal' : slot === 2 ? 'escort' : slot === 3 ? 'boss' : 'versus';
  });
  assert.deepEqual(sequence, expected);
  assert.deepEqual(sequence.slice(0, 8), [
    'normal',
    'escort',
    'boss',
    'versus',
    'normal',
    'escort',
    'boss',
    'versus',
  ]);
  assert.equal(sequence.filter((k) => k === 'normal').length, STAGE_GROUP_COUNT);
  assert.equal(sequence.filter((k) => k === 'escort').length, STAGE_GROUP_COUNT);
  assert.equal(sequence.filter((k) => k === 'boss').length, STAGE_GROUP_COUNT);
  assert.equal(sequence.filter((k) => k === 'versus').length, STAGE_GROUP_COUNT);
  assert.equal(sequence[STAGE_COUNT - 1], 'versus', '第 40 关是对战');

  // 回卷：第 41 关 = 第 1 关；组号一并归一。
  for (let stage = 1; stage <= STAGE_COUNT; stage++) {
    assert.equal(normalizeStage(stage + STAGE_COUNT), stage);
    assert.equal(stageKind(stage + STAGE_COUNT), stageKind(stage), `第 ${stage + STAGE_COUNT} 关类型`);
    assert.equal(stageGroup(stage + STAGE_COUNT), stageGroup(stage), `第 ${stage + STAGE_COUNT} 关组号`);
  }
  assert.equal(stageKind(STAGE_COUNT + 1), 'normal');
  assert.equal(stageGroup(STAGE_COUNT + 1), 1);
});

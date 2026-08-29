import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FIELD_COLS,
  FIELD_ROWS,
  FIELD_HEIGHT,
  PLAYER_SPAWN_POINTS,
  STAGE_COUNT,
  BOSS_STAGES,
  isBossStage,
  STAGE_ENEMY_MIX,
  STAGE_ENEMY_TOTAL,
  SUBTILE,
  TANK_SIZE,
  BOSS_X,
  BOSS_Y,
  BOSS_SIZE,
  ENEMY_SPAWN_INTERVAL_MIN,
  enemySpawnIntervalForStage,
} from '../src/core/constants';
import { Cell, LevelState, getCell, isSolidForTank } from '../src/game/level';
import { STAGES } from '../src/game/levels';

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

test('STAGES 覆盖 STAGE_COUNT 关，且每关都被 parseLevel 成功解析成 40×30', () => {
  assert.equal(STAGES.length, STAGE_COUNT);
  // 12 关循环：Boss A（1）→ 普通关 2–5 → Boss A（6）→ 普通关 7–11 → Boss B（12，最终战）。
  assert.equal(STAGE_COUNT, 12);
  assert.deepEqual([...BOSS_STAGES], [1, 6, 12]);
  for (let i = 0; i < STAGES.length; i++) {
    const level = STAGES[i];
    assert.equal(level.cols, FIELD_COLS, `第 ${i + 1} 关列数`);
    assert.equal(level.rows, FIELD_ROWS, `第 ${i + 1} 关行数`);
    assert.equal(level.cells.length, FIELD_COLS * FIELD_ROWS, `第 ${i + 1} 关格数`);
  }
});

test('每个普通关都有位于底部正中的 2×2 鹰巢', () => {
  for (let i = 0; i < STAGES.length; i++) {
    // Boss 关分流：竞技场没有鹰巢（过关条件是击杀 Boss），单独在下一条用例校验。
    if (isBossStage(i + 1)) continue;
    const level = STAGES[i];
    let eagleCells = 0;
    for (let row = 0; row < FIELD_ROWS; row++) {
      for (let col = 0; col < FIELD_COLS; col++) {
        if (getCell(level, col, row) === Cell.EAGLE) eagleCells++;
      }
    }
    assert.equal(eagleCells, 4, `第 ${i + 1} 关鹰巢格数`);
    for (const [col, row] of [
      [19, 28],
      [20, 28],
      [19, 29],
      [20, 29],
    ]) {
      assert.equal(getCell(level, col, row), Cell.EAGLE, `第 ${i + 1} 关 (${col},${row}) 不是鹰巢`);
    }
  }
});

test('Boss 关没有鹰巢、留出 Boss 初始空域、且下半场有掩体', () => {
  for (const stage of BOSS_STAGES) {
    const level = STAGES[stage - 1];
    // 1) 全图不得出现任何鹰巢格。
    for (let row = 0; row < FIELD_ROWS; row++) {
      for (let col = 0; col < FIELD_COLS; col++) {
        assert.notEqual(getCell(level, col, row), Cell.EAGLE, `第 ${stage} 关 (${col},${row}) 出现鹰巢`);
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
          `第 ${stage} 关 Boss 空域 (${col},${row}) 被占`,
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
    assert.ok(cover >= 40, `第 ${stage} 关下半场掩体仅 ${cover} 格`);
  }
  // Boss 关 B（最终战）的掩体应严格少于 Boss 关 A。
  const coverOf = (stage: number): number => {
    const level = STAGES[stage - 1];
    let n = 0;
    for (let row = FIELD_ROWS / 2; row < FIELD_ROWS; row++) {
      for (let col = 0; col < FIELD_COLS; col++) {
        const cell = getCell(level, col, row);
        if (cell === Cell.BRICK || cell === Cell.STEEL) n++;
      }
    }
    return n;
  };
  assert.ok(coverOf(12) < coverOf(6), 'Boss 关 B 的掩体应比 Boss 关 A 更少');
});

test('每关的四个玩家出生位都是空地', () => {
  for (let i = 0; i < STAGES.length; i++) {
    const level = STAGES[i];
    for (const p of PLAYER_SPAWN_POINTS) {
      const col0 = p.x / SUBTILE;
      const row0 = p.y / SUBTILE;
      for (let row = row0; row <= row0 + 1; row++) {
        for (let col = col0; col <= col0 + 1; col++) {
          assert.equal(
            getCell(level, col, row),
            Cell.EMPTY,
            `第 ${i + 1} 关出生位 (${col},${row}) 被占`,
          );
        }
      }
    }
  }
});

test('每关上半场的空格占比 ≥15%（保证敌军随机出生有落点）', () => {
  for (let i = 0; i < STAGES.length; i++) {
    const level = STAGES[i];
    let empty = 0;
    for (let row = 0; row < UPPER_ROWS; row++) {
      for (let col = 0; col < FIELD_COLS; col++) {
        if (getCell(level, col, row) === Cell.EMPTY) empty++;
      }
    }
    const ratio = empty / (UPPER_ROWS * FIELD_COLS);
    assert.ok(ratio >= 0.15, `第 ${i + 1} 关上半场空格仅 ${(ratio * 100).toFixed(1)}%`);
  }
});

test('每关都连通：上半场每个可站位都能从玩家出生点走到（不会把敌军困死）', () => {
  for (let i = 0; i < STAGES.length; i++) {
    const level = STAGES[i];
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
    assert.ok(free > 0, `第 ${i + 1} 关上半场没有任何可站位`);
    assert.equal(reached, free, `第 ${i + 1} 关上半场有死袋：${orphans.slice(0, 8).join(' ')}`);
  }
});

test('STAGE_ENEMY_MIX：普通关总数一致，Boss 关为空编成，硬骨头随关号单调不减', () => {
  assert.equal(STAGE_ENEMY_MIX.length, STAGE_COUNT);
  const hardOf = (i: number): number =>
    STAGE_ENEMY_MIX[i]
      .filter((m) => m.kind === 'power' || m.kind === 'armor')
      .reduce((sum, m) => sum + m.count, 0);

  let prevHard = -1;
  for (let i = 0; i < STAGE_ENEMY_MIX.length; i++) {
    const mix = STAGE_ENEMY_MIX[i];
    // Boss 关不走有限队列：编成必须为空数组（小兵由 Boss 逻辑无限补充）。
    if (isBossStage(i + 1)) {
      assert.equal(mix.length, 0, `第 ${i + 1} 关（Boss 关）编成应为空`);
      continue;
    }
    const total = mix.reduce((sum, m) => sum + m.count, 0);
    assert.equal(total, STAGE_ENEMY_TOTAL, `第 ${i + 1} 关敌军总数`);
    for (const m of mix) assert.ok(m.count > 0, `第 ${i + 1} 关不应写入 count=0 的编成项`);
    const hard = hardOf(i);
    assert.ok(hard >= prevHard, `第 ${i + 1} 关威力+装甲 ${hard} 低于上一关 ${prevHard}`);
    prevHard = hard;
  }

  // 最后一个普通关（第 11 关）必须是硬骨头最多的一关。
  let lastNormal = STAGE_ENEMY_MIX.length - 1;
  while (lastNormal > 0 && isBossStage(lastNormal + 1)) lastNormal--; // 索引 10 = 第 11 关
  const lastHard = hardOf(lastNormal);
  for (let i = 0; i < lastNormal; i++) {
    if (isBossStage(i + 1)) continue;
    assert.ok(lastHard > hardOf(i), `第 11 关威力+装甲应严格多于第 ${i + 1} 关`);
  }
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

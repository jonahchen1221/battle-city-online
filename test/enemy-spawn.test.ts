import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameState } from '../src/game/state';
import { updateEnemies } from '../src/game/enemy';
import { canTankOccupy, isPlayerTank } from '../src/game/tank';
import { FIELD_HEIGHT, FIELD_WIDTH, SUBTILE, TANK_SIZE } from '../src/core/constants';

// 驱动生成器直至攒够 count 台敌军闪光，返回各自的出生坐标。
function collectSpawns(seed: number, count: number): Array<{ x: number; y: number }> {
  const state = createGameState(seed, 1, 2); // 普通关；第 1 关暂作护送测试关
  state.phase = 'playing';
  state.enemyFreezeTicks = 0;
  const spots: Array<{ x: number; y: number }> = [];
  const seen = new Set<number>();
  for (let i = 0; i < 5000 && spots.length < count; i++) {
    updateEnemies(state, state.level);
    for (const s of state.spawning) {
      if (isPlayerTank(s.tank) || seen.has(s.tank.id)) continue;
      seen.add(s.tank.id);
      spots.push({ x: s.tank.x, y: s.tank.y });
    }
    // 让闪光立即完结、腾出场上名额，同时把实体化的敌人清走避免占位干扰后续判定。
    state.spawning = [];
    state.tanks = state.tanks.filter((t) => isPlayerTank(t));
  }
  return spots;
}

test('enemy spawns land on random valid spots in the upper half', () => {
  const spots = collectSpawns(20260829, 12);
  assert.equal(spots.length, 12);
  const state = createGameState(20260829, 1, 2); // 同 seed 的普通关地形
  for (const p of spots) {
    // 上半场 + 子格对齐 + 场内。
    assert.ok(p.y <= FIELD_HEIGHT / 2 - TANK_SIZE, `y=${p.y} 超出上半场`);
    assert.ok(p.x >= 0 && p.x <= FIELD_WIDTH - TANK_SIZE);
    assert.equal(p.x % SUBTILE, 0);
    assert.equal(p.y % SUBTILE, 0);
    // 落点对坦克可通行（空场校验地形即可）。
    const probe = { ...state.tanks[0], playerIndex: -1, x: p.x, y: p.y };
    assert.ok(canTankOccupy(probe, p.x, p.y, state.level, []), `(${p.x},${p.y}) 不可通行`);
  }
  // 随机性：12 次出生不应全落在同一点（旧行为是 3 点轮转，新行为应更分散）。
  const distinct = new Set(spots.map((p) => `${p.x},${p.y}`));
  assert.ok(distinct.size >= 6, `落点过于集中：${distinct.size} 种`);
});

test('spawn is deterministic for the same seed', () => {
  assert.deepEqual(collectSpawns(7, 6), collectSpawns(7, 6));
});

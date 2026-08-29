import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameState } from '../src/game/state';
import { updateEnemies } from '../src/game/enemy';
import { isPlayerTank } from '../src/game/tank';

// 驱动生成器直至攒够 count 台敌军闪光，返回各自的出生坐标。
function collectSpawns(seed: number, count: number): Array<{ x: number; y: number }> {
  const state = createGameState(seed, 1, 1); // 第 1 关为普通关（护送关是每组第 2 关）
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

test('spawn is deterministic for the same seed', () => {
  assert.deepEqual(collectSpawns(7, 6), collectSpawns(7, 6));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import type { Rng } from '../src/core/rng';
import { Cell, levelHasWater, setCell } from '../src/game/level';
import { dropPowerup } from '../src/game/powerup';
import { createGameState } from '../src/game/state';

// 首次取种类时尽量命中 POWERUP_KINDS 中原本的 boat 下标，后续落点固定在左上角。
function boatSeekingRng(): Rng {
  let calls = 0;
  return {
    next: () => 0,
    int: (maxExclusive) => (calls++ === 0 ? Math.min(11, maxExclusive - 1) : 0),
    getState: () => 0,
  };
}

test('无水场景的中立道具队列不包含船，有水场景仍会出现船', () => {
  for (let stage = 1; stage <= 30; stage++) {
    const state = createGameState(stage, 1, stage);
    if (!levelHasWater(state.level)) {
      assert.equal(state.neutralQueue.includes('boat'), false, `第 ${stage} 关不应生成船`);
    }
  }

  const dry = createGameState(1, 1, 1);
  assert.equal(levelHasWater(dry.level), false);
  assert.equal(dry.neutralQueue.includes('boat'), false);

  const wet = createGameState(1, 1, 7);
  assert.equal(levelHasWater(wet.level), true);
  assert.equal(wet.neutralQueue.includes('boat'), true);
});

test('携带者掉落在无水场景排除船，在有水场景保留船', () => {
  const dry = createGameState(1, 1, 1);
  dry.rng = boatSeekingRng();
  dropPowerup(dry);
  assert.notEqual(dry.powerups[0].kind, 'boat');

  const wet = createGameState(1, 1, 1);
  setCell(wet.level, 0, 0, Cell.WATER);
  wet.rng = boatSeekingRng();
  dropPowerup(wet);
  assert.equal(wet.powerups[0].kind, 'boat');
});

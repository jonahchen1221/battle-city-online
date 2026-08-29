import test from 'node:test';
import assert from 'node:assert/strict';
import { updatePhase } from '../src/game/phase';
import { createGameState, nextStage } from '../src/game/state';
import { update } from '../src/game/update';
import { emptyInput } from '../src/core/types';

test('game over overrides an armed stage clear when the eagle dies during the delay', () => {
  const state = createGameState(42, 1, 1); // 普通鹰巢关
  state.phase = 'playing';
  state.enemyQueue = [];
  state.spawning = [];
  state.tanks = state.tanks.filter((tank) => tank.kind === 'player');

  updatePhase(state);
  assert.equal(state.pendingResult, 'stageclear');

  state.eagleDestroyed = true;
  updatePhase(state);

  assert.equal(state.pendingResult, 'gameover');
});

test('game over retries the current stage from its exact opening checkpoint', () => {
  const state = createGameState(73, 2, 1);

  // 先模拟第 1 关的跨关成果，确保检查点不只是“按关号重新 new 一局”。
  state.scoreByPlayer = [1200, 700];
  state.livesByPlayer = [2, 4];
  state.tanks[0].level = 2;
  state.tanks[0].weapon = 'laser';
  nextStage(state);
  assert.equal(state.stage, 2);

  const checkpoint = state.stageStartCheckpoint;
  assert.ok(checkpoint);
  const expected = structuredClone(checkpoint);
  const epochBeforeRetry = state.levelEpoch;

  // 破坏一批互不相关的关内状态，覆盖地形、资源、实体、护送进度与随机序列。
  state.phase = 'gameover';
  state.phaseTicks = 999;
  state.tick += 500;
  state.scoreByPlayer[0] += 9000;
  state.livesByPlayer.fill(0);
  state.level.cells.fill(0);
  state.level.brickMask.fill(0);
  state.enemyQueue.length = 0;
  state.tanks.length = 0;
  state.spawning.length = 0;
  state.powerups.length = 0;
  state.escort!.x += 64;
  state.rng.next();
  state.rng.next();

  update(state, [{ ...emptyInput(), start: true }, emptyInput()]);

  const {
    rng,
    events,
    stageStartCheckpoint: restoredCheckpoint,
    // 连接状态是房间运行时数据，不属于可重试的关卡检查点。
    activePlayerCount,
    ...restored
  } = state;
  const { rngState, ...expectedState } = expected;
  expectedState.levelEpoch = epochBeforeRetry + 1;
  // update() 在恢复后会把当前按住的开始键记为 true，避免下一帧重复触发。
  expectedState.prevStart = true;

  assert.deepEqual(restored, expectedState);
  assert.deepEqual(restoredCheckpoint, checkpoint);
  assert.deepEqual(events, ['stageStart']);
  assert.equal(rng.getState(), rngState);
  assert.equal(activePlayerCount, 2);
  assert.equal(state.stage, 2);
  assert.equal(state.phase, 'stagestart');
});

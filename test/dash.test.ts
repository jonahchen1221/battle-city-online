import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameState, GameState } from '../src/game/state';
import { update } from '../src/game/update';
import { emptyInput, InputState } from '../src/core/types';
import {
  DASH_DISTANCE,
  DASH_TICKS,
  DASH_COOLDOWN_TICKS,
  FRIENDLY_FREEZE_TICKS,
} from '../src/core/constants';
import { createEmptyLevel } from '../src/game/level';
import { TankState } from '../src/game/tank';

const EPS = 1e-6;

// 造一局“空旷战场 + 只有 P1”的单人局：
//   • 地形换成全空图，位移可精确核对；
//   • enemyQueue 保留一台但把出生计时推到天边 —— 队列非空则不会误判过关，同时永不真的出生；
//   • neutralTimer 同样推远，避免中立道具（boots 等）改变移动速度。
function soloOnEmptyField(): { state: GameState; tank: TankState } {
  const state = createGameState(1, 1, 1);
  state.phase = 'playing';
  state.level = createEmptyLevel();
  state.enemyQueue = ['basic'];
  state.enemySpawnTimer = Number.MAX_SAFE_INTEGER;
  state.neutralTimer = Number.MAX_SAFE_INTEGER;
  state.spawning = [];
  const tank = state.tanks[0];
  Object.assign(tank, { x: 96, y: 96, dir: 'right', invulnTicks: 0 });
  return { state, tank };
}

function dashInput(): InputState {
  const input = emptyInput();
  input.dash = true;
  return input;
}

test('a dash covers exactly DASH_DISTANCE over DASH_TICKS frames on open ground', () => {
  const { state, tank } = soloOnEmptyField();
  const x0 = tank.x;

  update(state, [dashInput()]); // 按下沿：本帧即开始冲刺并走掉第一步
  assert.equal(tank.dashTicks, DASH_TICKS - 1);
  assert.equal(tank.dashCooldown, DASH_COOLDOWN_TICKS);

  for (let i = 1; i < DASH_TICKS; i++) update(state, [emptyInput()]);

  assert.ok(Math.abs(tank.x - (x0 + DASH_DISTANCE)) < EPS, `x=${tank.x}`);
  assert.equal(tank.y, 96); // 单轴位移，垂直轴不动
  assert.equal(tank.dashTicks, 0);

  // 冲刺结束后不再继续滑走。
  update(state, [emptyInput()]);
  assert.ok(Math.abs(tank.x - (x0 + DASH_DISTANCE)) < EPS);
});

test('freezing blocks a new dash and cancels one already in progress', () => {
  // ① 冻结期间按下：不触发（CD 也不被消耗）。
  const frozen = soloOnEmptyField();
  frozen.tank.freezeTicks = FRIENDLY_FREEZE_TICKS;
  const x0 = frozen.tank.x;
  update(frozen.state, [dashInput()]);
  assert.equal(frozen.tank.dashTicks, 0);
  assert.equal(frozen.tank.dashCooldown, 0);
  assert.equal(frozen.tank.x, x0);

  // ② 冲刺途中被冻结：冲刺立即中止，CD 照常保留（不退款）。
  const hit = soloOnEmptyField();
  update(hit.state, [dashInput()]);
  assert.ok(hit.tank.dashTicks > 0);
  const xWhenFrozen = hit.tank.x;
  hit.tank.freezeTicks = FRIENDLY_FREEZE_TICKS; // 模拟被队友子弹击中
  update(hit.state, [emptyInput()]);
  assert.equal(hit.tank.dashTicks, 0);
  assert.equal(hit.tank.x, xWhenFrozen); // 冻结那帧起不再位移
  assert.equal(hit.tank.dashCooldown, DASH_COOLDOWN_TICKS - 1);
});

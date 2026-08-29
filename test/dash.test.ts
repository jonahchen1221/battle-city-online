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
  TANK_SIZE,
} from '../src/core/constants';
import { Cell, createEmptyLevel, setCell } from '../src/game/level';
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

test('a dash into a wall stops early and never penetrates the terrain', () => {
  const { state, tank } = soloOnEmptyField();
  // 钢墙左缘 x=120：车体右缘从 112 起，只有 8px 可走（远小于 32px 的冲刺位移）。
  setCell(state.level, 15, 12, Cell.STEEL);
  setCell(state.level, 15, 13, Cell.STEEL);
  const x0 = tank.x;

  update(state, [dashInput()]);
  for (let i = 1; i < DASH_TICKS; i++) update(state, [emptyInput()]);

  assert.ok(tank.x > x0, '应当至少前进了一点');
  assert.ok(tank.x - x0 < DASH_DISTANCE, `撞墙应提前停住，实际位移 ${tank.x - x0}`);
  assert.ok(tank.x + TANK_SIZE <= 120 + EPS, `不得穿入钢墙，右缘 ${tank.x + TANK_SIZE}`);
  assert.equal(tank.dashTicks, 0); // 撞墙即止
});

test('dash is unavailable during cooldown and available again after DASH_COOLDOWN_TICKS', () => {
  const { state, tank } = soloOnEmptyField();

  update(state, [dashInput()]);
  assert.equal(tank.dashCooldown, DASH_COOLDOWN_TICKS);

  // 冲刺走完，随后在冷却中重新按下：不触发。
  for (let i = 1; i < DASH_TICKS; i++) update(state, [emptyInput()]);
  const xAfterFirst = tank.x;
  update(state, [dashInput()]); // 新的按下沿，但 CD 未好
  assert.equal(tank.dashTicks, 0);
  assert.ok(Math.abs(tank.x - xAfterFirst) < EPS);

  // 把冷却剩余帧耗到 1（首帧装填那次不递减，故共需 DASH_COOLDOWN_TICKS-1 帧）。
  while (tank.dashCooldown > 1) update(state, [emptyInput()]);
  assert.equal(tank.dashCooldown, 1);
  update(state, [emptyInput()]);
  assert.equal(tank.dashCooldown, 0);

  update(state, [dashInput()]); // CD 已好：再次触发
  assert.equal(tank.dashTicks, DASH_TICKS - 1);
  assert.equal(tank.dashCooldown, DASH_COOLDOWN_TICKS);
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

test('holding the dash key only triggers once (edge-triggered)', () => {
  const { state, tank } = soloOnEmptyField();

  update(state, [dashInput()]); // 第一次按下沿
  for (let i = 1; i < DASH_TICKS; i++) update(state, [dashInput()]); // 一直按住
  assert.equal(tank.dashTicks, 0);

  // 人为把 CD 清零：若不是边沿触发，按住的这几帧会立刻再冲一次。
  tank.dashCooldown = 0;
  const x0 = tank.x;
  for (let i = 0; i < 5; i++) update(state, [dashInput()]);
  assert.equal(tank.dashTicks, 0);
  assert.equal(tank.x, x0);

  // 松开一帧后重按：新的按下沿正常触发。
  update(state, [emptyInput()]);
  update(state, [dashInput()]);
  assert.equal(tank.dashTicks, DASH_TICKS - 1);
});

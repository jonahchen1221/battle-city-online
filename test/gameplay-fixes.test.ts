import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameState } from '../src/game/state';
import { update } from '../src/game/update';
import { destroyPlayerTank } from '../src/game/death';
import { emptyInput } from '../src/core/types';
import { isPlayerTank } from '../src/game/tank';
import { ESCORT_SIZE, TANK_SIZE } from '../src/core/constants';

// ── 护送关：阵亡重生落点跟随护送车当前位置（同屏），不再回路线起点 ──
test('escort respawn lands near the escort vehicle, not the route start', () => {
  const state = createGameState(7, 2, 2); // 第 2 关 = 护送关
  const escort = state.escort!;
  assert.ok(escort);
  // 把车开到路线中段（远离起点），模拟战斗进行中的阵亡。
  escort.x = 304;
  escort.y = 320;
  escort.dir = 'up';
  const p0 = state.tanks.find((t) => isPlayerTank(t) && t.playerIndex === 0)!;
  destroyPlayerTank(state, p0);
  const revived = state.spawning.find((s) => isPlayerTank(s.tank) && s.tank.playerIndex === 0);
  assert.ok(revived, '有剩余生命时应进入出生闪光');
  const dx = revived.tank.x + TANK_SIZE / 2 - (escort.x + ESCORT_SIZE / 2);
  const dy = revived.tank.y + TANK_SIZE / 2 - (escort.y + ESCORT_SIZE / 2);
  const dist = Math.hypot(dx, dy);
  assert.ok(dist <= 160, `重生点应在车辆同屏范围内，实际距离 ${dist.toFixed(1)}px`);
  // 旧行为回归防线：路线起点在 (304, 656) 一带，重生点不应贴回起点。
  assert.ok(Math.abs(revived.tank.y - escort.route[0].y) > 100, '不应回到路线起点');
});

// ── Boss：玩家贴身侧面时站定面向目标，不再左右甩头 ──
test('boss stands still facing a player hugging its side (no direction flapping)', () => {
  const state = createGameState(11, 2, 3); // 第 3 关 = Boss 关（双人 → 两阶段都会追踪）
  state.phase = 'playing';
  const boss = state.boss!;
  assert.ok(boss);
  const p0 = state.tanks.find((t) => isPlayerTank(t) && t.playerIndex === 0)!;
  // P0 紧贴 Boss 右侧、纵向与车体重叠（脸贴脸）。
  p0.x = boss.x + boss.size;
  p0.y = boss.y + (boss.size - TANK_SIZE) / 2;
  const inputs = [emptyInput(), emptyInput()];
  const positions = new Set<string>();
  const dirs = new Set<string>();
  for (let i = 0; i < 40; i++) {
    update(state, inputs);
    positions.add(`${state.boss!.x},${state.boss!.y}`);
    dirs.add(state.boss!.dir);
  }
  assert.equal(positions.size, 1, `贴身时 Boss 不应来回挪动，出现了 ${positions.size} 个位置`);
  assert.deepEqual([...dirs], ['right'], '应稳定面向贴身的玩家');
});

// ── 友军冻结：只封移动 / 转向，不封开火 ──
test('a friendly-frozen tank can still fire but cannot move', () => {
  const state = createGameState(13, 2, 1); // 第 1 关 = 普通关
  state.phase = 'playing';
  const p0 = state.tanks.find((t) => isPlayerTank(t) && t.playerIndex === 0)!;
  p0.freezeTicks = 60;
  const x0 = p0.x;
  const y0 = p0.y;
  const fireInput = { ...emptyInput(), fire: true, up: true };
  update(state, [fireInput, emptyInput()]);
  assert.ok(
    state.bullets.some((b) => b.ownerId === p0.id && b.alive),
    '冻结中按开火应能出弹',
  );
  for (let i = 0; i < 30; i++) update(state, [fireInput, emptyInput()]);
  assert.equal(p0.x, x0, '冻结中不应移动（x）');
  assert.equal(p0.y, y0, '冻结中不应移动（y）');
  assert.ok(p0.freezeTicks < 60, '冻结计时应照常递减');
});

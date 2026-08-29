import test from 'node:test';
import assert from 'node:assert/strict';
import { SPAWN_FLASH_TICKS, SUBTILE, TANK_SIZE } from '../src/core/constants';
import { Cell, createEmptyLevel, getCell, setCell } from '../src/game/level';
import { isPlayerTank, type TankState } from '../src/game/tank';
import { advanceBullets, spawnWeaponBullets, type BulletState } from '../src/game/bullet';
import { tryPickupPowerup, POWERUP_KINDS } from '../src/game/powerup';
import { createGameState, nextStage, type GameState } from '../src/game/state';

// 把一枚道具刷在某坦克脚下并触发拾取（拾取判定是 16×16 AABB 重叠）。
function giveP0(state: GameState, kind: (typeof POWERUP_KINDS)[number]): TankState {
  const tank = state.tanks.find((t) => isPlayerTank(t) && t.playerIndex === 0)!;
  state.powerups.push({ kind, x: tank.x, y: tank.y });
  tryPickupPowerup(state, 'player');
  return tank;
}

// 让 tank 朝右站在钢块左侧，开火并推进若干帧，返回那一发子弹。
function fireRightAtSteel(tank: TankState, steelCol: number, steelRow: number, ticks: number) {
  const level = createEmptyLevel();
  setCell(level, steelCol, steelRow, Cell.STEEL);
  tank.x = (steelCol - 4) * SUBTILE; // 车体右缘距钢块 3 个子格
  tank.y = steelRow * SUBTILE;
  tank.dir = 'right';
  const bullets: BulletState[] = spawnWeaponBullets(tank, 1);
  for (let i = 0; i < ticks; i++) advanceBullets(level, bullets, [], []);
  return { level, bullet: bullets[0] };
}

test('拾取钻头后：0 级经典炮的子弹也带破钢，并能整格清除钢块', () => {
  const state = createGameState(1, 1);
  const tank = giveP0(state, 'drill');
  assert.equal(tank.drill, true);
  assert.equal(tank.level, 0);
  assert.equal(tank.weapon, 'cannon');

  const { level, bullet } = fireRightAtSteel(tank, 20, 10, 20);
  assert.equal(bullet.steelPiercing, true);
  assert.equal(getCell(level, 20, 10), Cell.EMPTY, '钢块应被整格清除');
});

test('鹰巢与战场边界永不被钻头击穿', () => {
  const state = createGameState(3, 1);
  const tank = giveP0(state, 'drill');

  // 鹰巢：把一格设为 EAGLE，正对着打。
  const level = createEmptyLevel();
  setCell(level, 20, 10, Cell.EAGLE);
  tank.x = 16 * SUBTILE;
  tank.y = 10 * SUBTILE;
  tank.dir = 'right';
  const eagleShot = spawnWeaponBullets(tank, 1);
  for (let i = 0; i < 20; i++) advanceBullets(level, eagleShot, [], []);
  assert.equal(getCell(level, 20, 10), Cell.EAGLE, '鹰巢不可被击穿');
  assert.equal(eagleShot[0].alive, false);

  // 战场边界：贴着右缘朝外打，子弹撞边界消亡且不会“打穿”地图。
  const edge = createEmptyLevel();
  tank.x = edge.cols * SUBTILE - TANK_SIZE;
  tank.y = 10 * SUBTILE;
  tank.dir = 'right';
  const edgeShot = spawnWeaponBullets(tank, 2);
  for (let i = 0; i < 10; i++) advanceBullets(edge, edgeShot, [], []);
  assert.equal(edgeShot[0].alive, false, '子弹应被边界终止');
});

test('过关时武器 / 钻头 / star 等级一并带入下一关，未强化的队友保持初始状态', () => {
  const state = createGameState(5, 2);
  const p0 = state.tanks.find((t) => isPlayerTank(t) && t.playerIndex === 0)!;
  p0.weapon = 'spread';
  p0.drill = true;
  p0.level = 2;

  const stageBefore = state.stage;
  nextStage(state);
  assert.equal(state.stage, stageBefore + 1);

  const spawned = new Map<number, TankState>();
  for (const s of state.spawning) {
    if (isPlayerTank(s.tank)) spawned.set(s.tank.playerIndex, s.tank);
  }
  const next0 = spawned.get(0)!;
  assert.equal(next0.weapon, 'spread');
  assert.equal(next0.drill, true);
  assert.equal(next0.level, 2);

  const next1 = spawned.get(1)!;
  assert.equal(next1.weapon, 'cannon');
  assert.equal(next1.drill, false);
  assert.equal(next1.level, 0);

  // 复活仍走出生闪光（与既有行为一致）。
  assert.equal(state.spawning[0].ticksLeft, SPAWN_FLASH_TICKS);
});

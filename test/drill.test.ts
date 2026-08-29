import test from 'node:test';
import assert from 'node:assert/strict';
import { SPAWN_FLASH_TICKS, SUBTILE, TANK_SIZE } from '../src/core/constants';
import { Cell, createEmptyLevel, getCell, setCell } from '../src/game/level';
import { createPlayer, isPlayerTank, type TankState } from '../src/game/tank';
import { advanceBullets, spawnWeaponBullets, type BulletState } from '../src/game/bullet';
import { tryPickupPowerup, POWERUP_KINDS } from '../src/game/powerup';
import { createGameState, nextStage, type GameState } from '../src/game/state';
import { destroyPlayerTank } from '../src/game/death';

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

test('钻头道具位于 POWERUP_KINDS 尾部', () => {
  assert.equal(POWERUP_KINDS[POWERUP_KINDS.length - 1], 'drill');
});

test('新建坦克的 drill 为 false', () => {
  assert.equal(createPlayer(0, 1).drill, false);
});

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

test('未拾取钻头时，0 级经典炮打不穿钢块', () => {
  const tank = createPlayer(0, 1);
  const { level, bullet } = fireRightAtSteel(tank, 20, 10, 20);
  assert.equal(bullet.steelPiercing, false);
  assert.equal(getCell(level, 20, 10), Cell.STEEL, '钢块应保持完好');
  assert.equal(bullet.alive, false, '普通弹撞钢即消亡');
});

test('钻头让特殊武器一并带破钢；激光穿钢后仍继续飞', () => {
  const state = createGameState(2, 1);
  const tank = giveP0(state, 'drill');

  for (const weapon of ['spread', 'spiral', 'machine'] as const) {
    tank.weapon = weapon;
    tank.dir = 'right';
    for (const b of spawnWeaponBullets(tank, 1)) {
      assert.equal(b.steelPiercing, true, `${weapon} 的子弹应带破钢`);
    }
  }

  tank.weapon = 'laser';
  const { level, bullet } = fireRightAtSteel(tank, 20, 10, 4);
  assert.equal(bullet.steelPiercing, true);
  assert.equal(getCell(level, 20, 10), Cell.EMPTY, '激光应整格清除钢块');
  assert.equal(bullet.alive, true, '带钻头的激光穿钢后应继续飞');
});

test('无钻头的激光撞钢块仍然消亡（原行为不变）', () => {
  const tank = createPlayer(0, 1);
  tank.weapon = 'laser';
  const { level, bullet } = fireRightAtSteel(tank, 20, 10, 4);
  assert.equal(getCell(level, 20, 10), Cell.STEEL);
  assert.equal(bullet.alive, false);
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

test('坦克被击毁重生后，钻头与武器都归零', () => {
  const state = createGameState(4, 1);
  const tank = giveP0(state, 'drill');
  tank.weapon = 'laser';
  tank.level = 2;

  destroyPlayerTank(state, tank);
  const reborn = state.spawning.find((s) => isPlayerTank(s.tank))!.tank;
  assert.equal(reborn.drill, false);
  assert.equal(reborn.weapon, 'cannon');
  assert.equal(reborn.level, 0);
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

test('出生闪光中的坦克同样会被跨关捕获', () => {
  const state = createGameState(6, 1);
  const p0 = state.tanks.find((t) => isPlayerTank(t))!;
  p0.weapon = 'machine';
  p0.drill = true;
  destroyPlayerTank(state, p0); // 进入出生闪光（新坦克为 cannon / 无钻头）
  const flashing = state.spawning.find((s) => isPlayerTank(s.tank))!.tank;
  flashing.weapon = 'laser';
  flashing.drill = true;

  nextStage(state);
  const next0 = state.spawning.find((s) => isPlayerTank(s.tank))!.tank;
  assert.equal(next0.weapon, 'laser');
  assert.equal(next0.drill, true);
});

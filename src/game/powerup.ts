import {
  SUBTILE,
  TANK_SIZE,
  POWERUP_SIZE,
  FIELD_COLS,
  FIELD_ROWS,
  EAGLE_COL,
  EAGLE_ROW,
  POWERUP_SCORE,
  ENEMY_FREEZE_TICKS,
  SHOVEL_TICKS,
  HELMET_INVULN_TICKS,
  PLAYER_MAX_LEVEL,
  ENEMY_SCORE,
  EXPLOSION_BIG_TICKS,
  EXPLOSION_BIG_SIZE,
  MAX_POWERUPS_ON_FIELD,
  BOOTS_TICKS,
  GHOST_TICKS,
  ENEMY_SLOW_TICKS,
  NEUTRAL_POWERUP_INTERVAL_TICKS,
  NEUTRAL_POWERUP_RETRY_TICKS,
  NEUTRAL_POWERUP_MAX_TRIES,
} from '../core/constants';
import type { Rng } from '../core/rng';
import { Cell, setCell, getCell } from './level';
import { TankState, EnemyKind, WeaponKind, isPlayerTank } from './tank';
import type { GameState } from './state';

// 道具系统（纯模拟层）：一切随机取自 state.rng，可复现；GameState 保持可序列化。
// 六种经典道具 + 四种魂斗罗风格武器道具 + 五种“中立”道具（每关必出，见 updateNeutralPowerups）。
// rng.int(POWERUP_KINDS.length) → POWERUP_KINDS[idx]（顺序即取值映射，务必稳定：只在尾部追加）。
export type PowerupKind =
  | 'star'
  | 'grenade'
  | 'tank'
  | 'timer'
  | 'shovel'
  | 'helmet'
  | 'wpnSpread' // S：散弹
  | 'wpnSpiral' // F：螺旋弹
  | 'wpnLaser' // L：激光
  | 'wpnMachine' // M：机枪
  | 'boots' // 快靴：拾取者限时加速
  | 'boat' // 船：拾取者可驶入水面（直到死亡）
  | 'ghost' // 幽灵：拾取者限时穿砖
  | 'hourglass' // 沙漏：敌军限时半速
  | 'wrench'; // 扳手：即时修复鹰巢护墙环
export const POWERUP_KINDS: ReadonlyArray<PowerupKind> = [
  'star',
  'grenade',
  'tank',
  'timer',
  'shovel',
  'helmet',
  'wpnSpread',
  'wpnSpiral',
  'wpnLaser',
  'wpnMachine',
  'boots',
  'boat',
  'ghost',
  'hourglass',
  'wrench',
];

// 每关必出的“中立”道具（由定时器刷新到战场随机空位，与携带者掉落无关）。
export const NEUTRAL_POWERUP_KINDS: ReadonlyArray<PowerupKind> = [
  'boots',
  'boat',
  'ghost',
  'hourglass',
  'wrench',
];

// MVP 开局奖励可选的“强力道具”池（仅多人局，见 state.ts nextStage）。
export const MVP_POWERUP_KINDS: ReadonlyArray<PowerupKind> = [
  'star',
  'grenade',
  'tank',
  'helmet',
  'wpnSpread',
  'wpnSpiral',
  'wpnLaser',
  'wpnMachine',
];

// 武器道具 → 武器种类的映射（拾取即替换旧武器）。
export const POWERUP_WEAPON: Partial<Record<PowerupKind, WeaponKind>> = {
  wpnSpread: 'spread',
  wpnSpiral: 'spiral',
  wpnLaser: 'laser',
  wpnMachine: 'machine',
};

// 场上道具浮标：纯数据（x/y 为 16×16 包围盒左上角战场相对像素坐标）。
export interface PowerupState {
  kind: PowerupKind;
  x: number;
  y: number;
}

// 鹰巢护墙的“护盾环”子格（由 EAGLE_COL/ROW 推导）：2×2 鹰巢外围 1 子格厚的环，
// 去掉鹰巢本身与越界（战场边缘）格。第 1 关即 cols 18–21 行 27 的 4 格 + 列 18/21 行 28–29 各 2 格 = 8 格。
export function eagleRingCells(): Array<{ col: number; row: number }> {
  const cells: Array<{ col: number; row: number }> = [];
  for (let row = EAGLE_ROW - 1; row <= EAGLE_ROW + 2; row++) {
    for (let col = EAGLE_COL - 1; col <= EAGLE_COL + 2; col++) {
      if (col < 0 || row < 0 || col >= FIELD_COLS || row >= FIELD_ROWS) continue;
      // 跳过鹰巢自身的 2×2（cols EAGLE_COL..EAGLE_COL+1，rows EAGLE_ROW..EAGLE_ROW+1）。
      const inEagle =
        col >= EAGLE_COL && col <= EAGLE_COL + 1 && row >= EAGLE_ROW && row <= EAGLE_ROW + 1;
      if (inEagle) continue;
      cells.push({ col, row });
    }
  }
  return cells;
}

// 某 16×16 浮标（左上角子格 colX/rowY）是否与“鹰巢禁区”重叠：
// 禁区 = 鹰巢 2×2 + 护盾环，恰好是矩形 cols [EAGLE_COL-1, EAGLE_COL+2] × rows [EAGLE_ROW-1, EAGLE_ROW+1]。
function boxOverlapsEagleArea(colX: number, rowY: number): boolean {
  const pc0 = EAGLE_COL - 1;
  const pc1 = EAGLE_COL + 2;
  const pr0 = EAGLE_ROW - 1;
  const pr1 = EAGLE_ROW + 1;
  // 浮标覆盖子格 cols [colX, colX+1]、rows [rowY, rowY+1]。
  return colX <= pc1 && colX + 1 >= pc0 && rowY <= pr1 && rowY + 1 >= pr0;
}

// 把一枚道具放到场上：追加到数组尾部；超过上限则移除最旧的一枚（数组头）。
// 场上道具的“年龄序”即数组序（越靠前越旧），拾取时按此序遍历。
export function pushPowerup(state: GameState, p: PowerupState): void {
  state.powerups.push(p);
  while (state.powerups.length > MAX_POWERUPS_ON_FIELD) state.powerups.shift();
}

// 携带道具的敌军死亡时调用：向场上追加一枚新的随机道具，随机落点（不再替换旧道具）。
// rng 调用顺序（决定性）：先 rng.int(POWERUP_KINDS.length) 取种类；随后每次拒绝采样先
// rng.int(FIELD_COLS-1) 取列、再 rng.int(FIELD_ROWS-1) 取行，直到落点不与鹰巢禁区重叠
//（最多 MAX_TRIES 次，超限用兜底格）。
export function dropPowerup(state: GameState): void {
  const kind = POWERUP_KINDS[state.rng.int(POWERUP_KINDS.length)];
  const NUM_COL_POS = FIELD_COLS - 1; // 39：colX 0..38（16px 盒右缘 ≤ FIELD_WIDTH）
  const NUM_ROW_POS = FIELD_ROWS - 1; // 29：rowY 0..28（16px 盒下缘 ≤ FIELD_HEIGHT）
  const MAX_TRIES = 100;
  let colX = 0;
  let rowY = 0;
  for (let tries = 0; tries < MAX_TRIES; tries++) {
    colX = state.rng.int(NUM_COL_POS);
    rowY = state.rng.int(NUM_ROW_POS);
    if (!boxOverlapsEagleArea(colX, rowY)) break;
    // 超限（几乎不会发生）：退到左上角空区兜底。
    if (tries === MAX_TRIES - 1) {
      colX = 0;
      rowY = 0;
    }
  }
  pushPowerup(state, { kind, x: colX * SUBTILE, y: rowY * SUBTILE });
  state.events.push('powerupSpawn');
}

// 用 state.rng 对一组道具种类做 Fisher-Yates 洗牌，返回新数组（本关的中立道具刷新顺序）。
// 每关调用一次（createGameState / nextStage），保证 5 种新道具每关各出现恰一次。
export function shuffledNeutralQueue(rng: Rng): PowerupKind[] {
  const queue = NEUTRAL_POWERUP_KINDS.slice();
  for (let i = queue.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const tmp = queue[i];
    queue[i] = queue[j];
    queue[j] = tmp;
  }
  return queue;
}

// 中立道具的落点采样：子格对齐的 16×16 盒，完全落在战场内，且
//   (1) 不与鹰巢禁区重叠；(2) 覆盖的 4 个子格中至少一格既非水面也非钢块（否则玩家够不着）。
// 最多 MAX_TRIES 次拒绝采样；全失败返回 null（由调用方顺延本枚）。
function sampleNeutralSpot(state: GameState): { x: number; y: number } | null {
  const NUM_COL_POS = FIELD_COLS - 1; // colX 0..38
  const NUM_ROW_POS = FIELD_ROWS - 1; // rowY 0..28
  for (let tries = 0; tries < NEUTRAL_POWERUP_MAX_TRIES; tries++) {
    const colX = state.rng.int(NUM_COL_POS);
    const rowY = state.rng.int(NUM_ROW_POS);
    if (boxOverlapsEagleArea(colX, rowY)) continue;
    let reachable = false;
    for (let r = rowY; r <= rowY + 1 && !reachable; r++) {
      for (let c = colX; c <= colX + 1 && !reachable; c++) {
        const cell = getCell(state.level, c, r);
        if (cell !== Cell.WATER && cell !== Cell.STEEL) reachable = true;
      }
    }
    if (!reachable) continue;
    return { x: colX * SUBTILE, y: rowY * SUBTILE };
  }
  return null;
}

// 中立道具定时刷新（每关必出）：仅在 playing 期间由 update 每帧调用。
// neutralTimer 归零且队列非空 → 出队一枚并刷到随机空位，随后按 INTERVAL 刷下一枚；
// 落点采样全失败则本枚顺延（RETRY 帧后重试，队列不消耗）。
export function updateNeutralPowerups(state: GameState): void {
  if (state.neutralQueue.length === 0) return;
  if (state.neutralTimer > 0) {
    state.neutralTimer--;
    if (state.neutralTimer > 0) return; // 归零那一帧即刷新（间隔恰为 FIRST / INTERVAL 帧）
  }
  const spot = sampleNeutralSpot(state);
  if (!spot) {
    state.neutralTimer = NEUTRAL_POWERUP_RETRY_TICKS;
    return;
  }
  const kind = state.neutralQueue.shift()!;
  pushPowerup(state, { kind, x: spot.x, y: spot.y });
  state.neutralTimer = NEUTRAL_POWERUP_INTERVAL_TICKS;
  state.events.push('powerupSpawn');
}

// 玩家坦克 16×16 与道具 16×16 的 AABB 重叠。
function pickupOverlap(t: TankState, p: PowerupState): boolean {
  return (
    p.x < t.x + TANK_SIZE &&
    p.x + POWERUP_SIZE > t.x &&
    p.y < t.y + TANK_SIZE &&
    p.y + POWERUP_SIZE > t.y
  );
}

// 拾取检测（玩家移动后调用）：遍历场上全部浮标（自旧到新），任一存活玩家坦克与之重叠即
// 拾取——加分、生效、从数组移除、发声。同一帧可拾取多枚（各自结算）。
export function tryPickupPowerup(state: GameState): void {
  for (let i = 0; i < state.powerups.length; ) {
    const p = state.powerups[i];
    let taken = false;
    for (const t of state.tanks) {
      if (!t.alive || !isPlayerTank(t)) continue;
      if (!pickupOverlap(t, p)) continue;
      state.scoreByPlayer[t.playerIndex] += POWERUP_SCORE;
      applyPowerupEffect(state, t, p.kind);
      // tank 道具（加命）用独立的欢快 1UP 音效；其余用统一拾取提示音。
      state.events.push(p.kind === 'tank' ? 'lifeUp' : 'powerupPickup');
      taken = true;
      break;
    }
    if (taken) state.powerups.splice(i, 1);
    else i++;
  }
}

// 施加道具效果。collector 为拾取者（player 坦克）。
function applyPowerupEffect(state: GameState, collector: TankState, kind: PowerupKind): void {
  switch (kind) {
    case 'star':
      // 升级：等级 +1，封顶 3。等级作用于该玩家子弹（弹速 / 双弹 / 破钢，见 bullet.ts）。
      collector.level = Math.min(PLAYER_MAX_LEVEL, collector.level + 1);
      break;
    case 'grenade':
      grenadeKillAll(state, collector);
      break;
    case 'tank':
      // 加命：该玩家生命 +1。
      state.livesByPlayer[collector.playerIndex]++;
      break;
    case 'timer':
      state.enemyFreezeTicks = ENEMY_FREEZE_TICKS;
      break;
    case 'shovel':
      // 鹰巢护墙钢化；重复拾取仅重置计时（钢化本身幂等）。
      state.shovelTicks = SHOVEL_TICKS;
      fortifyEagleRing(state);
      break;
    case 'helmet':
      // 无敌：复用出生护盾计时 / 渲染。
      collector.invulnTicks = HELMET_INVULN_TICKS;
      break;
    case 'boots':
      // 快靴：限时加速（仅作用于移动计算，不改 speed 基值）；重复拾取重置计时。
      collector.speedBoostTicks = BOOTS_TICKS;
      break;
    case 'boat':
      // 船：水面视为可通行，直到该玩家死亡（复活即用 createPlayer 重建 → 自然消失）。
      collector.hasBoat = true;
      break;
    case 'ghost':
      // 幽灵：限时穿砖；重复拾取重置计时。
      collector.ghostTicks = GHOST_TICKS;
      break;
    case 'hourglass':
      // 沙漏：敌军限时半速（enemyFreezeTicks 全冻结优先，见 enemy.ts updateEnemies）。
      state.enemySlowTicks = ENEMY_SLOW_TICKS;
      break;
    case 'wrench':
      // 扳手：即时把鹰巢护墙环修复为全新完整砖；若正处于 shovel 钢化期间则刷成钢（不降级）。
      // 鹰巢本身不修复（已毁即已毁）。
      if (state.shovelTicks > 0) fortifyEagleRing(state);
      else restoreEagleRingBrick(state);
      break;
    default: {
      // 武器道具：替换拾取者当前武器（不叠加、不保留旧武器），连发冷却清零以便立即开火。
      // star 等级不受影响，仍与武器并存（见 bullet.ts maxBulletsFor / spawnWeaponBullets）。
      const weapon = POWERUP_WEAPON[kind];
      if (weapon) {
        collector.weapon = weapon;
        collector.fireCooldown = 0;
      }
      break;
    }
  }
}

// grenade：场上每台存活敌军立即以大爆炸死亡；得分 / 击毁数一律归属拾取者 collector
// （偏离原版“0 分”的小改动，为保持结算统计算术一致）。出生闪光中的敌人不受影响（仅遍历 state.tanks）。
function grenadeKillAll(state: GameState, collector: TankState): void {
  const off = (EXPLOSION_BIG_SIZE - TANK_SIZE) / 2; // 8
  for (const t of state.tanks) {
    if (!t.alive || isPlayerTank(t)) continue;
    t.hp = 0;
    t.alive = false;
    const kind = t.kind as EnemyKind;
    state.scoreByPlayer[collector.playerIndex] += ENEMY_SCORE[kind];
    state.killsByPlayer[collector.playerIndex][kind]++;
    state.explosions.push({
      x: t.x - off,
      y: t.y - off,
      ticksLeft: EXPLOSION_BIG_TICKS,
      big: true,
    });
    state.events.push('explosionBig');
  }
}

// 把鹰巢护盾环各格设为完整钢块（shovel 生效）。
export function fortifyEagleRing(state: GameState): void {
  for (const { col, row } of eagleRingCells()) {
    setCell(state.level, col, row, Cell.STEEL);
  }
}

// 把鹰巢护盾环各格恢复为完整砖块（shovel 到期；即使原先受损 / 被毁也重建 —— 经典表现）。
export function restoreEagleRingBrick(state: GameState): void {
  for (const { col, row } of eagleRingCells()) {
    setCell(state.level, col, row, Cell.BRICK);
  }
}

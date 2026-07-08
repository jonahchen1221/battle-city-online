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
} from '../core/constants';
import { Cell, setCell } from './level';
import { TankState, EnemyKind, isPlayerTank } from './tank';
import type { GameState } from './state';

// 道具系统（纯模拟层）：一切随机取自 state.rng，可复现；GameState 保持可序列化。
// 六种经典道具。rng.int(6) → POWERUP_KINDS[idx]（顺序即取值映射，务必稳定）。
export type PowerupKind = 'star' | 'grenade' | 'tank' | 'timer' | 'shovel' | 'helmet';
export const POWERUP_KINDS: ReadonlyArray<PowerupKind> = [
  'star',
  'grenade',
  'tank',
  'timer',
  'shovel',
  'helmet',
];

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

// 携带道具的敌军死亡时调用：把当前场上道具（若有）替换为一枚新的随机道具，随机落点。
// rng 调用顺序（决定性）：先 rng.int(6) 取种类；随后每次拒绝采样先 rng.int(FIELD_COLS-1) 取列、
// 再 rng.int(FIELD_ROWS-1) 取行，直到落点不与鹰巢禁区重叠（最多 MAX_TRIES 次，超限用兜底格）。
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
  state.powerup = { kind, x: colX * SUBTILE, y: rowY * SUBTILE };
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

// 拾取检测（玩家移动后调用）：任一存活玩家坦克与浮标重叠即拾取——加分、生效、清除浮标、发声。
export function tryPickupPowerup(state: GameState): void {
  const p = state.powerup;
  if (!p) return;
  for (const t of state.tanks) {
    if (!t.alive || !isPlayerTank(t)) continue;
    if (!pickupOverlap(t, p)) continue;
    state.score += POWERUP_SCORE;
    applyPowerupEffect(state, t, p.kind);
    state.powerup = null;
    // tank 道具（加命）用独立的欢快 1UP 音效；其余用统一拾取提示音。
    state.events.push(p.kind === 'tank' ? 'lifeUp' : 'powerupPickup');
    break;
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
      grenadeKillAll(state);
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
  }
}

// grenade：场上每台存活敌军立即以大爆炸死亡；正常计分 / 计入击毁数
// （偏离原版“0 分”的小改动，为保持结算统计算术一致）。出生闪光中的敌人不受影响（仅遍历 state.tanks）。
function grenadeKillAll(state: GameState): void {
  const off = (EXPLOSION_BIG_SIZE - TANK_SIZE) / 2; // 8
  for (const t of state.tanks) {
    if (!t.alive || isPlayerTank(t)) continue;
    t.hp = 0;
    t.alive = false;
    const kind = t.kind as EnemyKind;
    state.score += ENEMY_SCORE[kind];
    state.killsByKind[kind]++;
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

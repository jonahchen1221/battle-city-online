import {
  SUBTILE,
  BULLET_SIZE,
  EXPLOSION_BIG_TICKS,
  EXPLOSION_BIG_SIZE,
  EAGLE_COL,
  EAGLE_ROW,
  GAMEOVER_DELAY_TICKS,
  STAGE_CLEAR_DELAY_TICKS,
} from '../core/constants';
import { GameState, Phase, resetGameState } from './state';
import { isPlayerTank } from './tank';

// 阶段编排：鹰巢命中、失败/胜利判定、重开。update.ts 只做调用，逻辑集中于此以保持可读。

// 鹰巢包围盒（战场相对像素）：2×2 子格。
const EAGLE_X = EAGLE_COL * SUBTILE; // 96
const EAGLE_Y = EAGLE_ROW * SUBTILE; // 192
const EAGLE_SIZE = 2 * SUBTILE; // 16

// 子弹（4×4）命中鹰巢：任一方（敌我皆可）子弹触及鹰巢即摧毁基地。
// 鹰巢一旦被毁只结算一次；产生一个居中的大爆炸；命中子弹消亡。
export function resolveEagleHit(state: GameState): void {
  if (state.eagleDestroyed) return;
  for (const b of state.bullets) {
    if (
      b.x < EAGLE_X + EAGLE_SIZE &&
      b.x + BULLET_SIZE > EAGLE_X &&
      b.y < EAGLE_Y + EAGLE_SIZE &&
      b.y + BULLET_SIZE > EAGLE_Y
    ) {
      state.eagleDestroyed = true;
      b.alive = false;
      state.events.push('eagleDeath');
      // 大爆炸 32×32，居中于 16×16 鹰巢。
      const off = (EXPLOSION_BIG_SIZE - EAGLE_SIZE) / 2; // 8
      state.explosions.push({
        x: EAGLE_X - off,
        y: EAGLE_Y - off,
        ticksLeft: EXPLOSION_BIG_TICKS,
        big: true,
      });
      break;
    }
  }
}

// 场上是否有存活的玩家坦克（任一玩家）。
function anyPlayerAlive(state: GameState): boolean {
  return state.tanks.some((t) => t.alive && isPlayerTank(t));
}

// 是否有玩家坦克正在出生闪光（复活中，任一玩家）。
function anyPlayerSpawning(state: GameState): boolean {
  return state.spawning.some((s) => isPlayerTank(s.tank));
}

// 是否有存活的敌方坦克。
function anyEnemyAlive(state: GameState): boolean {
  return state.tanks.some((t) => t.alive && !isPlayerTank(t));
}

// 是否有敌方坦克正在出生闪光。
function anyEnemySpawning(state: GameState): boolean {
  return state.spawning.some((s) => !isPlayerTank(s.tank));
}

// 胜利条件：队列空 且 无在场敌人 且 无出生中的敌人。
function stageCleared(state: GameState): boolean {
  return state.enemyQueue.length === 0 && !anyEnemyAlive(state) && !anyEnemySpawning(state);
}

// 玩家彻底失败（合作）：所有玩家皆无剩余生命，且场上无在场玩家、无复活闪光。
function playerDefeated(state: GameState): boolean {
  const allOutOfLives = state.livesByPlayer.every((l) => l <= 0);
  return allOutOfLives && !anyPlayerAlive(state) && !anyPlayerSpawning(state);
}

// 武装一个延迟结果（仅当尚未武装）。
function arm(state: GameState, result: Exclude<Phase, 'playing'>, delay: number): void {
  state.pendingResult = result;
  state.resultTimer = delay;
}

// 每帧（playing 期间）末尾调用：检测触发并武装延迟结果；已武装则倒计时并适时切换阶段。
// 延迟期间仍处于 playing，模拟照常推进（经典手感）。
export function updatePhase(state: GameState): void {
  // 失败优先级始终高于通关：全歼后仍有 3 秒延迟模拟，期间残留敌弹可能摧毁鹰巢
  // 或击杀最后一名玩家。此时必须用 gameover 覆盖已武装的 stageclear。
  const defeated = state.eagleDestroyed || playerDefeated(state);
  if (defeated && state.pendingResult !== 'gameover') {
    arm(state, 'gameover', GAMEOVER_DELAY_TICKS);
  } else if (state.pendingResult === null && stageCleared(state)) {
    arm(state, 'stageclear', STAGE_CLEAR_DELAY_TICKS);
  }

  if (state.pendingResult !== null) {
    state.resultTimer--;
    if (state.resultTimer <= 0) {
      state.phase = state.pendingResult;
      state.phaseTicks = 0;
      state.pendingResult = null;
      state.events.push(state.phase === 'stageclear' ? 'stageClear' : 'gameOver');
    }
  }
}

// gameover / stageclear 时按 start 重开：seed 由旧 rng 确定性派生，就地重建 state。
export function restartGame(state: GameState): void {
  const seed = Math.floor(state.rng.next() * 2 ** 31);
  resetGameState(state, seed);
}

import {
  EXPLOSION_BIG_SIZE,
  EXPLOSION_BIG_TICKS,
  SPAWN_FLASH_TICKS,
  TANK_SIZE,
} from '../core/constants';
import { createPlayer, type TankState } from './tank';
import type { GameState } from './state';

// 大爆炸：32×32，居中于 16×16 坦克。
export function pushBigExplosion(state: GameState, tank: TankState): void {
  const off = (EXPLOSION_BIG_SIZE - TANK_SIZE) / 2;
  state.explosions.push({
    x: tank.x - off,
    y: tank.y - off,
    ticksLeft: EXPLOSION_BIG_TICKS,
    big: true,
  });
}

// 玩家坦克被击毁：扣该玩家一条生命；若其仍有剩余则走出生闪光复活。
// 多人合作中生命耗尽者会沿用既有规则，尝试向尚有余命的队友借一条命。
export function onPlayerKilled(state: GameState, tank: TankState): void {
  const idx = tank.playerIndex;
  state.livesByPlayer[idx]--;

  if (state.playerCount > 1 && state.livesByPlayer[idx] <= 0) {
    const donors: number[] = [];
    for (let i = 0; i < state.playerCount; i++) {
      if (i !== idx && state.livesByPlayer[i] >= 2) donors.push(i);
    }
    if (donors.length > 0) {
      const donor = donors[state.rng.int(donors.length)];
      state.livesByPlayer[donor]--;
      state.livesByPlayer[idx]++;
    }
  }

  if (state.livesByPlayer[idx] > 0) {
    state.spawning.push({ tank: createPlayer(idx, tank.id), ticksLeft: SPAWN_FLASH_TICKS });
  }
}

// 统一的玩家击毁入口，供敌弹与敌军拾取 grenade 共用，确保生命、复活、事件和爆炸一致。
export function destroyPlayerTank(state: GameState, tank: TankState): void {
  if (!tank.alive) return;
  tank.hp = 0;
  tank.alive = false;
  pushBigExplosion(state, tank);
  state.events.push('playerDeath');
  onPlayerKilled(state, tank);
}

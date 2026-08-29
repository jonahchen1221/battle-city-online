import {
  EXPLOSION_BIG_SIZE,
  EXPLOSION_BIG_TICKS,
  MAX_POWERUPS_ON_FIELD,
  PLAYER_DAMAGE_FLASH_TICKS,
  SPAWN_FLASH_TICKS,
  TANK_SIZE,
} from '../core/constants';
import { createPlayer, createVersusEnemy, type TankState } from './tank';
import { makeSmallExplosion } from './bullet';
import type { GameState } from './state';
import { escortPlayerSpawn } from './escort';
import { bossPlayerSpawnForStage } from './levels';

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

// 智能坦克死亡时，在车体原位置生成一颗五角星。沿用全局场上道具上限，
// 并发出标准道具出现事件；普通玩家死亡不再掉星。
export function dropDeathStar(state: GameState, tank: TankState): void {
  state.powerups.push({ kind: 'star', x: tank.x, y: tank.y });
  while (state.powerups.length > MAX_POWERUPS_ON_FIELD) state.powerups.shift();
  state.events.push('powerupSpawn');
}

// 对战 AI 被击毁：扣减它自己席位的一条命，仍有余命则以同 id、同席位重建。
// 命数在出生闪光开始前已经扣除，因此阶段判定不会在复活窗口误报全歼。
export function onVersusEnemyKilled(state: GameState, tank: TankState): void {
  const index = tank.versusIndex;
  if (index < 0 || index >= state.versusLivesByEnemy.length) return;
  if (state.versusLivesByEnemy[index] <= 0) return;

  state.versusLivesByEnemy[index]--;
  if (state.versusLivesByEnemy[index] <= 0) return;
  const revived = createVersusEnemy(index, tank.id);
  state.spawning.push({ tank: revived, ticksLeft: SPAWN_FLASH_TICKS });
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
    const revived = createPlayer(idx, tank.id);
    const spawn = state.boss
      ? bossPlayerSpawnForStage(state.stage, idx)
      : escortPlayerSpawn(state.escort, idx, state.level);
    revived.x = spawn.x;
    revived.y = spawn.y;
    state.spawning.push({ tank: revived, ticksLeft: SPAWN_FLASH_TICKS });
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

// 玩家统一受伤入口：3 级护甲优先吸收一次伤害；之后才扣车体生命。
// 非致命命中产生短暂无伤白闪与火花，避免同一轮散弹 / 同帧重叠弹一次剥掉多层耐久；
// 护甲破裂额外产生一簇火花并播放金属音。明确的即死机制直接走 destroyPlayerTank，不受此窗口影响。
export function damagePlayerTank(state: GameState, tank: TankState): void {
  if (!tank.alive || tank.hitFlashTicks > 0) return;
  const armorBroken = tank.armor > 0;
  if (armorBroken) tank.armor--;
  else tank.hp--;

  if (tank.hp <= 0) {
    destroyPlayerTank(state, tank);
    return;
  }

  tank.hitFlashTicks = PLAYER_DAMAGE_FLASH_TICKS;
  // 受伤发生在本帧输入处理之后。释放开火边沿锁，保证玩家按住开火跨过破甲帧时，
  // 下一帧仍能重新触发经典炮，而不会一直等到松键后才恢复。
  tank.prevFire = false;
  const cx = tank.x + TANK_SIZE / 2;
  const cy = tank.y + TANK_SIZE / 2;
  state.explosions.push(makeSmallExplosion(cx, cy));
  if (armorBroken) {
    state.explosions.push(makeSmallExplosion(cx + 5, cy - 3));
    state.events.push('steelHit');
  } else {
    state.events.push('explosionSmall');
  }
}

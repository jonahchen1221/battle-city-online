import { GameState } from './state';
import { InputState, emptyInput } from '../core/types';
import { applyInput, TankState, createPlayer1 } from './tank';
import {
  spawnBullet,
  hasLiveBullet,
  advanceBullets,
  resolveBulletBullet,
  bulletCanHit,
  bulletHitsTank,
} from './bullet';
import { updateEnemies } from './enemy';
import { updatePhase, resolveEagleHit, restartGame } from './phase';
import {
  EXPLOSION_BIG_TICKS,
  EXPLOSION_BIG_SIZE,
  TANK_SIZE,
  SPAWN_FLASH_TICKS,
  ENEMY_SCORE,
} from '../core/constants';

// 每逻辑帧调用一次。纯函数式推进：只依赖 state 与 inputs，
// 不得访问 DOM、canvas、performance.now 或 Math.random。
// update 只做编排：坦克移动在 tank.ts，子弹/战斗在 bullet.ts，敌方 AI 在 enemy.ts，
// 阶段（胜负/重开）在 phase.ts。
export function update(state: GameState, inputs: InputState[]): void {
  state.tick++;

  // start 键聚合 + 边沿检测：暂停切换与结算重开都只认“按下的那一帧”，避免按住连触发。
  const startDown = inputs.some((i) => i.start);
  const startEdge = startDown && !state.prevStart;
  state.prevStart = startDown;

  // gameover / stageclear：冻结模拟（不推进坦克/子弹/AI），仅让爆炸播完；按 start 边沿重开。
  if (state.phase !== 'playing') {
    state.phaseTicks++;
    advanceExplosions(state);
    if (startEdge) {
      restartGame(state);
      // restartGame 已把 prevStart 重置为 false；这里立即置回 true，
      // 使按住 Enter 不会在下一帧被再次识别为边沿而立刻重开。
      state.prevStart = true;
    }
    return;
  }

  // 暂停切换：start 边沿翻转 paused（含解除）。暂停期间彻底冻结模拟，仅 tick 继续走
  // （供渲染层驱动 "PAUSE" 闪烁与护盾流光）。
  if (startEdge) {
    state.paused = !state.paused;
    state.events.push('pause');
  }
  if (state.paused) return;

  state.phaseTicks++;
  const level = state.level;

  // 玩家坦克由输入驱动（未来 player2..4 时按顺序对应 inputs）。
  updatePlayers(state, inputs);

  // 敌方：出生闪光推进（含玩家复活）、AI 行进/开火、生成新敌人。
  updateEnemies(state, level);

  // 推进子弹并结算地形碰撞（撞地形消失时产生小爆炸）。
  advanceBullets(level, state.bullets, state.explosions, state.events);

  // 战斗结算：子弹互撞相消、子弹命中鹰巢、子弹命中坦克。
  resolveBulletBullet(state.bullets, state.explosions, state.events);
  resolveEagleHit(state);
  resolveBulletTanks(state);

  // 清理死亡子弹（其主人即可再次开火）与死亡坦克。
  state.bullets = state.bullets.filter((b) => b.alive);
  state.tanks = state.tanks.filter((t) => t.alive);

  // 推进爆炸计时，移除播放完毕的特效。
  advanceExplosions(state);

  // 阶段编排：检测鹰毁 / 玩家阵亡 / 全歼，武装并推进延迟结果。
  updatePhase(state);
}

// 玩家坦克：输入驱动移动 + 边沿触发开火。
function updatePlayers(state: GameState, inputs: InputState[]): void {
  const level = state.level;
  let pi = 0;
  for (const tank of state.tanks) {
    if (tank.kind !== 'player1') continue;
    const input = inputs[pi++] ?? emptyInput();
    if (!tank.alive) continue;

    // 出生护盾倒计时（实体化那一刻起算，逐帧递减到 0）。
    if (tank.invulnTicks > 0) tank.invulnTicks--;

    applyInput(tank, input, level, state.tanks);

    // 边沿触发开火：本帧按下且上帧未按下；每坦克同时仅一发在场。
    const firePressed = input.fire && !tank.prevFire;
    tank.prevFire = input.fire;
    if (firePressed && !hasLiveBullet(state.bullets, tank.id)) {
      state.bullets.push(spawnBullet(tank));
      state.events.push('playerFire'); // 仅玩家开火发声（敌弹静音，从简）
    }
  }
}

// 子弹 vs 坦克：按阵营命中，装甲坦克逐发扣血并闪烁，血尽爆炸；玩家被击即时复活。
function resolveBulletTanks(state: GameState): void {
  for (const b of state.bullets) {
    if (!b.alive) continue;
    for (const t of state.tanks) {
      if (!t.alive) continue;
      if (!bulletCanHit(b, t)) continue;
      if (!bulletHitsTank(b, t)) continue;

      b.alive = false;
      t.hp--;
      if (t.hp <= 0) {
        pushBigExplosion(state, t);
        t.alive = false;
        if (t.kind === 'player1') {
          state.events.push('playerDeath');
          onPlayerKilled(state, t);
        } else {
          // 敌方坦克被击毁：计分 + 计数（此处所有敌军死亡皆由玩家造成）。
          state.score += ENEMY_SCORE[t.kind];
          state.killsByKind[t.kind]++;
          state.events.push('explosionBig');
        }
      }
      // 装甲坦克 hp>0 时仅扣血（渲染层据 hp<ARMOR_HP 闪烁），子弹已消亡。
      break;
    }
  }
}

// 大爆炸：32×32，居中于 16×16 坦克。
function pushBigExplosion(state: GameState, t: TankState): void {
  const off = (EXPLOSION_BIG_SIZE - TANK_SIZE) / 2; // 8
  state.explosions.push({ x: t.x - off, y: t.y - off, ticksLeft: EXPLOSION_BIG_TICKS, big: true });
}

// 玩家坦克被击毁：扣一条生命；若仍有剩余则走 60 帧出生闪光复活（复用敌人出生机制，
// 而非即时瞬移），期间不可控/不可碰撞；若已无生命则保持死亡，交由 phase 判定 gameover。
function onPlayerKilled(state: GameState, t: TankState): void {
  state.playerLives--;
  if (state.playerLives > 0) {
    // 保留同一 id 以维持输入映射顺序；进入出生闪光队列，与敌人共用 updateSpawning。
    state.spawning.push({ tank: createPlayer1(t.id), ticksLeft: SPAWN_FLASH_TICKS });
  }
}

// 推进爆炸计时，移除播放完毕者。
function advanceExplosions(state: GameState): void {
  for (const e of state.explosions) e.ticksLeft--;
  state.explosions = state.explosions.filter((e) => e.ticksLeft > 0);
}

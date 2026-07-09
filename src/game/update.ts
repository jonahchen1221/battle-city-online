import { GameState, nextStage } from './state';
import { InputState, emptyInput } from '../core/types';
import { applyInput, TankState, EnemyKind, createPlayer, isPlayerTank } from './tank';
import {
  spawnBullet,
  liveBulletCount,
  maxBulletsFor,
  advanceBullets,
  resolveBulletBullet,
  bulletCanHit,
  bulletHitsTank,
} from './bullet';
import { updateEnemies } from './enemy';
import { updatePhase, resolveEagleHit, restartGame } from './phase';
import { tryPickupPowerup, dropPowerup, restoreEagleRingBrick } from './powerup';
import {
  EXPLOSION_BIG_TICKS,
  EXPLOSION_BIG_SIZE,
  TANK_SIZE,
  SPAWN_FLASH_TICKS,
  ENEMY_SCORE,
  STAGE_START_TICKS,
} from '../core/constants';

// 每逻辑帧调用一次。纯函数式推进：只依赖 state 与 inputs，
// 不得访问 DOM、canvas、performance.now 或 Math.random。
// update 只做编排：坦克移动在 tank.ts，子弹/战斗在 bullet.ts，敌方 AI 在 enemy.ts，
// 阶段（胜负/重开）在 phase.ts。
export function update(state: GameState, inputs: InputState[]): void {
  state.tick++;

  // start（Enter）与 pause（P）各自聚合 + 边沿检测：只认“按下的那一帧”，避免按住连触发。
  // start 仅用于结算重开 / 大厅；pause 仅用于暂停切换。二者分离，互不干扰。
  const startDown = inputs.some((i) => i.start);
  const startEdge = startDown && !state.prevStart;
  state.prevStart = startDown;
  const pauseDown = inputs.some((i) => i.pause);
  const pauseEdge = pauseDown && !state.prevPause;
  state.prevPause = pauseDown;

  // stagestart 开场幕布：冻结模拟（不推进坦克/子弹/AI），仅推进 phaseTicks；到时自动进入 playing。
  // 期间忽略 start 键（不可暂停 / 不可跳过）。
  if (state.phase === 'stagestart') {
    state.phaseTicks++;
    if (state.phaseTicks >= STAGE_START_TICKS) {
      state.phase = 'playing';
      state.phaseTicks = 0;
    }
    return;
  }

  // gameover / stageclear：冻结模拟（不推进坦克/子弹/AI），仅让爆炸播完；按 start 边沿推进。
  // stageclear → 进入下一关（nextStage）；gameover → 整局重开到第 1 关（restartGame）。
  if (state.phase !== 'playing') {
    state.phaseTicks++;
    advanceExplosions(state);
    if (startEdge) {
      if (state.phase === 'stageclear') {
        nextStage(state);
      } else {
        restartGame(state);
      }
      // restartGame 会把 prevStart 重置为 false；无论哪条分支，这里立即置回 true，
      // 使按住 Enter 不会在下一帧被再次识别为边沿而立刻重复触发。
      state.prevStart = true;
    }
    return;
  }

  // 暂停切换：pause（P）边沿翻转 paused（谁都能暂停、谁都能恢复）。暂停期间彻底冻结模拟，
  // 仅 tick 继续走（供渲染层驱动 "PAUSE" 闪烁与护盾流光）。
  // 暂停时记录触发者 playerIndex（inputs[i] 对应 playerIndex i），用于显示 "nP PAUSED"；恢复时清为 -1。
  if (pauseEdge) {
    state.paused = !state.paused;
    if (state.paused) {
      let by = 0;
      for (let i = 0; i < inputs.length; i++) {
        if (inputs[i]?.pause) { by = i; break; }
      }
      state.pausedBy = by;
    } else {
      state.pausedBy = -1;
    }
    state.events.push('pause');
  }
  if (state.paused) return;

  state.phaseTicks++;
  const level = state.level;

  // 道具计时递减。timer：敌军冻结逐帧递减。shovel：钢化护墙逐帧递减，归零那帧恢复砖墙。
  if (state.enemyFreezeTicks > 0) state.enemyFreezeTicks--;
  if (state.shovelTicks > 0) {
    state.shovelTicks--;
    if (state.shovelTicks === 0) restoreEagleRingBrick(state);
  }

  // 玩家坦克由输入驱动：inputs[i] 对应 playerIndex===i 的坦克（按序号映射，非数组顺序）。
  updatePlayers(state, inputs);

  // 玩家移动后做道具拾取检测（AABB 重叠即拾取、生效、清除浮标）。
  tryPickupPowerup(state);

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
// 输入按 playerIndex 映射（inputs[tank.playerIndex]）：某玩家阵亡后其坦克缺席，
// 其余玩家的输入不会因数组塌缩而错位。
function updatePlayers(state: GameState, inputs: InputState[]): void {
  const level = state.level;
  for (const tank of state.tanks) {
    if (!isPlayerTank(tank)) continue;
    if (!tank.alive) continue;
    const input = inputs[tank.playerIndex] ?? emptyInput();

    // 出生护盾倒计时（实体化那一刻起算，逐帧递减到 0）。
    if (tank.invulnTicks > 0) tank.invulnTicks--;

    applyInput(tank, input, level, state.tanks);

    // 边沿触发开火：本帧按下且上帧未按下；在场子弹数需低于该坦克上限（star 等级 ≥2 可双弹）。
    const firePressed = input.fire && !tank.prevFire;
    tank.prevFire = input.fire;
    if (firePressed && liveBulletCount(state.bullets, tank.id) < maxBulletsFor(tank)) {
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
        if (isPlayerTank(t)) {
          state.events.push('playerDeath');
          onPlayerKilled(state, t);
        } else {
          // 敌方坦克被击毁：把得分与击毁数归属给射手（敌弹不打敌人，故此处必为玩家弹，
          // ownerPlayerIndex ≥ 0；仍做守卫以防万一）。
          const kind = t.kind as EnemyKind; // 非玩家分支：kind 必为敌方种类
          if (b.ownerPlayerIndex >= 0) {
            state.scoreByPlayer[b.ownerPlayerIndex] += ENEMY_SCORE[kind];
            state.killsByPlayer[b.ownerPlayerIndex][kind]++;
          }
          state.events.push('explosionBig');
          // 携带者被击毁：用一枚新随机道具替换场上现有道具（随机落点）。
          // 仅子弹击杀触发掉落；grenade 群灭不掉落（在 powerup.ts 内直接置死，不经此分支）。
          if (t.carriesPowerup) dropPowerup(state);
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

// 玩家坦克被击毁：扣该玩家一条生命；若其仍有剩余则走 60 帧出生闪光复活（复用敌人出生机制，
// 而非即时瞬移），期间不可控/不可碰撞；若该玩家已无生命则保持死亡，交由 phase 判定 gameover。
function onPlayerKilled(state: GameState, t: TankState): void {
  const idx = t.playerIndex;
  state.livesByPlayer[idx]--;
  if (state.livesByPlayer[idx] > 0) {
    // 保留同一 id 与 playerIndex 以维持输入映射；进入出生闪光队列，与敌人共用 updateSpawning。
    state.spawning.push({ tank: createPlayer(idx, t.id), ticksLeft: SPAWN_FLASH_TICKS });
  }
}

// 推进爆炸计时，移除播放完毕者。
function advanceExplosions(state: GameState): void {
  for (const e of state.explosions) e.ticksLeft--;
  state.explosions = state.explosions.filter((e) => e.ticksLeft > 0);
}

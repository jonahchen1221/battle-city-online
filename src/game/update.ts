import { GameState, nextStage } from './state';
import { InputState, emptyInput } from '../core/types';
import { applyInput, TankState, EnemyKind, createPlayer, isPlayerTank } from './tank';
import {
  spawnWeaponBullets,
  liveBulletCount,
  maxBulletsFor,
  advanceBullets,
  resolveBulletBullet,
  bulletCanHit,
  bulletHitsTank,
  makeSmallExplosion,
} from './bullet';
import { updateEnemies } from './enemy';
import { updatePhase, resolveEagleHit, restartGame } from './phase';
import {
  tryPickupPowerup,
  dropPowerup,
  restoreEagleRingBrick,
  updateNeutralPowerups,
} from './powerup';
import {
  EXPLOSION_BIG_TICKS,
  EXPLOSION_BIG_SIZE,
  TANK_SIZE,
  BULLET_SIZE,
  SPAWN_FLASH_TICKS,
  ENEMY_SCORE,
  STAGE_START_TICKS,
  FRIENDLY_FREEZE_TICKS,
  MACHINE_FIRE_INTERVAL_TICKS,
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

  // 道具计时递减。timer：敌军冻结逐帧递减。hourglass：敌军半速逐帧递减。
  // shovel：钢化护墙逐帧递减，归零那帧恢复砖墙。
  if (state.enemyFreezeTicks > 0) state.enemyFreezeTicks--;
  if (state.enemySlowTicks > 0) state.enemySlowTicks--;
  if (state.shovelTicks > 0) {
    state.shovelTicks--;
    if (state.shovelTicks === 0) restoreEagleRingBrick(state);
  }

  // 中立道具定时刷新（每关必出 5 种新道具）：仅在 playing 期间推进。
  updateNeutralPowerups(state);

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

    // 限时移动类道具倒计时（boots 加速 / ghost 穿砖）：与护盾同样逐帧递减，
    // 冻结期间也照常流逝；死亡复活时由 createPlayer 重建而自然清零。
    if (tank.speedBoostTicks > 0) tank.speedBoostTicks--;
    if (tank.ghostTicks > 0) tank.ghostTicks--;

    // 友军冻结：被队友子弹击中后 freezeTicks>0，期间输入照常采样但一律不生效
    //（不能移动、不能开火），逐帧递减到 0 自动恢复。冻结中履带定格（moving=false）、冰面滑行中断。
    if (tank.freezeTicks > 0) {
      tank.freezeTicks--;
      tank.moving = false;
      tank.slideTicks = 0;
      tank.prevFire = input.fire; // 仍记录开火键状态：解冻那帧不会因一直按住而被判为边沿
      continue;
    }

    applyInput(tank, input, level, state.tanks);

    // 开火触发方式按武器区分：
    // - 机枪：按住连发（非边沿），由 fireCooldown 节流为每 MACHINE_FIRE_INTERVAL_TICKS 帧一发；
    // - 其余武器（含 cannon）：边沿触发 —— 本帧按下且上帧未按下。
    // 两者都还需满足在场子弹数低于该坦克上限（见 maxBulletsFor：star 双弹 / 各武器自有上限）。
    const firePressed = input.fire && !tank.prevFire;
    tank.prevFire = input.fire;
    if (tank.fireCooldown > 0) tank.fireCooldown--;
    const wantFire = tank.weapon === 'machine' ? input.fire && tank.fireCooldown === 0 : firePressed;
    if (wantFire && liveBulletCount(state.bullets, tank.id) < maxBulletsFor(tank)) {
      for (const b of spawnWeaponBullets(tank)) state.bullets.push(b);
      if (tank.weapon === 'machine') tank.fireCooldown = MACHINE_FIRE_INTERVAL_TICKS;
      state.events.push('playerFire'); // 仅玩家开火发声（敌弹静音，从简）
    }
  }
}

// 子弹 vs 坦克：按阵营命中，装甲坦克逐发扣血并闪烁，血尽爆炸；玩家被击即时复活。
// 激光（kind==='laser'）贯穿敌人：命中敌人照常扣血 / 记分 / 爆炸，但子弹不消亡，继续飞并可再命中后续敌人。
function resolveBulletTanks(state: GameState): void {
  for (const b of state.bullets) {
    if (!b.alive) continue;
    // 激光贯穿：不因命中敌人而消亡，也不 break —— 同一帧可穿过直线上的多台敌人。
    const pierces = b.kind === 'laser';
    for (const t of state.tanks) {
      if (!t.alive) continue;
      if (!bulletCanHit(b, t)) continue;
      if (!bulletHitsTank(b, t)) continue;

      // 友军火力（多人合作）：玩家弹命中队友 —— 不扣血、不记击杀、不产生大爆炸，
      // 改为把对方冻结 FRIENDLY_FREEZE_TICKS 帧；已在冻结中则刷新计时。
      // 子弹照常消亡并留下小火花（激光亦然：贯穿只对敌人生效）。
      if (!b.fromEnemy && isPlayerTank(t)) {
        b.alive = false;
        t.freezeTicks = FRIENDLY_FREEZE_TICKS;
        state.explosions.push(
          makeSmallExplosion(b.x + BULLET_SIZE / 2, b.y + BULLET_SIZE / 2),
        );
        state.events.push('explosionSmall');
        break;
      }

      if (!pierces) b.alive = false;

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
      if (!pierces) break;
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

  // 多人合作：生命耗尽者向队友“借命”——候选为其余生命 ≥2 条的玩家
  //（捐出一条后自己至少还剩 1 条给当前在场坦克，不会把队友一起拖死）。
  // 候选非空则由 state.rng 随机取一名捐赠者：捐赠者 -1、借命者 +1（回到 1 条）后照常复活；
  // 候选为空则维持死亡，交由 phase 判定 gameover。
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
    // 保留同一 id 与 playerIndex 以维持输入映射；进入出生闪光队列，与敌人共用 updateSpawning。
    state.spawning.push({ tank: createPlayer(idx, t.id), ticksLeft: SPAWN_FLASH_TICKS });
  }
}

// 推进爆炸计时，移除播放完毕者。
function advanceExplosions(state: GameState): void {
  for (const e of state.explosions) e.ticksLeft--;
  state.explosions = state.explosions.filter((e) => e.ticksLeft > 0);
}

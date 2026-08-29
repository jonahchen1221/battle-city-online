import { GameState, nextStage } from './state';
import { InputState, emptyInput } from '../core/types';
import { applyInput, EnemyKind, isPlayerTank } from './tank';
import {
  spawnWeaponBullets,
  liveBulletCount,
  maxBulletsFor,
  advanceBullets,
  resolveBulletBullet,
  bulletCanHit,
  bulletHitsTank,
  clearSpiralBlastBricks,
  makeSmallExplosion,
  spiralBlastRect,
} from './bullet';
import { updateEnemies } from './enemy';
import { collisionTanks, updateBoss, updateMines, resolveBulletBoss } from './boss';
import { updatePhase, resolveEagleHit, retryStage } from './phase';
import {
  tryPickupPowerup,
  dropPowerup,
  restoreEagleRingBrick,
  updateNeutralPowerups,
} from './powerup';
import {
  damagePlayerTank,
  dropDeathStar,
  onVersusEnemyKilled,
  pushBigExplosion,
} from './death';
import { resolveEscortHits, updateEscort } from './escort';
import {
  BULLET_SIZE,
  TANK_SIZE,
  ENEMY_SCORE,
  EXPLOSION_BIG_SIZE,
  EXPLOSION_BIG_TICKS,
  STAGE_START_TICKS,
  FRIENDLY_FREEZE_TICKS,
  MACHINE_FIRE_INTERVAL_TICKS,
  PLAYER_FIRE_INTERVAL_TICKS,
  FIRE_BUFFER_TICKS,
  DASH_TICKS,
  DASH_COOLDOWN_TICKS,
  DASH_READY_FLASH_TICKS,
  SMART_AI_INTERCEPT_RELOAD_TICKS,
} from '../core/constants';

// 每逻辑帧调用一次。纯函数式推进：只依赖 state 与 inputs，
// 不得访问 DOM、canvas、performance.now 或 Math.random。
// update 只做编排：坦克移动在 tank.ts，子弹/战斗在 bullet.ts，敌方 AI 在 enemy.ts，
// 阶段（胜负/重开）在 phase.ts。
export function update(
  state: GameState,
  inputs: InputState[],
  activePlayers?: readonly boolean[],
): void {
  state.tick++;
  if (activePlayers) {
    state.activePlayerCount = activePlayers.reduce(
      (count, active) => count + (active ? 1 : 0),
      0,
    );
  }

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
  // stageclear → 进入下一关（nextStage）；gameover → 恢复当前关卡的开局检查点（retryStage）。
  if (state.phase !== 'playing') {
    state.phaseTicks++;
    advanceExplosions(state);
    if (startEdge) {
      if (state.phase === 'stageclear') {
        nextStage(state);
      } else {
        retryStage(state);
      }
      // 检查点中的 prevStart 可能不是本帧输入状态；无论哪条分支，这里立即置回 true，
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

  // 道具与武器冷却计时递减。timer / hourglass 按阵营分别控制；shovel 仍是玩家基地钢化计时。
  // shovel：钢化护墙逐帧递减，归零那帧恢复砖墙。
  if (state.playerFreezeTicks > 0) state.playerFreezeTicks--;
  if (state.playerSlowTicks > 0) state.playerSlowTicks--;
  if (state.enemyFreezeTicks > 0) state.enemyFreezeTicks--;
  if (state.enemySlowTicks > 0) state.enemySlowTicks--;
  if (state.shovelTicks > 0) {
    state.shovelTicks--;
    if (state.shovelTicks === 0 && !state.escort) restoreEagleRingBrick(state);
  }
  advanceTankPowerupTimers(state);

  // 中立道具定时刷新（无水关排除船）：仅在 playing 期间推进。
  updateNeutralPowerups(state);

  // 玩家坦克由输入驱动：inputs[i] 对应 playerIndex===i 的坦克（按序号映射，非数组顺序）。
  updatePlayers(state, inputs);

  // 敌我各自在移动后拾取。
  tryPickupPowerup(state, 'player');

  // 敌方：出生闪光推进（含玩家复活）、AI 行进/开火、生成新敌人（Boss 关另含小兵补充）。
  updateEnemies(state, level);
  tryPickupPowerup(state, 'enemy');

  // Boss（仅 Boss 关）：炮塔转向、阶段转换、攻击状态机（弹幕出膛 / 激光逐帧判定）。
  updateBoss(state);

  // 推进子弹并结算地形碰撞（撞地形消失时产生小爆炸）。
  advanceBullets(level, state.bullets, state.explosions, state.events);

  // 战斗结算：子弹互撞相消、子弹命中鹰巢、子弹命中 Boss、子弹命中坦克。
  const interceptedEnemyOwners = resolveBulletBullet(
    state.bullets,
    state.explosions,
    state.events,
  );
  // 近距离对射时，普通 20 帧冷却会让智能坦克成功拦下一发后必吃玩家的下一发。
  // 对消只缩短智能坦克的装填，不影响传统敌军，也不凭空增加同时在场的弹量。
  if (interceptedEnemyOwners.size > 0) {
    for (const tank of state.tanks) {
      if (
        tank.alive &&
        tank.kind === 'smart' &&
        interceptedEnemyOwners.has(tank.id)
      ) {
        tank.fireCooldown = Math.min(
          tank.fireCooldown,
          SMART_AI_INTERCEPT_RELOAD_TICKS,
        );
      }
    }
  }
  resolveEagleHit(state);
  resolveBulletBoss(state);
  // Boss 地雷（仅第 6 位起的 Boss 会布雷）：武装 / 触雷 / 被子弹引爆 / 到期自爆。
  // 放在子弹推进之后，用的是本帧的最终弹道位置。
  updateMines(state);
  resolveEscortHits(state);
  resolveBulletTanks(state);
  // F 弹在所有直接碰撞结算之后统一爆燃：直接目标不会重复受伤，附近对手各结算一次。
  resolveSpiralBlasts(state);

  // 清理死亡子弹（其主人即可再次开火）与死亡坦克。
  state.bullets = state.bullets.filter((b) => b.alive);
  state.tanks = state.tanks.filter((t) => t.alive);

  // 推进爆炸计时，移除播放完毕的特效。
  advanceExplosions(state);

  // 移动鹰巢在战斗结算后前进：本帧刚清掉的路障/敌军会立即让它恢复行驶。
  updateEscort(state, activePlayers);

  // 阶段编排：检测鹰毁 / 玩家阵亡 / 全歼，武装并推进延迟结果。
  updatePhase(state);
}

// 个人型道具计时对敌我通用，即使坦克正被全局冻结也照常流逝。
function advanceTankPowerupTimers(state: GameState): void {
  for (const tank of state.tanks) {
    if (!tank.alive) continue;
    if (tank.invulnTicks > 0) tank.invulnTicks--;
    if (tank.speedBoostTicks > 0) tank.speedBoostTicks--;
    if (tank.ghostTicks > 0) tank.ghostTicks--;
    if (tank.fireCooldown > 0) {
      // 敌方射击冷却属于 AI 行动节拍：timer 冻结时暂停，hourglass 减速时仅在偶数 tick
      // 推进。否则智能坦克的确定性 20 帧冷却会在沙漏期间照常走完，实际射速完全不降。
      const enemyActionBlocked =
        !isPlayerTank(tank) &&
        (state.enemyFreezeTicks > 0 || (state.enemySlowTicks > 0 && state.tick % 2 !== 0));
      if (!enemyActionBlocked) tank.fireCooldown--;
    }
    if (tank.hitFlashTicks > 0) tank.hitFlashTicks--;
  }
}

// 玩家坦克：输入驱动移动 + 按住连续开火。
// 输入按 playerIndex 映射（inputs[tank.playerIndex]）：某玩家阵亡后其坦克缺席，
// 其余玩家的输入不会因数组塌缩而错位。
function updatePlayers(state: GameState, inputs: InputState[]): void {
  const level = state.level;
  // Boss 车体对玩家坦克同样是实心障碍（普通关时 obstacles 即 state.tanks 本身）。
  const obstacles = collisionTanks(state);
  for (const tank of state.tanks) {
    if (!isPlayerTank(tank)) continue;
    if (!tank.alive) continue;
    const input = inputs[tank.playerIndex] ?? emptyInput();

    // ── 冲刺（技能）──
    // 按下沿与冷却计时在冻结 / 半速跳帧期间照常推进：CD 不因被控而停摆，
    // 解冻那帧也不会因一直按住冲刺键而被误判为一次新按下（同 prevFire 的处理）。
    const dashPressed = input.dash && !tank.prevDash;
    tank.prevDash = input.dash;
    if (tank.dashCooldown > 0) {
      tank.dashCooldown--;
      // 冷却刚归零的那一帧装填“就绪黄闪”，仅供渲染层读取。
      if (tank.dashCooldown === 0) tank.dashReadyFlashTicks = DASH_READY_FLASH_TICKS;
    } else if (tank.dashReadyFlashTicks > 0) {
      tank.dashReadyFlashTicks--;
    }

    // 敌方 timer 阻止移动 / 开火；敌方 hourglass 让玩家隔帧行动。
    const personallyFrozen = tank.freezeTicks > 0;
    if (personallyFrozen) tank.freezeTicks--;
    const globallyFrozen = state.playerFreezeTicks > 0;
    const slowedSkip = !globallyFrozen && !personallyFrozen &&
      state.playerSlowTicks > 0 && state.tick % 2 !== 0;
    // 冻结取消冲刺：无论来自队友子弹还是敌方 timer，进行中的冲刺立即中止（CD 照走）。
    if (personallyFrozen || globallyFrozen) tank.dashTicks = 0;
    if (globallyFrozen || slowedSkip) {
      tank.moving = false;
      tank.slideTicks = 0;
      tank.prevFire = input.fire; // 仍记录开火键状态，供轻点缓冲的按下沿检测使用
      continue;
    }

    // 触发冲刺：按下沿 + CD 已好 + 不在冲刺中 + 未被冻结（全局冻结已在上方 continue）。
    if (dashPressed && tank.dashCooldown === 0 && tank.dashTicks === 0 && !personallyFrozen) {
      tank.dashTicks = DASH_TICKS;
      tank.dashCooldown = DASH_COOLDOWN_TICKS;
      state.events.push('dash');
    }

    // 友军冻结只封移动 / 转向、不封开火：被队友定住时仍可按被定住时的朝向原地输出。
    if (personallyFrozen) {
      tank.moving = false;
      tank.slideTicks = 0;
    } else {
      applyInput(tank, input, level, obstacles, state.escort ?? undefined);
    }

    // 所有武器都支持按住连发，并同时受“在场子弹上限 + 最短开火间隔”约束。
    // 前者保留远距离的经典弹位手感，后者防止贴脸时子弹瞬间消失导致射速逐帧上升。
    // 机枪使用自己的更长间隔，但允许更多子弹同时在场。
    // 同时保留短输入缓冲：轻点按下沿装填 FIRE_BUFFER_TICKS 帧，在弹位占满时提前点按也不会被吞掉。
    const firePressed = input.fire && !tank.prevFire;
    tank.prevFire = input.fire;
    if (tank.fireBufferTicks > 0) tank.fireBufferTicks--;
    if (firePressed) tank.fireBufferTicks = FIRE_BUFFER_TICKS;
    const heldFire = input.fire;
    const bufferedFire = tank.weapon !== 'machine' && tank.fireBufferTicks > 0;
    const wantFire = heldFire || bufferedFire;
    if (
      wantFire &&
      tank.fireCooldown === 0 &&
      liveBulletCount(state.bullets, tank.id) < maxBulletsFor(tank)
    ) {
      const spawned = spawnWeaponBullets(tank, state.nextBulletId, state.level);
      state.nextBulletId += spawned.length;
      for (const b of spawned) state.bullets.push(b);
      tank.fireCooldown = tank.weapon === 'machine'
        ? Math.max(PLAYER_FIRE_INTERVAL_TICKS, MACHINE_FIRE_INTERVAL_TICKS)
        : PLAYER_FIRE_INTERVAL_TICKS;
      tank.fireBufferTicks = 0; // 缓冲已兑现，避免同一次按键连发两发
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
      if (b.kind === 'spiral') b.spiralHitTankId = t.id;

      // 友军火力（多人合作）：玩家弹命中队友 —— 不扣血、不记击杀、不产生大爆炸，
      // 改为把对方冻结 FRIENDLY_FREEZE_TICKS 帧；已在冻结中则刷新计时。
      // 子弹照常消亡并留下小火花（激光亦然：贯穿只对敌人生效）。
      if (!b.fromEnemy && isPlayerTank(t)) {
        b.alive = false;
        t.freezeTicks = FRIENDLY_FREEZE_TICKS;
        if (b.kind !== 'spiral') {
          state.explosions.push(
            makeSmallExplosion(b.x + BULLET_SIZE / 2, b.y + BULLET_SIZE / 2),
          );
          state.events.push('explosionSmall');
        }
        break;
      }

      if (!pierces) b.alive = false;

      if (isPlayerTank(t)) {
        damagePlayerTank(state, t);
      } else {
        damageEnemyTank(state, t, b.ownerPlayerIndex);
      }
      // 装甲坦克 hp>0 时仅扣血（渲染层据 hp<ARMOR_HP 闪烁），子弹已消亡。
      if (!pierces) break;
    }
  }
}

// 敌方坦克的统一单次伤害入口，供直击与 F 弹范围炎爆复用，确保得分、携带道具和智能坦克掉星一致。
function damageEnemyTank(state: GameState, tank: GameState['tanks'][number], ownerPlayerIndex: number): void {
  if (!tank.alive || isPlayerTank(tank)) return;
  tank.hp--;
  if (tank.hp > 0) return;

  pushBigExplosion(state, tank);
  tank.alive = false;
  const kind = tank.kind as EnemyKind;
  if (ownerPlayerIndex >= 0) {
    state.scoreByPlayer[ownerPlayerIndex] += ENEMY_SCORE[kind];
    state.killsByPlayer[ownerPlayerIndex][kind]++;
  }
  state.events.push('explosionBig');
  if (tank.carriesPowerup) dropPowerup(state);
  if (tank.kind === 'smart') dropDeathStar(state, tank);
  onVersusEnemyKilled(state, tank);
}

// 所有本帧死亡且允许爆燃的 F 弹各产生一次 24×24 炎爆。伤害按阵营筛选：玩家 F 只炸敌军，
// 敌军 F 只炸玩家；护盾玩家免疫。直接命中的坦克 id 被排除，避免“核心 + 炎爆”重复扣血。
export function resolveSpiralBlasts(state: GameState): void {
  for (const b of state.bullets) {
    if (b.kind !== 'spiral' || b.alive || b.spiralDetonate === false) continue;
    b.spiralDetonate = false;
    clearSpiralBlastBricks(state.level, b);

    const blast = spiralBlastRect(b);
    const cx = b.x + BULLET_SIZE / 2;
    const cy = b.y + BULLET_SIZE / 2;
    state.explosions.push({
      x: cx - EXPLOSION_BIG_SIZE / 2,
      y: cy - EXPLOSION_BIG_SIZE / 2,
      ticksLeft: EXPLOSION_BIG_TICKS,
      big: true,
    });
    state.events.push('explosionBig');

    for (const tank of state.tanks) {
      if (!tank.alive || tank.id === b.spiralHitTankId) continue;
      if (blast.left >= tank.x + TANK_SIZE || blast.right <= tank.x) continue;
      if (blast.top >= tank.y + TANK_SIZE || blast.bottom <= tank.y) continue;
      if (b.fromEnemy) {
        if (!isPlayerTank(tank) || tank.invulnTicks > 0) continue;
        damagePlayerTank(state, tank);
      } else {
        if (isPlayerTank(tank)) continue;
        damageEnemyTank(state, tank, b.ownerPlayerIndex);
      }
    }
  }
}

// 推进爆炸计时，移除播放完毕者。
function advanceExplosions(state: GameState): void {
  for (const e of state.explosions) e.ticksLeft--;
  state.explosions = state.explosions.filter((e) => e.ticksLeft > 0);
}

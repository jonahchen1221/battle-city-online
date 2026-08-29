import { Direction, InputState, emptyInput } from '../core/types';
import { Rng } from '../core/rng';
import {
  SPAWN_FLASH_TICKS,
  AI_DECISION_MIN_TICKS,
  AI_DECISION_RANGE_TICKS,
  AI_FIRE_DENOM,
  maxEnemiesOnField,
  ENEMY_SPAWN_INTERVAL_TICKS,
  CARRIER_QUEUE_POSITIONS,
  FIELD_WIDTH,
  FIELD_HEIGHT,
  TANK_SIZE,
  SUBTILE,
  ENEMY_SPAWN_POINTS,
  spawnClusterXs,
  ENEMY_BERSERK_SPEED,
  ENEMY_BERSERK_BULLET_SPEED,
  ENEMY_BERSERK_FIRE_DENOM,
  ENEMY_BERSERK_MAX_BULLETS,
} from '../core/constants';
import { LevelState } from './level';
import {
  TankState,
  createEnemy,
  applyInput,
  turnTank,
  isPlayerTank,
  canTankOccupy,
} from './tank';
import { hasLiveBullet, liveBulletCount, spawnBullet } from './bullet';
import type { GameState } from './state';

// 敌方 AI + 生成器。纯逻辑：一切随机取自 state.rng，可复现。

// 把某个方向合成为一帧 InputState，交给 applyInput 复用玩家移动逻辑。
function driveInput(dir: Direction): InputState {
  const input = emptyInput();
  input[dir] = true;
  return input;
}

// 加权随机选向：偏向战场下方（基地一侧）。下 40% / 左 20% / 右 20% / 上 20%。
// 狂暴时更执着压向基地：下 60% / 左 20% / 右 10% / 上 10%。
function pickDirection(rng: Rng, berserk = false): Direction {
  if (berserk) {
    const r = rng.int(10);
    if (r < 6) return 'down';
    if (r < 8) return 'left';
    if (r === 8) return 'right';
    return 'up';
  }
  const r = rng.int(5); // 0,1→下(40%)  2→左  3→右  4→上
  if (r < 2) return 'down';
  if (r === 2) return 'left';
  if (r === 3) return 'right';
  return 'up';
}

// 重置 AI 决策计时：30–60 帧。
function resetDecisionTimer(rng: Rng): number {
  return AI_DECISION_MIN_TICKS + rng.int(AI_DECISION_RANGE_TICKS);
}

// 当前场上（含出生闪光中的）敌方坦克数量。出生队列现在也可能含玩家复活，需排除。
function enemyCount(state: GameState): number {
  let n = 0;
  for (const s of state.spawning) {
    if (!isPlayerTank(s.tank)) n++;
  }
  for (const t of state.tanks) {
    if (t.alive && !isPlayerTank(t)) n++;
  }
  return n;
}

// 随机出生点：在地图上半场（y ≤ FIELD_HEIGHT/2 − TANK_SIZE）按子格对齐随机取点，
// 要求地形可通行、不与在场坦克及出生闪光重叠。最多尝试 SPAWN_TRY_LIMIT 次，全失败返回 null
//（本帧放弃，由调用方短暂延时后重试 —— 不消耗出生队列）。
const SPAWN_TRY_LIMIT = 20;
const SPAWN_RETRY_TICKS = 30;
function pickSpawnSpot(state: GameState, tank: TankState): { x: number; y: number } | null {
  const xSlots = (FIELD_WIDTH - TANK_SIZE) / SUBTILE + 1; // 0..304，步长 8
  const ySlots = (FIELD_HEIGHT / 2 - TANK_SIZE) / SUBTILE + 1; // 0..104，步长 8（上半场）
  for (let i = 0; i < SPAWN_TRY_LIMIT; i++) {
    const x = state.rng.int(xSlots) * SUBTILE;
    const y = state.rng.int(ySlots) * SUBTILE;
    if (!canTankOccupy(tank, x, y, state.level, state.tanks)) continue;
    // 出生闪光中的坦克还不在 tanks 里，单独查重叠，避免两团闪光叠在同一点。
    const overlapsFlash = state.spawning.some(
      (s) => Math.abs(s.tank.x - x) < TANK_SIZE && Math.abs(s.tank.y - y) < TANK_SIZE,
    );
    if (overlapsFlash) continue;
    return { x, y };
  }
  return null;
}

// 候选落点是否被地形、在场坦克或出生闪光占用。
function spawnBlocked(state: GameState, tank: TankState, x: number, y: number): boolean {
  if (!canTankOccupy(tank, x, y, state.level, state.tanks)) return true;
  return state.spawning.some(
    (s) => Math.abs(s.tank.x - x) < TANK_SIZE && Math.abs(s.tank.y - y) < TANK_SIZE,
  );
}

function dequeueIntoFlash(state: GameState, tank: TankState): void {
  state.enemyQueue.shift();
  state.nextEnemyId++;
  // 出队计数（1 起）：第 4/11/18 台为“携带道具”者（红闪，死亡掉落）。按计数标记，不回看队列下标。
  state.enemiesDequeued++;
  if (CARRIER_QUEUE_POSITIONS.includes(state.enemiesDequeued)) {
    tank.carriesPowerup = true;
  }
  state.spawning.push({ tank, ticksLeft: SPAWN_FLASH_TICKS });
}

// 生成器：计时归零且场上有空位、队列非空时，四个出生点各齐射最多 5 台（进入出生闪光）。
// 每点沿顶行横向铺开；首选格被占则退回上半场随机探点。全失败则 SPAWN_RETRY_TICKS 后重试。
function updateSpawner(state: GameState): void {
  if (state.enemySpawnTimer > 0) state.enemySpawnTimer--;
  if (state.enemyQueue.length === 0) return;
  if (enemyCount(state) >= maxEnemiesOnField(state.playerCount)) return;
  if (state.enemySpawnTimer > 0) return;

  let spawnedAny = false;
  for (let spawnIndex = 0; spawnIndex < ENEMY_SPAWN_POINTS.length; spawnIndex++) {
    const ys = ENEMY_SPAWN_POINTS[spawnIndex].y;
    for (const x of spawnClusterXs(spawnIndex)) {
      if (state.enemyQueue.length === 0) break;
      if (enemyCount(state) >= maxEnemiesOnField(state.playerCount)) break;

      const tank = createEnemy(state.enemyQueue[0], state.nextEnemyId, spawnIndex);
      let spot: { x: number; y: number } | null = null;
      if (!spawnBlocked(state, tank, x, ys)) {
        spot = { x, y: ys };
      } else {
        spot = pickSpawnSpot(state, tank);
      }
      if (!spot) continue;

      tank.x = spot.x;
      tank.y = spot.y;
      dequeueIntoFlash(state, tank);
      spawnedAny = true;
    }
  }

  state.enemySpawnTimer = spawnedAny ? ENEMY_SPAWN_INTERVAL_TICKS : SPAWN_RETRY_TICKS;
}

// 本关只剩最后一台敌军（队列已空，场上含闪光恰好 1 台）时进入狂暴。
export function enrageLastEnemy(state: GameState): void {
  if (state.enemyQueue.length > 0) return;
  if (enemyCount(state) !== 1) return;

  let last: TankState | null = null;
  for (const t of state.tanks) {
    if (t.alive && !isPlayerTank(t)) {
      last = t;
      break;
    }
  }
  if (!last) {
    for (const s of state.spawning) {
      if (!isPlayerTank(s.tank)) {
        last = s.tank;
        break;
      }
    }
  }
  if (!last || last.berserk) return;
  last.berserk = true;
  last.speed = ENEMY_BERSERK_SPEED;
  last.bulletSpeed = ENEMY_BERSERK_BULLET_SPEED;
}

// 推进出生闪光：计时归零的坦克实体化（加入 tanks，此后可碰撞/受控）。
function updateSpawning(state: GameState, level: LevelState): void {
  const remaining: typeof state.spawning = [];
  for (const s of state.spawning) {
    s.ticksLeft--;
    if (s.ticksLeft <= 0) {
      // 出生点仍被占用时维持闪光末帧并逐帧重试。直接实体化会制造预先重叠，随后旧的
      // 单轴碰撞夹紧可能把任一坦克推到障碍另一侧，表现为瞬移。
      if (canTankOccupy(s.tank, s.tank.x, s.tank.y, level, state.tanks)) {
        state.tanks.push(s.tank);
      } else {
        s.ticksLeft = 1;
        remaining.push(s);
      }
    } else {
      remaining.push(s);
    }
  }
  state.spawning = remaining;
}

// 单台敌人的一帧 AI：沿当前方向行进；撞墙立即换向并沿新方向移动一次；
// 决策计时到点则仅转向（本帧已沿旧方向走过，避免一帧移动两次）。随机开火。
function updateOneEnemy(tank: TankState, state: GameState, level: LevelState): void {
  tank.aiTicks--;

  const px = tank.x;
  const py = tank.y;
  applyInput(tank, driveInput(tank.dir), level, state.tanks); // 沿当前方向前进一步
  const blocked = tank.x === px && tank.y === py;

  if (blocked) {
    // 撞墙/被坦克挡住：立即换向并沿新方向移动一次（上一步没动，不会双倍位移）。
    const nd = pickDirection(state.rng, tank.berserk);
    tank.aiTicks = resetDecisionTimer(state.rng);
    applyInput(tank, driveInput(nd), level, state.tanks);
  } else if (tank.aiTicks <= 0) {
    // 定时器到点：仅转向（含吸附），下一帧起沿新方向行进。
    const nd = pickDirection(state.rng, tank.berserk);
    tank.aiTicks = resetDecisionTimer(state.rng);
    turnTank(tank, nd, level, state.tanks);
  }

  // 随机开火：常规每帧约 1/AI_FIRE_DENOM 且场上无己弹；狂暴射速更高且最多两发在场。
  const fireDenom = tank.berserk ? ENEMY_BERSERK_FIRE_DENOM : AI_FIRE_DENOM;
  const canFire = tank.berserk
    ? liveBulletCount(state.bullets, tank.id) < ENEMY_BERSERK_MAX_BULLETS
    : !hasLiveBullet(state.bullets, tank.id);
  if (state.rng.int(fireDenom) === 0 && canFire) {
    state.bullets.push(spawnBullet(tank, state.nextBulletId++));
  }
}

// 敌方总编排：先推进出生闪光（实体化），再驱动全部在场敌人，最后尝试出生新敌人。
// 敌军行动门禁（两级，冻结优先于减速）：
//   • timer 道具冻结期间（enemyFreezeTicks>0）：跳过全部在场敌人的 AI（不动、不开火、履带冻结）；
//   • hourglass 道具减速期间（enemySlowTicks>0）：敌人仅在偶数 tick 行动 —— 移动 / AI 决策 / 开火
//     一并减半，即整体半速；已在场的敌弹不受影响（照常按自身速度飞行）。
// 两种情形下出生闪光与出生器都照常推进（经典表现）。子弹由 update 的 advanceBullets 继续推进。
export function updateEnemies(state: GameState, level: LevelState): void {
  updateSpawning(state, level);

  const frozen = state.enemyFreezeTicks > 0;
  const slowedSkip = !frozen && state.enemySlowTicks > 0 && state.tick % 2 !== 0;
  if (!frozen && !slowedSkip) {
    for (const tank of state.tanks) {
      if (!tank.alive || isPlayerTank(tank)) continue;
      updateOneEnemy(tank, state, level);
    }
  }

  updateSpawner(state);
  enrageLastEnemy(state);
}

import { Direction, InputState, emptyInput } from '../core/types';
import { Rng } from '../core/rng';
import {
  SPAWN_FLASH_TICKS,
  AI_DECISION_MIN_TICKS,
  AI_DECISION_RANGE_TICKS,
  AI_FIRE_DENOM,
  maxEnemiesOnField,
  enemySpawnIntervalForStage,
  CARRIER_QUEUE_POSITIONS,
  TANK_SIZE,
  SUBTILE,
  MACHINE_FIRE_INTERVAL_TICKS,
  BULLET_SIZE,
  EAGLE_COL,
  EAGLE_ROW,
  ESCORT_SIZE,
  ESCORT_ENEMY_COMBAT_HALF_WIDTH,
  ESCORT_ENEMY_COMBAT_AHEAD,
  ESCORT_ENEMY_COMBAT_BEHIND,
  ESCORT_ENEMY_RECYCLE_BEHIND,
  ESCORT_ENEMY_RECYCLE_TICKS,
  FIELD_WIDTH,
  FIELD_HEIGHT,
  SMART_AI_REPLAN_TICKS,
  SMART_AI_BRICK_COST,
  SMART_POWERUP_SEEK_RADIUS,
  BOSS_MINION_MAX,
  BOSS_MINION_INTERVAL_TICKS,
  BOSS_MINION_CARRIER_EVERY,
  BOSS_MINION_KINDS_A,
  BOSS_MINION_KINDS_B,
  BOSS_STAGES,
} from '../core/constants';
import { Cell, LevelState, getCell } from './level';
import {
  TankState,
  createEnemy,
  applyInput,
  turnTank,
  isPlayerTank,
  canTankOccupy,
} from './tank';
import { liveBulletCount, maxBulletsFor, spawnWeaponBullets } from './bullet';
import {
  canSmartTankPickup,
  type PowerupKind,
  type PowerupState,
} from './powerup';
import { collisionTanks } from './boss';
import type { GameState } from './state';
import type { EscortState } from './escort';

// 敌方 AI + 生成器。纯逻辑：一切随机取自 state.rng，可复现。

// 把某个方向合成为一帧 InputState，交给 applyInput 复用玩家移动逻辑。
function driveInput(dir: Direction): InputState {
  const input = emptyInput();
  input[dir] = true;
  return input;
}

// 加权随机选向：偏向战场下方（基地一侧）。下 40% / 左 20% / 右 20% / 上 20%。
function pickDirection(rng: Rng): Direction {
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

function escortForwardDistance(tank: TankState, escort: EscortState): number {
  const dx = tank.x + TANK_SIZE / 2 - (escort.x + ESCORT_SIZE / 2);
  const dy = tank.y + TANK_SIZE / 2 - (escort.y + ESCORT_SIZE / 2);
  switch (escort.dir) {
    case 'up': return -dy;
    case 'down': return dy;
    case 'left': return -dx;
    case 'right': return dx;
  }
}

// 护送关普通敌军的软战区。战区会随车辆转向；越界时只改变行驶意图，不传送。
function escortLeashDirection(tank: TankState, state: GameState): Direction | null {
  const escort = state.escort;
  if (!escort) return null;
  const tankCx = tank.x + TANK_SIZE / 2;
  const tankCy = tank.y + TANK_SIZE / 2;
  const escortCx = escort.x + ESCORT_SIZE / 2;
  const escortCy = escort.y + ESCORT_SIZE / 2;
  const forward = escortForwardDistance(tank, escort);

  if (forward < -ESCORT_ENEMY_COMBAT_BEHIND) return escort.dir;
  if (forward > ESCORT_ENEMY_COMBAT_AHEAD) return oppositeDirection(escort.dir);
  if (escort.dir === 'up' || escort.dir === 'down') {
    if (tankCx < escortCx - ESCORT_ENEMY_COMBAT_HALF_WIDTH) return 'right';
    if (tankCx > escortCx + ESCORT_ENEMY_COMBAT_HALF_WIDTH) return 'left';
  } else {
    if (tankCy < escortCy - ESCORT_ENEMY_COMBAT_HALF_WIDTH) return 'down';
    if (tankCy > escortCy + ESCORT_ENEMY_COMBAT_HALF_WIDTH) return 'up';
  }
  return null;
}

function tankVisibleToAnyPlayer(tank: TankState, state: GameState): boolean {
  const worldWidth = state.level.cols * SUBTILE;
  const worldHeight = state.level.rows * SUBTILE;
  const maxLeft = Math.max(0, worldWidth - FIELD_WIDTH);
  const maxTop = Math.max(0, worldHeight - FIELD_HEIGHT);
  const players = [
    ...state.tanks.filter((candidate) => candidate.alive && isPlayerTank(candidate)),
    ...state.spawning
      .map((spawn) => spawn.tank)
      .filter((candidate) => candidate.alive && isPlayerTank(candidate)),
  ];

  return players.some((player) => {
    const left = Math.max(0, Math.min(maxLeft, player.x + TANK_SIZE / 2 - FIELD_WIDTH / 2));
    const top = Math.max(0, Math.min(maxTop, player.y + TANK_SIZE / 2 - FIELD_HEIGHT / 2));
    return (
      tank.x < left + FIELD_WIDTH &&
      tank.x + TANK_SIZE > left &&
      tank.y < top + FIELD_HEIGHT &&
      tank.y + TANK_SIZE > top
    );
  });
}

const EAGLE_X = EAGLE_COL * SUBTILE;
const EAGLE_Y = EAGLE_ROW * SUBTILE;
const EAGLE_SIZE = 2 * SUBTILE;
const NAV_TANK_CELLS = TANK_SIZE / SUBTILE;

interface NavDirection {
  dir: Direction;
  dc: number;
  dr: number;
}

const NAV_DIRECTIONS: ReadonlyArray<NavDirection> = [
  { dir: 'up', dc: 0, dr: -1 },
  { dir: 'down', dc: 0, dr: 1 },
  { dir: 'left', dc: -1, dr: 0 },
  { dir: 'right', dc: 1, dr: 0 },
];

interface OpenNode {
  index: number;
  f: number;
  h: number;
}

function openNodeBefore(a: OpenNode, b: OpenNode): boolean {
  return a.f < b.f || (a.f === b.f && (a.h < b.h || (a.h === b.h && a.index < b.index)));
}

// A* 开放集使用确定性最小堆；同分时按离目标距离、再按网格下标排序，保证联机模拟可复现。
function pushOpen(heap: OpenNode[], node: OpenNode): void {
  heap.push(node);
  let i = heap.length - 1;
  while (i > 0) {
    const parent = Math.floor((i - 1) / 2);
    if (!openNodeBefore(heap[i], heap[parent])) break;
    [heap[i], heap[parent]] = [heap[parent], heap[i]];
    i = parent;
  }
}

function popOpen(heap: OpenNode[]): OpenNode | undefined {
  const first = heap[0];
  const last = heap.pop();
  if (heap.length > 0 && last) {
    heap[0] = last;
    let i = 0;
    while (true) {
      const left = i * 2 + 1;
      const right = left + 1;
      let best = i;
      if (left < heap.length && openNodeBefore(heap[left], heap[best])) best = left;
      if (right < heap.length && openNodeBefore(heap[right], heap[best])) best = right;
      if (best === i) break;
      [heap[i], heap[best]] = [heap[best], heap[i]];
      i = best;
    }
  }
  return first;
}

// 智能坦克会把砖看成“可清除但代价较高”的路面，把钢和鹰巢视为永久障碍；
// 拿到船后水面可通行，幽灵生效期间砖块按普通路面规划。
// 返回进入这个 8px 对齐位置的代价；16×16 车体覆盖的任一子格为永久障碍时不可进入。
function navigationCost(tank: TankState, level: LevelState, col: number, row: number): number {
  let hasBrick = false;
  for (let dr = 0; dr < NAV_TANK_CELLS; dr++) {
    for (let dc = 0; dc < NAV_TANK_CELLS; dc++) {
      const cell = getCell(level, col + dc, row + dr);
      if (cell === Cell.STEEL || cell === Cell.EAGLE) return Infinity;
      if (cell === Cell.WATER && !tank.hasBoat) return Infinity;
      if (cell === Cell.BRICK && tank.ghostTicks <= 0) hasBrick = true;
    }
  }
  return hasBrick ? SMART_AI_BRICK_COST : 1;
}

function manhattan(col: number, row: number, goalCol: number, goalRow: number): number {
  return Math.abs(goalCol - col) + Math.abs(goalRow - row);
}

// 在 8px 网格上以 A* 找到追向玩家的第一步。其他坦克是会移动的动态障碍，不写入路径图，
// 实际移动仍由 applyInput 做实体碰撞；若目标暂不可达，则走向已搜索到的最近可达点。
function findSmartDirection(
  tank: TankState,
  target: { x: number; y: number },
  level: LevelState,
): Direction | null {
  const navCols = level.cols - NAV_TANK_CELLS + 1;
  const navRows = level.rows - NAV_TANK_CELLS + 1;
  const clampCol = (x: number): number => Math.max(0, Math.min(navCols - 1, Math.round(x / SUBTILE)));
  const clampRow = (y: number): number => Math.max(0, Math.min(navRows - 1, Math.round(y / SUBTILE)));
  const startCol = clampCol(tank.x);
  const startRow = clampRow(tank.y);
  const goalCol = clampCol(target.x);
  const goalRow = clampRow(target.y);
  const startIndex = startRow * navCols + startCol;
  const goalIndex = goalRow * navCols + goalCol;
  const size = navCols * navRows;
  const costs = new Array<number>(size).fill(Infinity);
  const firstSteps = new Array<Direction | null>(size).fill(null);
  const closed = new Array<boolean>(size).fill(false);
  const open: OpenNode[] = [];
  const startH = manhattan(startCol, startRow, goalCol, goalRow);
  costs[startIndex] = 0;
  pushOpen(open, { index: startIndex, f: startH, h: startH });

  let closestIndex = startIndex;
  let closestH = startH;
  while (open.length > 0) {
    const current = popOpen(open)!;
    if (closed[current.index]) continue;
    closed[current.index] = true;
    const col = current.index % navCols;
    const row = Math.floor(current.index / navCols);
    if (
      current.h < closestH ||
      (current.h === closestH && costs[current.index] < costs[closestIndex])
    ) {
      closestIndex = current.index;
      closestH = current.h;
    }
    if (current.index === goalIndex) {
      closestIndex = current.index;
      break;
    }

    for (const step of NAV_DIRECTIONS) {
      const nextCol = col + step.dc;
      const nextRow = row + step.dr;
      if (nextCol < 0 || nextRow < 0 || nextCol >= navCols || nextRow >= navRows) continue;
      const stepCost = navigationCost(tank, level, nextCol, nextRow);
      if (!Number.isFinite(stepCost)) continue;
      const nextIndex = nextRow * navCols + nextCol;
      const nextCost = costs[current.index] + stepCost;
      if (nextCost >= costs[nextIndex]) continue;
      costs[nextIndex] = nextCost;
      firstSteps[nextIndex] = current.index === startIndex ? step.dir : firstSteps[current.index];
      const h = manhattan(nextCol, nextRow, goalCol, goalRow);
      pushOpen(open, { index: nextIndex, f: nextCost + h, h });
    }
  }

  return firstSteps[closestIndex];
}

// 多人局按直线距离选择最近存活玩家；完全同距时 playerIndex 小者优先，结果稳定可复现。
function nearestPlayer(tank: TankState, state: GameState): TankState | null {
  let target: TankState | null = null;
  let bestDistance = Infinity;
  for (const candidate of state.tanks) {
    if (!candidate.alive || !isPlayerTank(candidate)) continue;
    const dx = candidate.x - tank.x;
    const dy = candidate.y - tank.y;
    const distance = dx * dx + dy * dy;
    if (
      distance < bestDistance ||
      (distance === bestDistance && target !== null && candidate.playerIndex < target.playerIndex)
    ) {
      target = candidate;
      bestDistance = distance;
    }
  }
  return target;
}

// 严格优先级：无敌 > 合适武器 > 星星 > 修复 > 临时机动 > 船。
// 分数只用于当前坦克在自己拥有的候选中择优；同一道具的归属由距离单独决定。
const SMART_POWERUP_PRIORITY: Partial<Record<PowerupKind, number>> = {
  helmet: 8,
  wpnSpread: 7,
  wpnSpiral: 7,
  star: 6,
  wrench: 5,
  ghost: 4,
  boots: 3,
  boat: 2,
};
const SMART_POWERUP_SEEK_RADIUS_SQ = SMART_POWERUP_SEEK_RADIUS * SMART_POWERUP_SEEK_RADIUS;

function distanceSquared(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

// 每枚道具只由范围内最近的可用智能坦克认领；完全同距时 id 小者优先，保证模拟确定性。
function smartTankClaimsPowerup(tank: TankState, powerup: PowerupState, state: GameState): boolean {
  let owner: TankState | null = null;
  let ownerDistance = Infinity;
  for (const candidate of state.tanks) {
    if (!canSmartTankPickup(candidate, powerup.kind)) continue;
    const distance = distanceSquared(candidate, powerup);
    if (distance > SMART_POWERUP_SEEK_RADIUS_SQ) continue;
    if (
      distance < ownerDistance ||
      (distance === ownerDistance && owner !== null && candidate.id < owner.id)
    ) {
      owner = candidate;
      ownerDistance = distance;
    }
  }
  return owner?.id === tank.id;
}

function smartPowerupTarget(tank: TankState, state: GameState): PowerupState | null {
  let target: PowerupState | null = null;
  let bestPriority = -1;
  let bestDistance = Infinity;
  for (const powerup of state.powerups) {
    const priority = SMART_POWERUP_PRIORITY[powerup.kind];
    if (priority === undefined || !canSmartTankPickup(tank, powerup.kind)) continue;
    const distance = distanceSquared(tank, powerup);
    if (distance > SMART_POWERUP_SEEK_RADIUS_SQ) continue;
    if (!smartTankClaimsPowerup(tank, powerup, state)) continue;
    if (priority > bestPriority || (priority === bestPriority && distance < bestDistance)) {
      target = powerup;
      bestPriority = priority;
      bestDistance = distance;
    }
  }
  return target;
}

// 玩家中心进入炮口的 16px 直线走廊时，返回精确的瞄准方向。
function aimDirection(tank: TankState, target: TankState): Direction | null {
  const tankCx = tank.x + TANK_SIZE / 2;
  const tankCy = tank.y + TANK_SIZE / 2;
  const targetCx = target.x + TANK_SIZE / 2;
  const targetCy = target.y + TANK_SIZE / 2;
  if (Math.abs(tankCx - targetCx) <= TANK_SIZE / 2) {
    if (targetCy < tankCy) return 'up';
    if (targetCy > tankCy) return 'down';
  }
  if (Math.abs(tankCy - targetCy) <= TANK_SIZE / 2) {
    if (targetCx < tankCx) return 'left';
    if (targetCx > tankCx) return 'right';
  }
  return null;
}

function rangesOverlap(a0: number, a1: number, b0: number, b1: number): boolean {
  return a0 < b1 && a1 > b0;
}

// 只要炮弹沿当前射线继续飞行有可能触及鹰巢，就禁止智能坦克开火。该检查不依赖中间墙体，
// 因而即使砖墙稍后被其他炮弹打掉，已发射的智能坦克炮弹也不会误伤基地。
function shotThreatensEagle(tank: TankState, dir: Direction, state: GameState): boolean {
  if (state.boss || state.escort) return false; // 两种特殊关都没有固定鹰巢
  const cx = tank.x + TANK_SIZE / 2;
  const cy = tank.y + TANK_SIZE / 2;
  const halfBullet = BULLET_SIZE / 2;
  if (dir === 'up' || dir === 'down') {
    if (!rangesOverlap(cx - halfBullet, cx + halfBullet, EAGLE_X, EAGLE_X + EAGLE_SIZE)) {
      return false;
    }
    return dir === 'up' ? tank.y >= EAGLE_Y + EAGLE_SIZE : tank.y + TANK_SIZE <= EAGLE_Y;
  }
  if (!rangesOverlap(cy - halfBullet, cy + halfBullet, EAGLE_Y, EAGLE_Y + EAGLE_SIZE)) {
    return false;
  }
  return dir === 'left' ? tank.x >= EAGLE_X + EAGLE_SIZE : tank.x + TANK_SIZE <= EAGLE_X;
}

function fireSmartTank(tank: TankState, state: GameState): void {
  const canFire = tank.fireCooldown === 0 &&
    liveBulletCount(state.bullets, tank.id) < maxBulletsFor(tank);
  if (!canFire || shotThreatensEagle(tank, tank.dir, state)) return;
  const spawned = spawnWeaponBullets(tank, state.nextBulletId, state.level);
  state.nextBulletId += spawned.length;
  for (const bullet of spawned) state.bullets.push(bullet);
  if (tank.weapon === 'machine') tank.fireCooldown = MACHINE_FIRE_INTERVAL_TICKS;
}

function oppositeDirection(dir: Direction): Direction {
  switch (dir) {
    case 'up':
      return 'down';
    case 'down':
      return 'up';
    case 'left':
      return 'right';
    case 'right':
      return 'left';
  }
}

// 垂直↔水平转向可能因“最近 8px 吸附点”压到半砖而被拒绝。若仍原地重复同一规划，
// 智能坦克会永久死锁；此时先沿当前轴反向退出一小步，让下一帧能吸附到后方安全网格。
function recoverFromRejectedTurn(
  tank: TankState,
  state: GameState,
  obstacles: TankState[],
  level: LevelState,
): void {
  applyInput(
    tank,
    driveInput(oppositeDirection(tank.dir)),
    level,
    obstacles,
    state.escort ?? undefined,
  );
  tank.aiTicks = 0;
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

// 普通关在地图上半场随机出生；护送关改为在车队前方一个视口内出生，
// 要求地形可通行、不与在场坦克及出生闪光重叠。最多尝试 SPAWN_TRY_LIMIT 次，全失败返回 null
//（本帧放弃，由调用方短暂延时后重试 —— 不消耗出生队列）。
const SPAWN_TRY_LIMIT = 20;
const SPAWN_RETRY_TICKS = 30;
function pickSpawnSpot(
  state: GameState,
  tank: TankState,
  obstacles: TankState[],
): { x: number; y: number } | null {
  const worldWidth = state.level.cols * SUBTILE;
  const worldHeight = state.level.rows * SUBTILE;
  let minX = 0;
  let maxX = worldWidth - TANK_SIZE;
  let minY = 0;
  let maxY = worldHeight / 2 - TANK_SIZE;
  if (state.escort) {
    const escort = state.escort;
    switch (escort.dir) {
      case 'up':
        minX = Math.max(0, escort.x - 160);
        maxX = Math.min(worldWidth - TANK_SIZE, escort.x + 160);
        minY = Math.max(0, escort.y - 180);
        maxY = Math.max(minY, Math.min(worldHeight - TANK_SIZE, escort.y - 48));
        break;
      case 'down':
        minX = Math.max(0, escort.x - 160);
        maxX = Math.min(worldWidth - TANK_SIZE, escort.x + 160);
        minY = Math.min(worldHeight - TANK_SIZE, escort.y + ESCORT_SIZE + 16);
        maxY = Math.max(minY, Math.min(worldHeight - TANK_SIZE, escort.y + ESCORT_SIZE + 148));
        break;
      case 'left':
        minX = Math.max(0, escort.x - 180);
        maxX = Math.max(minX, Math.min(worldWidth - TANK_SIZE, escort.x - 48));
        minY = Math.max(0, escort.y - 160);
        maxY = Math.min(worldHeight - TANK_SIZE, escort.y + 160);
        break;
      case 'right':
        minX = Math.min(worldWidth - TANK_SIZE, escort.x + ESCORT_SIZE + 16);
        maxX = Math.max(minX, Math.min(worldWidth - TANK_SIZE, escort.x + ESCORT_SIZE + 148));
        minY = Math.max(0, escort.y - 160);
        maxY = Math.min(worldHeight - TANK_SIZE, escort.y + 160);
        break;
    }
  }
  minX = Math.ceil(minX / SUBTILE) * SUBTILE;
  maxX = Math.floor(maxX / SUBTILE) * SUBTILE;
  minY = Math.ceil(minY / SUBTILE) * SUBTILE;
  maxY = Math.floor(maxY / SUBTILE) * SUBTILE;
  const xSlots = Math.floor((maxX - minX) / SUBTILE) + 1;
  const ySlots = Math.floor((maxY - minY) / SUBTILE) + 1;
  for (let i = 0; i < SPAWN_TRY_LIMIT; i++) {
    const x = minX + state.rng.int(xSlots) * SUBTILE;
    const y = minY + state.rng.int(ySlots) * SUBTILE;
    // obstacles 含 Boss 车体伪坦克；escort 作为 32×32 独立阻挡体传入。
    if (!canTankOccupy(tank, x, y, state.level, obstacles, state.escort ?? undefined)) continue;
    if (
      state.escort &&
      x < state.escort.x + ESCORT_SIZE &&
      x + TANK_SIZE > state.escort.x &&
      y < state.escort.y + ESCORT_SIZE &&
      y + TANK_SIZE > state.escort.y
    ) continue;
    // 出生闪光中的坦克还不在 tanks 里，单独查重叠，避免两团闪光叠在同一点。
    const overlapsFlash = state.spawning.some(
      (s) => Math.abs(s.tank.x - x) < TANK_SIZE && Math.abs(s.tank.y - y) < TANK_SIZE,
    );
    if (overlapsFlash) continue;
    return { x, y };
  }
  return null;
}

// 生成器：计时归零且场上有空位、队列非空时，取队首出生（进入出生闪光）。
// 出生点在上半场随机（见 pickSpawnSpot）；找不到可用落点则 SPAWN_RETRY_TICKS 后重试。
// 所有敌军出生完毕后停止（胜负判定属后续任务）。
function updateSpawner(state: GameState, obstacles: TankState[]): void {
  if (state.enemySpawnTimer > 0) state.enemySpawnTimer--;
  if (state.enemyQueue.length === 0) return;
  if (enemyCount(state) >= maxEnemiesOnField(state.playerCount)) return;
  if (state.enemySpawnTimer > 0) return;

  // 先用队首种类探点（不出队）：探不到落点时队列原样保留。
  const tank = createEnemy(state.enemyQueue[0], state.nextEnemyId, 0);
  const spot = pickSpawnSpot(state, tank, obstacles);
  if (!spot) {
    state.enemySpawnTimer = SPAWN_RETRY_TICKS;
    return;
  }
  tank.x = spot.x;
  tank.y = spot.y;
  state.enemyQueue.shift();
  state.nextEnemyId++;
  // 出队计数（1 起）：第 4/11/18 台为“携带道具”者（红闪，死亡掉落）。按计数标记，不回看队列下标。
  state.enemiesDequeued++;
  if (CARRIER_QUEUE_POSITIONS.includes(state.enemiesDequeued)) {
    tank.carriesPowerup = true;
  }
  state.spawning.push({ tank, ticksLeft: SPAWN_FLASH_TICKS });
  // 出生节奏随关号加快（190 → 90 帧，见 constants enemySpawnIntervalForStage）。
  state.enemySpawnTimer = enemySpawnIntervalForStage(state.stage);
}

// 推进出生闪光：计时归零的坦克实体化（加入 tanks，此后可碰撞/受控）。
function updateSpawning(state: GameState, level: LevelState, obstacles: TankState[]): void {
  const remaining: typeof state.spawning = [];
  for (const s of state.spawning) {
    s.ticksLeft--;
    if (s.ticksLeft <= 0) {
      // 出生点仍被占用时维持闪光末帧并逐帧重试。直接实体化会制造预先重叠，随后旧的
      // 单轴碰撞夹紧可能把任一坦克推到障碍另一侧，表现为瞬移。
      if (
        canTankOccupy(
          s.tank,
          s.tank.x,
          s.tank.y,
          level,
          obstacles,
          state.escort ?? undefined,
        )
      ) {
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

// 仅护送关：普通敌军若远远落在车辆后方且连续不在任何玩家视野内，就以同一实体、同一血量
// 和携带状态重新进入前方出生闪光。这样不会在玩家眼前消失，也不会永久占住场上敌军名额。
function recycleEscapedEscortEnemies(state: GameState): void {
  const escort = state.escort;
  if (!escort) return;
  const recycledIds = new Set<number>();

  for (const tank of state.tanks) {
    if (!tank.alive || isPlayerTank(tank) || tank.kind === 'smart') {
      tank.escortFarTicks = 0;
      continue;
    }
    const farBehind = escortForwardDistance(tank, escort) < -ESCORT_ENEMY_RECYCLE_BEHIND;
    if (!farBehind || tankVisibleToAnyPlayer(tank, state)) {
      tank.escortFarTicks = 0;
      continue;
    }

    tank.escortFarTicks++;
    if (tank.escortFarTicks < ESCORT_ENEMY_RECYCLE_TICKS) continue;
    const spot = pickSpawnSpot(state, tank, collisionTanks(state));
    if (!spot) continue;

    tank.x = spot.x;
    tank.y = spot.y;
    tank.dir = 'down';
    tank.moving = false;
    tank.aiTicks = AI_DECISION_MIN_TICKS;
    tank.escortFarTicks = 0;
    tank.slideTicks = 0;
    state.spawning.push({ tank, ticksLeft: SPAWN_FLASH_TICKS });
    recycledIds.add(tank.id);
  }

  if (recycledIds.size === 0) return;
  state.tanks = state.tanks.filter((tank) => !recycledIds.has(tank.id));
  for (const bullet of state.bullets) {
    if (recycledIds.has(bullet.ownerId)) bullet.alive = false;
  }
}

// 单台敌人的一帧 AI：沿当前方向行进；撞墙立即换向并沿新方向移动一次；
// 决策计时到点则仅转向（本帧已沿旧方向走过，避免一帧移动两次）。随机开火。
function updateOneEnemy(
  tank: TankState,
  state: GameState,
  level: LevelState,
  obstacles: TankState[],
): void {
  tank.aiTicks--;
  const leashDir = escortLeashDirection(tank, state);

  const px = tank.x;
  const py = tank.y;
  applyInput(
    tank,
    driveInput(leashDir ?? tank.dir),
    level,
    obstacles,
    state.escort ?? undefined,
  );
  const blocked = tank.x === px && tank.y === py;

  if (blocked) {
    // 撞墙/被坦克挡住：立即换向并沿新方向移动一次（上一步没动，不会双倍位移）。
    const nd = pickDirection(state.rng);
    tank.aiTicks = resetDecisionTimer(state.rng);
    applyInput(tank, driveInput(nd), level, obstacles, state.escort ?? undefined);
  } else if (leashDir) {
    // 越界期间持续折返，不允许随机决策再次把它带离车辆战区。
    tank.aiTicks = AI_DECISION_MIN_TICKS;
  } else if (tank.aiTicks <= 0) {
    // 定时器到点：仅转向（含吸附），下一帧起沿新方向行进。
    const nd = pickDirection(state.rng);
    tank.aiTicks = resetDecisionTimer(state.rng);
    turnTank(tank, nd, level, obstacles, state.escort ?? undefined);
  }

  // 随机开火：拾取 star 或特殊武器后，弹量、弹型与冷却均沿用通用武器规则。
  const canFire = tank.fireCooldown === 0 &&
    liveBulletCount(state.bullets, tank.id) < maxBulletsFor(tank);
  if (state.rng.int(AI_FIRE_DENOM) === 0 && canFire) {
    const spawned = spawnWeaponBullets(tank, state.nextBulletId, state.level);
    state.nextBulletId += spawned.length;
    for (const bullet of spawned) state.bullets.push(bullet);
    if (tank.weapon === 'machine') tank.fireCooldown = MACHINE_FIRE_INTERVAL_TICKS;
  }
}

// 智能坦克：锁定最近玩家，以 A* 主动追踪；玩家进入直线火力走廊后停车瞄准并持续压制。
// 撞上路径中的砖墙时向规划方向清障。所有开火都经过鹰巢射线检查，不参与传统的随机向下攻击。
function updateSmartEnemy(
  tank: TankState,
  state: GameState,
  level: LevelState,
  obstacles: TankState[],
): void {
  const target = nearestPlayer(tank, state);
  const powerupTarget = smartPowerupTarget(tank, state);
  if (!target && !powerupTarget) {
    tank.moving = false;
    return;
  }

  tank.aiTicks--;
  if (target) {
    const aim = aimDirection(tank, target);
    if (aim !== null && !shotThreatensEagle(tank, aim, state)) {
      tank.moving = false;
      // 转向必然生效（吸附不可用时原地转车头，见 tank.ts turnTank），转完即可开火压制。
      turnTank(tank, aim, level, obstacles, state.escort ?? undefined);
      fireSmartTank(tank, state);
      return;
    }
  }

  const chaseTarget = powerupTarget ?? target!;

  let desired = tank.dir;
  if (tank.aiTicks <= 0) {
    desired = findSmartDirection(tank, chaseTarget, level) ?? desired;
    tank.aiTicks = SMART_AI_REPLAN_TICKS;
  }

  const px = tank.x;
  const py = tank.y;
  applyInput(tank, driveInput(desired), level, obstacles, state.escort ?? undefined);
  if (tank.dir !== desired) {
    recoverFromRejectedTurn(tank, state, obstacles, level);
    return;
  }
  if (tank.x !== px || tank.y !== py) return;

  // 动态障碍或砖墙使本步失败：立即重算。若替代首步存在则原地转向并尝试；仍失败时开炮清障。
  tank.aiTicks = SMART_AI_REPLAN_TICKS;
  const retry = findSmartDirection(tank, chaseTarget, level);
  if (retry !== null && retry !== desired) {
    applyInput(tank, driveInput(retry), level, obstacles, state.escort ?? undefined);
    if (tank.dir !== retry) {
      recoverFromRejectedTurn(tank, state, obstacles, level);
      return;
    }
    if (tank.x !== px || tank.y !== py) return;
  }
  fireSmartTank(tank, state);
}

// 敌方总编排：先推进出生闪光（实体化），再驱动全部在场敌人，最后尝试出生新敌人。
// 敌军行动门禁（两级，冻结优先于减速）：
//   • timer 道具冻结期间（enemyFreezeTicks>0）：跳过全部在场敌人的 AI（不动、不开火、履带冻结）；
//   • hourglass 道具减速期间（enemySlowTicks>0）：敌人仅在偶数 tick 行动 —— 移动 / AI 决策 / 开火
//     一并减半，即整体半速；已在场的敌弹不受影响（照常按自身速度飞行）。
// 两种情形下出生闪光与出生器都照常推进（经典表现）。子弹由 update 的 advanceBullets 继续推进。
export function updateEnemies(state: GameState, level: LevelState): void {
  // 本帧的移动占位数组：场上坦克 + Boss 车体（Boss 关才有，普通关即 state.tanks 本身）。
  const obstacles = collisionTanks(state);
  updateSpawning(state, level, obstacles);
  recycleEscapedEscortEnemies(state);

  const frozen = state.enemyFreezeTicks > 0;
  const slowedSkip = !frozen && state.enemySlowTicks > 0 && state.tick % 2 !== 0;
  if (!frozen && !slowedSkip) {
    for (const tank of state.tanks) {
      if (!tank.alive || isPlayerTank(tank)) continue;
      if (tank.kind === 'smart') updateSmartEnemy(tank, state, level, obstacles);
      else updateOneEnemy(tank, state, level, obstacles);
    }
  }

  updateSpawner(state, obstacles);
  updateBossMinions(state, obstacles);
}

// ── Boss 关小兵补充器 ──
// Boss 关的 STAGE_ENEMY_MIX 为空数组（不走有限队列），改由此处无限补充：
// 场上至多 BOSS_MINION_MAX 只、每 BOSS_MINION_INTERVAL_TICKS 帧一只，
// 种类按关（A：basic/fast；B：power/smart 对半随机），每第 BOSS_MINION_CARRIER_EVERY 只携带道具。
// Boss 已死时停止补充（此时正在走 stageclear 延迟）。落点沿用 pickSpawnSpot 的上半场随机采样。
function updateBossMinions(state: GameState, obstacles: TankState[]): void {
  const boss = state.boss;
  if (!boss || boss.dead) return;
  if (boss.minionTimer > 0) boss.minionTimer--;
  if (enemyCount(state) >= BOSS_MINION_MAX) return;
  if (boss.minionTimer > 0) return;

  // 关号决定种类池：最终战（BOSS_STAGES 最后一档）用 B 池，其余 Boss 关用 A 池。
  const pool =
    state.stage === BOSS_STAGES[BOSS_STAGES.length - 1] ? BOSS_MINION_KINDS_B : BOSS_MINION_KINDS_A;
  const kind = pool[state.rng.int(pool.length)];
  const tank = createEnemy(kind, state.nextEnemyId, 0);
  const spot = pickSpawnSpot(state, tank, obstacles);
  if (!spot) {
    boss.minionTimer = SPAWN_RETRY_TICKS;
    return;
  }
  tank.x = spot.x;
  tank.y = spot.y;
  state.nextEnemyId++;
  boss.minionsSpawned++;
  if (boss.minionsSpawned % BOSS_MINION_CARRIER_EVERY === 0) {
    tank.carriesPowerup = true;
  }
  state.spawning.push({ tank, ticksLeft: SPAWN_FLASH_TICKS });
  boss.minionTimer = BOSS_MINION_INTERVAL_TICKS;
}

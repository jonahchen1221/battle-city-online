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
  ESCORT_STOPPED_SPAWN_DIVISOR,
  FIELD_WIDTH,
  FIELD_HEIGHT,
  SMART_AI_REPLAN_TICKS,
  SMART_AI_STUCK_TICKS,
  SMART_AI_ESCAPE_TICKS,
  SMART_AI_FIRE_COOLDOWN_TICKS,
  SMART_AI_BRICK_COST,
  SMART_AI_DODGE_LOOKAHEAD_TICKS,
  SMART_AI_DODGE_COMMIT_TICKS,
  SMART_AI_FIRING_MIN_DISTANCE,
  SMART_AI_FIRING_IDEAL_DISTANCE,
  SMART_AI_FIRING_MAX_DISTANCE,
  SMART_AI_FIRING_DISTANCE_STEP,
  SMART_AI_FLANK_SIDE_COST,
  SMART_AI_FIRING_BRICK_PENALTY,
  SMART_POWERUP_SEEK_RADIUS,
  SPIRAL_RADIUS,
  SPIRAL_PERIOD_TICKS,
  bossMinionsOnField,
  BOSS_MINION_INTERVAL_TICKS,
  BOSS_MINION_CARRIER_EVERY,
  bossMinionKindsForStage,
  STAGE_ENEMY_TOTAL,
  isVersusStage,
} from '../core/constants';
import { Cell, LevelState, brickMaskOverlapsRect, getCell } from './level';
import {
  TankState,
  createEnemy,
  applyInput,
  turnTank,
  isPlayerTank,
  canTankOccupy,
} from './tank';
import {
  liveBulletCount,
  maxBulletsFor,
  spawnWeaponBullets,
  type BulletState,
} from './bullet';
import {
  canSmartTankPickup,
  type PowerupKind,
  type PowerupState,
} from './powerup';
import { collisionTanks } from './boss';
import { createStageEnemyQueue, type GameState } from './state';
import type { EscortState } from './escort';

// 敌方 AI + 生成器。纯逻辑：一切随机取自 state.rng，可复现。

// 把某个方向合成为一帧 InputState，交给 applyInput 复用玩家移动逻辑。
function driveInput(dir: Direction): InputState {
  const input = emptyInput();
  input[dir] = true;
  return input;
}

// 地形碰撞为避免浮点边界抖动保留约 1e-6px 的容差；AI 若直接用严格相等判断，会把
// 贴墙二分产生的微小残值误认成“成功移动”。统一在这里过滤并回滚这种幽灵位移。
const SMART_MOVE_EPSILON = 1e-4;
function smartMoved(tank: TankState, fromX: number, fromY: number): boolean {
  const moved =
    Math.abs(tank.x - fromX) > SMART_MOVE_EPSILON ||
    Math.abs(tank.y - fromY) > SMART_MOVE_EPSILON;
  if (!moved) {
    tank.x = fromX;
    tank.y = fromY;
  }
  return moved;
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

interface SmartNavigationTarget {
  x: number;
  y: number;
  id?: number;
}

function navigationBoxesOverlap(
  ax: number,
  ay: number,
  aw: number,
  ah: number,
  bx: number,
  by: number,
  bw: number,
  bh: number,
): boolean {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

interface PredictedBulletFrame {
  tick: number;
  x: number;
  y: number;
}

interface SmartBulletThreat {
  bullet: BulletState;
  hitTick: number;
  trajectories: PredictedBulletTrajectory[];
}

interface PredictedBulletTrajectory {
  frames: PredictedBulletFrame[];
}

function predictedBulletPosition(
  bullet: BulletState,
  ticks: number,
): { x: number; y: number } {
  let x = bullet.x + bullet.vx * ticks;
  let y = bullet.y + bullet.vy * ticks;
  if (bullet.kind !== 'spiral') return { x, y };

  const w = (2 * Math.PI) / SPIRAL_PERIOD_TICKS;
  const offset =
    (Math.sin((bullet.age + ticks) * w) - Math.sin(bullet.age * w)) * SPIRAL_RADIUS;
  switch (bullet.dir) {
    case 'up':
      x += offset;
      break;
    case 'down':
      x -= offset;
      break;
    case 'left':
      y -= offset;
      break;
    case 'right':
      y += offset;
      break;
  }
  return { x, y };
}

// 预判只读地形，不真的开砖。普通弹碰到砖/钢即结束；激光可穿砖，带钻头的激光也可穿钢。
// 鹰巢、边界、Boss 与护送车都能在子弹抵达智能坦克前把它截住，因此可作为可信掩体。
function predictedBulletBlocked(
  bullet: BulletState,
  state: GameState,
  x: number,
  y: number,
): boolean {
  if (
    bullet.viewportBounds &&
    (x < bullet.viewportBounds.left ||
      y < bullet.viewportBounds.top ||
      x + BULLET_SIZE > bullet.viewportBounds.right ||
      y + BULLET_SIZE > bullet.viewportBounds.bottom)
  ) return true;
  if (
    state.escort &&
    navigationBoxesOverlap(
      x,
      y,
      BULLET_SIZE,
      BULLET_SIZE,
      state.escort.x,
      state.escort.y,
      ESCORT_SIZE,
      ESCORT_SIZE,
    )
  ) return true;
  if (
    state.boss &&
    !state.boss.dead &&
    navigationBoxesOverlap(
      x,
      y,
      BULLET_SIZE,
      BULLET_SIZE,
      state.boss.x,
      state.boss.y,
      state.boss.size,
      state.boss.size,
    )
  ) return true;

  const c0 = Math.floor(x / SUBTILE);
  const c1 = Math.floor((x + BULLET_SIZE - 1e-6) / SUBTILE);
  const r0 = Math.floor(y / SUBTILE);
  const r1 = Math.floor((y + BULLET_SIZE - 1e-6) / SUBTILE);
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      const cell = getCell(state.level, col, row);
      if (cell === Cell.BRICK) {
        if (
          bullet.kind !== 'laser' &&
          brickMaskOverlapsRect(
            state.level,
            col,
            row,
            x,
            y,
            x + BULLET_SIZE,
            y + BULLET_SIZE,
          )
        ) return true;
        continue;
      }
      if (cell === Cell.STEEL) {
        const inField = col >= 0 && row >= 0 && col < state.level.cols && row < state.level.rows;
        if (bullet.kind !== 'laser' || !bullet.steelPiercing || !inField) return true;
      } else if (cell === Cell.EAGLE) {
        return true;
      }
    }
  }
  return false;
}

// 与真实子弹推进一致，把高速弹一帧的路径拆成至多 4px 的采样段，避免激光越过薄掩体。
function predictBulletFrames(
  bullet: BulletState,
  state: GameState,
): PredictedBulletFrame[] {
  const frames: PredictedBulletFrame[] = [];
  let previous = { x: bullet.x, y: bullet.y };
  for (let tick = 1; tick <= SMART_AI_DODGE_LOOKAHEAD_TICKS; tick++) {
    const next = predictedBulletPosition(bullet, tick);
    const dx = next.x - previous.x;
    const dy = next.y - previous.y;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / BULLET_SIZE));
    let blocked = false;
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      if (
        predictedBulletBlocked(
          bullet,
          state,
          previous.x + dx * t,
          previous.y + dy * t,
        )
      ) {
        blocked = true;
        break;
      }
    }
    if (blocked) break;
    frames.push({ tick, x: next.x, y: next.y });
    previous = next;
  }
  return frames;
}

function bulletFrameHitsTank(
  frame: PredictedBulletFrame,
  tank: { x: number; y: number },
): boolean {
  return navigationBoxesOverlap(
    frame.x,
    frame.y,
    BULLET_SIZE,
    BULLET_SIZE,
    tank.x,
    tank.y,
    TANK_SIZE,
    TANK_SIZE,
  );
}

function imminentSmartBulletThreat(
  tank: TankState,
  state: GameState,
): SmartBulletThreat | null {
  if (tank.invulnTicks > 0) return null;
  const trajectories: PredictedBulletTrajectory[] = [];
  let threatBullet: BulletState | null = null;
  let threatTick = Infinity;
  for (const bullet of state.bullets) {
    if (!bullet.alive || bullet.fromEnemy) continue;
    const frames = predictBulletFrames(bullet, state);
    trajectories.push({ frames });
    const hit = frames.find((frame) => bulletFrameHitsTank(frame, tank));
    if (!hit) continue;
    if (
      threatBullet === null ||
      hit.tick < threatTick ||
      (hit.tick === threatTick && bullet.id < threatBullet.id)
    ) {
      threatBullet = bullet;
      threatTick = hit.tick;
    }
  }
  return threatBullet === null
    ? null
    : { bullet: threatBullet, hitTick: threatTick, trajectories };
}

function dodgeDirectionOrder(tank: TankState, bullet: BulletState): [Direction, Direction] {
  const tankCx = tank.x + TANK_SIZE / 2;
  const tankCy = tank.y + TANK_SIZE / 2;
  const bulletCx = bullet.x + BULLET_SIZE / 2;
  const bulletCy = bullet.y + BULLET_SIZE / 2;
  if (Math.abs(bullet.vy) >= Math.abs(bullet.vx)) {
    if (bulletCx > tankCx) return ['left', 'right'];
    if (bulletCx < tankCx) return ['right', 'left'];
    return tank.id % 2 === 0 ? ['left', 'right'] : ['right', 'left'];
  }
  if (bulletCy > tankCy) return ['up', 'down'];
  if (bulletCy < tankCy) return ['down', 'up'];
  return tank.id % 2 === 0 ? ['up', 'down'] : ['down', 'up'];
}

interface DodgeCandidate {
  dir: Direction;
  hitTick: number;
  distance: number;
}

// 对来弹的两个垂直方向都做短期沙盘：复用真实移动/碰撞，选择能把首次命中推得最晚、
// 且拥有更大净空的一侧。完全同分沿用上面的“远离弹心 + id 奇偶”稳定顺序。
function smartDodgeDirection(
  tank: TankState,
  threat: SmartBulletThreat,
  state: GameState,
  level: LevelState,
  obstacles: TankState[],
): Direction | null {
  let best: DodgeCandidate | null = null;
  for (const dir of dodgeDirectionOrder(tank, threat.bullet)) {
    const probe = { ...tank };
    const probeObstacles = obstacles.map((obstacle) => obstacle === tank ? probe : obstacle);
    let firstMoved = false;
    let hitTick = Infinity;
    for (let tick = 1; tick <= SMART_AI_DODGE_LOOKAHEAD_TICKS; tick++) {
      const beforeX = probe.x;
      const beforeY = probe.y;
      applyInput(probe, driveInput(dir), level, probeObstacles, state.escort ?? undefined);
      if (tick === 1) firstMoved = smartMoved(probe, beforeX, beforeY);
      const hit = threat.trajectories.some((trajectory) => {
        const frame = trajectory.frames[tick - 1];
        return frame !== undefined && bulletFrameHitsTank(frame, probe);
      });
      if (hit) {
        hitTick = tick;
        break;
      }
    }
    if (!firstMoved) continue;
    const candidate = {
      dir,
      hitTick,
      distance: Math.abs(probe.x - tank.x) + Math.abs(probe.y - tank.y),
    };
    if (
      best === null ||
      candidate.hitTick > best.hitTick ||
      (candidate.hitTick === best.hitTick && candidate.distance > best.distance)
    ) best = candidate;
  }
  // 只晚一两帧被击中不算有效闪避：至少要换来一个完整机动窗口，否则留在原地反击。
  return best && best.hitTick >= threat.hitTick + SMART_AI_DODGE_COMMIT_TICKS
    ? best.dir
    : null;
}

// A* 把其他坦克、Boss 伪坦克与护送车作为本次规划的动态实心占位。追踪目标玩家本身除外，
// 否则目标节点永远不可达；最终贴近目标仍由实体碰撞与瞄准逻辑裁决。
function dynamicNavigationBlocked(
  tank: TankState,
  target: SmartNavigationTarget,
  col: number,
  row: number,
  obstacles: TankState[],
  escort?: EscortState,
): boolean {
  const x = col * SUBTILE;
  const y = row * SUBTILE;
  for (const obstacle of obstacles) {
    if (
      obstacle === tank ||
      !obstacle.alive ||
      (target.id !== undefined && obstacle.id === target.id)
    ) continue;
    if (
      navigationBoxesOverlap(
        x,
        y,
        TANK_SIZE,
        TANK_SIZE,
        obstacle.x,
        obstacle.y,
        TANK_SIZE,
        TANK_SIZE,
      )
    ) return true;
  }
  return escort !== undefined && navigationBoxesOverlap(
    x,
    y,
    TANK_SIZE,
    TANK_SIZE,
    escort.x,
    escort.y,
    ESCORT_SIZE,
    ESCORT_SIZE,
  );
}

// 在 8px 网格上以 A* 找到追向玩家的第一步。地形决定长期通路，其他坦克等动态占位也参与
// 本次搜索；若目标暂不可达，则走向已搜索到的最近可达点。
function findSmartDirection(
  tank: TankState,
  target: SmartNavigationTarget,
  level: LevelState,
  obstacles: TankState[],
  escort?: EscortState,
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
      if (dynamicNavigationBlocked(tank, target, nextCol, nextRow, obstacles, escort)) continue;
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

type SmartFiringSide = Direction;

interface SmartFiringCandidate {
  col: number;
  row: number;
  index: number;
  x: number;
  y: number;
  side: SmartFiringSide;
  distance: number;
  shotPath: SmartShotPath;
}

interface SmartFiringPlan {
  dir: Direction | null;
  x: number;
  y: number;
  side: SmartFiringSide;
}

const SMART_FIRING_SIDES: ReadonlyArray<SmartFiringSide> = [
  'left',
  'right',
  'up',
  'down',
];

// id 将同一批智能坦克稳定分散到目标四周；多人局再叠加 playerIndex，避免换目标后仍整队同侧。
function preferredSmartFiringSide(tank: TankState, target: TankState): SmartFiringSide {
  const index = Math.abs(tank.id + target.playerIndex) % SMART_FIRING_SIDES.length;
  return SMART_FIRING_SIDES[index];
}

function smartFiringSideCost(side: SmartFiringSide, preferred: SmartFiringSide): number {
  if (side === preferred) return 0;
  if (side === oppositeDirection(preferred)) return SMART_AI_FLANK_SIDE_COST / 2;
  return SMART_AI_FLANK_SIDE_COST;
}

function smartFiringCandidate(
  tank: TankState,
  target: TankState,
  state: GameState,
  level: LevelState,
  obstacles: TankState[],
  navCols: number,
  navRows: number,
  targetCol: number,
  targetRow: number,
  side: SmartFiringSide,
  distance: number,
): SmartFiringCandidate | null {
  const cells = distance / SUBTILE;
  let col = targetCol;
  let row = targetRow;
  if (side === 'left') col -= cells;
  else if (side === 'right') col += cells;
  else if (side === 'up') row -= cells;
  else row += cells;
  if (col < 0 || row < 0 || col >= navCols || row >= navRows) return null;
  // 射击位本身必须能立即站住；沿途砖块仍由后面的 Dijkstra 以较高代价纳入路线。
  if (navigationCost(tank, level, col, row) > 1) return null;

  const x = col * SUBTILE;
  const y = row * SUBTILE;
  const navTarget = { x: target.x, y: target.y };
  if (
    dynamicNavigationBlocked(
      tank,
      navTarget,
      col,
      row,
      obstacles,
      state.escort ?? undefined,
    )
  ) return null;

  const probe = { ...tank, x, y };
  const aim = aimDirection(probe, target);
  if (aim === null || shotThreatensEagle(probe, aim, state)) return null;
  probe.dir = aim;
  const shotPath = smartShotPath(probe, target, aim, state);
  if (shotPath === 'hard') return null;
  return {
    col,
    row,
    index: row * navCols + col,
    x,
    y,
    side,
    distance,
    shotPath,
  };
}

// 一次 Dijkstra 同时得到全部候选射击位的真实路径代价。这样钢墙、水面、动态占位和可清砖
// 都参与决策，而不是只按直线距离挑一个看似很近、实际到不了的位置。
function findSmartFiringPlan(
  tank: TankState,
  target: TankState,
  state: GameState,
  level: LevelState,
  obstacles: TankState[],
): SmartFiringPlan | null {
  const navCols = level.cols - NAV_TANK_CELLS + 1;
  const navRows = level.rows - NAV_TANK_CELLS + 1;
  const clampCol = (x: number): number => Math.max(0, Math.min(navCols - 1, Math.round(x / SUBTILE)));
  const clampRow = (y: number): number => Math.max(0, Math.min(navRows - 1, Math.round(y / SUBTILE)));
  const startCol = clampCol(tank.x);
  const startRow = clampRow(tank.y);
  const targetCol = clampCol(target.x);
  const targetRow = clampRow(target.y);
  const startIndex = startRow * navCols + startCol;
  const size = navCols * navRows;
  const candidates: SmartFiringCandidate[] = [];
  const seen = new Set<number>();
  for (const side of SMART_FIRING_SIDES) {
    for (
      let distance = SMART_AI_FIRING_MIN_DISTANCE;
      distance <= SMART_AI_FIRING_MAX_DISTANCE;
      distance += SMART_AI_FIRING_DISTANCE_STEP
    ) {
      const candidate = smartFiringCandidate(
        tank,
        target,
        state,
        level,
        obstacles,
        navCols,
        navRows,
        targetCol,
        targetRow,
        side,
        distance,
      );
      if (!candidate || seen.has(candidate.index)) continue;
      seen.add(candidate.index);
      candidates.push(candidate);
    }
  }
  if (candidates.length === 0) return null;

  const costs = new Array<number>(size).fill(Infinity);
  const firstSteps = new Array<Direction | null>(size).fill(null);
  const closed = new Array<boolean>(size).fill(false);
  const open: OpenNode[] = [];
  const navTarget = { x: target.x, y: target.y };
  costs[startIndex] = 0;
  pushOpen(open, { index: startIndex, f: 0, h: 0 });
  while (open.length > 0) {
    const current = popOpen(open)!;
    if (closed[current.index]) continue;
    closed[current.index] = true;
    const col = current.index % navCols;
    const row = Math.floor(current.index / navCols);
    for (const step of NAV_DIRECTIONS) {
      const nextCol = col + step.dc;
      const nextRow = row + step.dr;
      if (nextCol < 0 || nextRow < 0 || nextCol >= navCols || nextRow >= navRows) continue;
      const stepCost = navigationCost(tank, level, nextCol, nextRow);
      if (!Number.isFinite(stepCost)) continue;
      if (
        dynamicNavigationBlocked(
          tank,
          navTarget,
          nextCol,
          nextRow,
          obstacles,
          state.escort ?? undefined,
        )
      ) continue;
      const nextIndex = nextRow * navCols + nextCol;
      const nextCost = costs[current.index] + stepCost;
      if (nextCost >= costs[nextIndex]) continue;
      costs[nextIndex] = nextCost;
      firstSteps[nextIndex] = current.index === startIndex ? step.dir : firstSteps[current.index];
      pushOpen(open, { index: nextIndex, f: nextCost, h: 0 });
    }
  }

  const preferred = preferredSmartFiringSide(tank, target);
  let best: SmartFiringCandidate | null = null;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    const routeCost = costs[candidate.index];
    if (!Number.isFinite(routeCost)) continue;
    const rangeCost =
      Math.abs(candidate.distance - SMART_AI_FIRING_IDEAL_DISTANCE) / SUBTILE;
    const brickCost = candidate.shotPath === 'brick' ? SMART_AI_FIRING_BRICK_PENALTY : 0;
    const score =
      routeCost +
      rangeCost +
      smartFiringSideCost(candidate.side, preferred) +
      brickCost;
    if (
      score < bestScore ||
      (score === bestScore && best !== null && candidate.index < best.index)
    ) {
      best = candidate;
      bestScore = score;
    }
  }
  if (!best) return null;
  return {
    dir: firstSteps[best.index],
    x: best.x,
    y: best.y,
    side: best.side,
  };
}

// 对战关先按席位一一分配对手，避免 N 台 AI 全部追着同一名玩家。
// 自己的对位玩家暂时不在场时，才按 AI 席位均匀分流到其他存活目标上参与包抄。
function versusAssignedPlayer(tank: TankState, state: GameState): TankState | null {
  if (!isVersusStage(state.stage) || tank.versusIndex < 0) return null;
  const players = state.tanks
    .filter((candidate) => candidate.alive && isPlayerTank(candidate))
    .sort((a, b) => a.playerIndex - b.playerIndex);
  if (players.length === 0) return null;
  const assigned = players.find((candidate) => candidate.playerIndex === tank.versusIndex);
  return assigned ?? players[tank.versusIndex % players.length];
}

// 普通多人局按直线距离选择最近存活玩家；完全同距时 playerIndex 小者优先，结果稳定可复现。
function nearestPlayer(tank: TankState, state: GameState): TankState | null {
  const assigned = versusAssignedPlayer(tank, state);
  if (assigned) return assigned;
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
  tank: 9,
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

interface ShotCorridor {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

type SmartShotPath = 'clear' | 'brick' | 'hard';

// 从炮口到目标车体近侧边缘的 4px 弹道走廊。目标本身不纳入走廊，避免把目标脚下地形
// 误判为“目标前方障碍”。aimDirection 已保证目标位于 dir 对应的前方。
function shotCorridorToTarget(
  tank: TankState,
  target: TankState,
  dir: Direction,
): ShotCorridor {
  const cx = tank.x + TANK_SIZE / 2;
  const cy = tank.y + TANK_SIZE / 2;
  const halfBullet = BULLET_SIZE / 2;
  switch (dir) {
    case 'up':
      return {
        x0: cx - halfBullet,
        y0: target.y + TANK_SIZE,
        x1: cx + halfBullet,
        y1: tank.y,
      };
    case 'down':
      return {
        x0: cx - halfBullet,
        y0: tank.y + TANK_SIZE,
        x1: cx + halfBullet,
        y1: target.y,
      };
    case 'left':
      return {
        x0: target.x + TANK_SIZE,
        y0: cy - halfBullet,
        x1: tank.x,
        y1: cy + halfBullet,
      };
    case 'right':
      return {
        x0: tank.x + TANK_SIZE,
        y0: cy - halfBullet,
        x1: target.x,
        y1: cy + halfBullet,
      };
  }
}

function corridorOverlapsBox(
  corridor: ShotCorridor,
  box: { x: number; y: number },
  size: number,
): boolean {
  return (
    rangesOverlap(corridor.x0, corridor.x1, box.x, box.x + size) &&
    rangesOverlap(corridor.y0, corridor.y1, box.y, box.y + size)
  );
}

// 瞄准射线分类：砖可由智能坦克原地射穿；钢、鹰巢、护送车与 Boss 无法由小兵炮弹清除，
// 必须放弃“停车压制”并回到 A* / 动态障碍脱困流程。护送车只检查目标之前的线段，
// 因此玩家站在车前时可以正常被射击，玩家在车后时才会触发绕路。
function smartShotPath(
  tank: TankState,
  target: TankState,
  dir: Direction,
  state: GameState,
): SmartShotPath {
  const corridor = shotCorridorToTarget(tank, target, dir);
  if (corridor.x1 <= corridor.x0 || corridor.y1 <= corridor.y0) return 'clear';
  if (state.escort && corridorOverlapsBox(corridor, state.escort, ESCORT_SIZE)) return 'hard';
  if (
    state.boss &&
    !state.boss.dead &&
    corridorOverlapsBox(corridor, state.boss, state.boss.size)
  ) return 'hard';

  const c0 = Math.floor(corridor.x0 / SUBTILE);
  const c1 = Math.ceil(corridor.x1 / SUBTILE) - 1;
  const r0 = Math.floor(corridor.y0 / SUBTILE);
  const r1 = Math.ceil(corridor.y1 / SUBTILE) - 1;
  let brick = false;
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      const cell = getCell(state.level, col, row);
      if (cell === Cell.STEEL || cell === Cell.EAGLE) return 'hard';
      if (
        cell === Cell.BRICK &&
        brickMaskOverlapsRect(
          state.level,
          col,
          row,
          corridor.x0,
          corridor.y0,
          corridor.x1,
          corridor.y1,
        )
      ) brick = true;
    }
  }
  return brick ? 'brick' : 'clear';
}

// 只要炮弹沿当前射线继续飞行有可能触及鹰巢，就禁止智能坦克开火。该检查不依赖中间墙体，
// 因而即使砖墙稍后被其他炮弹打掉，已发射的智能坦克炮弹也不会误伤基地。
function shotThreatensEagle(tank: TankState, dir: Direction, state: GameState): boolean {
  if (state.boss || state.escort || isVersusStage(state.stage)) return false; // 特殊关没有固定鹰巢
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

// 护送车是不可摧毁的实体障碍。智能坦克若朝车体所在射线开火，炮弹只会立即被吸收，
// 不应把这种“快速腾出弹位”的情况误当成可以连续压制玩家。
function shotThreatensEscort(tank: TankState, dir: Direction, state: GameState): boolean {
  const escort = state.escort;
  if (!escort) return false;
  const cx = tank.x + TANK_SIZE / 2;
  const cy = tank.y + TANK_SIZE / 2;
  const halfBullet = BULLET_SIZE / 2;
  if (dir === 'up' || dir === 'down') {
    if (
      !rangesOverlap(
        cx - halfBullet,
        cx + halfBullet,
        escort.x,
        escort.x + ESCORT_SIZE,
      )
    ) return false;
    return dir === 'up'
      ? tank.y >= escort.y + ESCORT_SIZE
      : tank.y + TANK_SIZE <= escort.y;
  }
  if (
    !rangesOverlap(
      cy - halfBullet,
      cy + halfBullet,
      escort.y,
      escort.y + ESCORT_SIZE,
    )
  ) return false;
  return dir === 'left'
    ? tank.x >= escort.x + ESCORT_SIZE
    : tank.x + TANK_SIZE <= escort.x;
}

function fireSmartTank(
  tank: TankState,
  state: GameState,
  targetPath?: SmartShotPath,
): boolean {
  const canFire = tank.fireCooldown === 0 &&
    liveBulletCount(state.bullets, tank.id) < maxBulletsFor(tank);
  if (
    !canFire ||
    shotThreatensEagle(tank, tank.dir, state) ||
    (targetPath === undefined
      ? shotThreatensEscort(tank, tank.dir, state)
      : targetPath === 'hard')
  ) return false;
  const spawned = spawnWeaponBullets(tank, state.nextBulletId, state.level);
  state.nextBulletId += spawned.length;
  for (const bullet of spawned) state.bullets.push(bullet);
  tank.fireCooldown = Math.max(MACHINE_FIRE_INTERVAL_TICKS, SMART_AI_FIRE_COOLDOWN_TICKS);
  return true;
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

// A* 刻意不把坦克写进静态路径图，因此多台智能坦克追同一目标时可能选择同一条车道。
// 卡住后优先尝试两个侧向，再尝试后退；id 奇偶让相邻智能坦克倾向不同侧，减少再次互堵。
function smartEscapeDirections(blockedDir: Direction, tankId: number): Direction[] {
  const sides: [Direction, Direction] =
    blockedDir === 'up' || blockedDir === 'down' ? ['left', 'right'] : ['up', 'down'];
  if (tankId % 2 !== 0) sides.reverse();
  return [sides[0], sides[1], oppositeDirection(blockedDir)];
}

function beginSmartEscape(
  tank: TankState,
  blockedDir: Direction,
  state: GameState,
  level: LevelState,
  obstacles: TankState[],
): boolean {
  for (const dir of smartEscapeDirections(blockedDir, tank.id)) {
    // 先用纯数据副本探一步，避免失败候选反复改变真实坦克的朝向或吸附坐标。
    const probe = { ...tank };
    const probeObstacles = obstacles.map((obstacle) => obstacle === tank ? probe : obstacle);
    applyInput(probe, driveInput(dir), level, probeObstacles, state.escort ?? undefined);
    if (!smartMoved(probe, tank.x, tank.y)) continue;

    applyInput(tank, driveInput(dir), level, obstacles, state.escort ?? undefined);
    tank.smartStuckTicks = 0;
    tank.smartEscapeTicks = SMART_AI_ESCAPE_TICKS;
    tank.aiTicks = 0;
    return true;
  }
  // 四周确实封死时继续按原逻辑射击清障，稍后再尝试脱困。
  tank.smartStuckTicks = 0;
  return false;
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
  // 护送关以抵达终点为胜利条件，因此原始 20 台耗尽后循环本关编成，持续保持沿途战斗。
  // 普通关仍保留有限队列与全歼过关规则。
  if (
    state.enemyQueue.length === 0 &&
    state.escort &&
    !state.escort.arrived &&
    !state.escort.timeExpired
  ) {
    state.enemyQueue.push(...createStageEnemyQueue(state.stage));
  }

  const spawnTimerAdvances =
    !state.escort ||
    state.escort.moving ||
    state.tick % ESCORT_STOPPED_SPAWN_DIVISOR === 0;
  if (state.enemySpawnTimer > 0 && spawnTimerAdvances) state.enemySpawnTimer--;
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
  const cyclePosition = ((state.enemiesDequeued - 1) % STAGE_ENEMY_TOTAL) + 1;
  if (CARRIER_QUEUE_POSITIONS.includes(cyclePosition)) {
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

// 仅护送关：任意敌军若远远落在车辆后方且连续不在任何玩家视野内，就以同一实体、同一血量
// 和携带状态重新进入前方出生闪光。这样不会在玩家眼前消失，也不会永久占住场上敌军名额。
function recycleEscapedEscortEnemies(state: GameState): void {
  const escort = state.escort;
  if (!escort) return;
  const recycledIds = new Set<number>();

  for (const tank of state.tanks) {
    if (!tank.alive || isPlayerTank(tank)) {
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
    tank.smartStuckTicks = 0;
    tank.smartEscapeTicks = 0;
    tank.smartGoalX = -1;
    tank.smartGoalY = -1;
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

function clearSmartFiringGoal(tank: TankState): void {
  tank.smartGoalX = -1;
  tank.smartGoalY = -1;
}

function smartFiringGoalReached(tank: TankState): boolean {
  return (
    tank.smartGoalX >= 0 &&
    tank.smartGoalY >= 0 &&
    Math.abs(tank.x - tank.smartGoalX) <= SUBTILE / 2 &&
    Math.abs(tank.y - tank.smartGoalY) <= SUBTILE / 2
  );
}

function planSmartMovement(
  tank: TankState,
  target: TankState | null,
  powerupTarget: PowerupState | null,
  state: GameState,
  level: LevelState,
  obstacles: TankState[],
): Direction | null {
  if (powerupTarget) {
    clearSmartFiringGoal(tank);
    return findSmartDirection(
      tank,
      powerupTarget,
      level,
      obstacles,
      state.escort ?? undefined,
    );
  }
  if (!target) {
    clearSmartFiringGoal(tank);
    return null;
  }

  const firingPlan = findSmartFiringPlan(tank, target, state, level, obstacles);
  if (firingPlan) {
    tank.smartGoalX = firingPlan.x;
    tank.smartGoalY = firingPlan.y;
    return firingPlan.dir;
  }
  clearSmartFiringGoal(tank);
  return findSmartDirection(
    tank,
    target,
    level,
    obstacles,
    state.escort ?? undefined,
  );
}

// 智能坦克：锁定最近玩家，规划可达的中距离射击位并按 id 分散到不同侧翼。
// 途中遇到火力线会机会射击；若尚未抵达战术位，装填期间继续包抄而不是原地露头等待。
function updateSmartEnemy(
  tank: TankState,
  state: GameState,
  level: LevelState,
  obstacles: TankState[],
): void {
  const bulletThreat = imminentSmartBulletThreat(tank, state);
  if (bulletThreat) {
    const dodge = smartDodgeDirection(tank, bulletThreat, state, level, obstacles);
    if (dodge !== null) {
      applyInput(tank, driveInput(dodge), level, obstacles, state.escort ?? undefined);
      tank.smartStuckTicks = 0;
      // 复用局部机动保持计时：弹道刚与车体分离时仍继续侧移，避免下一帧追踪回头送死。
      tank.smartEscapeTicks = SMART_AI_DODGE_COMMIT_TICKS;
      tank.aiTicks = 0;
      return;
    }
  }

  const target = nearestPlayer(tank, state);
  const powerupTarget = smartPowerupTarget(tank, state);
  if (!target && !powerupTarget) {
    tank.moving = false;
    tank.smartStuckTicks = 0;
    tank.smartEscapeTicks = 0;
    clearSmartFiringGoal(tank);
    return;
  }

  // 脱困一旦开始就保持方向足够久，避免刚侧移一帧又被 A* 拉回原拥堵车道。
  if (tank.smartEscapeTicks > 0) {
    const px = tank.x;
    const py = tank.y;
    applyInput(tank, driveInput(tank.dir), level, obstacles, state.escort ?? undefined);
    if (smartMoved(tank, px, py)) {
      tank.smartEscapeTicks--;
      tank.smartStuckTicks = 0;
      if (tank.smartEscapeTicks === 0) tank.aiTicks = 0;
      return;
    }
    tank.smartEscapeTicks = 0;
    tank.aiTicks = 0;
  }

  tank.aiTicks--;
  let desired = tank.dir;
  if (tank.aiTicks <= 0) {
    desired = planSmartMovement(
      tank,
      target,
      powerupTarget,
      state,
      level,
      obstacles,
    ) ?? desired;
    tank.aiTicks = SMART_AI_REPLAN_TICKS;
  }

  if (target) {
    const aim = aimDirection(tank, target);
    if (aim !== null && !shotThreatensEagle(tank, aim, state)) {
      const targetPath = smartShotPath(tank, target, aim, state);
      if (targetPath !== 'hard') {
        const atFiringGoal = !powerupTarget && smartFiringGoalReached(tank);
        const readyToFire = tank.fireCooldown === 0 &&
          liveBulletCount(state.bullets, tank.id) < maxBulletsFor(tank);
        // 路过火力线但尚未装填好时不反复转头，否则横向吸附会把每帧侧移重置成 0.75px。
        if (readyToFire || atFiringGoal) {
          tank.moving = false;
          tank.smartStuckTicks = 0;
          tank.smartEscapeTicks = 0;
          // 转向必然生效（吸附不可用时原地转车头，见 tank.ts turnTank），转完即可开火压制。
          turnTank(tank, aim, level, obstacles, state.escort ?? undefined);
          if (fireSmartTank(tank, state, targetPath)) {
            // 路过的射线只打一发就继续包抄；抵达选定射击位后才稳定压制。
            if (!atFiringGoal) tank.aiTicks = 0;
            return;
          }
          if (atFiringGoal) return;
        }
      }
    }
  }

  // 玩家移动后，旧射击位可能不再形成火力线；到点却无法瞄准时立即更新目标位。
  if (!powerupTarget && target && smartFiringGoalReached(tank)) {
    desired = planSmartMovement(
      tank,
      target,
      null,
      state,
      level,
      obstacles,
    ) ?? desired;
    tank.aiTicks = SMART_AI_REPLAN_TICKS;
  }

  const px = tank.x;
  const py = tank.y;
  applyInput(tank, driveInput(desired), level, obstacles, state.escort ?? undefined);
  if (smartMoved(tank, px, py)) {
    tank.smartStuckTicks = 0;
    return;
  }

  // 动态障碍或砖墙使本步失败：立即重算。若替代首步存在则原地转向并尝试；仍失败时开炮清障。
  tank.aiTicks = SMART_AI_REPLAN_TICKS;
  const retry = planSmartMovement(
    tank,
    target,
    powerupTarget,
    state,
    level,
    obstacles,
  );
  let blockedDir = desired;
  if (retry !== null && retry !== desired) {
    blockedDir = retry;
    applyInput(tank, driveInput(retry), level, obstacles, state.escort ?? undefined);
    if (smartMoved(tank, px, py)) {
      tank.smartStuckTicks = 0;
      return;
    }
  }
  tank.smartStuckTicks++;
  if (
    tank.smartStuckTicks >= SMART_AI_STUCK_TICKS &&
    beginSmartEscape(tank, blockedDir, state, level, obstacles)
  ) return;
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
// Boss 关不走有限出生队列（enemyQueue 为空），改由此处无限补充：
// 场上上限按人数为 2 / 3 / 4 / 5，每 BOSS_MINION_INTERVAL_TICKS 帧补一只，
// 种类按关（A：basic/fast；B：power/smart 对半随机），每第 BOSS_MINION_CARRIER_EVERY 只携带道具。
// Boss 已死时停止补充（此时正在走 stageclear 延迟）。落点沿用 pickSpawnSpot 的上半场随机采样。
function updateBossMinions(state: GameState, obstacles: TankState[]): void {
  const boss = state.boss;
  if (!boss || boss.dead) return;
  if (boss.minionTimer > 0) boss.minionTimer--;
  if (enemyCount(state) >= bossMinionsOnField(state.playerCount)) return;
  if (boss.minionTimer > 0) return;

  // 关号决定种类池（与 summon 技能共用同一张表）：最终战用 B 池，其余 Boss 关用 A 池。
  const pool = bossMinionKindsForStage(state.stage);
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

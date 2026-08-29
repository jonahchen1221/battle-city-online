import { Direction, InputState } from '../core/types';
import {
  SUBTILE,
  TANK_SIZE,
  PLAYER_SPEED,
  PLAYER_SPEED_UPGRADED,
  PLAYER_MAX_LEVEL,
  PLAYER_SPAWN_POINTS,
  BULLET_SPEED,
  ENEMY_SPEED_BASIC,
  ENEMY_SPEED_FAST,
  ENEMY_SPEED_POWER,
  ENEMY_SPEED_ARMOR,
  ENEMY_SPEED_SMART,
  ENEMY_HP_DEFAULT,
  ARMOR_HP,
  ENEMY_BULLET_SPEED_POWER,
  ENEMY_BULLET_SPEED_DEFAULT,
  ENEMY_SPAWN_POINTS,
  AI_DECISION_MIN_TICKS,
  SMART_AI_TURN_FIRE_DELAY_TICKS,
  PLAYER_INVULN_TICKS,
  ICE_SLIDE_TICKS,
  BOOTS_SPEED_MULT,
  ESCORT_SIZE,
  DASH_SPEED,
} from '../core/constants';
import {
  Cell,
  CellType,
  LevelState,
  brickMaskOverlapsRect,
  getCell,
  isSolidForTank,
} from './level';

// 敌方坦克种类（用于计分/计数等以种类为键的表）。
export type EnemyKind = 'basic' | 'fast' | 'power' | 'armor' | 'smart';

// 坦克种类：玩家 + 五种敌方。移动/碰撞逻辑敌我复用，靠 kind 区分外观与属性。
// 玩家不再区分 player1/2/…，统一为 'player'，具体序号见 playerIndex。
export type TankKind = 'player' | EnemyKind;

// 武器种类（魂斗罗风格）：'cannon' 为经典炮（默认，沿用 star 等级规则），
// 其余四种由对应武器道具获得，各有自己的弹速 / 在场上限 / 开火方式（见 bullet.ts 与 update.ts）。
// 死亡复活即用 createPlayer 重建 → 自然归 'cannon'。敌人恒为 'cannon'。
export type WeaponKind = 'cannon' | 'spread' | 'spiral' | 'laser' | 'machine';

// 坦克实体：纯数据、可序列化（无函数/类实例）。设计为敌我复用，靠 kind 区分。
// x/y 为 16×16 包围盒左上角的关卡世界相对像素坐标。
export interface TankState {
  id: number;
  kind: TankKind;
  playerIndex: number; // 玩家序号 0..3（决定出生点/配色/输入映射）；敌人恒为 -1
  versusIndex: number; // 对战关 AI 席位 0..3（决定独立命数/复活点）；其他坦克为 -1
  x: number;
  y: number;
  dir: Direction;
  moving: boolean; // 本帧是否有方向输入（用于履带动画；撞墙不动时仍为 true）
  speed: number; // px/tick
  bulletSpeed: number; // 该坦克子弹速度（px/tick）
  prevFire: boolean; // 上一帧开火键状态（轻点输入缓冲的按下沿检测用）
  alive: boolean;
  hp: number; // 剩余血量：常规 1，装甲 4；≤0 即毁
  armor: number; // 玩家 3 级的一次性外层护甲（0/1）；敌军恒为 0
  hitFlashTicks: number; // 玩家非致命受击白闪；敌军恒为 0（装甲敌军沿用 hp 周期闪烁）
  aiTicks: number; // 敌方 AI 决策倒计时（玩家不使用，恒为 0）
  smartStuckTicks: number; // 智能坦克连续尝试追踪却没有位移的帧数
  smartEscapeTicks: number; // 智能坦克保持当前脱困或闪避方向的剩余帧数
  smartGoalX: number; // 智能坦克当前战术射击位 x；无目标时为 -1
  smartGoalY: number; // 智能坦克当前战术射击位 y；无目标时为 -1
  smartTurnFireTicks: number; // 智能坦克转向后允许开火前的剩余等待帧数
  escortFarTicks: number; // 护送关普通敌军落在车后且不在玩家视野内的连续帧数；其他情况恒为 0
  invulnTicks: number; // 护盾剩余帧：>0 时对方子弹穿过、不受伤
  level: number; // star 等级 0..3；玩家路线见 upgradePlayerTank，死亡 / 复活归 0
  carriesPowerup: boolean; // 是否为“携带道具”的敌军（第 4/11/18 台出队者）：红色闪烁，死亡掉落道具
  slideTicks: number; // 冰面滑行剩余帧：在冰面上移动时装填为 ICE_SLIDE_TICKS，松开方向键后据此继续滑行
  freezeTicks: number; // 友军冻结剩余帧：被队友子弹击中后 >0，期间不能移动 / 开火（敌人恒为 0）
  weapon: WeaponKind; // 当前武器：初始 / 死亡复活均为 'cannon'，由武器道具替换
  fireCooldown: number; // 开火冷却剩余帧（玩家射速上限 / 机枪 / 智能坦克共用；>0 时不能再射）
  fireBufferTicks: number; // 轻点开火缓冲剩余帧：按下沿装填，在弹位释放后的窗口内自动补发（敌人恒为 0）
  speedBoostTicks: number; // boots 快靴剩余帧：>0 时移动速度 ×BOOTS_SPEED_MULT（speed 基值不变）
  hasBoat: boolean; // boat 船：true 时移动碰撞把水面视为可通行（子弹不受影响），死亡即失
  ghostTicks: number; // ghost 幽灵剩余帧：>0 时移动碰撞把砖块视为可通行（钢/水/鹰/边界照旧）
  drill: boolean; // drill 钻头：true 时该坦克**所有武器**的子弹可击穿钢块（鹰巢 / 边界仍不可穿），死亡即失
  // ── 冲刺技能（玩家专属；敌人三项恒为 0 / 0 / false）──
  dashTicks: number; // 冲刺剩余帧：>0 时每帧沿当前朝向以 DASH_SPEED 前进并忽略方向输入；撞墙 / 被夹紧（位置未变）立即清零提前结束
  dashCooldown: number; // 冲刺冷却剩余帧：触发时装填 DASH_COOLDOWN_TICKS，逐帧递减（冻结期间照走），为 0 才能再次冲刺
  dashReadyFlashTicks: number; // 冷却刚归零后的“就绪黄闪”剩余帧：只由渲染层读取，不影响模拟
  prevDash: boolean; // 上一帧冲刺键状态（边沿触发用，同 prevFire）
}

// 判断一台坦克是否为玩家坦克。
export function isPlayerTank(t: TankState): boolean {
  return t.kind === 'player';
}

// 玩家车体生命上限：0 级 1 点，1 级起 2 点；3 级护甲单独记录在 armor，不混入 hp。
export function playerMaxHpForLevel(level: number): number {
  return level >= 1 ? 2 : 1;
}

export function playerSpeedForLevel(level: number): number {
  return level >= 1 ? PLAYER_SPEED_UPGRADED : PLAYER_SPEED;
}

// 星星只补充“该级新解锁的耐久”，不承担回血功能：
// 0→1 增加的一点车体上限会立即兑现；1→2 不回血；2→3 只装上一层新护甲。
// 返回 false 表示已经满级，拾取者属性保持不变。
export function upgradePlayerTank(tank: TankState): boolean {
  if (!isPlayerTank(tank) || tank.level >= PLAYER_MAX_LEVEL) return false;
  const oldMaxHp = playerMaxHpForLevel(tank.level);
  tank.level++;
  const newMaxHp = playerMaxHpForLevel(tank.level);
  tank.speed = playerSpeedForLevel(tank.level);
  tank.hp = Math.min(newMaxHp, tank.hp + (newMaxHp - oldMaxHp));
  if (tank.level === 3) tank.armor = 1;
  return true;
}

// 跨关恢复已捕获的升级状态，但不治疗既有车体伤害，也不补回已经打掉的护甲。
export function restorePlayerUpgrade(
  tank: TankState,
  level: number,
  hp: number,
  armor: number,
): void {
  tank.level = Math.max(0, Math.min(PLAYER_MAX_LEVEL, level));
  tank.speed = playerSpeedForLevel(tank.level);
  tank.hp = Math.max(1, Math.min(playerMaxHpForLevel(tank.level), hp));
  tank.armor = tank.level >= 3 ? Math.max(0, Math.min(1, armor)) : 0;
}

// 建立一名玩家坦克：按 playerIndex 取出生点，出生朝上。
export function createPlayer(playerIndex: number, id: number): TankState {
  const p = PLAYER_SPAWN_POINTS[playerIndex];
  return {
    id,
    kind: 'player',
    playerIndex,
    versusIndex: -1,
    x: p.x,
    y: p.y,
    dir: 'up',
    moving: false,
    speed: PLAYER_SPEED,
    bulletSpeed: BULLET_SPEED,
    prevFire: false,
    alive: true,
    hp: 1,
    armor: 0,
    hitFlashTicks: 0,
    aiTicks: 0,
    smartStuckTicks: 0,
    smartEscapeTicks: 0,
    smartGoalX: -1,
    smartGoalY: -1,
    smartTurnFireTicks: 0,
    escortFarTicks: 0,
    // 实体化即获无敌：开局直接入场、复活经出生闪光后入场，两条路径都从此值起算。
    invulnTicks: PLAYER_INVULN_TICKS,
    level: 0, // 复活即用 createPlayer 重建 → star 等级自然归 0
    carriesPowerup: false,
    slideTicks: 0,
    freezeTicks: 0, // 复活即用 createPlayer 重建 → 冻结自然解除
    weapon: 'cannon', // 复活即用 createPlayer 重建 → 武器自然归经典炮
    fireCooldown: 0,
    fireBufferTicks: 0,
    // 四项道具状态同样随 createPlayer 重建而清空（死亡复活即失效；跨关继承见 state.ts nextStage）。
    speedBoostTicks: 0,
    hasBoat: false,
    ghostTicks: 0,
    drill: false,
    // 冲刺状态随 createPlayer 重建而清零（死亡复活 / 跨关重建即冷却归零）。
    dashTicks: 0,
    dashCooldown: 0,
    dashReadyFlashTicks: 0,
    prevDash: false,
  };
}

// 敌方各种类的移动速度。
function enemySpeed(kind: TankKind): number {
  switch (kind) {
    case 'fast':
      return ENEMY_SPEED_FAST;
    case 'power':
      return ENEMY_SPEED_POWER;
    case 'armor':
      return ENEMY_SPEED_ARMOR;
    case 'smart':
      return ENEMY_SPEED_SMART;
    default:
      return ENEMY_SPEED_BASIC;
  }
}

// 敌方各种类的子弹速度（仅威力坦克更快）。
function enemyBulletSpeed(kind: TankKind): number {
  return kind === 'power' ? ENEMY_BULLET_SPEED_POWER : ENEMY_BULLET_SPEED_DEFAULT;
}

// 敌方各种类的血量（仅装甲坦克为 4）。
function enemyHp(kind: TankKind): number {
  return kind === 'armor' ? ARMOR_HP : ENEMY_HP_DEFAULT;
}

// 建立一台敌方坦克：出生于三个出生点之一（0=左 / 1=中 / 2=右），朝下。
export function createEnemy(kind: TankKind, id: number, spawnIndex: number): TankState {
  const p = ENEMY_SPAWN_POINTS[spawnIndex % ENEMY_SPAWN_POINTS.length];
  return {
    id,
    kind,
    playerIndex: -1, // 敌人无玩家序号
    versusIndex: -1,
    x: p.x,
    y: p.y,
    dir: 'down',
    moving: false,
    speed: enemySpeed(kind),
    bulletSpeed: enemyBulletSpeed(kind),
    prevFire: false,
    alive: true,
    hp: enemyHp(kind),
    armor: 0,
    hitFlashTicks: 0,
    // 智能坦克出生后立即规划路径；传统敌人仍沿出生朝向行进半秒再做首次随机决策。
    aiTicks: kind === 'smart' ? 0 : AI_DECISION_MIN_TICKS,
    smartStuckTicks: 0,
    smartEscapeTicks: 0,
    smartGoalX: -1,
    smartGoalY: -1,
    smartTurnFireTicks: 0,
    escortFarTicks: 0,
    invulnTicks: 0, // 敌方无出生护盾，但可拾取 helmet 获得护盾
    level: 0,
    carriesPowerup: false, // 由出生器按出队计数标记（见 enemy.ts updateSpawner）
    slideTicks: 0,
    freezeTicks: 0, // 敌人不受友军冻结影响（敌军冻结由道具 state.enemyFreezeTicks 全局控制）
    weapon: 'cannon',
    fireCooldown: 0,
    fireBufferTicks: 0, // 敌人开火不走输入缓冲（见 enemy.ts 随机开火）
    speedBoostTicks: 0,
    hasBoat: false,
    ghostTicks: 0,
    drill: false,
    // 敌人不使用冲刺（这四项恒为初始值）。
    dashTicks: 0,
    dashCooldown: 0,
    dashReadyFlashTicks: 0,
    prevDash: false,
  };
}

// 对战关的智能对手：席位和 id 在多次复活间保持稳定，便于联机插值与战术分工。
// 复活与玩家使用同样的出生护盾，避免在顶部出生点被预瞄秒杀。
export function createVersusEnemy(versusIndex: number, id: number): TankState {
  const tank = createEnemy('smart', id, versusIndex);
  tank.versusIndex = versusIndex;
  tank.invulnTicks = PLAYER_INVULN_TICKS;
  return tank;
}

const EPS = 1e-6;

function isVertical(dir: Direction): boolean {
  return dir === 'up' || dir === 'down';
}

// 多键同按时的优先级：上 > 下 > 左 > 右。无方向键返回 null。
function desiredDir(input: InputState): Direction | null {
  if (input.up) return 'up';
  if (input.down) return 'down';
  if (input.left) return 'left';
  if (input.right) return 'right';
  return null;
}

// 轴吸附：把坐标对齐到最近的 8px（SUBTILE）整数倍。
function snapAxis(v: number): number {
  return Math.round(v / SUBTILE) * SUBTILE;
}

// 某坦克的“地形是否阻挡”判定（每帧按其道具状态生成）。
type SolidTest = (cell: CellType) => boolean;

// 坦克 16×16 车体当前是否与任一砖块子格重叠（幽灵到期的防卡死判定用）。
function overlapsBrick(tank: TankState, level: LevelState): boolean {
  const c0 = Math.floor(tank.x / SUBTILE);
  const c1 = Math.floor((tank.x + TANK_SIZE - EPS) / SUBTILE);
  const r0 = Math.floor(tank.y / SUBTILE);
  const r1 = Math.floor((tank.y + TANK_SIZE - EPS) / SUBTILE);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (
        brickMaskOverlapsRect(
          level,
          c,
          r,
          tank.x,
          tank.y,
          tank.x + TANK_SIZE,
          tank.y + TANK_SIZE,
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

// 在通用规则 isSolidForTank 之上叠加道具豁免（仅作用于坦克移动，子弹不受影响）：
//   • boat（hasBoat）  → 水面可通行，直到该玩家死亡；
//   • ghost（ghostTicks>0）→ 砖块可通行（钢 / 水 / 鹰巢 / 边界照旧阻挡）。
// 幽灵到期防卡死：若车体此刻仍与砖块重叠，砖对其保持可通行，直到完全脱离为止
//（同样兜住了“扳手 / 铲子在坦克脚下造墙”这类把坦克封在墙里的情形）。
function tankSolidTest(tank: TankState, level: LevelState): SolidTest {
  const brickPass = tank.ghostTicks > 0 || overlapsBrick(tank, level);
  const waterPass = tank.hasBoat;
  return (cell: CellType): boolean => {
    if (cell === Cell.BRICK) return !brickPass;
    if (cell === Cell.WATER) return !waterPass;
    return isSolidForTank(cell);
  };
}

// 完整 16×16 车体在候选位置是否与当前坦克不可穿透的地形重叠。
// 砖块须进一步检查仍存活的 4×4 象限；其余实心地形仍按整个 8×8 子格判定。
function terrainBlocksTankAt(
  level: LevelState,
  x: number,
  y: number,
  solid: SolidTest,
): boolean {
  const c0 = Math.floor(x / SUBTILE);
  const c1 = Math.floor((x + TANK_SIZE - EPS) / SUBTILE);
  const r0 = Math.floor(y / SUBTILE);
  const r1 = Math.floor((y + TANK_SIZE - EPS) / SUBTILE);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const cell = getCell(level, c, r);
      if (!solid(cell)) continue;
      if (
        cell !== Cell.BRICK ||
        brickMaskOverlapsRect(level, c, r, x, y, x + TANK_SIZE, y + TANK_SIZE)
      ) {
        return true;
      }
    }
  }
  return false;
}

// 一帧最多移动 1.5px，远小于最小砖象限 4px。若终点穿入地形，在起点到终点之间
// 二分出最远的无碰撞坐标，使坦克能贴到半砖（4px）边缘，而不是退回整个 8px 子格边缘。
function furthestTerrainClear(
  from: number,
  to: number,
  blockedAt: (position: number) => boolean,
): number {
  if (!blockedAt(to)) return to;
  if (blockedAt(from)) return from;
  let clear = from;
  let blocked = to;
  for (let i = 0; i < 24; i++) {
    const mid = (clear + blocked) / 2;
    if (blockedAt(mid)) blocked = mid;
    else clear = mid;
  }
  return clear;
}

// 两个 16×16 坦克盒是否严格重叠（紧贴相邻不算重叠，便于吸附贴合）。
function tanksOverlap(ax: number, ay: number, bx: number, by: number): boolean {
  return ax < bx + TANK_SIZE && ax + TANK_SIZE > bx && ay < by + TANK_SIZE && ay + TANK_SIZE > by;
}

export interface TankBlocker {
  x: number;
  y: number;
  destroyed?: boolean;
}

function blockerOverlap(x: number, y: number, blocker: TankBlocker): boolean {
  return (
    x < blocker.x + ESCORT_SIZE &&
    x + TANK_SIZE > blocker.x &&
    y < blocker.y + ESCORT_SIZE &&
    y + TANK_SIZE > blocker.y
  );
}

// 16×16 坦克盒能否完整占据候选位置。转向吸附会沿当前移动轴瞬移最多 4px，
// 因而不能复用只检查“前沿一行/一列”的常规移动碰撞；这里检查完整盒与所有实心占位。
export function canTankOccupy(
  tank: TankState,
  x: number,
  y: number,
  level: LevelState,
  others: TankState[],
  blocker?: TankBlocker,
): boolean {
  const maxX = level.cols * SUBTILE - TANK_SIZE;
  const maxY = level.rows * SUBTILE - TANK_SIZE;
  if (x < 0 || y < 0 || x > maxX || y > maxY) return false;
  const solid = tankSolidTest(tank, level);
  if (terrainBlocksTankAt(level, x, y, solid)) return false;
  if (blocker && !blocker.destroyed && blockerOverlap(x, y, blocker)) return false;
  for (const o of others) {
    if (o === tank || !o.alive) continue;
    if (tanksOverlap(x, y, o.x, o.y)) return false;
  }
  return true;
}

// 沿当前朝向尽量前进：先按地形紧贴边缘，再对其他坦克做实心夹紧（紧贴其外侧停下）。
// others 为场上全部坦克（含自身与死者，内部跳过）；单轴移动，垂直轴坐标本帧不变。
// stepOverride：本帧步长的绝对值覆盖（冲刺用；给定时不再叠加 boots 快靴倍率）。
function moveTank(
  tank: TankState,
  level: LevelState,
  others: TankState[],
  blocker?: TankBlocker,
  stepOverride?: number,
): void {
  // boots 快靴：本帧步长按倍率放大（不改 tank.speed 基值，到期自然恢复）。
  const d =
    stepOverride ?? (tank.speedBoostTicks > 0 ? tank.speed * BOOTS_SPEED_MULT : tank.speed);
  const solid = tankSolidTest(tank, level);
  const maxX = level.cols * SUBTILE - TANK_SIZE;
  const maxY = level.rows * SUBTILE - TANK_SIZE;
  const { x, y } = tank;
  switch (tank.dir) {
    case 'up': {
      const target = Math.max(0, y - d);
      let ny = furthestTerrainClear(y, target, (candidate) =>
        terrainBlocksTankAt(level, x, candidate, solid),
      );
      for (const o of others) {
        if (o === tank || !o.alive) continue;
        // 只允许位于移动方向前方的坦克收紧候选位置。若状态中已经存在重叠，后方坦克
        // 不得把当前坦克反向推出；朝重叠坦克移动时最多原地阻塞，绝不产生反向位移。
        if (o.y < y && tanksOverlap(x, ny, o.x, o.y)) ny = Math.max(ny, o.y + TANK_SIZE);
      }
      if (blocker && !blocker.destroyed && blocker.y < y && blockerOverlap(x, ny, blocker)) {
        ny = Math.max(ny, blocker.y + ESCORT_SIZE);
      }
      tank.y = Math.max(0, Math.min(y, ny));
      break;
    }
    case 'down': {
      const target = Math.min(maxY, y + d);
      let ny = furthestTerrainClear(y, target, (candidate) =>
        terrainBlocksTankAt(level, x, candidate, solid),
      );
      for (const o of others) {
        if (o === tank || !o.alive) continue;
        if (o.y > y && tanksOverlap(x, ny, o.x, o.y)) ny = Math.min(ny, o.y - TANK_SIZE);
      }
      if (blocker && !blocker.destroyed && blocker.y > y && blockerOverlap(x, ny, blocker)) {
        ny = Math.min(ny, blocker.y - TANK_SIZE);
      }
      tank.y = Math.min(maxY, Math.max(y, ny));
      break;
    }
    case 'left': {
      const target = Math.max(0, x - d);
      let nx = furthestTerrainClear(x, target, (candidate) =>
        terrainBlocksTankAt(level, candidate, y, solid),
      );
      for (const o of others) {
        if (o === tank || !o.alive) continue;
        if (o.x < x && tanksOverlap(nx, y, o.x, o.y)) nx = Math.max(nx, o.x + TANK_SIZE);
      }
      if (blocker && !blocker.destroyed && blocker.x < x && blockerOverlap(nx, y, blocker)) {
        nx = Math.max(nx, blocker.x + ESCORT_SIZE);
      }
      tank.x = Math.max(0, Math.min(x, nx));
      break;
    }
    case 'right': {
      const target = Math.min(maxX, x + d);
      let nx = furthestTerrainClear(x, target, (candidate) =>
        terrainBlocksTankAt(level, candidate, y, solid),
      );
      for (const o of others) {
        if (o === tank || !o.alive) continue;
        if (o.x > x && tanksOverlap(nx, y, o.x, o.y)) nx = Math.min(nx, o.x - TANK_SIZE);
      }
      if (blocker && !blocker.destroyed && blocker.x > x && blockerOverlap(nx, y, blocker)) {
        nx = Math.min(nx, blocker.x - TANK_SIZE);
      }
      tank.x = Math.min(maxX, Math.max(x, nx));
      break;
    }
  }
}

// 仅转向（含原版轴吸附），不移动。垂直↔水平切换时把上一条移动轴吸附到最近 8px；
// 反向（up<->down / left<->right）不吸附。吸附位置被地形（残砖象限）或坦克占据时
// 放弃吸附、原地转向 —— 车头必须立即响应输入（原版手感），能否前进交由移动碰撞裁决。
export function turnTank(
  tank: TankState,
  desired: Direction,
  level: LevelState,
  tanks: TankState[],
  blocker?: TankBlocker,
): void {
  if (desired === tank.dir) return;
  if (isVertical(tank.dir) !== isVertical(desired)) {
    let nx = tank.x;
    let ny = tank.y;
    const maxX = level.cols * SUBTILE - TANK_SIZE;
    const maxY = level.rows * SUBTILE - TANK_SIZE;
    if (isVertical(tank.dir)) {
      ny = Math.min(maxY, Math.max(0, snapAxis(tank.y)));
    } else {
      nx = Math.min(maxX, Math.max(0, snapAxis(tank.x)));
    }
    if (canTankOccupy(tank, nx, ny, level, tanks, blocker)) {
      tank.x = nx;
      tank.y = ny;
    }
  }
  if (tank.kind === 'smart') {
    tank.smartTurnFireTicks = SMART_AI_TURN_FIRE_DELAY_TICKS;
  }
  tank.dir = desired;
}

// 坦克中心所在子格是否为冰面（16×16 盒中心 = 左上角 + 8）。
function centerOnIce(tank: TankState, level: LevelState): boolean {
  const col = Math.floor((tank.x + TANK_SIZE / 2) / SUBTILE);
  const row = Math.floor((tank.y + TANK_SIZE / 2) / SUBTILE);
  return getCell(level, col, row) === Cell.ICE;
}

// 应用一帧输入：转向（含轴吸附）+ 移动（含坦克互相实心）。不处理开火（由 update 编排）。
// tanks 为场上全部坦克，用于坦克对坦克碰撞夹紧。
export function applyInput(
  tank: TankState,
  input: InputState,
  level: LevelState,
  tanks: TankState[],
  blocker?: TankBlocker,
): void {
  // 冲刺中：忽略方向 / 转向输入，沿当前朝向以 DASH_SPEED（绝对速度，不叠加 boots）前进。
  // 每帧步长 ≈ 2.67px 远小于车体，撞墙由既有二分紧贴逻辑兜住，不会穿透。
  if (tank.dashTicks > 0) {
    const px = tank.x;
    const py = tank.y;
    moveTank(tank, level, tanks, blocker, DASH_SPEED);
    const blocked = tank.x === px && tank.y === py;
    tank.dashTicks--;
    if (blocked) tank.dashTicks = 0; // 撞墙 / 被夹紧即止（提前结束冲刺）
    tank.moving = true; // 驱动履带动画
    // 冲刺落在冰面照常装填滑行计时（与普通移动一致）。
    tank.slideTicks = centerOnIce(tank, level) ? ICE_SLIDE_TICKS : 0;
    return;
  }

  const desired = desiredDir(input);
  if (desired === null) {
    // 无方向输入：若正处于冰面滑行中（slideTicks>0 且中心仍在冰面），沿当前朝向继续滑行一步；
    // 否则原地停住。撞墙 / 被夹紧（位置未变）或离开冰面则立即停止滑行。
    if (tank.slideTicks > 0 && centerOnIce(tank, level)) {
      const px = tank.x;
      const py = tank.y;
      moveTank(tank, level, tanks, blocker); // 沿当前朝向按自身速度滑行一步（含地形/坦克碰撞夹紧）
      const blocked = tank.x === px && tank.y === py;
      tank.slideTicks--;
      if (blocked) tank.slideTicks = 0;
      tank.moving = !blocked; // 滑行中视为移动（驱动履带动画）
    } else {
      tank.slideTicks = 0;
      tank.moving = false;
    }
    return;
  }

  tank.moving = true;
  turnTank(tank, desired, level, tanks, blocker); // 转向必然生效（吸附不可用时原地转车头）
  moveTank(tank, level, tanks, blocker);
  // 移动后：中心若在冰面则装填滑行计时（松键后可继续滑行），离开冰面则清零。
  tank.slideTicks = centerOnIce(tank, level) ? ICE_SLIDE_TICKS : 0;
}

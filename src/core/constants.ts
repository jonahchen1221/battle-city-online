import type { EnemyKind } from '../game/tank';
// 仅类型引用（编译期擦除，不产生运行时依赖）：Boss 攻击池表在本文件里定义，
// 但攻击种类的真值来源仍是 src/game/boss.ts 的状态机。
import type { BossAttackKind } from '../game/boss';

// NES 原生分辨率与布局（所有游戏逻辑均以此坐标系为准，渲染时整体放大）
// 为 1–4 人合作放大战场：原生宽 = FIELD_X(16) + 320 + 32(HUD) = 368；高 = 8 + 240 + 8 = 256。
export const NATIVE_WIDTH = 368;
export const NATIVE_HEIGHT = 256;

// 战场：20×15 个大格（每格 16px），即 40×30 个子格（每格 8px）
export const TILE = 16; // 大格边长（坦克尺寸）
export const SUBTILE = 8; // 子格边长（砖块破坏的基本单位）
export const FIELD_COLS = 40; // 子格列数
export const FIELD_ROWS = 30; // 子格行数
export const FIELD_WIDTH = FIELD_COLS * SUBTILE; // 320
export const FIELD_HEIGHT = FIELD_ROWS * SUBTILE; // 240

// 固定逻辑帧率（与 NES 一致）；所有速度单位为 px/tick
export const TICKS_PER_SECOND = 60;

// ── 护送关 ──
// 关卡循环为「普通 → 护送 → Boss → 对战」（见 stageKind）：护送关是每组的第 2 关。
// 护送关世界是普通战场的 2×3，渲染仍只展示 320×240 视口。
export const ESCORT_FIELD_COLS = FIELD_COLS * 2; // 80 子格 = 640px
export const ESCORT_FIELD_ROWS = FIELD_ROWS * 3; // 90 子格 = 720px
export const ESCORT_SIZE = 32;
export const ESCORT_SPEED = 0.25;
export const ESCORT_TIME_LIMIT_TICKS = 180 * TICKS_PER_SECOND; // 每张移动关限时 3 分钟
export const ESCORT_TIME_BONUS_TICKS = 15 * TICKS_PER_SECOND; // 扳手：追回 15 秒
// 护送关普通敌军维持在车辆周围的战区，避免随机游走后长期占用敌军名额。
export const ESCORT_ENEMY_COMBAT_HALF_WIDTH = 192;
export const ESCORT_ENEMY_COMBAT_AHEAD = 220;
export const ESCORT_ENEMY_COMBAT_BEHIND = 96;
export const ESCORT_ENEMY_RECYCLE_BEHIND = 160;
// 车队停驶时援军计时减速，避免玩家清障 / 补护送位期间压力继续按行驶节奏堆积。
export const ESCORT_STOPPED_SPAWN_DIVISOR = 2;
// 推车位：车尾一条与车身同宽（ESCORT_SIZE）、纵深一个坦克位（TANK_SIZE）的矩形。
// 每名推车手为车速追加一档加成，最多计 2 名；护卫位没人时车不动，推车也不产生任何效果。
// 推车是独立动力：每名推车手贡献 0.5 档车速（1 人推 = 半速、2 人推 = 全速），
// 与护卫位占比相加 —— 满护航 + 2 人推 = 2 倍速。
export const ESCORT_PUSH_SPEED_PER_TANK = 0.5;
export const ESCORT_PUSH_MAX_TANKS = 2;

// 战场在屏幕上的偏移（左侧 16px 灰边，顶部 8px，右侧留 32px HUD 栏）
export const FIELD_X = 16;
export const FIELD_Y = 8;

export const ESCORT_ENEMY_RECYCLE_TICKS = 2 * TICKS_PER_SECOND;

// 美术分辨率倍数（仅限渲染层！）：把所有精灵按 2× 重新绘制、画布内部分辨率放大到
// NATIVE_*×ART_SCALE（736×512），从而获得 4× 像素细节。
// 逻辑坐标 / 游戏代码（src/game/）一律使用未缩放的世界像素，不受此常量影响。
// 屏幕显示缩放不再是固定倍数，而由 main.ts 依视口大小取 736×512 画布的最大半整数（0.5 步长）CSS 倍率。
export const ART_SCALE = 2;

// NES 经典配色
export const COLOR_FRAME = '#636363'; // 屏幕灰边
export const COLOR_FIELD = '#000000'; // 战场黑底
export const COLOR_GAMEOVER = '#e44437'; // "GAME OVER" 经典红
export const COLOR_STAGE_CLEAR = '#ffffff'; // "STAGE CLEAR" 白色
export const COLOR_HUD_ICON = '#000000'; // HUD 图标/文字（灰底上的黑）
export const COLOR_PAUSE = '#e0a030'; // "PAUSE" 经典黄

// 砖块四分之一象限位掩码（每象限 4×4 px，子弹破坏的最小单位）
export const BRICK_TL = 0b0001; // 左上
export const BRICK_TR = 0b0010; // 右上
export const BRICK_BL = 0b0100; // 左下
export const BRICK_BR = 0b1000; // 右下
export const BRICK_FULL = 0b1111; // 完整砖块
export const QUARTER = 4; // 象限边长（子格 8px 的一半）

// 水面动画：四帧波纹每 10 逻辑帧推进一次（约 6 FPS），保留低帧像素感同时避免静态跳变。
export const WATER_ANIM_TICKS = 10;
// 水陆交界浪花的虚线流动节奏（独立于水面主波纹，形成轻微视差）。
export const WATER_FOAM_ANIM_TICKS = 6;
export const COLOR_WATER_EDGE = '#4c9cf4';
export const COLOR_WATER_FOAM = '#b8ecff';

// 坦克尺寸（= 一个大格）
export const TANK_SIZE = TILE; // 16

// 玩家坦克基础移动速度（px/tick）；取得第一颗星后提升到 PLAYER_SPEED_UPGRADED。
export const PLAYER_SPEED = 0.75;
export const PLAYER_SPEED_UPGRADED = 1;

// ── 冲刺技能（玩家专属）──
// 按下冲刺键后沿当前朝向高速位移 2 个大格，随后进入 5 秒冷却；期间车身周围渲染倒计时圆环。
export const DASH_DISTANCE = TILE * 2; // 32：冲刺总位移（2 个大格）
export const DASH_TICKS = 12; // 冲刺持续帧数（约 0.2s）
// 每帧步长 = 32 / 12 ≈ 2.67px，远小于 16px 车体，现有碰撞二分不会穿透地形。
// 这是绝对速度：不与 boots 快靴倍率叠加（见 tank.ts moveTank 的步长覆盖参数）。
export const DASH_SPEED = DASH_DISTANCE / DASH_TICKS;
export const DASH_COOLDOWN_TICKS = 5 * TICKS_PER_SECOND; // 300 帧 = 5 秒
export const DASH_READY_FLASH_TICKS = 30; // CD 转好后小圈黄闪的持续帧数（渲染用）
// ── 冲刺的渲染参数（仅渲染层读取）──
export const DASH_RING_RADIUS = 11; // 倒计时圆环半径（逻辑像素，略大于 16px 车体的一半）
export const DASH_RING_SAMPLES = 72; // 整圈的采样点数（逐点 fillRect，像素风、无抗锯齿）
export const DASH_READY_BLINK_TICKS = 5; // 就绪黄闪的明灭周期（帧）
export const COLOR_DASH_RING = '#ffffff'; // 冷却剩余弧段（白）
export const COLOR_DASH_READY = '#f0c860'; // 就绪闪烁（经典黄）
// 冲刺残影：在坦克后方这些距离处以对应透明度各画一份当前精灵。
export const DASH_TRAIL_STEPS: ReadonlyArray<{ dist: number; alpha: number }> = [
  { dist: 12, alpha: 0.2 },
  { dist: 6, alpha: 0.35 },
];

// 可支持的最大玩家数（1–4 人合作）。
export const MAX_PLAYERS = 4;

// 玩家出生点（战场相对坐标，底行朝上）。按 playerIndex（0..3）索引：
//   P1/P2 内侧贴近鹰巢（经典 2P 布局），P3/P4 更靠外；全部位于底行 y=224（子格 28 行，= FIELD_HEIGHT-16）。
//   P1 子格列 14（x=112）、P2 列 24（x=192）、P3 列 6（x=48）、P4 列 32（x=256）。
export const PLAYER_SPAWN_POINTS: ReadonlyArray<{ x: number; y: number }> = [
  { x: 14 * SUBTILE, y: 28 * SUBTILE }, // P1 = (112, 224)
  { x: 24 * SUBTILE, y: 28 * SUBTILE }, // P2 = (192, 224)
  { x: 6 * SUBTILE, y: 28 * SUBTILE }, // P3 = (48, 224)
  { x: 32 * SUBTILE, y: 28 * SUBTILE }, // P4 = (256, 224)
];

// 每名玩家的高亮配色（浮空 "1P".."4P" 标签用；取自各玩家坦克高光色）。
export const PLAYER_LABEL_COLORS: ReadonlyArray<string> = [
  '#f0c860', // P1 黄
  '#78e048', // P2 绿
  '#78d8f8', // P3 青
  '#f8b8f8', // P4 粉
];

// 子弹尺寸与速度
export const BULLET_SIZE = 4;
export const BULLET_SPEED = 2; // px/tick

// 玩家最短开火间隔（帧）：在“在场子弹数”之外再加一层固定射速上限。
// 上限对齐现有机枪的固定射速，避免贴脸命中 / 撞墙时弹位迅速释放后反而快过机枪。
export const PLAYER_FIRE_INTERVAL_TICKS = 10; // 60Hz 下最多 6 轮/秒

// 轻点开火输入缓冲（帧）：按下沿装填；在场子弹达到上限时不吞掉这次按键，
// 缓冲窗口内一旦弹位与开火冷却都就绪就补发。长按则在两项条件都满足后持续补发。
export const FIRE_BUFFER_TICKS = 6;

// 子弹击穿砖块：垂直行进方向宽 16px、沿行进方向纵深 8px 的破坏条
export const BRICK_CARVE_WIDTH = TILE; // 16
export const BRICK_CARVE_DEPTH = SUBTILE; // 8

// 坦克履带动画：移动时每约 8 逻辑帧切换一帧
export const TRACK_ANIM_TICKS = 8;
// 智能坦克识别标记：绘于树林之上，瞄准框按此周期轻微脉冲。
export const SMART_MARKER_PULSE_TICKS = 12;
export const COLOR_SMART_MARKER = '#58f8f8';

// ── 敌方坦克 ──
// 移动速度（px/tick）：快速坦克最快，基础/装甲最慢。
export const ENEMY_SPEED_BASIC = 0.5;
export const ENEMY_SPEED_FAST = 1.0;
export const ENEMY_SPEED_POWER = 0.75;
export const ENEMY_SPEED_ARMOR = 0.5;
export const ENEMY_SPEED_SMART = 0.75;
// 血量：常规敌军 1 发即毁，装甲坦克需 4 发。
export const ENEMY_HP_DEFAULT = 1;
export const ARMOR_HP = 4;
// 敌弹速度：威力坦克的子弹更快，其余与玩家一致。
export const ENEMY_BULLET_SPEED_POWER = 3;
export const ENEMY_BULLET_SPEED_DEFAULT = 2;
// 出生点（战场相对坐标，16×16 盒左上角）：顶行四点 左 / 中左 / 中右 / 右，出生朝下，按序轮转。
export const ENEMY_SPAWN_POINTS: ReadonlyArray<{ x: number; y: number }> = [
  { x: 0, y: 0 }, // 左
  { x: 104, y: 0 }, // 中左
  { x: 200, y: 0 }, // 中右
  { x: 304, y: 0 }, // 右（右缘：304 + 16 = 320 = FIELD_WIDTH）
];
// 出生闪光（星形）持续帧数，闪光结束后坦克才实体化（可碰撞）。
export const SPAWN_FLASH_TICKS = 60;
// 出生星形动画：4 帧，每约 8 帧切换一帧。
export const SPAWN_STAR_ANIM_TICKS = 8;
// AI 决策计时器：每 30–60 帧（含撞墙立即）重新选向。
export const AI_DECISION_MIN_TICKS = 30;
export const AI_DECISION_RANGE_TICKS = 31; // 30 + rng.int(31) → 30..60
// AI 开火概率：每帧约 1/60（且当前无在场子弹时）。
export const AI_FIRE_DENOM = 60;
// 智能坦克的目标路径刷新间隔；遇阻时不等计时，立即重新规划并尝试清障。
export const SMART_AI_REPLAN_TICKS = 12;
// 智能坦克连续无位移达到此帧数后，进入局部脱困；脱困方向保持一段时间以真正绕开动态障碍。
export const SMART_AI_STUCK_TICKS = 12;
export const SMART_AI_ESCAPE_TICKS = 24;
// 智能坦克转向后等待约 150ms 再开火：60Hz 下 9 帧，避免瞬间转头射击。
export const SMART_AI_TURN_FIRE_DELAY_TICKS = 9;
// 智能坦克的最低射击间隔；避免炮弹在近距离立刻消失时逐帧重新开火。
export const SMART_AI_FIRE_COOLDOWN_TICKS = 20;
// 智能坦克炮弹与玩家弹对消后只保留一帧装填；下一逻辑帧即可继续反制连续射击。
export const SMART_AI_INTERCEPT_RELOAD_TICKS = 1;
// A* 中进入含砖位置的代价：优先选择短绕路，无路可绕时仍会主动射穿砖墙。
export const SMART_AI_BRICK_COST = 6;
// 智能坦克预判玩家弹道的时间窗；36 帧足以让基础速度的智能坦克横移出一条 4px 弹道。
export const SMART_AI_DODGE_LOOKAHEAD_TICKS = 36;
// 刚移出弹道后继续侧移片刻，避免 A* 立即把坦克拉回尚未通过的炮弹前。
export const SMART_AI_DODGE_COMMIT_TICKS = 8;
// 提前量射击：按玩家当前朝向 / 移动状态向前推演，覆盖转向前摇与中距离弹道飞行时间。
export const SMART_AI_LEAD_LOOKAHEAD_TICKS = 72;
// 未出膛枪线感知沿用较短窗口：只规避玩家已经架好的近期威胁，不读取输入或做超远程读心。
export const SMART_AI_READY_GUN_LOOKAHEAD_TICKS = 36;
// 智能坦克围绕目标搜索射击位的距离带：保持中距离，避免只会贴脸追踪。
export const SMART_AI_FIRING_MIN_DISTANCE = 48;
export const SMART_AI_FIRING_IDEAL_DISTANCE = 80;
export const SMART_AI_FIRING_MAX_DISTANCE = 112;
export const SMART_AI_FIRING_DISTANCE_STEP = 16;
// 不同 id 偏向不同侧翼；路径明显更短或首选侧无射线时仍可改走其他侧。
export const SMART_AI_FLANK_SIDE_COST = 16;
// 候选射线上有砖时降低优先级：可清障，但优先抢占已经打通的火力线。
export const SMART_AI_FIRING_BRICK_PENALTY = 12;
// 多 AI 协同：相近玩家间按当前已分配人数均衡兵力；同一目标则预约不同侧翼与射击位。
// 目标分流使用平方距离，因此惩罚量也是 px²；64px 的额外路程仍允许明显更近的目标被集火。
export const SMART_AI_TARGET_LOAD_PENALTY = 64 * 64;
// 已锁定目标只有在替代目标的综合分数至少好出 1024px² 时才切换，避免多人负载边界上逐轮折返。
export const SMART_AI_TARGET_SWITCH_MARGIN = 32 * 32;
export const SMART_AI_RESERVED_GOAL_RADIUS = TANK_SIZE * 2;
export const SMART_AI_SAME_FLANK_PENALTY = SMART_AI_FLANK_SIDE_COST * 2;
// 关卡敌军总数（单一可调常量；暂不随人数变化）。各档 STAGE_ENEMY_MIX 之和均等于此值。
// Boss 关不走有限队列（编成为空），故不受此值约束。
export const STAGE_ENEMY_TOTAL = 20;

// ── 关卡编排：普通 → 护送 → Boss → 对战 四段循环 ──
// 一个循环组（“组”）含四关，共 STAGE_GROUP_COUNT 组 = STAGE_COUNT 关；通关第 40 关回卷第 1 关。
//   组 t 的四关关号为 4t-3（普通）/ 4t-2（护送）/ 4t-1（Boss）/ 4t（对战）。
//   普通关取第 t 张普通图与第 t 档敌军编成；护送关取第 ((t-1) % 路线数) 条路线；
//   Boss 关竞技场按组号推进；对战关在 6 张专用竞技场中循环取图。
export const STAGE_CYCLE = 4; // 一组的关数（普通 / 护送 / Boss / 对战各一）
export const STAGE_GROUP_COUNT = 10; // 组数（= 普通图张数 = 敌军编成档数）
export const STAGE_COUNT = STAGE_CYCLE * STAGE_GROUP_COUNT; // 40

export type StageKind = 'normal' | 'escort' | 'boss' | 'versus';

// 把任意关号（含回卷 / 越界）归一到 1..STAGE_COUNT。
export function normalizeStage(stage: number): number {
  const n = Math.floor(stage) - 1;
  return (((n % STAGE_COUNT) + STAGE_COUNT) % STAGE_COUNT) + 1;
}

// 某关号所属的循环组（1..STAGE_GROUP_COUNT）：普通图张号 / 护送次序 / Boss 次序共用这一个序号。
export function stageGroup(stage: number): number {
  return Math.ceil(normalizeStage(stage) / STAGE_CYCLE);
}

// 关卡类型：归一后按每组的 1 / 2 / 3 / 0 分流。
// 各 is*Stage 一律派生自它，绝不再各自算关号。
export function stageKind(stage: number): StageKind {
  const slot = normalizeStage(stage) % STAGE_CYCLE;
  if (slot === 1) return 'normal';
  if (slot === 2) return 'escort';
  if (slot === 3) return 'boss';
  return 'versus';
}

export function isBossStage(stage: number): boolean {
  return stageKind(stage) === 'boss';
}

export function isEscortStage(stage: number): boolean {
  return stageKind(stage) === 'escort';
}

export function isVersusStage(stage: number): boolean {
  return stageKind(stage) === 'versus';
}

// Boss 关的关号（1-based）：[3, 7, …, 39]，由编排派生，不再手写。
export const BOSS_STAGES: ReadonlyArray<number> = Array.from(
  { length: STAGE_GROUP_COUNT },
  (_, i) => i * STAGE_CYCLE + 3,
);

// 各组的敌军编成（普通关与护送关共用，总数均为 STAGE_ENEMY_TOTAL，逐组升级），按 stageGroup 取。
// 出生队列按各种类剩余数轮转交错（round-robin）构建，确定性、无需 rng（见 state.ts）。
// Boss 关不取本表：小兵由 Boss 关专属逻辑无限补充（见 enemy.ts updateBossMinions）。
export const STAGE_ENEMY_MIX: ReadonlyArray<ReadonlyArray<{ kind: EnemyKind; count: number }>> = [
  // 第 1 组（第 1 / 2 关）：基础 14 + 快速 2 + 智能 4
  [
    { kind: 'basic', count: 14 },
    { kind: 'fast', count: 2 },
    { kind: 'smart', count: 4 },
  ],
  // 第 2 组：基础 8 + 快速 5 + 威力 2 + 智能 5（智能占 25%）
  [
    { kind: 'basic', count: 8 },
    { kind: 'fast', count: 5 },
    { kind: 'power', count: 2 },
    { kind: 'smart', count: 5 },
  ],
  // 第 3 组：基础 5 + 快速 5 + 威力 2 + 装甲 2 + 智能 6（智能占 30%）
  [
    { kind: 'basic', count: 5 },
    { kind: 'fast', count: 5 },
    { kind: 'power', count: 2 },
    { kind: 'armor', count: 2 },
    { kind: 'smart', count: 6 },
  ],
  // 第 4 组：基础 2 + 快速 5 + 威力 3 + 装甲 3 + 智能 7（智能占 35%）
  [
    { kind: 'basic', count: 2 },
    { kind: 'fast', count: 5 },
    { kind: 'power', count: 3 },
    { kind: 'armor', count: 3 },
    { kind: 'smart', count: 7 },
  ],
  // 第 5 组：快速 4 + 威力 4 + 装甲 4 + 智能 8（智能占 40%，不再出现基础型）
  [
    { kind: 'fast', count: 4 },
    { kind: 'power', count: 4 },
    { kind: 'armor', count: 4 },
    { kind: 'smart', count: 8 },
  ],
  // ── 后半程（第 6–10 组）──
  // 硬骨头（威力 + 装甲）合计逐组单调不减：8 → 8 → 9 → 10 → 11 → 12；
  // 智能坦克稳定在 45%，快速坦克逐组退场，最终由装甲与威力压满战场。
  // 第 6 组：快速 3 + 威力 4 + 装甲 4 + 智能 9（智能占 45%）
  [
    { kind: 'fast', count: 3 },
    { kind: 'power', count: 4 },
    { kind: 'armor', count: 4 },
    { kind: 'smart', count: 9 },
  ],
  // 第 7 组：快速 2 + 威力 4 + 装甲 5 + 智能 9
  [
    { kind: 'fast', count: 2 },
    { kind: 'power', count: 4 },
    { kind: 'armor', count: 5 },
    { kind: 'smart', count: 9 },
  ],
  // 第 8 组：快速 1 + 威力 5 + 装甲 5 + 智能 9
  [
    { kind: 'fast', count: 1 },
    { kind: 'power', count: 5 },
    { kind: 'armor', count: 5 },
    { kind: 'smart', count: 9 },
  ],
  // 第 9 组：威力 5 + 装甲 6 + 智能 9（快速坦克退场）
  [
    { kind: 'power', count: 5 },
    { kind: 'armor', count: 6 },
    { kind: 'smart', count: 9 },
  ],
  // 第 10 组：威力 4 + 装甲 8 + 智能 8（装甲占四成，普通关最难）
  [
    { kind: 'power', count: 4 },
    { kind: 'armor', count: 8 },
    { kind: 'smart', count: 8 },
  ],
];
// 同屏敌军上限的基数与每多一名玩家的增量。
export const MAX_ENEMIES_BASE = 4;
export const MAX_ENEMIES_PER_EXTRA_PLAYER = 2;
// 同屏敌军上限随人数放大：4 / 6 / 8 / 10（1–4 人）。
export function maxEnemiesOnField(playerCount: number): number {
  return MAX_ENEMIES_BASE + MAX_ENEMIES_PER_EXTRA_PLAYER * (playerCount - 1);
}
// 出生间隔（帧）：计时归零且场上有空位时出生新坦克。第 1 关的基准值。
export const ENEMY_SPAWN_INTERVAL_TICKS = 190;
// 每关递减的出生间隔步长与下限：关号越大，援军来得越密。
export const ENEMY_SPAWN_INTERVAL_STEP = 12;
export const ENEMY_SPAWN_INTERVAL_MIN = 90;
// 某关（1-based 关号）的敌军出生间隔（帧）：190 起、每关减 12，最低 90（第 9 关起触底）。
// 单调不增，且恒 ≥ ENEMY_SPAWN_INTERVAL_MIN；stage 越界（回卷关）由 max 自然兜住。
export function enemySpawnIntervalForStage(stage: number): number {
  return Math.max(
    ENEMY_SPAWN_INTERVAL_MIN,
    ENEMY_SPAWN_INTERVAL_TICKS - (stage - 1) * ENEMY_SPAWN_INTERVAL_STEP,
  );
}
// 装甲坦克受损后闪烁：每约 4 帧切换一次银/白配色。
export const ARMOR_FLASH_TICKS = 4;
// 爆炸持续帧数与帧数（tick 驱动）。
export const EXPLOSION_SMALL_TICKS = 18; // 小爆炸：3 帧 × 6
export const EXPLOSION_BIG_TICKS = 24; // 大爆炸：2 帧 × 12
export const EXPLOSION_SMALL_FRAMES = 3;
export const EXPLOSION_BIG_FRAMES = 2;
export const EXPLOSION_BIG_SIZE = 32; // 大爆炸精灵 32×32（居中于 16×16 坦克）

// ── 关卡阶段 / 生命 ──
// 关卡开场“幕布”（STAGE N）冻结帧数：经典过场，期间模拟冻结，随后自动进入 playing。
export const STAGE_START_TICKS = 120;
// 冰面滑行：玩家/敌人在冰面上松开方向键后，沿原方向继续滑行的最大帧数（经典手感）。
export const ICE_SLIDE_TICKS = 20;
// 玩家初始生命数（含当前在场坦克）：3 条即共 3 台坦克。单机保持 NES 原版规则。
export const PLAYER_LIVES_START = 3;
// 多人合作局的初始生命数：合作模式更宽裕（且可向队友借命，见 update.ts onPlayerKilled）。
export const PLAYER_LIVES_START_MP = 5;
// 鹰巢被毁 / 玩家阵亡（无剩余生命）后仍继续模拟的帧数，随后进入 gameover。
export const GAMEOVER_DELAY_TICKS = 90;
// 全歼敌军后仍继续模拟的帧数，随后进入 stageclear。
export const STAGE_CLEAR_DELAY_TICKS = 180;
// "GAME OVER" 由屏幕底部滑到中央所需帧数。
export const GAMEOVER_SLIDE_TICKS = 60;
// 鹰巢（基地）位置：子格列 19–20、行 28–29 → 战场像素 (152,224)，16×16。底部正中。
export const EAGLE_COL = 19;
export const EAGLE_ROW = 28;

// ── 出生护盾（经典无敌）──
// 玩家坦克实体化（开局 / 复活）时获得的无敌帧数；期间敌弹穿过、不受伤。
export const PLAYER_INVULN_TICKS = 180;
// 护盾闪烁精灵：每约 4 帧在两帧间切换，形成流动的星光边框。
export const SHIELD_ANIM_TICKS = 4;

// ── 友军冻结（多人合作）──
// 玩家坦克被队友子弹击中后的冻结帧数：期间不能移动、不能开火（不扣血、不记击杀）。
// 单人局不存在队友，天然不会触发。
export const FRIENDLY_FREEZE_TICKS = 3 * TICKS_PER_SECOND; // 180 帧 = 3 秒
// 冻结中的玩家坦克闪烁周期（帧）：每约 4 帧明灭一次，一眼可辨“这台坦克被冻了”。
export const FRIENDLY_FREEZE_BLINK_TICKS = 4;

// ── 计分 ──
// 击毁各种敌方坦克的得分：经典四型 100–400，智能型因主动追踪与瞄准计 500。
export const ENEMY_SCORE: Record<EnemyKind, number> = {
  basic: 100,
  fast: 200,
  power: 300,
  armor: 400,
  smart: 500,
};

// ── 暂停 ──
// "PAUSE" 文本闪烁周期（帧）：一半亮、一半灭。
export const PAUSE_BLINK_TICKS = 32;

// ── 道具系统（经典六种）──
// 携带道具的敌军在出生队列中的序号（1 起）：第 4 / 11 / 18 台出队者为“携带者”。
// 按“出队计数”标记，不再回看队列下标（队列在出队后会塌缩）。
export const CARRIER_QUEUE_POSITIONS: ReadonlyArray<number> = [4, 11, 18];
// 携带道具敌军红色闪烁周期（帧）：每约 8 帧在常态 / 红色变体间切换。
export const CARRIER_FLASH_TICKS = 8;
// 拾取任一道具的全局加分。
export const POWERUP_SCORE = 500;
// timer 道具：玩家拾取时冻结敌军 10 秒；敌军拾取时只冻结玩家 3 秒，避免多人全队长时间失控。
export const ENEMY_FREEZE_TICKS = 10 * TICKS_PER_SECOND;
export const PLAYER_FREEZE_TICKS = 3 * TICKS_PER_SECOND;
// shovel 道具：鹰巢护墙钢化持续帧数；到期恢复为完整砖墙。
export const SHOVEL_TICKS = 1200;
// helmet 道具：无敌帧数（复用出生护盾机制 / 渲染）。
export const HELMET_INVULN_TICKS = 600;
// star 道具：玩家等级上限。1 级提升移动/弹速并增加 1 点车体生命，
// 2 级开放双弹与破钢，3 级增加一层独立护甲。
export const PLAYER_MAX_LEVEL = 3;
// star 等级 ≥1 时的玩家弹速（px/tick，原为 BULLET_SPEED=2）。
export const STAR_BULLET_SPEED = 3;
// star 等级 ≥2 时同屏可存在的玩家子弹数（原为 1）。
export const PLAYER_MAX_BULLETS_UPGRADED = 2;
// 玩家受到非致命伤害后的白闪持续时间；残血会另有持续冒烟反馈。
export const PLAYER_DAMAGE_FLASH_TICKS = 18;
// 道具浮标闪烁：一个周期 32 帧内前 24 帧可见、后 8 帧隐藏。
export const POWERUP_BLINK_CYCLE_TICKS = 32;
export const POWERUP_BLINK_VISIBLE_TICKS = 24;
// 道具浮标包围盒尺寸（= 一个大格 16×16）。
export const POWERUP_SIZE = TILE;

// ── 道具系统（扩展：场上多枚并存 + 五种新道具）──
// 场上同时存在的道具浮标上限：超限时移除最旧的一枚（数组头）。
export const MAX_POWERUPS_ON_FIELD = 6;
// boots 快靴：拾取者加速持续帧数与倍率（仅作用于移动计算，不改坦克 speed 基值）。
export const BOOTS_TICKS = 20 * TICKS_PER_SECOND; // 1200 帧 = 20 秒
export const BOOTS_SPEED_MULT = 1.5;
// ghost 幽灵：可穿砖持续帧数（到期时若车体仍与砖重叠，砖对其保持可通行直到完全脱离）。
export const GHOST_TICKS = 10 * TICKS_PER_SECOND; // 600 帧 = 10 秒
// 幽灵态坦克的渲染透明度（半透明，与友军冻结的明灭闪烁明显区分）。
export const GHOST_RENDER_ALPHA = 0.45;
// 智能坦克只会主动争夺附近的温和强化；限时效果与耐久仍使用更保守的数值，
// star 则可走完整的三级火炮升级路线（弹速 → 双弹 → 破钢）。
export const SMART_POWERUP_SEEK_RADIUS = 80;
export const SMART_HELMET_TICKS = 4 * TICKS_PER_SECOND;
export const SMART_BOOTS_TICKS = 8 * TICKS_PER_SECOND;
export const SMART_GHOST_TICKS = 5 * TICKS_PER_SECOND;
export const SMART_MAX_LEVEL = PLAYER_MAX_LEVEL;
export const SMART_MAX_HP = 2;
// hourglass 沙漏：敌军半速持续帧数（期间敌军仅在偶数 tick 行动；enemyFreezeTicks 全冻结优先）。
export const ENEMY_SLOW_TICKS = 12 * TICKS_PER_SECOND; // 720 帧 = 12 秒
// 中立道具定时刷新（无水关排除船）：首枚延迟、后续间隔、落点采样失败时的顺延重试间隔。
export const NEUTRAL_POWERUP_FIRST_TICKS = 10 * TICKS_PER_SECOND; // 600 帧 = 10 秒
export const NEUTRAL_POWERUP_INTERVAL_TICKS = 15 * TICKS_PER_SECOND; // 900 帧 = 15 秒
export const NEUTRAL_POWERUP_RETRY_TICKS = 60; // 采样 20 次全失败：1 秒后重试同一枚
export const NEUTRAL_POWERUP_MAX_TRIES = 20; // 单枚落点的最大拒绝采样次数

// ── 魂斗罗风格武器系统 ──
// 玩家默认为 'cannon'（经典炮），拾取武器道具后替换为特殊武器，死亡复活归 'cannon'。
// star 等级与武器并存：cannon 沿用 star 规则（弹速 / 双弹 / 破钢），
// 特殊武器有各自的弹速与在场上限，且 star 满级的破钢只作用于 cannon。

// spread（S 散弹）：一次齐射三发，中路沿朝向直飞、两侧各偏 SPREAD_SPLAY_RAD。
// 在场上限为“一轮齐射”：三发全灭前不能再开火（故上限计数取 1）。
export const SPREAD_PELLET_COUNT = 3;
export const SPREAD_SPLAY_RAD = Math.PI / 8; // 22.5°
export const SPREAD_BULLET_SPEED = 3; // 与 STAR_BULLET_SPEED 一致
export const SPREAD_MAX_VOLLEYS = 1;

// spiral（F 双螺旋炎爆弹）：逻辑核心沿准星直飞，两颗火球仅在渲染层绕中心线反向旋转。
// 16px 宽的连续热区保证轴向瞄准不会因视觉摆动漏怪；命中后产生 24px 炎爆。
export const SPIRAL_BULLET_SPEED = 3;
export const SPIRAL_RADIUS = 6; // 双火球相对逻辑核心的最大视觉摆幅（px）
export const SPIRAL_PERIOD_TICKS = 24; // 双火球完成一轮交叉的周期（帧）
export const SPIRAL_HIT_WIDTH = 16; // 垂直于行进方向的连续热区宽度
export const SPIRAL_HIT_LENGTH = 8; // 沿行进方向的热区长度
export const SPIRAL_BLAST_SIZE = 24; // 命中炎爆的正方形伤害范围
export const SPIRAL_BRICK_BLAST_SIZE = 16; // 炎爆清除砖墙的范围（钢块不受影响）
export const SPIRAL_GUARD_HITS = 1; // 外层火焰可烧掉一发对方子弹后继续飞
export const SPIRAL_MAX_BULLETS = 1;

// laser（L 激光）：高速贯穿弹 —— 穿敌人（照常扣血/记分/爆炸）、穿砖块（照常开凿）；
// 钢块 / 边界 / 鹰巢照常终止，命中队友照常走冻结分支并消亡。
export const LASER_BULLET_SPEED = 8;
export const LASER_MAX_BULLETS = 1;

// machine（M 机枪）：按住连发（非边沿），每 MACHINE_FIRE_INTERVAL_TICKS 帧一发。
export const MACHINE_BULLET_SPEED = 3; // 与 STAR_BULLET_SPEED 一致
export const MACHINE_FIRE_INTERVAL_TICKS = PLAYER_FIRE_INTERVAL_TICKS;
export const MACHINE_MAX_BULLETS = 3;

// 激光精灵为 8×8 逻辑（细长亮条居中于精灵），绘制时相对 4×4 弹体盒左上角的偏移。
export const LASER_SPRITE_SIZE = 8;
export const LASER_SPRITE_OFFSET = (LASER_SPRITE_SIZE - BULLET_SIZE) / 2; // 2

// ── Boss 关（每组第 3 关：3 / 7 / … / 39）──
// Boss 是一台 32×32 巨型坦克（普通坦克的 2×2，即 4 格大小）：对坦克是实心障碍，
// 对小兵子弹是吸收体，能在战场内四向移动，并以双发破障激光打通砖墙（钢墙打不穿，只能绕行）。
// 只有玩家子弹能对它造成伤害（受击次数制，见 BOSS_DAMAGE_*）。全部数值以 tick 计。

// 车体尺寸与默认初始坐标（战场相对像素，32×32 盒左上角）。
// 默认值供直接构造与第 1 / 5 / 10 张经典中轴竞技场使用；正式开关时由
// BOSS_ARENA_CONFIGS 把每张地图自己的入场点传给 createBoss。
export const BOSS_SIZE = TANK_SIZE * 2;
export const BOSS_X = (FIELD_WIDTH - BOSS_SIZE) / 2; // 144
export const BOSS_Y = 48;
// 移动与破障：Boss 以基础敌军速度追踪最近玩家；被砖墙挡住时发射两枚破障激光，
// 两条 16px 破坏带并排，恰好为 32px 车体清出通路。钢墙不可破，只能绕行。
// 冷却拉长到 2 秒，避免掩体被连续刷弹瞬间蒸发。
export const BOSS_SPEED = ENEMY_SPEED_BASIC;
// 单机局的追踪速度：一阶段定点不动（速度 0，见 boss.ts bossMoveSpeed），二阶段起慢速追踪。
export const BOSS_SPEED_SOLO_P2 = 0.35;
// 移动方向承诺期（帧）：新选中的方向至少坚持这么久（被堵或该轴走完则立即解除）。
// 消除两类甩头：斜向追击时主次轴逐帧互换的楼梯抖动、绕障时逐帧重评估的来回横跳。
export const BOSS_MOVE_COMMIT_TICKS = 16;
export const BOSS_BREACH_INTERVAL_TICKS = 120;
export const BOSS_BREACH_BULLET_SPEED = 2;
// Boss 弹幕的射手 id：任何坦克都不会取到 0（玩家 id 从 1 起），故可安全用作哨兵值。
export const BOSS_OWNER_ID = 0;

// ── Boss 序号（b）──
// 第 b 位 Boss = 第 b 组的第 3 关（关号 4b-1），b ∈ 1..STAGE_GROUP_COUNT(10)。
// 竞技场、血量、攻击间隔、技能解锁全部按它索引，绝不再各自算关号。
export function bossOrdinalForStage(stage: number): number {
  return stageGroup(stage);
}

// 血量（受击次数制）：基础 100 + 10×(b−1)，每多一名玩家再 +60。
// 例：1 号 Boss 单人 100 / 四人 280；10 号 Boss 单人 190 / 四人 370。
export const BOSS_HP_BASE = 100;
export const BOSS_HP_PER_ORDINAL = 10;
export const BOSS_HP_PER_EXTRA_PLAYER = 60;
export function bossMaxHp(playerCount: number, bossOrdinal = 1): number {
  return (
    BOSS_HP_BASE +
    BOSS_HP_PER_ORDINAL * (bossOrdinal - 1) +
    BOSS_HP_PER_EXTRA_PLAYER * (playerCount - 1)
  );
}
// 单发伤害：激光弹 −2，其余一律 −1（drill / star 等级不改变对 Boss 的伤害）。
export const BOSS_DAMAGE_NORMAL = 1;
export const BOSS_DAMAGE_LASER = 2;
// 受击白闪帧数。
export const BOSS_HIT_FLASH_TICKS = 3;
// 进入第二阶段的血量比例（hp < maxHp × 该比例，单向不回退）。
export const BOSS_PHASE2_HP_RATIO = 0.5;

// 攻击循环：冷却归零即从该阶段的攻击池随机（state.rng）选一发动。
// 这两个值是**1 号 Boss 的基准**；实际间隔由 bossAttackIntervalTicks 按序号 b 线性收紧。
export const BOSS_ATTACK_INTERVAL_P1 = 180;
export const BOSS_ATTACK_INTERVAL_P2 = 160;

// 每高一位 Boss，攻击间隔再收紧 1.5%：b=1 为 100%、b=10 为 1 − 0.015×9 = 86.5%。
export const BOSS_ATTACK_INTERVAL_STEP = 0.015;
// 狂暴（仅 10 号 Boss，hp < 25% 时单向进入）：攻击间隔再 ×0.75、弹幕弹速 ×1.2。
export const BOSS_ENRAGE_ORDINAL = STAGE_GROUP_COUNT; // 10 —— 只有最后一位 Boss 会狂暴
export const BOSS_ENRAGE_HP_RATIO = 0.25;
export const BOSS_ENRAGE_INTERVAL_MULT = 0.75;
export const BOSS_ENRAGE_BULLET_SPEED_MULT = 1.2;

// 某位 Boss 在某阶段的攻击间隔（帧）。纯函数、无副作用：
//   基准（P1 180 / P2 160）× 序号收紧 × 狂暴倍率，向下取整，至少 1 帧。
// 对固定的 phase / enraged，结果随 b 单调不增（见 test/boss.test.ts）。
export function bossAttackIntervalTicks(
  phase: 1 | 2,
  bossOrdinal: number,
  enraged = false,
): number {
  const base = phase === 2 ? BOSS_ATTACK_INTERVAL_P2 : BOSS_ATTACK_INTERVAL_P1;
  const ramp = 1 - BOSS_ATTACK_INTERVAL_STEP * (bossOrdinal - 1);
  const mult = enraged ? BOSS_ENRAGE_INTERVAL_MULT : 1;
  return Math.max(1, Math.floor(base * ramp * mult));
}

// ── 技能解锁表（按 Boss 序号累积）──
// 1 号 Boss = 现状基础组；此后每位 Boss 进一件新技能，且一旦解锁永不移除。
//   b≥2 弹幕墙 bulletWall（P1 池） / b≥3 蓄力冲撞 charge（P2 池）
//   b≥4 迫击炮雨 mortar（P1 池）   / b≥5 召唤援军 summon（P1 池）
//   b≥6 沿途布雷 mines（被动，不进攻击池，见 bossMinesEnabled）
//   b≥7 磁力牵引 magnet（P2 池）   / b≥8 横扫激光 sweepLaser（P2 池）
//   b=9 无新技能：全池解锁 + 间隔继续收紧；b=10 狂暴（见 BOSS_ENRAGE_*）。
export const BOSS_SKILL_UNLOCK_BULLET_WALL = 2;
export const BOSS_SKILL_UNLOCK_CHARGE = 3;
export const BOSS_SKILL_UNLOCK_MORTAR = 4;
export const BOSS_SKILL_UNLOCK_SUMMON = 5;
export const BOSS_SKILL_UNLOCK_MINES = 6;
export const BOSS_SKILL_UNLOCK_MAGNET = 7;
export const BOSS_SKILL_UNLOCK_SWEEP = 8;

// 1 号 Boss 的基础攻击池（历史行为）。
const BOSS_BASE_ATTACKS_P1: ReadonlyArray<BossAttackKind> = ['laser', 'radial', 'burst'];
const BOSS_BASE_ATTACKS_P2: ReadonlyArray<BossAttackKind> = [
  'laser',
  'radial',
  'burst',
  'spin',
  'dualLaser',
];

// 各竞技场的招牌技能。重复放入攻击池即代表更高权重，仍保持确定性随机与纯数据快照。
// 第 6 位的招牌是被动布雷，不额外提高某个主动技能的权重。
const BOSS_SIGNATURE_ATTACKS: ReadonlyArray<{
  p1?: BossAttackKind;
  p2?: BossAttackKind;
}> = [
  {},
  { p1: 'bulletWall' },
  { p2: 'charge' },
  { p1: 'mortar' },
  { p1: 'summon' },
  {},
  { p2: 'magnet' },
  { p2: 'sweepLaser' },
  { p1: 'bulletWall', p2: 'spin' },
  { p1: 'mortar', p2: 'dualLaser' },
];

// 第 b 位 Boss 的两个阶段攻击池（表驱动，纯函数）。基础技能各占一份，招牌技能
// 额外占两份；因此能稳定塑造关卡身份，又不会把战斗锁死成固定脚本。
export function bossSkillsFor(b: number): {
  p1: ReadonlyArray<BossAttackKind>;
  p2: ReadonlyArray<BossAttackKind>;
} {
  const p1: BossAttackKind[] = [...BOSS_BASE_ATTACKS_P1];
  const p2: BossAttackKind[] = [...BOSS_BASE_ATTACKS_P2];
  if (b >= BOSS_SKILL_UNLOCK_BULLET_WALL) p1.push('bulletWall');
  if (b >= BOSS_SKILL_UNLOCK_CHARGE) p2.push('charge');
  if (b >= BOSS_SKILL_UNLOCK_MORTAR) p1.push('mortar');
  if (b >= BOSS_SKILL_UNLOCK_SUMMON) p1.push('summon');
  if (b >= BOSS_SKILL_UNLOCK_MAGNET) p2.push('magnet');
  if (b >= BOSS_SKILL_UNLOCK_SWEEP) p2.push('sweepLaser');
  const signature = BOSS_SIGNATURE_ATTACKS[b - 1];
  if (signature?.p1 && p1.includes(signature.p1)) {
    p1.push(signature.p1, signature.p1);
  }
  if (signature?.p2 && p2.includes(signature.p2)) {
    p2.push(signature.p2, signature.p2);
  }
  return { p1, p2 };
}

// 沿途布雷是被动技能（不进攻击池）：第 6 位起的 Boss 一边移动一边在车尾丢雷。
export function bossMinesEnabled(b: number): boolean {
  return b >= BOSS_SKILL_UNLOCK_MINES;
}

// ⑥ 弹幕墙 bulletWall（b≥2，P1 池）：从 Boss 所在行朝目标半场齐射一整排子弹，
// 横向间隔 16px，随机（rng）留一个 32px（= 2 个弹位）的缺口 —— 缺口就是唯一生路。
export const BOSS_WALL_SPACING = TILE; // 16：相邻两发的横向间隔
export const BOSS_WALL_GAP_SLOTS = 2; // 连续留空的弹位数（2 × 16px = 32px 缺口）
export const BOSS_WALL_SPEED = 1.6;

// ⑦ 蓄力冲撞 charge（b≥3，P2 池）：预警 45 帧（整条冲撞路径闪烁）→ 4px/帧冲锋，
// 沿途砖块整格粉碎、撞到玩家即击毁；撞钢眩晕 90 帧、撞边界 / 水面眩晕 45 帧。
// **眩晕期是本技能的核心反制窗口**：Boss 不移动、不攻击，可以随便打（见 boss.ts）。
export const BOSS_CHARGE_WARN_TICKS = 45;
export const BOSS_CHARGE_SPEED = 4;
export const BOSS_CHARGE_STUN_STEEL_TICKS = 90;
export const BOSS_CHARGE_STUN_SOFT_TICKS = 45;
// 预警路径闪烁周期（帧）。
export const BOSS_CHARGE_BLINK_TICKS = 5;

// ⑧ 迫击炮雨 mortar（b≥4，P1 池）：选 4 个落点（每名存活玩家附近 ±32px 散布，
// 不足 4 个用随机点凑满），地面画闪烁十字标记 48 帧后爆炸：
// 16×16 判定内的玩家即毁、砖块整格清除、钢块不毁。
export const BOSS_MORTAR_COUNT = 4;
export const BOSS_MORTAR_FUSE_TICKS = 48;
export const BOSS_MORTAR_SCATTER = 32; // 每轴 ±32px 的散布半径
export const BOSS_MORTAR_BLAST = TILE; // 16×16 爆炸判定
export const BOSS_MORTAR_MARK_BLINK_TICKS = 6;

// ⑨ 召唤援军 summon（b≥5，P1 池）：立即在 Boss 两侧闪现 2 只小兵（无视 BOSS_MINION_MAX
// 软上限），但全场敌军受硬上限约束，超出则少放。种类取当前关的小兵池。
export const BOSS_SUMMON_COUNT = 2;
export const BOSS_ENEMY_HARD_CAP = 6;

// ⑩ 沿途布雷 mines（b≥6，被动）：Boss 处于移动状态时每 90 帧在车尾放一枚 8×8 地雷。
// 武装延时 60 帧（此前无害），武装后玩家碰触即爆（击毁玩家 + 小爆炸），
// 240 帧后自爆消失；任何子弹打中都能提前引爆（安全排雷）。
export const BOSS_MINE_SIZE = SUBTILE; // 8×8
export const BOSS_MINE_MAX = 6; // 全场同时存在的地雷上限
export const BOSS_MINE_INTERVAL_TICKS = 90;
export const BOSS_MINE_ARM_TICKS = 60;
export const BOSS_MINE_LIFE_TICKS = 240;
export const BOSS_MINE_BLINK_TICKS = 8; // 武装后闪红周期（帧）

// ⑪ 磁力牵引 magnet（b≥7，P2 池）：预警 30 帧（Boss 泛紫脉冲）→ 持续 90 帧，
// 每帧把所有存活玩家向 Boss 中心拉 0.25px（逐轴做地形碰撞校验，拉不动就停在障碍前），
// 同时每 30 帧放一圈 8 向弹幕。
export const BOSS_MAGNET_WARN_TICKS = 30;
export const BOSS_MAGNET_TICKS = 90;
export const BOSS_MAGNET_PULL_PER_TICK = 0.25;
export const BOSS_MAGNET_WAVE_INTERVAL_TICKS = 30;
export const BOSS_MAGNET_BULLETS = 8;
export const BOSS_MAGNET_SPEED = 1.5;
export const BOSS_MAGNET_PULSE_TICKS = 6; // 紫色脉冲环的呼吸周期（帧）

// ⑫ 横扫激光 sweepLaser（b≥8，P2 池）：预警 45 帧（起始列红线 + 扫向箭头）→
// 激光列以 1.2px/帧朝目标所在半场横移，扫完该半场即结束；站到另一半场即安全。
// 命中判定复用整列激光（同一玩家一次横扫至多结算一次）。
export const BOSS_SWEEP_WARN_TICKS = 45;
export const BOSS_SWEEP_SPEED = 1.2;

// ① 垂直粗激光（两阶段）：前摇 90 帧（红色瞄准线，不伤人）→ 激光 30 帧（宽 16px、整列贯穿）。
// 双列激光（⑤）与它共用这组计时。
export const BOSS_LASER_WINDUP_TICKS = 90;
export const BOSS_LASER_ACTIVE_TICKS = 30;
export const BOSS_LASER_WIDTH = TILE; // 16
// 瞄准线闪烁周期（帧）：一半亮、一半灭。
export const BOSS_AIM_BLINK_TICKS = 6;
// ⑤ 双列激光（仅 phase2）：单人局无第二名玩家可锁，改用玩家列 ±该偏移的两列。
export const BOSS_DUAL_LASER_SOLO_OFFSET = 32;

// ② 8 向放射弹幕（两阶段）：45° 间隔 8 发，弹速 1.75px/tick。
export const BOSS_RADIAL_BULLETS = 8;
export const BOSS_RADIAL_SPEED = 1.75;

// ③ 三连瞄准射（两阶段）：朝最近玩家中心连射 3 发，间隔 12 帧，弹速 2.5（发射瞬间实时瞄准）。
export const BOSS_BURST_SHOTS = 3;
export const BOSS_BURST_INTERVAL_TICKS = 12;
export const BOSS_BURST_SPEED = 2.5;

// ④ 16 向旋转弹幕（仅 phase2）：2 波、每波 16 发、波间 30 帧，每波起始角偏转 7.5°。
export const BOSS_SPIN_WAVES = 2;
export const BOSS_SPIN_BULLETS = 16;
export const BOSS_SPIN_WAVE_INTERVAL_TICKS = 30;
export const BOSS_SPIN_STEP_RAD = Math.PI / 24; // 7.5°
export const BOSS_SPIN_SPEED = 1.6;

// Boss 死亡：错落 3–5 个大爆炸（数量取 MIN + rng.int(RANGE)）。
export const BOSS_DEATH_EXPLOSION_MIN = 3;
export const BOSS_DEATH_EXPLOSION_RANGE = 3; // → 3..5

// 小兵（Boss 关专属无限补充）：单人基数 2 只、出生间隔 400 帧、每第 2 只携带道具
//（Boss 关缺乏输出增益来源，靠携带者掉落给玩家补给）。
export const BOSS_MINION_MAX = 2;
export const BOSS_MINION_INTERVAL_TICKS = 400;
export const BOSS_MINION_CARRIER_EVERY = 2;
// Boss 小兵上限随合作人数扩展：2 / 3 / 4 / 5。
export function bossMinionsOnField(playerCount: number): number {
  return BOSS_MINION_MAX + Math.max(0, playerCount - 1);
}
// 各 Boss 关的小兵种类池（按 state.rng 等概率取）：第 10 组最终 Boss 用 B 池，其余用 A 池。
export const BOSS_MINION_KINDS_A: ReadonlyArray<EnemyKind> = ['basic', 'fast'];
export const BOSS_MINION_KINDS_B: ReadonlyArray<EnemyKind> = ['power', 'smart'];
// 某 Boss 关的小兵池（定时补充与 summon 技能共用同一张表，绝不各自判关号）。
export function bossMinionKindsForStage(stage: number): ReadonlyArray<EnemyKind> {
  return isBossStage(stage) && stageGroup(stage) === STAGE_GROUP_COUNT
    ? BOSS_MINION_KINDS_B
    : BOSS_MINION_KINDS_A;
}

// 中立道具对 Boss 的控制效果（玩家拾取时生效，与敌军的冻结 / 减速另行计算）：
// timer（时钟）冻结 Boss 2 秒 —— 不动、不破障、攻击状态机整体暂停；
// hourglass（沙漏）令 Boss 半速 12 秒 —— 仅偶数 tick 推进移动与攻击计时。
export const BOSS_FREEZE_TICKS = 2 * TICKS_PER_SECOND; // 120 帧 = 2 秒
export const BOSS_SLOW_TICKS = ENEMY_SLOW_TICKS; // 720 帧 = 12 秒

// Boss 渲染配色：血条底 / 血条前景（按剩余比例 红 → 橙 → 黄）/ 瞄准线 / 激光芯与边 / 冻结冷蓝罩。
export const COLOR_BOSS_HP_BACK = '#3c1414';
export const COLOR_BOSS_HP_HIGH = '#d82800';
export const COLOR_BOSS_HP_MID = '#f85838';
export const COLOR_BOSS_HP_LOW = '#f0c860';
export const COLOR_BOSS_AIM = '#f85838';
export const COLOR_BOSS_LASER_CORE = '#ffffff';
export const COLOR_BOSS_LASER_EDGE = '#58f8f8';
export const COLOR_BOSS_FREEZE = '#58a8f8';
// 新技能的渲染配色：冲撞预警路径 / 迫击炮落点十字 / 磁力紫脉冲 / 地雷本体与武装闪红。
export const COLOR_BOSS_CHARGE_WARN = '#f8b800';
export const COLOR_BOSS_MORTAR_MARK = '#f85838';
export const COLOR_BOSS_MAGNET = '#a858f8';
export const COLOR_BOSS_MINE_BODY = '#7c7c7c';
export const COLOR_BOSS_MINE_ARMED = '#e44437';

// 武器在 HUD 上的字母配色（与道具图标内的字母同色系；cannon 用 COLOR_HUD_ICON 黑）。
export const COLOR_WEAPON_SPREAD = '#f0c860'; // 黄
export const COLOR_WEAPON_SPIRAL = '#f85838'; // 橙红
export const COLOR_WEAPON_LASER = '#78d8f8'; // 亮青
export const COLOR_WEAPON_MACHINE = '#78e048'; // 亮绿

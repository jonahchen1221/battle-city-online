import type { EnemyKind } from '../game/tank';

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

// 战场在屏幕上的偏移（左侧 16px 灰边，顶部 8px，右侧留 32px HUD 栏）
export const FIELD_X = 16;
export const FIELD_Y = 8;

// 固定逻辑帧率（与 NES 一致）；所有速度单位为 px/tick
export const TICKS_PER_SECOND = 60;

// 美术分辨率倍数（仅限渲染层！）：把所有精灵按 2× 重新绘制、画布内部分辨率放大到
// NATIVE_*×ART_SCALE（736×512），从而获得 4× 像素细节。
// 逻辑坐标 / 游戏代码（src/game/）一律保持在 368×256 空间，不受此常量影响。
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

// 水面动画：每约 32 逻辑帧切换一帧
export const WATER_ANIM_TICKS = 32;

// 坦克尺寸（= 一个大格）
export const TANK_SIZE = TILE; // 16

// 玩家坦克移动速度（px/tick）
export const PLAYER_SPEED = 0.75;

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

// 开火输入缓冲（帧）：按下沿装填；在场子弹达到上限时不吞掉这次按键，
// 缓冲窗口内一旦腾出弹位立即补发。机枪为按住连发，不走缓冲。
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
// A* 中进入含砖位置的代价：优先选择短绕路，无路可绕时仍会主动射穿砖墙。
export const SMART_AI_BRICK_COST = 6;
// 关卡敌军总数（单一可调常量；暂不随人数变化）。各关 STAGE_ENEMY_MIX 之和均等于此值。
export const STAGE_ENEMY_TOTAL = 20;
// 关卡总数（levels.ts STAGES 的长度）；通关第 10 关后回卷到第 1 关。
export const STAGE_COUNT = 10;
// 每关敌军编成（每关总数均为 STAGE_ENEMY_TOTAL，逐关升级）。
// 出生队列按各种类剩余数轮转交错（round-robin）构建，确定性、无需 rng（见 state.ts）。
export const STAGE_ENEMY_MIX: ReadonlyArray<ReadonlyArray<{ kind: EnemyKind; count: number }>> = [
  // 第 1 关：基础 14 + 快速 2 + 智能 4（智能占 20%）
  [
    { kind: 'basic', count: 14 },
    { kind: 'fast', count: 2 },
    { kind: 'smart', count: 4 },
  ],
  // 第 2 关：基础 8 + 快速 5 + 威力 2 + 智能 5（智能占 25%）
  [
    { kind: 'basic', count: 8 },
    { kind: 'fast', count: 5 },
    { kind: 'power', count: 2 },
    { kind: 'smart', count: 5 },
  ],
  // 第 3 关：基础 5 + 快速 5 + 威力 2 + 装甲 2 + 智能 6（智能占 30%）
  [
    { kind: 'basic', count: 5 },
    { kind: 'fast', count: 5 },
    { kind: 'power', count: 2 },
    { kind: 'armor', count: 2 },
    { kind: 'smart', count: 6 },
  ],
  // 第 4 关：基础 2 + 快速 5 + 威力 3 + 装甲 3 + 智能 7（智能占 35%）
  [
    { kind: 'basic', count: 2 },
    { kind: 'fast', count: 5 },
    { kind: 'power', count: 3 },
    { kind: 'armor', count: 3 },
    { kind: 'smart', count: 7 },
  ],
  // 第 5 关：快速 4 + 威力 4 + 装甲 4 + 智能 8（智能占 40%，不再出现基础型）
  [
    { kind: 'fast', count: 4 },
    { kind: 'power', count: 4 },
    { kind: 'armor', count: 4 },
    { kind: 'smart', count: 8 },
  ],
  // ── 后半程（第 6–10 关）──
  // 硬骨头（威力 + 装甲）合计逐关单调不减：8 → 8 → 9 → 10 → 11 → 12；
  // 智能坦克稳定在 45%，快速坦克逐关退场，最终由装甲与威力压满战场。
  // 第 6 关：快速 3 + 威力 4 + 装甲 4 + 智能 9（智能占 45%）
  [
    { kind: 'fast', count: 3 },
    { kind: 'power', count: 4 },
    { kind: 'armor', count: 4 },
    { kind: 'smart', count: 9 },
  ],
  // 第 7 关：快速 2 + 威力 4 + 装甲 5 + 智能 9
  [
    { kind: 'fast', count: 2 },
    { kind: 'power', count: 4 },
    { kind: 'armor', count: 5 },
    { kind: 'smart', count: 9 },
  ],
  // 第 8 关：快速 1 + 威力 5 + 装甲 5 + 智能 9
  [
    { kind: 'fast', count: 1 },
    { kind: 'power', count: 5 },
    { kind: 'armor', count: 5 },
    { kind: 'smart', count: 9 },
  ],
  // 第 9 关：威力 5 + 装甲 6 + 智能 9（快速坦克退场）
  [
    { kind: 'power', count: 5 },
    { kind: 'armor', count: 6 },
    { kind: 'smart', count: 9 },
  ],
  // 第 10 关：威力 4 + 装甲 8 + 智能 8（装甲占四成，全场最难）
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
// timer 道具：对方阵营冻结帧数（期间不能移动或开火，履带动画亦冻结）。
export const ENEMY_FREEZE_TICKS = 600;
// shovel 道具：鹰巢护墙钢化持续帧数；到期恢复为完整砖墙。
export const SHOVEL_TICKS = 1200;
// helmet 道具：无敌帧数（复用出生护盾机制 / 渲染）。
export const HELMET_INVULN_TICKS = 600;
// star 道具：坦克等级上限；等级 ≥1 提升弹速、≥2 可双弹在场、=3 可击穿钢块。
export const PLAYER_MAX_LEVEL = 3;
// star 等级 ≥1 时的玩家弹速（px/tick，原为 BULLET_SPEED=2）。
export const STAR_BULLET_SPEED = 3;
// star 等级 ≥2 时同屏可存在的玩家子弹数（原为 1）。
export const PLAYER_MAX_BULLETS_UPGRADED = 2;
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
// 智能坦克只会主动争夺附近的温和强化，并使用更短持续时间 / 更低上限控制强度。
export const SMART_POWERUP_SEEK_RADIUS = 80;
export const SMART_HELMET_TICKS = 4 * TICKS_PER_SECOND;
export const SMART_BOOTS_TICKS = 8 * TICKS_PER_SECOND;
export const SMART_GHOST_TICKS = 5 * TICKS_PER_SECOND;
export const SMART_MAX_LEVEL = 1;
export const SMART_MAX_HP = 2;
// hourglass 沙漏：敌军半速持续帧数（期间敌军仅在偶数 tick 行动；enemyFreezeTicks 全冻结优先）。
export const ENEMY_SLOW_TICKS = 12 * TICKS_PER_SECOND; // 720 帧 = 12 秒
// 中立道具定时刷新（每关必出五种新道具）：首枚延迟、后续间隔、落点采样失败时的顺延重试间隔。
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

// spiral（F 螺旋弹）：前进分量恒定，实际位置在直线路径两侧做正弦摆动。
// 摆动用增量式实现（每帧位移 = 前进分量 + (sin((age+1)ω)−sin(age·ω))·R），无需记录出膛原点。
export const SPIRAL_BULLET_SPEED = 2;
export const SPIRAL_RADIUS = 6; // 摆动半径（px）
export const SPIRAL_PERIOD_TICKS = 24; // 摆动周期（帧）
export const SPIRAL_MAX_BULLETS = 1;

// laser（L 激光）：高速贯穿弹 —— 穿敌人（照常扣血/记分/爆炸）、穿砖块（照常开凿）；
// 钢块 / 边界 / 鹰巢照常终止，命中队友照常走冻结分支并消亡。
export const LASER_BULLET_SPEED = 8;
export const LASER_MAX_BULLETS = 1;

// machine（M 机枪）：按住连发（非边沿），每 MACHINE_FIRE_INTERVAL_TICKS 帧一发。
export const MACHINE_BULLET_SPEED = 3; // 与 STAR_BULLET_SPEED 一致
export const MACHINE_FIRE_INTERVAL_TICKS = 10;
export const MACHINE_MAX_BULLETS = 3;

// 激光精灵为 8×8 逻辑（细长亮条居中于精灵），绘制时相对 4×4 弹体盒左上角的偏移。
export const LASER_SPRITE_SIZE = 8;
export const LASER_SPRITE_OFFSET = (LASER_SPRITE_SIZE - BULLET_SIZE) / 2; // 2

// 武器在 HUD 上的字母配色（与道具图标内的字母同色系；cannon 用 COLOR_HUD_ICON 黑）。
export const COLOR_WEAPON_SPREAD = '#f0c860'; // 黄
export const COLOR_WEAPON_SPIRAL = '#f85838'; // 橙红
export const COLOR_WEAPON_LASER = '#78d8f8'; // 亮青
export const COLOR_WEAPON_MACHINE = '#78e048'; // 亮绿

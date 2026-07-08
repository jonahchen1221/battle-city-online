// NES 原生分辨率与布局（所有游戏逻辑均以此坐标系为准，渲染时整体放大）
export const NATIVE_WIDTH = 256;
export const NATIVE_HEIGHT = 224;

// 战场：13×13 个大格（每格 16px），即 26×26 个子格（每格 8px）
export const TILE = 16; // 大格边长（坦克尺寸）
export const SUBTILE = 8; // 子格边长（砖块破坏的基本单位）
export const FIELD_COLS = 26; // 子格列数
export const FIELD_ROWS = 26; // 子格行数
export const FIELD_WIDTH = FIELD_COLS * SUBTILE; // 208
export const FIELD_HEIGHT = FIELD_ROWS * SUBTILE; // 208

// 战场在屏幕上的偏移（左侧 16px 灰边，顶部 8px，右侧留 32px HUD 栏）
export const FIELD_X = 16;
export const FIELD_Y = 8;

// 固定逻辑帧率（与 NES 一致）；所有速度单位为 px/tick
export const TICKS_PER_SECOND = 60;

// 渲染放大倍数
export const RENDER_SCALE = 3;

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

// 玩家 1 出生点（战场相对坐标，子格 8 列 / 24 行，即左下角朝上）
export const PLAYER1_SPAWN_X = 8 * SUBTILE; // 64
export const PLAYER1_SPAWN_Y = 24 * SUBTILE; // 192

// 子弹尺寸与速度
export const BULLET_SIZE = 4;
export const BULLET_SPEED = 2; // px/tick

// 子弹击穿砖块：垂直行进方向宽 16px、沿行进方向纵深 8px 的破坏条
export const BRICK_CARVE_WIDTH = TILE; // 16
export const BRICK_CARVE_DEPTH = SUBTILE; // 8

// 坦克履带动画：移动时每约 8 逻辑帧切换一帧
export const TRACK_ANIM_TICKS = 8;

// ── 敌方坦克 ──
// 移动速度（px/tick）：快速坦克最快，基础/装甲最慢。
export const ENEMY_SPEED_BASIC = 0.5;
export const ENEMY_SPEED_FAST = 1.0;
export const ENEMY_SPEED_POWER = 0.75;
export const ENEMY_SPEED_ARMOR = 0.5;
// 血量：常规敌军 1 发即毁，装甲坦克需 4 发。
export const ENEMY_HP_DEFAULT = 1;
export const ARMOR_HP = 4;
// 敌弹速度：威力坦克的子弹更快，其余与玩家一致。
export const ENEMY_BULLET_SPEED_POWER = 3;
export const ENEMY_BULLET_SPEED_DEFAULT = 2;
// 出生点（战场相对坐标，16×16 盒左上角）：左 / 中 / 右，出生朝下。
export const ENEMY_SPAWN_POINTS: ReadonlyArray<{ x: number; y: number }> = [
  { x: 0, y: 0 }, // 左
  { x: 96, y: 0 }, // 中
  { x: 192, y: 0 }, // 右
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
// 关卡敌军总数与同屏上限。
export const STAGE_ENEMY_TOTAL = 20;
export const MAX_ENEMIES_ON_FIELD = 4;
// 出生间隔（帧）：计时归零且场上有空位时出生新坦克。
export const ENEMY_SPAWN_INTERVAL_TICKS = 190;
// 装甲坦克受损后闪烁：每约 4 帧切换一次银/白配色。
export const ARMOR_FLASH_TICKS = 4;
// 爆炸持续帧数与帧数（tick 驱动）。
export const EXPLOSION_SMALL_TICKS = 18; // 小爆炸：3 帧 × 6
export const EXPLOSION_BIG_TICKS = 24; // 大爆炸：2 帧 × 12
export const EXPLOSION_SMALL_FRAMES = 3;
export const EXPLOSION_BIG_FRAMES = 2;
export const EXPLOSION_BIG_SIZE = 32; // 大爆炸精灵 32×32（居中于 16×16 坦克）

// ── 关卡阶段 / 生命 ──
// 玩家初始生命数（含当前在场坦克）：3 条即共 3 台坦克。
export const PLAYER_LIVES_START = 3;
// 鹰巢被毁 / 玩家阵亡（无剩余生命）后仍继续模拟的帧数，随后进入 gameover。
export const GAMEOVER_DELAY_TICKS = 90;
// 全歼敌军后仍继续模拟的帧数，随后进入 stageclear。
export const STAGE_CLEAR_DELAY_TICKS = 180;
// "GAME OVER" 由屏幕底部滑到中央所需帧数。
export const GAMEOVER_SLIDE_TICKS = 60;
// 鹰巢（基地）位置：子格列 12–13、行 24–25 → 战场像素 (96,192)，16×16。
export const EAGLE_COL = 12;
export const EAGLE_ROW = 24;

// ── 出生护盾（经典无敌）──
// 玩家坦克实体化（开局 / 复活）时获得的无敌帧数；期间敌弹穿过、不受伤。
export const PLAYER_INVULN_TICKS = 180;
// 护盾闪烁精灵：每约 4 帧在两帧间切换，形成流动的星光边框。
export const SHIELD_ANIM_TICKS = 4;

// ── 计分 ──
// 击毁各种敌方坦克的得分（经典）：基础 100 / 快速 200 / 威力 300 / 装甲 400。
export const ENEMY_SCORE: Record<'basic' | 'fast' | 'power' | 'armor', number> = {
  basic: 100,
  fast: 200,
  power: 300,
  armor: 400,
};

// ── 暂停 ──
// "PAUSE" 文本闪烁周期（帧）：一半亮、一半灭。
export const PAUSE_BLINK_TICKS = 32;

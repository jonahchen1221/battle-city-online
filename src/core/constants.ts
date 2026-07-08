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
// 关卡敌军总数（单一可调常量；暂不随人数变化）。各关 STAGE_ENEMY_MIX 之和均等于此值。
export const STAGE_ENEMY_TOTAL = 20;
// 关卡总数（levels.ts STAGES 的长度）；通关第 5 关后回卷到第 1 关。
export const STAGE_COUNT = 5;
// 每关敌军编成（每关总数均为 STAGE_ENEMY_TOTAL，逐关升级）。
// 出生队列按各种类剩余数轮转交错（round-robin）构建，确定性、无需 rng（见 state.ts）。
export const STAGE_ENEMY_MIX: ReadonlyArray<ReadonlyArray<{ kind: EnemyKind; count: number }>> = [
  // 第 1 关：基础 18 + 快速 2
  [
    { kind: 'basic', count: 18 },
    { kind: 'fast', count: 2 },
  ],
  // 第 2 关：基础 12 + 快速 6 + 威力 2
  [
    { kind: 'basic', count: 12 },
    { kind: 'fast', count: 6 },
    { kind: 'power', count: 2 },
  ],
  // 第 3 关：基础 10 + 快速 6 + 威力 2 + 装甲 2
  [
    { kind: 'basic', count: 10 },
    { kind: 'fast', count: 6 },
    { kind: 'power', count: 2 },
    { kind: 'armor', count: 2 },
  ],
  // 第 4 关：基础 8 + 快速 6 + 威力 3 + 装甲 3
  [
    { kind: 'basic', count: 8 },
    { kind: 'fast', count: 6 },
    { kind: 'power', count: 3 },
    { kind: 'armor', count: 3 },
  ],
  // 第 5 关：基础 6 + 快速 6 + 威力 4 + 装甲 4
  [
    { kind: 'basic', count: 6 },
    { kind: 'fast', count: 6 },
    { kind: 'power', count: 4 },
    { kind: 'armor', count: 4 },
  ],
];
// 同屏敌军上限的基数与每多一名玩家的增量。
export const MAX_ENEMIES_BASE = 4;
export const MAX_ENEMIES_PER_EXTRA_PLAYER = 2;
// 同屏敌军上限随人数放大：4 / 6 / 8 / 10（1–4 人）。
export function maxEnemiesOnField(playerCount: number): number {
  return MAX_ENEMIES_BASE + MAX_ENEMIES_PER_EXTRA_PLAYER * (playerCount - 1);
}
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
// 关卡开场“幕布”（STAGE N）冻结帧数：经典过场，期间模拟冻结，随后自动进入 playing。
export const STAGE_START_TICKS = 120;
// 冰面滑行：玩家/敌人在冰面上松开方向键后，沿原方向继续滑行的最大帧数（经典手感）。
export const ICE_SLIDE_TICKS = 20;
// 玩家初始生命数（含当前在场坦克）：3 条即共 3 台坦克。
export const PLAYER_LIVES_START = 3;
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

// ── 道具系统（经典六种）──
// 携带道具的敌军在出生队列中的序号（1 起）：第 4 / 11 / 18 台出队者为“携带者”。
// 按“出队计数”标记，不再回看队列下标（队列在出队后会塌缩）。
export const CARRIER_QUEUE_POSITIONS: ReadonlyArray<number> = [4, 11, 18];
// 携带道具敌军红色闪烁周期（帧）：每约 8 帧在常态 / 红色变体间切换。
export const CARRIER_FLASH_TICKS = 8;
// 拾取任一道具的全局加分。
export const POWERUP_SCORE = 500;
// timer 道具：敌军冻结帧数（期间敌人既不移动也不开火，履带动画亦冻结）。
export const ENEMY_FREEZE_TICKS = 600;
// shovel 道具：鹰巢护墙钢化持续帧数；到期恢复为完整砖墙。
export const SHOVEL_TICKS = 1200;
// helmet 道具：无敌帧数（复用出生护盾机制 / 渲染）。
export const HELMET_INVULN_TICKS = 600;
// star 道具：玩家等级上限；等级 ≥1 提升弹速、≥2 可双弹在场、=3 可击穿钢块。
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

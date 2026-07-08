// NES 风格像素画：以调色板索引字符串数组定义，启动时一次性绘制到离屏 canvas 图集。
// 不使用任何外部图片资产。每个字符 = 一个调色板索引，'.' 表示透明。

// 共享调色板（近似 NES 取色）。键为字符，值为 CSS 颜色。'.' 为透明，不参与绘制。
const PALETTE: Record<string, string> = {
  // 砖块：暗红 + 橙色高光 + 深色灰缝
  r: '#a83200', // 砖红
  o: '#d86038', // 橙色高光
  k: '#521800', // 灰缝（暗）
  // 钢块：浅灰斜切 + 白色高光 + 深灰阴影
  w: '#ffffff',
  c: '#bcbcbc',
  b: '#7c7c7c',
  a: '#3c3c3c',
  // 水：深蓝底 + 中蓝 + 亮蓝波纹
  u: '#0c2c8c',
  i: '#2038ec',
  l: '#6890f8',
  // 树林：暗绿网眼 + 中绿 + 更暗的孔洞
  g: '#00681c',
  G: '#38a028',
  n: '#003808',
  // 冰面：浅蓝白 + 灰阴影（白 w 复用高光）
  p: '#dcdcec',
  q: '#a8a8c0',
  // 玩家 1 坦克：经典黄，主体 + 高光 + 阴影 + 黑色轮廓（履带复用钢块的 c/a）
  y: '#e0a030', // 主体黄
  Y: '#f0c860', // 高光黄
  d: '#886018', // 阴影黄
  e: '#000000', // 黑色轮廓
};

// 8×8 砖块：错缝双色砖纹，深色灰缝分隔。
const BRICK: string[] = [
  'orrkorrk',
  'rrrkrrrk',
  'kkkkkkkk',
  'rkorrkor',
  'rkrrrkrr',
  'kkkkkkkk',
  'orrkorrk',
  'rrrkrrrk',
];

// 8×8 钢块：左上白高光、右下深灰阴影的斜切金属块。
const STEEL: string[] = [
  'wwwwwwwc',
  'wccccccb',
  'wccccccb',
  'wcccbbcb',
  'wcccbbcb',
  'wccccccb',
  'wbbbbbbb',
  'caaaaaaa',
];

// 8×8 水（两帧，波纹相位错开）。
const WATER_0: string[] = [
  'iiuuiiuu',
  'uuuluuul',
  'uuuuuuuu',
  'iiuuiiuu',
  'uuuluuul',
  'uuuuuuuu',
  'iiuuiiuu',
  'uuuluuul',
];
const WATER_1: string[] = [
  'uuiiuuii',
  'uluuuluu',
  'uuuuuuuu',
  'uuiiuuii',
  'uluuuluu',
  'uuuuuuuu',
  'uuiiuuii',
  'uluuuluu',
];

// 8×8 树林：密集绿色网眼，夹杂更暗的孔洞。
const TREES: string[] = [
  'gGgGgngG',
  'GgngGgGg',
  'gGgGgngG',
  'ngGgGgGn',
  'gGgGgngG',
  'GgngGgGg',
  'gGgGgngG',
  'ngGgGgGn',
];

// 8×8 冰面：浅色底 + 灰阴影 + 白色闪光点。
const ICE: string[] = [
  'ppppwppp',
  'ppqppppq',
  'pppppwpp',
  'qpppqppp',
  'ppwppppp',
  'pppqpppq',
  'ppppppwp',
  'qpppwppp',
];

// 16×16 鹰巢徽记（透明底，白色展翅雄鹰）。
const EAGLE: string[] = [
  '.......ww.......',
  '......wwww......',
  '....wwwwwwww....',
  '..wwwwwwwwwwww..',
  'wwwwwwwwwwwwwwww',
  'ww..wwwwwwww..ww',
  '....wwwwwwww....',
  '.....wwwwww.....',
  '....wwwwwwww....',
  '...www..ww..www.',
  '..ww........ww..',
  '......wwww......',
  '.....wwwwww.....',
  '.....ww..ww.....',
  '....ww....ww....',
  '................',
];

// 16×16 被摧毁的鹰巢（供后续使用）：暗灰废墟 + 黑色裂痕 + 零星红色碎砖。
const EAGLE_DESTROYED: string[] = [
  'aaaaaaaaaaaaaaaa',
  'aaakaaaaaaaakaaa',
  'aakaaaaraaaakaaa',
  'akaaaaaaaaaaakaa',
  'aaaarakaaaraaaaa',
  'aaaaakaaaakaaaaa',
  'akaaaaaaraaaakaa',
  'aakaaraaaakaaaka',
  'aaaakaaaakaraaaa',
  'aaraaakaakaaakaa',
  'akaaaaaaaaaaaraa',
  'aaaakaaraaakaaaa',
  'aaraakaaaakaakaa',
  'akaaaaraaaaaakaa',
  'aaaakaaaakaaaaaa',
  'aaaaaaaaaaaaaaaa',
];

// 16×16 玩家 1 坦克，朝上（唯一手绘基准朝向）。两帧履带动画：treads 相位差 1px。
// 中央黄色炮塔 + 朝上炮管，两侧履带（浅 c / 暗 a 交替横纹）。
// 其余三个朝向在图集构建时由像素网格旋转 90° 生成（禁止绘制时 ctx.rotate）。
const PLAYER_UP_0: string[] = [
  '................',
  '.......yy.......',
  '.......yy.......',
  '.ccc...yy...ccc.',
  '.aaa.eeeeee.aaa.',
  '.ccc.eYYYye.ccc.',
  '.aaa.eYyyye.aaa.',
  '.ccc.eyyyye.ccc.',
  '.aaa.eyyyye.aaa.',
  '.ccc.eyydye.ccc.',
  '.aaa.eyddye.aaa.',
  '.ccc.eyddye.ccc.',
  '.aaa.eyyyye.aaa.',
  '.ccc.eeeeee.ccc.',
  '.aaa........aaa.',
  '................',
];
const PLAYER_UP_1: string[] = [
  '................',
  '.......yy.......',
  '.......yy.......',
  '.aaa...yy...aaa.',
  '.ccc.eeeeee.ccc.',
  '.aaa.eYYYye.aaa.',
  '.ccc.eYyyye.ccc.',
  '.aaa.eyyyye.aaa.',
  '.ccc.eyyyye.ccc.',
  '.aaa.eyydye.aaa.',
  '.ccc.eyddye.ccc.',
  '.aaa.eyddye.aaa.',
  '.ccc.eyyyye.ccc.',
  '.aaa.eeeeee.aaa.',
  '.ccc........ccc.',
  '................',
];

// 4×4 子弹：银白弹体、灰边（方向无关，四向复用）。
const BULLET: string[] = [
  '.cc.',
  'cwwc',
  'cwwc',
  '.cc.',
];

// ── HUD 图标（右侧灰栏，黑色/黄色，灰底可见）──
// 8×8 剩余敌军小坦克（黑，'e' 黑轮廓）。
const HUD_ENEMY: string[] = [
  '...ee...',
  '.e.ee.e.',
  '.eeeeee.',
  'eeeeeeee',
  'ee.ee.ee',
  'eeeeeeee',
  '.eeeeee.',
  '........',
];
// 8×8 玩家生命迷你黄坦克。
const HUD_LIFE: string[] = [
  '...yy...',
  '.y.yy.y.',
  '.yyyyyy.',
  'yyyyyyyy',
  'yy.yy.yy',
  'yyyyyyyy',
  '.yyyyyy.',
  '........',
];
// 16×16 关卡旗（'a' 暗杆 + 白旗红边）。旗号由 drawText 另绘。
const HUD_FLAG: string[] = [
  '................',
  '...a............',
  '...arrrrrrrrrr..',
  '...arwwwwwwwwr..',
  '...arwwwwwwwwr..',
  '...arwwwwwwwwr..',
  '...arwwwwwwwwr..',
  '...arwwwwwwwwr..',
  '...arrrrrrrrrr..',
  '...a............',
  '...a............',
  '...a............',
  '...a............',
  '...a............',
  '...aa...........',
  '................',
];

// ── 8×8 像素字体（仅覆盖所需字形）──
// 5×7 单色掩码：'#'=点亮，其余=透明。着色在 drawText 时选定（红/白/黑）。
// 字形宽 5、行进 FONT_ADVANCE。仅收录 GAME OVER / STAGE CLEAR / IP + 数字所需字符。
export const FONT_ADVANCE = 6;
export type FontGlyphs = Record<string, string[]>;
// prettier-ignore
const FONT: FontGlyphs = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  E: ['#####', '#....', '#....', '###..', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '###..', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '#.#.#', '.#.#.'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  '0': ['.###.', '#..##', '#.#.#', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '..##.', '.#...', '#....', '#####'],
  '3': ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  '4': ['#..#.', '#..#.', '#..#.', '#####', '...#.', '...#.', '...#.'],
  '5': ['#####', '#....', '#....', '####.', '....#', '....#', '####.'],
  '6': ['.###.', '#....', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '....#', '.###.'],
};

// ── 敌方坦克模板（以“记号”书写，按 kind 用调色板字符重着色）──
// 记号：T=履带亮 t=履带暗 H=车体 L=车体高光 D=车体阴影 O=黑色轮廓 R=炮管(须亮色) '.'=透明
// 全部为朝上基准帧，其余朝向在构建图集时旋转生成（与玩家一致）。

// 标准车体（基础 / 威力共用）：3px 履带。
const TANK_STD: string[] = [
  '................',
  '.......RR.......',
  '.......RR.......',
  '.TTT...RR...TTT.',
  '.ttt.OOOOOO.ttt.',
  '.TTT.OLLLHO.TTT.',
  '.ttt.OLHHHO.ttt.',
  '.TTT.OHHHHO.TTT.',
  '.ttt.OHHHHO.ttt.',
  '.TTT.OHHDHO.TTT.',
  '.ttt.OHDDHO.ttt.',
  '.TTT.OHDDHO.TTT.',
  '.ttt.OHHHHO.ttt.',
  '.TTT.OOOOOO.TTT.',
  '.ttt........ttt.',
  '................',
];

// 快速车体：更纤细的 2px 履带 + 略矮车体，视觉上明显区别于基础型。
const TANK_FAST: string[] = [
  '................',
  '.......RR.......',
  '.......RR.......',
  '..TT...RR...TT..',
  '..tt.OOOOOO.tt..',
  '..TT.OLLLHO.TT..',
  '..tt.OHHHHO.tt..',
  '..TT.OHHHHO.TT..',
  '..tt.OHHHHO.tt..',
  '..TT.OHHDHO.TT..',
  '..tt.OHDDHO.tt..',
  '..TT.OHHHHO.TT..',
  '..tt.OOOOOO.tt..',
  '..TT........TT..',
  '................',
  '................',
];

// 装甲车体：厚重的 4px 履带，车体更宽。搭配两套配色（银 / 白闪）供受损闪烁。
const TANK_ARMOR: string[] = [
  '................',
  '.......RR.......',
  '.......RR.......',
  'TTTT...RR...TTTT',
  'tttt.OOOOOO.tttt',
  'TTTT.OLLLHO.TTTT',
  'tttt.OLHHHO.tttt',
  'TTTT.OHHHHO.TTTT',
  'tttt.OHHHHO.tttt',
  'TTTT.OHHDHO.TTTT',
  'tttt.OHDDHO.tttt',
  'TTTT.OHDDHO.TTTT',
  'tttt.OHHHHO.TTTT',
  'TTTT.OOOOOO.TTTT',
  'tttt........tttt',
  '................',
];

// 记号 → 调色板字符 的重着色映射（'.' 与未列出的字符原样透传）。
type ColorMap = Record<string, string>;
// 基础型：中灰车体 + 浅灰高光 + 深灰阴影，履带亮/暗 c/a，炮管浅灰（亮，黑底可见）。
const MAP_BASIC: ColorMap = { T: 'c', t: 'a', H: 'b', L: 'c', D: 'a', O: 'e', R: 'c' };
// 威力型：银色车体 + 绿色高光点缀（L→绿），炮管仍为亮色。
const MAP_POWER: ColorMap = { T: 'c', t: 'a', H: 'b', L: 'G', D: 'a', O: 'e', R: 'c' };
// 装甲型（常态）：与基础同为银色，靠更厚车体区分。
const MAP_ARMOR: ColorMap = { T: 'c', t: 'a', H: 'b', L: 'c', D: 'a', O: 'e', R: 'c' };
// 装甲型（白闪）：受损时交替使用的高亮白色变体。
const MAP_ARMOR_FLASH: ColorMap = { T: 'w', t: 'c', H: 'w', L: 'w', D: 'c', O: 'e', R: 'w' };

// 按映射重着色一张记号图（未列出字符透传）。
function recolor(rows: string[], map: ColorMap): string[] {
  return rows.map((line) => {
    let out = '';
    for (const ch of line) out += map[ch] ?? ch;
    return out;
  });
}

// 交换履带亮/暗记号，得到第二帧履带动画。
function swapTreads(rows: string[]): string[] {
  return rows.map((line) => {
    let out = '';
    for (const ch of line) out += ch === 'T' ? 't' : ch === 't' ? 'T' : ch;
    return out;
  });
}

// ── 特效：以到中心的欧氏距离分环着色，程序生成保证对称、行宽正确 ──
function radialGrid(size: number, colorAt: (d: number) => string): string[] {
  const c = (size - 1) / 2;
  const rows: string[] = [];
  for (let y = 0; y < size; y++) {
    let line = '';
    for (let x = 0; x < size; x++) {
      line += colorAt(Math.hypot(x - c, y - c));
    }
    rows.push(line);
  }
  return rows;
}

// 出生星形闪光的第 f 帧（16×16）：白/黄同心环随 f 交替，形成收束闪烁感。
function starFrame(f: number): string[] {
  return radialGrid(16, (d) => {
    if (d > 7.2) return '.';
    return (Math.round(d) + f) % 2 === 0 ? 'w' : 'Y';
  });
}

// 小爆炸 3 帧（16×16，橙黄火花，逐帧扩散并转暗）。
const EXPLOSION_SMALL_FRAMES_ART: string[][] = [
  radialGrid(16, (d) => (d <= 1.5 ? 'w' : d <= 3 ? 'Y' : d <= 4 ? 'o' : '.')),
  radialGrid(16, (d) => (d <= 2 ? 'w' : d <= 4 ? 'Y' : d <= 6 ? 'o' : '.')),
  radialGrid(16, (d) => (d <= 3 ? 'Y' : d <= 5 ? 'o' : d <= 7 ? 'r' : '.')),
];

// 大爆炸 2 帧（32×32，坦克死亡）。
const EXPLOSION_BIG_FRAMES_ART: string[][] = [
  radialGrid(32, (d) => (d <= 5 ? 'w' : d <= 10 ? 'Y' : d <= 14 ? 'o' : '.')),
  radialGrid(32, (d) => (d <= 7 ? 'Y' : d <= 12 ? 'o' : d <= 15 ? 'r' : '.')),
];

// 出生星形 4 帧。
const SPAWN_STAR_FRAMES_ART: string[][] = [starFrame(0), starFrame(1), starFrame(2), starFrame(3)];

// 出生护盾第 f 帧（16×16）：仅在包围盒外缘 2px 环上，白/亮蓝按对角线交替，
// 两帧相位相反，形成沿边框流动的星光/电弧感。
function shieldFrame(f: number): string[] {
  const rows: string[] = [];
  for (let y = 0; y < 16; y++) {
    let line = '';
    for (let x = 0; x < 16; x++) {
      const edge = x <= 1 || x >= 14 || y <= 1 || y >= 14;
      if (!edge) {
        line += '.';
        continue;
      }
      line += (x + y + f) % 2 === 0 ? 'w' : 'l'; // 白 / 亮蓝对角交替
    }
    rows.push(line);
  }
  return rows;
}
const SHIELD_FRAMES_ART: string[][] = [shieldFrame(0), shieldFrame(1)];

// 把方形字符网格顺时针旋转 90°（用于从朝上帧生成其余朝向）。
function rotateCW(rows: string[]): string[] {
  const n = rows.length;
  const out: string[] = [];
  for (let r = 0; r < n; r++) {
    let line = '';
    for (let c = 0; c < n; c++) {
      line += rows[n - 1 - c][r];
    }
    out.push(line);
  }
  return out;
}

// 图集内单个精灵的取样矩形（含所属 canvas 引用，供 drawTile 使用）。
export interface Sprite {
  src: HTMLCanvasElement;
  sx: number;
  sy: number;
  w: number;
  h: number;
}

// 一台坦克四朝向、各两帧履带动画。
export interface TankFrames {
  up: [Sprite, Sprite];
  down: [Sprite, Sprite];
  left: [Sprite, Sprite];
  right: [Sprite, Sprite];
}

export interface SpriteAtlas {
  canvas: HTMLCanvasElement;
  brick: Sprite;
  steel: Sprite;
  water: [Sprite, Sprite]; // 两帧动画
  trees: Sprite;
  ice: Sprite;
  eagle: Sprite;
  eagleDestroyed: Sprite;
  playerTank: TankFrames;
  enemyTank: {
    basic: TankFrames;
    fast: TankFrames;
    power: TankFrames;
    armor: TankFrames; // 常态银色
    armorFlash: TankFrames; // 受损白闪变体
  };
  bullet: Sprite;
  spawnStar: [Sprite, Sprite, Sprite, Sprite]; // 出生闪光 4 帧
  shield: [Sprite, Sprite]; // 出生护盾 2 帧（16×16）
  explosionSmall: [Sprite, Sprite, Sprite]; // 小爆炸 3 帧（16×16）
  explosionBig: [Sprite, Sprite]; // 大爆炸 2 帧（32×32）
  hudEnemy: Sprite; // HUD 剩余敌军小坦克（8×8）
  hudLifeTank: Sprite; // HUD 玩家生命迷你坦克（8×8）
  hudFlag: Sprite; // HUD 关卡旗（16×16）
  font: FontGlyphs; // 像素字体掩码（着色在 drawText 时选定）
}

// 把一张字符像素图逐像素画到 ctx 的 (ox, oy) 处。
function paint(ctx: CanvasRenderingContext2D, rows: string[], ox: number, oy: number): void {
  for (let y = 0; y < rows.length; y++) {
    const line = rows[y];
    for (let x = 0; x < line.length; x++) {
      const color = PALETTE[line[x]];
      if (!color) continue; // '.' 或未定义字符 = 透明
      ctx.fillStyle = color;
      ctx.fillRect(ox + x, oy + y, 1, 1);
    }
  }
}

// 图集各行的 y 偏移。
const Y_TERRAIN = 0;
const Y_PLAYER = 16;
const Y_BASIC = 32;
const Y_FAST = 48;
const Y_POWER = 64;
const Y_ARMOR = 80;
const Y_ARMOR_FLASH = 96;
const Y_FX = 112; // 出生星 4 帧(0..63) + 小爆炸 3 帧(64,80,96)
const Y_BIG = 128; // 大爆炸 2 帧(0,32)，各 32×32

// 把一台坦克的朝上两帧铺到某一行：旋转生成其余朝向，
// 按 up0,up1,down0,down1,left0,left1,right0,right1 排布于 x=0,16,…,112。
function paintTankRow(
  ctx: CanvasRenderingContext2D,
  up0: string[],
  up1: string[],
  y: number,
): void {
  const right0 = rotateCW(up0);
  const right1 = rotateCW(up1);
  const down0 = rotateCW(right0);
  const down1 = rotateCW(right1);
  const left0 = rotateCW(down0);
  const left1 = rotateCW(down1);
  paint(ctx, up0, 0, y);
  paint(ctx, up1, 16, y);
  paint(ctx, down0, 32, y);
  paint(ctx, down1, 48, y);
  paint(ctx, left0, 64, y);
  paint(ctx, left1, 80, y);
  paint(ctx, right0, 96, y);
  paint(ctx, right1, 112, y);
}

// 取某坦克行的四朝向取样矩形。
function tankFramesAt(canvas: HTMLCanvasElement, y: number): TankFrames {
  const s = (sx: number): Sprite => ({ src: canvas, sx, sy: y, w: 16, h: 16 });
  return {
    up: [s(0), s(16)],
    down: [s(32), s(48)],
    left: [s(64), s(80)],
    right: [s(96), s(112)],
  };
}

// 启动时调用一次，构建离屏图集并返回带取样矩形的 API。
export function createSpriteAtlas(): SpriteAtlas {
  const width = 132;
  const height = 160;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable for sprite atlas');
  ctx.imageSmoothingEnabled = false;

  const s = (sx: number, sy: number, w: number, h: number): Sprite => ({ src: canvas, sx, sy, w, h });

  // 地形行
  paint(ctx, BRICK, 0, Y_TERRAIN);
  paint(ctx, STEEL, 8, Y_TERRAIN);
  paint(ctx, WATER_0, 16, Y_TERRAIN);
  paint(ctx, WATER_1, 24, Y_TERRAIN);
  paint(ctx, TREES, 32, Y_TERRAIN);
  paint(ctx, ICE, 40, Y_TERRAIN);
  paint(ctx, EAGLE, 48, Y_TERRAIN);
  paint(ctx, EAGLE_DESTROYED, 64, Y_TERRAIN);
  // HUD 图标（复用地形行右侧空白：x 80..112）
  paint(ctx, HUD_ENEMY, 80, Y_TERRAIN);
  paint(ctx, HUD_LIFE, 88, Y_TERRAIN);
  paint(ctx, HUD_FLAG, 96, Y_TERRAIN);

  // 玩家坦克行 + 子弹
  paintTankRow(ctx, PLAYER_UP_0, PLAYER_UP_1, Y_PLAYER);
  paint(ctx, BULLET, 128, Y_PLAYER);

  // 敌方坦克各行（由记号模板重着色 + 履带第二帧）
  paintTankRow(ctx, recolor(TANK_STD, MAP_BASIC), recolor(swapTreads(TANK_STD), MAP_BASIC), Y_BASIC);
  paintTankRow(ctx, recolor(TANK_FAST, MAP_BASIC), recolor(swapTreads(TANK_FAST), MAP_BASIC), Y_FAST);
  paintTankRow(ctx, recolor(TANK_STD, MAP_POWER), recolor(swapTreads(TANK_STD), MAP_POWER), Y_POWER);
  paintTankRow(ctx, recolor(TANK_ARMOR, MAP_ARMOR), recolor(swapTreads(TANK_ARMOR), MAP_ARMOR), Y_ARMOR);
  paintTankRow(
    ctx,
    recolor(TANK_ARMOR, MAP_ARMOR_FLASH),
    recolor(swapTreads(TANK_ARMOR), MAP_ARMOR_FLASH),
    Y_ARMOR_FLASH,
  );

  // 特效行：出生星 4 帧 + 小爆炸 3 帧
  paint(ctx, SPAWN_STAR_FRAMES_ART[0], 0, Y_FX);
  paint(ctx, SPAWN_STAR_FRAMES_ART[1], 16, Y_FX);
  paint(ctx, SPAWN_STAR_FRAMES_ART[2], 32, Y_FX);
  paint(ctx, SPAWN_STAR_FRAMES_ART[3], 48, Y_FX);
  paint(ctx, EXPLOSION_SMALL_FRAMES_ART[0], 64, Y_FX);
  paint(ctx, EXPLOSION_SMALL_FRAMES_ART[1], 80, Y_FX);
  paint(ctx, EXPLOSION_SMALL_FRAMES_ART[2], 96, Y_FX);
  // 大爆炸行（x 0..63）+ 护盾 2 帧（复用右侧空白 x 64/80）
  paint(ctx, EXPLOSION_BIG_FRAMES_ART[0], 0, Y_BIG);
  paint(ctx, EXPLOSION_BIG_FRAMES_ART[1], 32, Y_BIG);
  paint(ctx, SHIELD_FRAMES_ART[0], 64, Y_BIG);
  paint(ctx, SHIELD_FRAMES_ART[1], 80, Y_BIG);

  return {
    canvas,
    brick: s(0, Y_TERRAIN, 8, 8),
    steel: s(8, Y_TERRAIN, 8, 8),
    water: [s(16, Y_TERRAIN, 8, 8), s(24, Y_TERRAIN, 8, 8)],
    trees: s(32, Y_TERRAIN, 8, 8),
    ice: s(40, Y_TERRAIN, 8, 8),
    eagle: s(48, Y_TERRAIN, 16, 16),
    eagleDestroyed: s(64, Y_TERRAIN, 16, 16),
    playerTank: tankFramesAt(canvas, Y_PLAYER),
    enemyTank: {
      basic: tankFramesAt(canvas, Y_BASIC),
      fast: tankFramesAt(canvas, Y_FAST),
      power: tankFramesAt(canvas, Y_POWER),
      armor: tankFramesAt(canvas, Y_ARMOR),
      armorFlash: tankFramesAt(canvas, Y_ARMOR_FLASH),
    },
    bullet: s(128, Y_PLAYER, 4, 4),
    spawnStar: [
      s(0, Y_FX, 16, 16),
      s(16, Y_FX, 16, 16),
      s(32, Y_FX, 16, 16),
      s(48, Y_FX, 16, 16),
    ],
    shield: [s(64, Y_BIG, 16, 16), s(80, Y_BIG, 16, 16)],
    explosionSmall: [s(64, Y_FX, 16, 16), s(80, Y_FX, 16, 16), s(96, Y_FX, 16, 16)],
    explosionBig: [s(0, Y_BIG, 32, 32), s(32, Y_BIG, 32, 32)],
    hudEnemy: s(80, Y_TERRAIN, 8, 8),
    hudLifeTank: s(88, Y_TERRAIN, 8, 8),
    hudFlag: s(96, Y_TERRAIN, 16, 16),
    font: FONT,
  };
}

// 把整块精灵绘制到目标 ctx 的 (x, y)（像素坐标，未放大）。
export function drawTile(ctx: CanvasRenderingContext2D, sprite: Sprite, x: number, y: number): void {
  ctx.drawImage(sprite.src, sprite.sx, sprite.sy, sprite.w, sprite.h, x, y, sprite.w, sprite.h);
}

// 以像素字体绘制一行文本到 (x, y)，逐字形按 FONT_ADVANCE 递进。color 决定点亮像素的颜色。
// 未收录的字符（含空格）仅占位（推进一格）不绘制。
export function drawText(
  ctx: CanvasRenderingContext2D,
  atlas: SpriteAtlas,
  text: string,
  x: number,
  y: number,
  color = '#ffffff',
): void {
  ctx.fillStyle = color;
  for (let i = 0; i < text.length; i++) {
    const glyph = atlas.font[text[i]];
    const gx0 = x + i * FONT_ADVANCE;
    if (!glyph) continue;
    for (let gy = 0; gy < glyph.length; gy++) {
      const line = glyph[gy];
      for (let gc = 0; gc < line.length; gc++) {
        if (line[gc] === '#') ctx.fillRect(gx0 + gc, y + gy, 1, 1);
      }
    }
  }
}

// 文本像素宽度（用于居中）。
export function textWidth(text: string): number {
  return text.length * FONT_ADVANCE;
}

// 只绘制精灵的一个 4×4 象限（用于砖块按存活象限渲染）。
// qx/qy 为象限在精灵内的偏移（0 或 4）；dx/dy 为目标像素坐标。
export function drawQuarter(
  ctx: CanvasRenderingContext2D,
  sprite: Sprite,
  qx: number,
  qy: number,
  dx: number,
  dy: number,
): void {
  ctx.drawImage(sprite.src, sprite.sx + qx, sprite.sy + qy, 4, 4, dx, dy, 4, 4);
}

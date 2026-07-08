// NES 风格像素画（“hi-bit” 2× 重制）：以调色板索引字符串数组定义，启动时一次性绘制到离屏图集。
// 不使用任何外部图片资产。每个字符 = 一个调色板索引，'.' 表示透明。
//
// 关键：所有精灵均以 ART_SCALE=2 的“美术分辨率”授权（坦克 32×32、地形 16×16、子弹 8×8、
// 鹰巢 32×32 …）。图集本身即以美术像素存储；drawTile/drawText/drawQuarter 接收 *逻辑* 目标
// 坐标，内部乘以 ART_SCALE 后落到 512×448 画布。silhouette / 色系与 NES 原版一致，仅细化。

import { ART_SCALE, QUARTER } from '../core/constants';

// 共享调色板（近似 NES 取色 + 若干“中间过渡色”以获得更细腻的分色带）。'.' 为透明。
const PALETTE: Record<string, string> = {
  // 砖块：暗红 + 橙高光 + 亮橙尖 + 中红阴影 + 深缝
  r: '#a83200', // 砖红（主体）
  o: '#d86038', // 橙色高光
  m: '#f0885c', // 亮橙尖（新增：砖面顶缘更亮的高光）
  x: '#7c2400', // 中红阴影（新增：砖面靠缝处的过渡暗色）
  k: '#521800', // 灰缝（暗）
  // 钢块 / 银色坦克：白高光 + 浅灰 + 银中调 + 中灰 + 深灰
  w: '#ffffff',
  c: '#bcbcbc',
  s: '#9c9c9c', // 银中调（新增：车体/钢面的中间分色带）
  b: '#7c7c7c',
  v: '#5c5c5c', // 暗银过渡（新增：银车体 H→D 之间的暗分色带）
  a: '#3c3c3c',
  // 水：深蓝底 + 中蓝 + 亮蓝波 + 浪尖泡沫
  u: '#0c2c8c',
  i: '#2038ec',
  l: '#6890f8',
  f: '#a8c0fc', // 浪尖泡沫（新增：波峰更亮的水色）
  // 树林：暗绿孔洞 + 中绿 + 亮绿 + 高光叶尖
  g: '#00681c',
  G: '#38a028',
  j: '#58c840', // 高光叶尖（新增：叶簇顶部更亮的绿）
  n: '#003808',
  // 冰面：浅蓝白 + 灰阴影（白 w 复用高光）
  p: '#dcdcec',
  q: '#a8a8c0',
  // 玩家 1 坦克：经典黄，主体 + 高光 + 阴影 + 黑轮廓（履带复用钢块的 c/a）
  y: '#e0a030', // 主体黄
  Y: '#f0c860', // 高光黄
  h: '#e8b448', // 亮黄过渡（新增：Y→y 之间的分色带）
  z: '#b48024', // 暗黄过渡（新增：y→d 之间的分色带）
  d: '#886018', // 阴影黄
  e: '#000000', // 黑色轮廓
};

// 校验一张精灵网格的尺寸（模块加载即执行，越早暴露排版错误越好）。
function assertGrid(rows: string[], w: number, h: number, name: string): string[] {
  if (rows.length !== h) throw new Error(`sprite ${name}: expected ${h} rows, got ${rows.length}`);
  for (const r of rows) {
    if (r.length !== w) throw new Error(`sprite ${name}: row width ${r.length} != ${w} ("${r}")`);
  }
  return rows;
}

// ── 地形（16×16 美术像素 = 8px 逻辑子格）──

// 砖块：错缝双色砖纹（顶缘亮橙 → 砖红 → 中红阴影），2px 深灰缝分隔。
// prettier-ignore
const BRICK = assertGrid([
  'moooookkmoooookk',
  'orrrrxkkorrrrxkk',
  'rrrrxxkkrrrrxxkk',
  'xxxxxxkkxxxxxxkk',
  'kkkkkkkkkkkkkkkk',
  'kkkkkkkkkkkkkkkk',
  'mokkmoooookkmooo',
  'orkkorrrrxkkorrx',
  'rrkkrrrrxxkkrrxx',
  'xxkkxxxxxxkkxxxx',
  'kkkkkkkkkkkkkkkk',
  'kkkkkkkkkkkkkkkk',
  'moooookkmoooookk',
  'orrrrxkkorrrrxkk',
  'rrrrxxkkrrrrxxkk',
  'xxxxxxkkxxxxxxkk',
], 16, 16, 'brick');

// 钢块：斜切金属板 —— 白色顶/左高光、深灰底/右阴影，四角铆钉，中央银色分色带 + 一点白色反光。
// prettier-ignore
const STEEL = assertGrid([
  'wwwwwwwwwwwwwwww',
  'wcccccccccccccsa',
  'wcbbcccccccbbcsa',
  'wcbacccccccbacsa',
  'wcccccccccccccsa',
  'wccccsssssccccsa',
  'wccccsssssccccsa',
  'wccccswwssccccsa',
  'wccccsssssccccsa',
  'wcccccccccccccsa',
  'wcccccccccccccsa',
  'wcccccccccccccsa',
  'wcbbcccccccbbcsa',
  'wcbacccccccbacsa',
  'wbbbbbbbbbbbbbba',
  'aaaaaaaaaaaaaaaa',
], 16, 16, 'steel');

// 水：整格行进波（sin 相位），四色分带（深 u → 中 i → 亮 l → 泡沫 f）。两帧相位相反做动画。
function waterFrame(phase: number): string[] {
  const rows: string[] = [];
  for (let y = 0; y < 16; y++) {
    let line = '';
    for (let x = 0; x < 16; x++) {
      const wv = Math.sin((y / 16) * Math.PI * 3 + (x / 16) * Math.PI * 2 + phase);
      line += wv > 0.82 ? 'f' : wv > 0.35 ? 'l' : wv > -0.25 ? 'i' : 'u';
    }
    rows.push(line);
  }
  return assertGrid(rows, 16, 16, 'water');
}
const WATER_0 = waterFrame(0);
const WATER_1 = waterFrame(Math.PI);

// 树林：交叠叶簇（中绿/亮绿/高光尖 + 暗绿孔洞），程序生成保证密实自然。
function treesTile(): string[] {
  const rows: string[] = [];
  for (let y = 0; y < 16; y++) {
    let line = '';
    for (let x = 0; x < 16; x++) {
      const c = Math.sin((x + y * 0.6) * 1.35) * Math.cos((y - x * 0.45) * 1.15);
      // 阈值偏向两端：更多暗色孔洞（n）与高光叶尖（j），拉开明暗对比，远看仍有“枝叶网眼”感。
      line += c < -0.28 ? 'n' : c < 0.18 ? 'g' : c < 0.52 ? 'G' : 'j';
    }
    rows.push(line);
  }
  return assertGrid(rows, 16, 16, 'trees');
}
const TREES = treesTile();

// 冰面：浅色底 + 细斜裂纹网（灰 q）+ 零星白色闪光点。
function iceTile(): string[] {
  const rows: string[] = [];
  for (let y = 0; y < 16; y++) {
    let line = '';
    for (let x = 0; x < 16; x++) {
      const crack = (x + y) % 8 === 0 || (x - y + 32) % 11 === 0;
      const spark = (x * 5 + y * 3) % 29 === 0;
      line += spark ? 'w' : crack ? 'q' : 'p';
    }
    rows.push(line);
  }
  return assertGrid(rows, 16, 16, 'ice');
}
const ICE = iceTile();

// ── 鹰巢徽记（32×32，透明底白鹰）──
// 左半 16 列手绘，镜像成 32 列以保证左右对称。'c' 为羽翼阴影点缀。
function mirrorRows(half: string[]): string[] {
  return half.map((h) => h + [...h].reverse().join(''));
}
// prettier-ignore
const EAGLE_LEFT = assertGrid([
  '...............w',
  '...............w',
  '..............ww',
  '..............ww',
  '.............www',
  '.............www',
  '............wwww',
  '...........wwwww',
  '..........wwwwww',
  '.........wwwwwww',
  '.......wwwwwwwww',
  '....wwwwwwwwwwww',
  'wwwwwwwwwwwwwwww',
  'wwwwwwwwwwwwwwww',
  'wwwc...wwwwwwwww',
  'wwc....wwwwwwwww',
  '.......wwwwwwwww',
  '.......wwwwwwwww',
  '........wwwwwwww',
  '........wwwwcwww',
  '........wwwwwwww',
  '.........wwwwwww',
  '......wwwwwwwwww',
  '.......wwwwwwwww',
  '........wwwwwwww',
  '.........wwwwwww',
  '.........wwwwwww',
  '........wwww.www',
  '.......wwww..www',
  '......wwww...www',
  '......www....www',
  '................',
], 16, 32, 'eagleLeft');
const EAGLE = assertGrid(mirrorRows(EAGLE_LEFT), 32, 32, 'eagle');

// 被摧毁的鹰巢（32×32）：暗灰废墟 + 深缝裂痕 + 零星红色碎砖 + 亮灰碎块（程序生成的哈希噪声）。
function eagleDestroyedTile(): string[] {
  const rows: string[] = [];
  for (let y = 0; y < 32; y++) {
    let line = '';
    for (let x = 0; x < 32; x++) {
      const v = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
      const hsh = v - Math.floor(v);
      line += hsh < 0.12 ? 'r' : hsh < 0.4 ? 'k' : hsh < 0.75 ? 'a' : 'b';
    }
    rows.push(line);
  }
  return assertGrid(rows, 32, 32, 'eagleDestroyed');
}
const EAGLE_DESTROYED = eagleDestroyedTile();

// ── 坦克（32×32，朝上基准帧，以“记号”书写，手工授权）──
// 记号：T=履带亮 t=履带暗 E=履带齿分隔(更暗) H=车体 L=车体高光 D=车体阴影
//       S=高光过渡(L↔H 之间) Z=阴影过渡(H↔D 之间) O=黑轮廓 R=炮管(须亮色) '.'=透明
// 版式来源：原版 16×16 模板逐像素 2× 展开（每旧像素 → 2×2 块），再做限定性精修：
//   * 车体轮廓四角各切 1 美术px（45°），轮廓仍为原位 2px 黑框；
//   * L/D 色域边界的阶梯以 S/Z 过渡带（1–2px）柔化，保持原版“左上高光/右下阴影”平面布局；
//   * 履带齿：2px 明带 + 2px 暗带、齿间 1px 更暗分隔线（E 不参与 swapTreads，第二帧仍由 T↔t 互换生成）；
//   * 炮管保持原位、宽 4 美术px（原 2 逻辑px），顶端收 1px。
// 其余三朝向在构建图集时由像素网格旋转 90° 生成。
// 注：原版 PLAYER_UP_0/1 与 TANK_STD 为同一版式（仅配色不同），故玩家坦克 = TANK_STD × MAP_PLAYER。

// 标准车体（玩家 / 基础 / 威力共用）：6px 履带（原 3px），车体 12px 宽。
// prettier-ignore
const TANK_STD = assertGrid([
  '................................',
  '................................',
  '...............RR...............',
  '..............RRRR..............',
  '..............RRRR..............',
  '..............RRRR..............',
  '..TTTTTT......RRRR......TTTTTT..',
  '..TTTTTT......RRRR......TTTTTT..',
  '..EEEEEE...OOOOOOOOOO...EEEEEE..',
  '..tttttt..OOOOOOOOOOOO..tttttt..',
  '..tttttt..OOLLLLLLSHOO..tttttt..',
  '..EEEEEE..OOLLLLLSHHOO..EEEEEE..',
  '..TTTTTT..OOLLSSHHHHOO..TTTTTT..',
  '..TTTTTT..OOLSSHHHHHOO..TTTTTT..',
  '..EEEEEE..OOSSHHHHHHOO..EEEEEE..',
  '..tttttt..OOSHHHHHHHOO..tttttt..',
  '..tttttt..OOHHHHHHHHOO..tttttt..',
  '..EEEEEE..OOHHHHHHHHOO..EEEEEE..',
  '..TTTTTT..OOHHHZDDZHOO..TTTTTT..',
  '..TTTTTT..OOHHZZDDZHOO..TTTTTT..',
  '..EEEEEE..OOHZDDDDZHOO..EEEEEE..',
  '..tttttt..OOHZDDDDZHOO..tttttt..',
  '..tttttt..OOHZDDDDZHOO..tttttt..',
  '..EEEEEE..OOHZDDDDZHOO..EEEEEE..',
  '..TTTTTT..OOHHZZZZHHOO..TTTTTT..',
  '..TTTTTT..OOHHHHHHHHOO..TTTTTT..',
  '..EEEEEE..OOOOOOOOOOOO..EEEEEE..',
  '..tttttt...OOOOOOOOOO...tttttt..',
  '..tttttt................tttttt..',
  '..EEEEEE................EEEEEE..',
  '................................',
  '................................',
], 32, 32, 'tankStd');

// 快速车体：4px 纤细履带（原 2px）+ 略矮车体（原版行 4–13），视觉上明显区别于基础型。
// prettier-ignore
const TANK_FAST = assertGrid([
  '................................',
  '................................',
  '...............RR...............',
  '..............RRRR..............',
  '..............RRRR..............',
  '..............RRRR..............',
  '....TTTT......RRRR......TTTT....',
  '....TTTT......RRRR......TTTT....',
  '....EEEE...OOOOOOOOOO...EEEE....',
  '....tttt..OOOOOOOOOOOO..tttt....',
  '....tttt..OOLLLLLLSHOO..tttt....',
  '....EEEE..OOLLLLLSHHOO..EEEE....',
  '....TTTT..OOSSHHHHHHOO..TTTT....',
  '....TTTT..OOSHHHHHHHOO..TTTT....',
  '....EEEE..OOHHHHHHHHOO..EEEE....',
  '....tttt..OOHHHHHHHHOO..tttt....',
  '....tttt..OOHHHHHHHHOO..tttt....',
  '....EEEE..OOHHHHHHHHOO..EEEE....',
  '....TTTT..OOHHHZDDZHOO..TTTT....',
  '....TTTT..OOHHZZDDZHOO..TTTT....',
  '....EEEE..OOHZDDDDZHOO..EEEE....',
  '....tttt..OOHZDDDDZHOO..tttt....',
  '....tttt..OOHHZZZZHHOO..tttt....',
  '....EEEE..OOHHHHHHHHOO..EEEE....',
  '....TTTT..OOOOOOOOOOOO..TTTT....',
  '....TTTT...OOOOOOOOOO...TTTT....',
  '....EEEE................EEEE....',
  '....tttt................tttt....',
  '................................',
  '................................',
  '................................',
  '................................',
], 32, 32, 'tankFast');

// 装甲车体：8px 厚重履带（原 4px），车体版式同标准。搭配银 / 白闪两套配色供受损闪烁。
// prettier-ignore
const TANK_ARMOR = assertGrid([
  '................................',
  '................................',
  '...............RR...............',
  '..............RRRR..............',
  '..............RRRR..............',
  '..............RRRR..............',
  'TTTTTTTT......RRRR......TTTTTTTT',
  'TTTTTTTT......RRRR......TTTTTTTT',
  'EEEEEEEE...OOOOOOOOOO...EEEEEEEE',
  'tttttttt..OOOOOOOOOOOO..tttttttt',
  'tttttttt..OOLLLLLLSHOO..tttttttt',
  'EEEEEEEE..OOLLLLLSHHOO..EEEEEEEE',
  'TTTTTTTT..OOLLSSHHHHOO..TTTTTTTT',
  'TTTTTTTT..OOLSSHHHHHOO..TTTTTTTT',
  'EEEEEEEE..OOSSHHHHHHOO..EEEEEEEE',
  'tttttttt..OOSHHHHHHHOO..tttttttt',
  'tttttttt..OOHHHHHHHHOO..tttttttt',
  'EEEEEEEE..OOHHHHHHHHOO..EEEEEEEE',
  'TTTTTTTT..OOHHHZDDZHOO..TTTTTTTT',
  'TTTTTTTT..OOHHZZDDZHOO..TTTTTTTT',
  'EEEEEEEE..OOHZDDDDZHOO..EEEEEEEE',
  'tttttttt..OOHZDDDDZHOO..tttttttt',
  'tttttttt..OOHZDDDDZHOO..tttttttt',
  'EEEEEEEE..OOHZDDDDZHOO..EEEEEEEE',
  'TTTTTTTT..OOHHZZZZHHOO..TTTTTTTT',
  'TTTTTTTT..OOHHHHHHHHOO..TTTTTTTT',
  'EEEEEEEE..OOOOOOOOOOOO..EEEEEEEE',
  'tttttttt...OOOOOOOOOO...tttttttt',
  'tttttttt................tttttttt',
  'EEEEEEEE................EEEEEEEE',
  '................................',
  '................................',
], 32, 32, 'tankArmor');

// 记号 → 调色板字符 的重着色映射（'.' 与未列出的字符原样透传）。
type ColorMap = Record<string, string>;
// 玩家：黄车体（高光 Y / 过渡 h/z / 主体 y / 阴影 d），钢制履带 c/a + 黑分隔，炮管亮黄。
const MAP_PLAYER: ColorMap = { T: 'c', t: 'a', E: 'e', H: 'y', S: 'h', Z: 'z', L: 'Y', D: 'd', O: 'e', R: 'Y' };
// 基础型：银灰车体（高光 c / 过渡 s/v / 主体 b / 阴影 a），炮管浅灰（亮，黑底可见）。
const MAP_BASIC: ColorMap = { T: 'c', t: 'a', E: 'e', H: 'b', S: 's', Z: 'v', L: 'c', D: 'a', O: 'e', R: 'c' };
// 威力型：银车体 + 绿色高光点缀（L→绿 / 过渡 S→亮绿），炮管仍为亮色。
const MAP_POWER: ColorMap = { T: 'c', t: 'a', E: 'e', H: 'b', S: 'j', Z: 'v', L: 'G', D: 'a', O: 'e', R: 'c' };
// 装甲型（常态）：与基础同为银色，靠更厚履带区分。
const MAP_ARMOR: ColorMap = { T: 'c', t: 'a', E: 'e', H: 'b', S: 's', Z: 'v', L: 'c', D: 'a', O: 'e', R: 'c' };
// 装甲型（白闪）：受损时交替使用的高亮白色变体（履带 w/c、分隔灰，车体近全白）。
const MAP_ARMOR_FLASH: ColorMap = { T: 'w', t: 'c', E: 'b', H: 'w', S: 'w', Z: 'c', L: 'w', D: 'c', O: 'e', R: 'w' };

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

// ── 子弹（8×8）──：银白弹体、灰边（方向无关，四向复用）。
// prettier-ignore
const BULLET = assertGrid([
  '..cccc..',
  '.cwwwwc.',
  'cwwwwwwc',
  'cwwwwwwc',
  'cwwwwwwc',
  'cwwwwwwc',
  '.cwwwwc.',
  '..cccc..',
], 8, 8, 'bullet');

// ── HUD 迷你坦克（16×16，记号 X 重着色为黑 e / 黄 y）──
// prettier-ignore
const MINI_TANK = assertGrid([
  '................',
  '.......XX.......',
  '.XXX...XX...XXX.',
  '.XXX.XXXXXX.XXX.',
  '.XXX.XXXXXX.XXX.',
  '.XXX.XXXXXX.XXX.',
  '.XXX.XXXXXX.XXX.',
  '.XXX.XXXXXX.XXX.',
  '.XXX.XXXXXX.XXX.',
  '.XXX.XXXXXX.XXX.',
  '.XXX.XXXXXX.XXX.',
  '.XXX........XXX.',
  '................',
  '................',
  '................',
  '................',
], 16, 16, 'miniTank');
const HUD_ENEMY = recolor(MINI_TANK, { X: 'e' });
const HUD_LIFE = recolor(MINI_TANK, { X: 'y' });

// ── HUD 关卡旗（32×32）：暗杆 + 白旗红边。旗号由 drawText 另绘。──
// prettier-ignore
const HUD_FLAG = assertGrid([
  '...aa...........................',
  '...aa...........................',
  '...aa...........................',
  '...aarrrrrrrrrrrrrrrrrrrrrr.....',
  '...aarwwwwwwwwwwwwwwwwwwwwr.....',
  '...aarwwwwwwwwwwwwwwwwwwwwr.....',
  '...aarwwwwwwwwwwwwwwwwwwwwr.....',
  '...aarwwwwwwwwwwwwwwwwwwwwr.....',
  '...aarwwwwwwwwwwwwwwwwwwwwr.....',
  '...aarwwwwwwwwwwwwwwwwwwwwr.....',
  '...aarwwwwwwwwwwwwwwwwwwwwr.....',
  '...aarwwwwwwwwwwwwwwwwwwwwr.....',
  '...aarwwwwwwwwwwwwwwwwwwwwr.....',
  '...aarwwwwwwwwwwwwwwwwwwwwr.....',
  '...aarwwwwwwwwwwwwwwwwwwwwr.....',
  '...aarwwwwwwwwwwwwwwwwwwwwr.....',
  '...aarwwwwwwwwwwwwwwwwwwwwr.....',
  '...aarrrrrrrrrrrrrrrrrrrrrr.....',
  '...aa...........................',
  '...aa...........................',
  '...aa...........................',
  '...aa...........................',
  '...aa...........................',
  '...aa...........................',
  '...aa...........................',
  '...aa...........................',
  '...aa...........................',
  '...aa...........................',
  '...aa...........................',
  '...aa...........................',
  '..aaaa..........................',
  '................................',
], 32, 32, 'hudFlag');

// ── 8×8 像素字体（5×7 掩码，drawText 时按 ART_SCALE 放大绘制，保持粗块像素观感）──
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
  N: ['#...#', '##..#', '#.#.#', '#.#.#', '#..##', '#...#', '#...#'],
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

// ── 特效：以到中心的欧氏距离分环着色，程序生成保证对称、行宽正确（2× 尺寸 + 更多环）──
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

// 出生星形闪光第 f 帧（32×32）：经典四角星 —— 白色十字长臂（沿轴）+ 黄色短斜臂与内晕。
// 4 帧收束：第 0 帧臂细长直抵精灵边缘，第 3 帧收成小而密的亮核。
// 由“菱形距离 |dx|+|dy| × 轴向贴近度”生成，非圆环。
function starFrame(f: number): string[] {
  const armLen = 15 - f * 3; // 轴向臂长：15,12,9,6（逐帧收束）
  const armHalf = 1 + f * 0.5; // 臂半宽：逐帧变粗变密
  const diagLen = 7 - f * 1.5; // 斜向短臂长
  const core = 2 + f; // 中心亮核（菱形半径，逐帧变大变密）
  const rows: string[] = [];
  for (let y = 0; y < 32; y++) {
    let line = '';
    for (let x = 0; x < 32; x++) {
      const adx = Math.abs(x - 15.5);
      const ady = Math.abs(y - 15.5);
      const diamond = adx + ady;
      const onAxisArm = (adx <= armHalf && ady <= armLen) || (ady <= armHalf && adx <= armLen);
      const onDiag = Math.abs(adx - ady) <= 1 && adx <= diagLen;
      if (diamond <= core || onAxisArm) line += 'w';
      else if (onDiag || diamond <= core + 2) line += 'Y';
      else line += '.';
    }
    rows.push(line);
  }
  return assertGrid(rows, 32, 32, 'spawnStar');
}

// 小爆炸 3 帧（32×32，橙黄火花，逐帧扩散并转暗）。
const EXPLOSION_SMALL_FRAMES_ART: string[][] = [
  radialGrid(32, (d) => (d <= 3 ? 'w' : d <= 6 ? 'Y' : d <= 8 ? 'o' : '.')),
  radialGrid(32, (d) => (d <= 4 ? 'w' : d <= 8 ? 'Y' : d <= 12 ? 'o' : '.')),
  radialGrid(32, (d) => (d <= 6 ? 'Y' : d <= 10 ? 'o' : d <= 14 ? 'r' : '.')),
];

// 大爆炸 2 帧（64×64，坦克死亡；四色分带、更多环使爆团更平滑）。
const EXPLOSION_BIG_FRAMES_ART: string[][] = [
  radialGrid(64, (d) => (d <= 6 ? 'w' : d <= 14 ? 'Y' : d <= 22 ? 'o' : d <= 28 ? 'r' : '.')),
  radialGrid(64, (d) => (d <= 10 ? 'w' : d <= 20 ? 'Y' : d <= 28 ? 'o' : d <= 31 ? 'r' : '.')),
];

// 出生星形 4 帧。
const SPAWN_STAR_FRAMES_ART: string[][] = [starFrame(0), starFrame(1), starFrame(2), starFrame(3)];

// 出生护盾第 f 帧（32×32）：仅在包围盒外缘 4px 环上，白/亮蓝按对角线交替，
// 两帧相位相反，形成沿边框流动的星光/电弧感。
function shieldFrame(f: number): string[] {
  const rows: string[] = [];
  for (let y = 0; y < 32; y++) {
    let line = '';
    for (let x = 0; x < 32; x++) {
      const edge = x <= 3 || x >= 28 || y <= 3 || y >= 28;
      if (!edge) {
        line += '.';
        continue;
      }
      line += (x + y + f) % 2 === 0 ? 'w' : 'l';
    }
    rows.push(line);
  }
  return rows;
}
const SHIELD_FRAMES_ART: string[][] = [shieldFrame(0), shieldFrame(1)];

// 把方形字符网格顺时针旋转 90°（用于从朝上帧生成其余朝向；尺寸无关）。
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

// 图集内单个精灵的取样矩形（含所属 canvas 引用，供 drawTile 使用）。宽高以 *美术像素* 计。
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
  spawnStar: [Sprite, Sprite, Sprite, Sprite]; // 出生闪光 4 帧（32×32）
  shield: [Sprite, Sprite]; // 出生护盾 2 帧（32×32）
  explosionSmall: [Sprite, Sprite, Sprite]; // 小爆炸 3 帧（32×32）
  explosionBig: [Sprite, Sprite]; // 大爆炸 2 帧（64×64）
  hudEnemy: Sprite; // HUD 剩余敌军小坦克（16×16）
  hudLifeTank: Sprite; // HUD 玩家生命迷你坦克（16×16）
  hudFlag: Sprite; // HUD 关卡旗（32×32）
  font: FontGlyphs; // 像素字体掩码（着色在 drawText 时选定）
}

// 把一张字符像素图逐像素（1 美术像素）画到 ctx 的 (ox, oy)。
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

// 图集各行的 y 偏移（美术像素）。
const Y_TERRAIN = 0; // 16 高：地形 8 块 16×16（含 HUD 迷你坦克）
const Y_EAGLE = 16; // 32 高：鹰巢 / 废墟 / HUD 旗（各 32）+ 子弹（8）
const Y_PLAYER = 48; // 以下各 32 高：坦克行（每行 8 帧 × 32）
const Y_BASIC = 80;
const Y_FAST = 112;
const Y_POWER = 144;
const Y_ARMOR = 176;
const Y_ARMOR_FLASH = 208;
const Y_FX = 240; // 32 高：出生星 4 帧 + 小爆炸 3 帧
const Y_BIG = 272; // 64 高：大爆炸 2 帧（64）+ 护盾 2 帧（32）

// 把一台坦克的朝上两帧铺到某一行：旋转生成其余朝向，
// 按 up0,up1,down0,down1,left0,left1,right0,right1 排布于 x=0,32,…,224。
function paintTankRow(ctx: CanvasRenderingContext2D, up0: string[], up1: string[], y: number): void {
  const right0 = rotateCW(up0);
  const right1 = rotateCW(up1);
  const down0 = rotateCW(right0);
  const down1 = rotateCW(right1);
  const left0 = rotateCW(down0);
  const left1 = rotateCW(down1);
  paint(ctx, up0, 0, y);
  paint(ctx, up1, 32, y);
  paint(ctx, down0, 64, y);
  paint(ctx, down1, 96, y);
  paint(ctx, left0, 128, y);
  paint(ctx, left1, 160, y);
  paint(ctx, right0, 192, y);
  paint(ctx, right1, 224, y);
}

// 取某坦克行的四朝向取样矩形（32×32）。
function tankFramesAt(canvas: HTMLCanvasElement, y: number): TankFrames {
  const s = (sx: number): Sprite => ({ src: canvas, sx, sy: y, w: 32, h: 32 });
  return {
    up: [s(0), s(32)],
    down: [s(64), s(96)],
    left: [s(128), s(160)],
    right: [s(192), s(224)],
  };
}

// 启动时调用一次，构建离屏图集并返回带取样矩形的 API。
export function createSpriteAtlas(): SpriteAtlas {
  const width = 256;
  const height = 336;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable for sprite atlas');
  ctx.imageSmoothingEnabled = false;

  const s = (sx: number, sy: number, w: number, h: number): Sprite => ({ src: canvas, sx, sy, w, h });

  // 地形行（16×16）
  paint(ctx, BRICK, 0, Y_TERRAIN);
  paint(ctx, STEEL, 16, Y_TERRAIN);
  paint(ctx, WATER_0, 32, Y_TERRAIN);
  paint(ctx, WATER_1, 48, Y_TERRAIN);
  paint(ctx, TREES, 64, Y_TERRAIN);
  paint(ctx, ICE, 80, Y_TERRAIN);
  paint(ctx, HUD_ENEMY, 96, Y_TERRAIN);
  paint(ctx, HUD_LIFE, 112, Y_TERRAIN);

  // 鹰巢行（32×32）+ 子弹（8×8）
  paint(ctx, EAGLE, 0, Y_EAGLE);
  paint(ctx, EAGLE_DESTROYED, 32, Y_EAGLE);
  paint(ctx, HUD_FLAG, 64, Y_EAGLE);
  paint(ctx, BULLET, 96, Y_EAGLE);

  // 玩家坦克行
  paintTankRow(ctx, recolor(TANK_STD, MAP_PLAYER), recolor(swapTreads(TANK_STD), MAP_PLAYER), Y_PLAYER);

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

  // 特效行：出生星 4 帧（32）+ 小爆炸 3 帧（32）
  paint(ctx, SPAWN_STAR_FRAMES_ART[0], 0, Y_FX);
  paint(ctx, SPAWN_STAR_FRAMES_ART[1], 32, Y_FX);
  paint(ctx, SPAWN_STAR_FRAMES_ART[2], 64, Y_FX);
  paint(ctx, SPAWN_STAR_FRAMES_ART[3], 96, Y_FX);
  paint(ctx, EXPLOSION_SMALL_FRAMES_ART[0], 128, Y_FX);
  paint(ctx, EXPLOSION_SMALL_FRAMES_ART[1], 160, Y_FX);
  paint(ctx, EXPLOSION_SMALL_FRAMES_ART[2], 192, Y_FX);
  // 大爆炸行（64×64，x 0/64）+ 护盾 2 帧（32×32，x 128/160）
  paint(ctx, EXPLOSION_BIG_FRAMES_ART[0], 0, Y_BIG);
  paint(ctx, EXPLOSION_BIG_FRAMES_ART[1], 64, Y_BIG);
  paint(ctx, SHIELD_FRAMES_ART[0], 128, Y_BIG);
  paint(ctx, SHIELD_FRAMES_ART[1], 160, Y_BIG);

  return {
    canvas,
    brick: s(0, Y_TERRAIN, 16, 16),
    steel: s(16, Y_TERRAIN, 16, 16),
    water: [s(32, Y_TERRAIN, 16, 16), s(48, Y_TERRAIN, 16, 16)],
    trees: s(64, Y_TERRAIN, 16, 16),
    ice: s(80, Y_TERRAIN, 16, 16),
    eagle: s(0, Y_EAGLE, 32, 32),
    eagleDestroyed: s(32, Y_EAGLE, 32, 32),
    playerTank: tankFramesAt(canvas, Y_PLAYER),
    enemyTank: {
      basic: tankFramesAt(canvas, Y_BASIC),
      fast: tankFramesAt(canvas, Y_FAST),
      power: tankFramesAt(canvas, Y_POWER),
      armor: tankFramesAt(canvas, Y_ARMOR),
      armorFlash: tankFramesAt(canvas, Y_ARMOR_FLASH),
    },
    bullet: s(96, Y_EAGLE, 8, 8),
    spawnStar: [
      s(0, Y_FX, 32, 32),
      s(32, Y_FX, 32, 32),
      s(64, Y_FX, 32, 32),
      s(96, Y_FX, 32, 32),
    ],
    shield: [s(128, Y_BIG, 32, 32), s(160, Y_BIG, 32, 32)],
    explosionSmall: [s(128, Y_FX, 32, 32), s(160, Y_FX, 32, 32), s(192, Y_FX, 32, 32)],
    explosionBig: [s(0, Y_BIG, 64, 64), s(64, Y_BIG, 64, 64)],
    hudEnemy: s(96, Y_TERRAIN, 16, 16),
    hudLifeTank: s(112, Y_TERRAIN, 16, 16),
    hudFlag: s(64, Y_EAGLE, 32, 32),
    font: FONT,
  };
}

// 把整块精灵绘制到目标 ctx 的 (x, y)。x/y 为 *逻辑* 像素，内部乘以 ART_SCALE；
// 精灵宽高本身已是美术像素（2×），因此目标尺寸直接用 sprite.w/h，不再二次缩放。
export function drawTile(ctx: CanvasRenderingContext2D, sprite: Sprite, x: number, y: number): void {
  ctx.drawImage(sprite.src, sprite.sx, sprite.sy, sprite.w, sprite.h, x * ART_SCALE, y * ART_SCALE, sprite.w, sprite.h);
}

// 以像素字体绘制一行文本到 (x, y)（*逻辑* 坐标），逐字形按 FONT_ADVANCE 递进。
// 5×7 掩码的每个点绘制为 ART_SCALE×ART_SCALE 的方块，得到粗块像素字（period-authentic）。
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
    if (!glyph) continue;
    const gx0 = (x + i * FONT_ADVANCE) * ART_SCALE;
    const gy0 = y * ART_SCALE;
    for (let gy = 0; gy < glyph.length; gy++) {
      const line = glyph[gy];
      for (let gc = 0; gc < line.length; gc++) {
        if (line[gc] === '#') ctx.fillRect(gx0 + gc * ART_SCALE, gy0 + gy * ART_SCALE, ART_SCALE, ART_SCALE);
      }
    }
  }
}

// 文本像素宽度（*逻辑* 像素，用于居中）。
export function textWidth(text: string): number {
  return text.length * FONT_ADVANCE;
}

// 只绘制精灵的一个象限（用于砖块按存活象限渲染）。
// qx/qy 为象限在精灵内的 *逻辑* 偏移（0 或 QUARTER=4）；dx/dy 为 *逻辑* 目标坐标。
// 内部统一乘以 ART_SCALE：象限在图集/画布上均为 8 美术像素。
export function drawQuarter(
  ctx: CanvasRenderingContext2D,
  sprite: Sprite,
  qx: number,
  qy: number,
  dx: number,
  dy: number,
): void {
  const q = QUARTER * ART_SCALE; // 8 美术像素
  ctx.drawImage(
    sprite.src,
    sprite.sx + qx * ART_SCALE,
    sprite.sy + qy * ART_SCALE,
    q,
    q,
    dx * ART_SCALE,
    dy * ART_SCALE,
    q,
    q,
  );
}

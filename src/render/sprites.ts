// NES 风格像素画（“hi-bit” 2× 重制）：以调色板索引字符串数组定义，启动时一次性绘制到离屏图集。
// 不使用任何外部图片资产。每个字符 = 一个调色板索引，'.' 表示透明。
//
// 关键：所有精灵均以 ART_SCALE=2 的“美术分辨率”授权（坦克 32×32、地形 16×16、子弹 8×8、
// 鹰巢 32×32 …）。图集本身即以美术像素存储；drawTile/drawText/drawQuarter 接收 *逻辑* 目标
// 坐标，内部乘以 ART_SCALE 后落到 512×448 画布。silhouette / 色系与 NES 原版一致，仅细化。

import { ART_SCALE, BOSS_SIZE, QUARTER } from '../core/constants';
import type { Direction } from '../core/types';
import { POWERUP_KINDS, type PowerupKind } from '../game/powerup';

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
  // 玩家 2 坦克：经典绿（NES 2P olive/green 家族）。结构对齐黄色组：高光/亮过渡/主体/暗过渡/阴影。
  A: '#78e048', // 高光绿
  B: '#58c840', // 亮绿过渡
  C: '#38a028', // 主体绿
  M: '#2c7c1c', // 暗绿过渡
  N: '#205810', // 阴影绿
  // 玩家 3 坦克：青/蓝家族。
  I: '#78d8f8', // 高光青
  J: '#38b8f8', // 亮蓝过渡
  K: '#0078f8', // 主体蓝
  P: '#0058c8', // 暗蓝过渡
  Q: '#003c88', // 阴影蓝
  // 玩家 4 坦克：粉/品红家族。
  U: '#f8b8f8', // 高光粉
  V: '#f878d8', // 亮粉过渡
  W: '#e840b0', // 主体品红
  X: '#a82888', // 暗品红过渡
  F: '#701858', // 阴影品红
  // 携带道具敌军红闪：红色车体家族（履带仍用钢制 c/a）。用数字键，避免与既有色 / 记号冲突。
  '1': '#f87858', // 高光红
  '2': '#f85838', // 亮红过渡
  '3': '#d82800', // 主体红
  '4': '#a81800', // 暗红过渡
  '5': '#701000', // 阴影红
  // 智能坦克：高亮青色计算核心，避免与银色敌军及 P3 蓝色坦克混淆。
  '6': '#ffffff', // 传感器白色高光
  '7': '#58f8f8', // 霓虹青
  '8': '#00b8d8', // 青蓝主体
  '9': '#005878', // 深青阴影
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

// ── 鹰巢徽记（32×32，透明底金属鹰）──
// 正面展翼的徽章式轮廓：金色尖嘴明确指向左侧，双翼横向撑开基地门洞，
// 三组羽翼缝与三片尾羽保证缩小后仍能与胸腹分离。金属体用左上白色高光、
// 浅银主体、右下中灰硬边塑形，避免旧版大面积白色连成一团。
function eagleTile(): string[] {
  const size = 32;
  const mask = Array.from({ length: size }, () => new Array<string>(size).fill('.'));
  const fill = (x0: number, y0: number, x1: number, y1: number, mark = 'B'): void => {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) mask[y][x] = mark;
    }
  };

  // 头部朝左：桂冠、额头、金色阶梯尖嘴和颈部。
  fill(15, 1, 19, 1);
  fill(13, 2, 20, 2);
  fill(12, 3, 20, 5);
  fill(10, 4, 13, 5, 'O');
  fill(8, 5, 12, 6, 'O');
  fill(14, 6, 19, 9);
  fill(13, 8, 20, 11);

  // 展翼的水平扇面：先快速展宽，再逐行向下收拢。
  const wingSpans: Array<[y: number, inset: number]> = [
    [7, 11], [8, 7], [9, 4], [10, 2], [11, 1], [12, 1], [13, 1],
    [14, 2], [15, 3], [16, 4], [17, 5], [18, 6], [19, 7], [20, 8],
  ];
  for (const [y, inset] of wingSpans) {
    fill(inset, y, 13, y);
    fill(18, y, size - 1 - inset, y);
  }

  // 紧凑胸腹：上宽下窄，避免中轴变成一根等宽柱子。
  for (let y = 10; y <= 24; y++) {
    const half = y < 15 ? 4 : y < 21 ? 3 : 2;
    fill(16 - half, y, 16 + half, y);
  }

  // 三组左翼羽缝同步镜像到右翼，用透明负形保持轮廓干净。
  for (const [startX, startY, length] of [
    [3, 13, 5],
    [6, 14, 6],
    [9, 15, 6],
  ]) {
    for (let d = 0; d < length; d++) {
      const x = startX + Math.floor(d * 0.35);
      mask[startY + d][x] = '.';
      mask[startY + d][size - 1 - x] = '.';
    }
  }

  // 三片逐级收尖的尾羽：中羽最长，两侧羽外扩后快速收拢。
  // 从 y=25 开始留出两道稳定的黑色羽缝，避免底部读成方正的脚架。
  fill(13, 22, 19, 22);
  fill(12, 23, 20, 23);
  fill(11, 24, 21, 24);
  for (let y = 25; y <= 29; y++) {
    const taper = Math.floor((y - 25) / 2);
    fill(10 + taper, y, 13, y);
    fill(15, y, 17, y);
    fill(19, y, 22 - taper, y);
  }
  fill(15, 30, 17, 30);

  const isBody = (x: number, y: number): boolean => mask[y]?.[x] === 'B';
  const rows = mask.map((row, y) => row.map((mark, x) => {
    if (mark === 'O') return 'Y';
    if (mark !== 'B') return '.';
    const topOrLeftEdge = !isBody(x, y - 1) || !isBody(x - 1, y);
    const bottomOrRightEdge = !isBody(x, y + 1) || !isBody(x + 1, y);
    return topOrLeftEdge ? 'w' : bottomOrRightEdge ? 'b' : 'c';
  }));

  // 眼睛复用边缘中灰，不额外扩张单张精灵的色数。
  if (rows[3][14] !== '.') {
    rows[3][14] = 'b';
  }
  return assertGrid(rows.map((row) => row.join('')), size, size, 'eagle');
}
const EAGLE = eagleTile();

// 被摧毁的鹰巢（32×32）：断裂的鹰徽金属片 + 焦黑瓦砾堆 + 少量余烬。
// 所有残片都有明确轮廓，门洞上半重新露出黑底，避免随机噪点读成方形电视雪花。
function eagleDestroyedTile(): string[] {
  const size = 32;
  const grid = Array.from({ length: size }, () => new Array<string>(size).fill('.'));
  type RowSpan = [y: number, x0: number, x1: number];

  const span = (y: number, x0: number, x1: number, color: string): void => {
    for (let x = x0; x <= x1; x++) grid[y][x] = color;
  };

  // 先铺不对称的焦黑残骸：中腹鼓起、两端留黑，底边稍微回收。
  const rubbleBed: RowSpan[] = [
    [20, 7, 24], [21, 4, 28], [22, 2, 30], [23, 1, 30],
    [24, 1, 30], [25, 2, 29], [26, 1, 30], [27, 1, 30],
    [28, 2, 29], [29, 3, 28], [30, 4, 27], [31, 6, 25],
  ];
  for (const [y, x0, x1] of rubbleBed) span(y, x0, x1, 'a');

  // 瓦砾堆内部的灰烬层：只用几段成组色带，不再用逐像素随机噪声。
  for (const [y, x0, x1] of [
    [21, 5, 9], [21, 22, 26], [23, 9, 13], [24, 18, 22],
    [26, 2, 5], [27, 23, 28], [29, 5, 11], [30, 17, 23],
  ] as RowSpan[]) {
    span(y, x0, x1, 'v');
  }

  // 给一块独立残片加硬边高光/阴影。每块先建自己的 mask，
  // 因此即使它们在瓦砾中相邻，轮廓也不会糊成一块。
  const paintFragment = (
    rows: RowSpan[],
    highlight = 'c',
    body = 'b',
    shadow = 'v',
  ): void => {
    const cells = new Set<number>();
    for (const [y, x0, x1] of rows) {
      for (let x = x0; x <= x1; x++) cells.add(y * size + x);
    }
    const has = (x: number, y: number): boolean => cells.has(y * size + x);
    for (const key of cells) {
      const x = key % size;
      const y = Math.floor(key / size);
      const topOrLeftEdge = !has(x, y - 1) || !has(x - 1, y);
      const bottomOrRightEdge = !has(x, y + 1) || !has(x + 1, y);
      grid[y][x] = topOrLeftEdge ? highlight : bottomOrRightEdge ? shadow : body;
    }
  };

  // 主胸甲、左右断翼与一块尾羽：保留“原来是鹰徽”的上下文。
  paintFragment([
    [12, 16, 18], [13, 14, 19], [14, 12, 20], [15, 12, 20],
    [16, 13, 20], [17, 12, 18], [18, 11, 17], [19, 12, 16], [20, 13, 17],
  ]);
  paintFragment([
    [16, 6, 8], [17, 4, 10], [18, 4, 11],
    [19, 6, 12], [20, 8, 12], [21, 9, 11],
  ]);
  paintFragment([
    [14, 23, 25], [15, 21, 27], [16, 20, 28], [17, 20, 27],
    [18, 19, 26], [19, 18, 23], [20, 18, 21],
  ]);
  paintFragment([[22, 14, 19], [23, 13, 20], [24, 14, 18]], 's', 'b', 'v');

  // 两块被抛到上方的银色碎片，保留爆炸方向感，但数量足够克制。
  paintFragment([[8, 7, 8], [9, 6, 9], [10, 7, 9]], 's', 'b', 'v');
  paintFragment([[7, 24, 25], [8, 23, 26], [9, 24, 26]], 's', 'b', 'v');

  // 底部独立石块：大小、高度交错，不重复平铺整齐方格。
  for (const rock of [
    [[23, 3, 7], [24, 2, 8], [25, 4, 8]],
    [[24, 9, 13], [25, 8, 14], [26, 9, 12]],
    [[25, 16, 20], [26, 15, 21], [27, 16, 19]],
    [[22, 24, 27], [23, 22, 28], [24, 23, 27]],
    [[27, 3, 8], [28, 2, 9], [29, 4, 8]],
    [[28, 10, 15], [29, 9, 16], [30, 11, 15]],
    [[28, 20, 26], [29, 18, 27], [30, 20, 25]],
  ] as RowSpan[][]) {
    paintFragment(rock, 's', 'b', 'v');
  }

  // 斜向裂缝把主胸甲切成两片，黑底直接透过裂口露出。
  for (const [x, y] of [[16, 14], [15, 15], [15, 16], [14, 17], [13, 18]]) {
    grid[y][x] = '.';
  }

  // 红砖残片与少量余烬：热色只作点睛，不再铺满整张精灵。
  paintFragment([[13, 2, 3], [14, 1, 4], [15, 2, 4]], 'o', 'r', 'x');
  paintFragment([[10, 28, 29], [11, 27, 30], [12, 28, 30]], 'o', 'r', 'x');
  paintFragment([[25, 5, 7], [26, 4, 7], [27, 5, 6]], 'o', 'r', 'x');
  paintFragment([[24, 25, 27], [25, 24, 28], [26, 26, 28]], 'o', 'r', 'x');
  for (const [x, y, color] of [
    [17, 21, 'o'], [18, 22, 'r'], [15, 24, 'o'], [20, 27, 'r'],
  ] as Array<[number, number, string]>) {
    grid[y][x] = color;
  }

  return assertGrid(grid.map((row) => row.join('')), size, size, 'eagleDestroyed');
}
const EAGLE_DESTROYED = eagleDestroyedTile();

// ── 坦克（32×32，朝上基准帧，以“记号”程序化绘制）──
// 记号：T=履带亮 t=履带暗 E=履带齿分隔(更暗) H=车体 L=车体高光 D=车体阴影
//       S=高光过渡 Z=阴影过渡 O=黑外轮廓 K=车体内部深色 B=炮管/细节黑边
//       R=炮管亮色内芯 '.'=透明
// 统一使用 1–2 美术像素切角、硬轮廓、左上高光与右下暗面；其余三朝向由网格旋转生成。

// 六套差异化坦克模板：
// PLAYER = 箭头前甲 + 菱形徽记；BASIC = 方正量产车；FAST = 窄体梭形；
// POWER = 宽炮塔 + 粗炮管；ARMOR = 满宽履带 + 双层重甲；SMART = 传感器炮塔 + 侧舱。
// 即使把所有车体去色为同一灰度，仍能依靠外轮廓和炮塔比例识别阵营/类型。
type TankGrid = string[][];
type TankSilhouette = 'player' | 'basic' | 'fast' | 'power' | 'armor' | 'smart';

function tankBlank(): TankGrid {
  return Array.from({ length: 32 }, () => new Array<string>(32).fill('.'));
}

function tankRect(g: TankGrid, x0: number, y0: number, x1: number, y1: number, ch: string): void {
  for (let y = Math.max(0, y0); y <= Math.min(31, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(31, x1); x++) g[y][x] = ch;
  }
}

function tankTrack(g: TankGrid, x0: number, x1: number, y0: number, y1: number): void {
  for (let y = y0; y <= y1; y++) {
    const band = (y - y0) % 6;
    const ch = band < 2 ? 'T' : band < 4 ? 't' : 'E';
    tankRect(g, x0, y, x1, y, ch);
  }
  // 履带外缘切角，避免每种坦克都像两根矩形柱。
  g[y0][x0] = '.';
  g[y0][x1] = '.';
  g[y1][x0] = '.';
  g[y1][x1] = '.';
}

// 炮管使用“1px 黑边 + 亮色内芯”：在冰面等高亮地形上仍能一眼读出朝向。
// 不同车型保留原本的内芯宽度，因此快速型仍纤细，威力/装甲型仍厚重。
function tankBarrel(g: TankGrid, x0: number, y0: number, x1: number, y1: number): void {
  tankRect(g, x0 - 1, y0 - 1, x1 + 1, y1, 'B');
  tankRect(g, x0, y0, x1, y1, 'R');
}

function tankPlate(
  g: TankGrid,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  chamfer = 1,
): void {
  tankRect(g, x0, y0, x1, y1, 'O');
  tankRect(g, x0 + 2, y0 + 2, x1 - 2, y1 - 2, 'H');
  tankRect(g, x0 + 2, y0 + 2, x1 - 3, y0 + 3, 'L');
  tankRect(g, x0 + 2, y0 + 4, x0 + 3, y1 - 3, 'S');
  tankRect(g, x0 + 3, y1 - 3, x1 - 2, y1 - 2, 'D');
  tankRect(g, x1 - 3, y0 + 4, x1 - 2, y1 - 4, 'Z');
  for (let i = 0; i < chamfer; i++) {
    g[y0 + i][x0 + i] = '.';
    g[y0 + i][x1 - i] = '.';
    g[y1 - i][x0 + i] = '.';
    g[y1 - i][x1 - i] = '.';
  }
}

// 玩家专属圆形炮塔盖：用 2px 黑色阶梯边缘包住圆面，并沿用左上高光 / 右下阴影。
// 圆形只用于上层炮塔，底盘仍保留箭头形前甲，因此缩到 1× 游戏尺寸时仍能同时读出阵营与朝向。
function tankRoundPlate(g: TankGrid, cx: number, cy: number, radius: number): void {
  const innerRadius = radius - 2;
  const x0 = Math.max(0, Math.floor(cx - radius));
  const x1 = Math.min(31, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const y1 = Math.min(31, Math.ceil(cy + radius));

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq > radius * radius) continue;

      let ch = 'O';
      if (distanceSq <= innerRadius * innerRadius) {
        if (dy <= -3) ch = 'L';
        else if (dx <= -3) ch = 'S';
        else if (dy >= 3) ch = 'D';
        else if (dx >= 3) ch = 'Z';
        else ch = 'H';
      }
      g[y][x] = ch;
    }
  }
}

// 外轮廓保持纯黑；完全包在车体内部的粗黑线改成阵营对应的最深色。
// 这样炮塔与底盘连成实心装甲，不会在亮色地形上被误读成透明空洞。
function shadeTankInterior(g: TankGrid): void {
  const source = g.map((row) => [...row]);
  for (let y = 0; y < 32; y++) {
    // 履带分隔继续使用纯黑，只处理中央车体区域。
    for (let x = 7; x <= 24; x++) {
      if (source[y][x] !== 'O') continue;
      let touchesTransparency = false;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= 32 || ny < 0 || ny >= 32 || source[ny][nx] === '.') {
            touchesTransparency = true;
          }
        }
      }
      if (!touchesTransparency) g[y][x] = 'K';
    }
  }
}

function makeTankTemplate(kind: TankSilhouette, playerLevel = 0): string[] {
  const g = tankBlank();

  if (kind === 'player') {
    tankTrack(g, 2, 8, 7, 29);
    tankTrack(g, 23, 29, 7, 29);
    tankBarrel(g, 14, 1, 17, 12);
    tankPlate(g, 7, 11, 24, 28, 2);
    // 玩家独有的箭头形前翼，形成明显的“向前”轮廓。
    tankRect(g, 7, 12, 9, 18, 'H');
    tankRect(g, 22, 12, 24, 18, 'H');
    // 圆形炮塔盖是全体玩家共享的阵营特征；敌军炮塔统一保持方正 / 棱角造型。
    tankRoundPlate(g, 15.5, 14.5, 7);
    // 菱形队徽：亮色中心 + 暗色下尖。
    g[13][15] = 'L'; g[13][16] = 'L';
    g[14][14] = 'L'; g[14][17] = 'S';
    g[15][15] = 'L'; g[15][16] = 'H';
    g[16][15] = 'Z'; g[16][16] = 'Z';
    if (playerLevel >= 1) {
      // 1 级高速型：外扩履带、长炮管、前肩翼与后导流翼，和 0 级拉开明显剪影差。
      tankTrack(g, 1, 8, 7, 30);
      tankTrack(g, 23, 30, 7, 30);
      tankBarrel(g, 14, 0, 17, 12);
      tankRect(g, 4, 11, 9, 14, 'O');
      tankRect(g, 6, 12, 9, 13, 'L');
      tankRect(g, 22, 11, 27, 14, 'O');
      tankRect(g, 22, 12, 25, 13, 'Z');
      g[11][4] = '.'; g[14][4] = '.';
      g[11][27] = '.'; g[14][27] = '.';
      tankRect(g, 5, 24, 9, 27, 'O');
      tankRect(g, 6, 24, 9, 25, 'L');
      tankRect(g, 22, 24, 26, 27, 'O');
      tankRect(g, 22, 24, 25, 25, 'Z');
    }
    if (playerLevel >= 2) {
      // 2 级突击型：收窄斜切炮塔，侧舱改成短刀翼；炮口制退器强调双弹/破钢而不显笨重。
      tankBarrel(g, 14, 0, 17, 13);
      tankRect(g, 11, 2, 20, 5, 'B');
      tankRect(g, 12, 3, 19, 4, 'R');
      tankPlate(g, 9, 8, 22, 21, 4);
      tankRect(g, 5, 15, 8, 18, 'O');
      tankRect(g, 6, 15, 8, 16, 'L');
      tankRect(g, 23, 15, 26, 18, 'O');
      tankRect(g, 23, 15, 25, 16, 'Z');
      g[15][5] = '.'; g[18][5] = '.';
      g[15][26] = '.'; g[18][26] = '.';
      // 炮盾上的双亮线形成向前的 V 形视觉重心。
      g[11][13] = 'L'; g[12][14] = 'L';
      g[11][18] = 'S'; g[12][17] = 'S';
    }
    if (playerLevel >= 3) {
      // 3 级：满宽侧裙、外层装甲板和四枚铆钉；破甲后渲染层会退回 2 级剪影。
      tankTrack(g, 0, 8, 6, 31);
      tankTrack(g, 23, 31, 6, 31);
      tankRect(g, 4, 10, 9, 29, 'O');
      tankRect(g, 5, 12, 9, 27, 'H');
      tankRect(g, 22, 10, 27, 29, 'O');
      tankRect(g, 22, 12, 26, 27, 'D');
      tankPlate(g, 7, 10, 24, 29, 1);
      tankPlate(g, 8, 7, 23, 22, 1);
      g[12][10] = 'L'; g[12][21] = 'L';
      g[25][9] = 'S'; g[25][22] = 'Z';
    }
  } else if (kind === 'basic') {
    tankTrack(g, 2, 8, 9, 29);
    tankTrack(g, 23, 29, 9, 29);
    tankBarrel(g, 14, 3, 17, 13);
    tankPlate(g, 9, 12, 22, 28, 1);
    tankPlate(g, 11, 9, 20, 20, 1);
    // 量产敌军的横向观察口，强化“方盒子”面相。
    tankRect(g, 13, 14, 18, 15, 'B');
  } else if (kind === 'fast') {
    tankTrack(g, 5, 9, 11, 27);
    tankTrack(g, 22, 26, 11, 27);
    tankBarrel(g, 15, 0, 16, 13);
    tankPlate(g, 9, 12, 22, 27, 4);
    tankPlate(g, 12, 8, 19, 19, 2);
    // 梭形车鼻与长尾，旋转到任一方向都保持纤细轮廓。
    tankRect(g, 13, 10, 18, 12, 'L');
    tankRect(g, 13, 27, 18, 29, 'D');
  } else if (kind === 'power') {
    tankTrack(g, 1, 7, 9, 30);
    tankTrack(g, 24, 30, 9, 30);
    tankBarrel(g, 13, 0, 18, 14);
    tankPlate(g, 7, 12, 24, 29, 2);
    tankPlate(g, 8, 8, 23, 22, 3);
    // 宽炮塔两侧的后坐机构，是威力型最显眼的剪影特征。
    tankRect(g, 6, 13, 9, 20, 'O');
    tankRect(g, 7, 14, 9, 19, 'L');
    tankRect(g, 22, 13, 25, 20, 'O');
    tankRect(g, 22, 14, 24, 19, 'Z');
    // 绿色只留在中央能量芯，车体其余部分统一使用敌军冷灰钢材。
    tankRect(g, 13, 13, 18, 16, '@');
  } else if (kind === 'smart') {
    tankTrack(g, 3, 9, 8, 29);
    tankTrack(g, 22, 28, 8, 29);
    tankBarrel(g, 14, 1, 17, 12);
    tankPlate(g, 8, 12, 23, 28, 3);
    tankPlate(g, 10, 8, 21, 21, 4);
    // 两侧传感器舱与成对“眼睛”构成智能型独有的机器人面相。
    tankRect(g, 6, 14, 10, 20, 'O');
    tankRect(g, 7, 15, 10, 19, 'S');
    tankRect(g, 21, 14, 25, 20, 'O');
    tankRect(g, 21, 15, 24, 19, 'Z');
    // 青色只留在成对传感器眼与炮管芯，避免整车与 P3 青色玩家混淆。
    tankRect(g, 13, 12, 14, 14, '?');
    tankRect(g, 17, 12, 18, 14, '?');
    tankRect(g, 14, 18, 17, 19, 'B');
  } else {
    tankTrack(g, 0, 8, 6, 31);
    tankTrack(g, 23, 31, 6, 31);
    tankBarrel(g, 13, 2, 18, 12);
    // 先画宽大的外层装甲，再叠内层炮塔，形成双层堡垒感。
    tankPlate(g, 6, 11, 25, 30, 1);
    tankPlate(g, 8, 7, 23, 22, 1);
    tankRect(g, 5, 15, 8, 26, 'H');
    tankRect(g, 23, 15, 26, 26, 'D');
    // 四枚铆钉即便缩小时仍会形成可见亮点。
    g[12][11] = 'L'; g[12][20] = 'L';
    g[24][10] = 'S'; g[24][21] = 'Z';
  }

  shadeTankInterior(g);

  return assertGrid(g.map((row) => row.join('')), 32, 32, `tank-${kind}`);
}

const TANK_PLAYER_LEVELS = [0, 1, 2, 3].map((level) => makeTankTemplate('player', level));
const TANK_BASIC = makeTankTemplate('basic');
const TANK_FAST_HD = makeTankTemplate('fast');
const TANK_POWER = makeTankTemplate('power');
const TANK_ARMOR_HD = makeTankTemplate('armor');
const TANK_SMART = makeTankTemplate('smart');

// ── Boss（64×64 美术 = 32×32 逻辑，朝上基准帧）──
// 与普通坦克使用同一套记号（H/L/S/Z/D/O/K/B/R/T/t/E），因此可以复用 recolor 换配色：
// phase1 = 钢蓝重甲，phase2 = 血红暴走，受击白闪 = 整体提亮。其余三朝向由 rotateCW 生成。
const BOSS_ART = BOSS_SIZE * ART_SCALE;

function bossTrack(g: CharGrid, x0: number, x1: number, y0: number, y1: number): void {
  for (let y = y0; y <= y1; y++) {
    const band = (y - y0) % 12;
    const ch = band < 4 ? 'T' : band < 8 ? 't' : 'E';
    fillRectG(g, x0, y, x1, y, ch);
  }
  // 履带四角切角，避免整台车读成两根矩形柱。
  for (let i = 0; i < 2; i++) {
    fillRectG(g, x0 + i, y0 + i, x0 + i, y0 + i, '.');
    fillRectG(g, x1 - i, y0 + i, x1 - i, y0 + i, '.');
    fillRectG(g, x0 + i, y1 - i, x0 + i, y1 - i, '.');
    fillRectG(g, x1 - i, y1 - i, x1 - i, y1 - i, '.');
  }
}

// 粗炮管：2px 黑边 + 亮色内芯（内芯色由 R 记号决定，随阶段换色）。
function bossBarrel(g: CharGrid, x0: number, y0: number, x1: number, y1: number): void {
  fillRectG(g, x0 - 2, y0 - 2, x1 + 2, y1, 'B');
  fillRectG(g, x0, y0, x1, y1, 'R');
}

// 装甲板：黑轮廓 + 主体 + 顶部高光 / 左侧过渡 / 右下阴影。
function bossPlate(
  g: CharGrid,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  chamfer = 2,
): void {
  fillRectG(g, x0, y0, x1, y1, 'O');
  fillRectG(g, x0 + 3, y0 + 3, x1 - 3, y1 - 3, 'H');
  fillRectG(g, x0 + 3, y0 + 3, x1 - 6, y0 + 7, 'L');
  fillRectG(g, x0 + 3, y0 + 8, x0 + 7, y1 - 7, 'S');
  fillRectG(g, x0 + 7, y1 - 7, x1 - 3, y1 - 3, 'D');
  fillRectG(g, x1 - 7, y0 + 8, x1 - 3, y1 - 8, 'Z');
  for (let i = 0; i < chamfer; i++) {
    g[y0 + i][x0 + i] = '.';
    g[y0 + i][x1 - i] = '.';
    g[y1 - i][x0 + i] = '.';
    g[y1 - i][x1 - i] = '.';
  }
}

// 完全包在车体内部的粗黑线改用阵营最深色，使炮塔与底盘连成实心装甲（同 shadeTankInterior）。
function shadeBossInterior(g: CharGrid): void {
  const source = g.map((row) => [...row]);
  for (let y = 0; y < BOSS_ART; y++) {
    for (let x = 15; x <= BOSS_ART - 16; x++) {
      if (source[y][x] !== 'O') continue;
      let touchesTransparency = false;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= BOSS_ART || ny < 0 || ny >= BOSS_ART || source[ny][nx] === '.') {
            touchesTransparency = true;
          }
        }
      }
      if (!touchesTransparency) g[y][x] = 'K';
    }
  }
}

// 厚重装甲大坦克：满高双履带 + 双联粗炮管 + 双层堡垒车体 + 两侧炮舱 + 中央能量核心。
// 即使去色，仅凭轮廓也能与任何一台 16×16 小坦克区分开。
function makeBossTemplate(): string[] {
  const g = blankGrid(BOSS_ART);

  // 满高双履带（比任何小坦克都宽，形成“压路机”体量）。
  bossTrack(g, 1, 13, 7, 62);
  bossTrack(g, 50, 62, 7, 62);

  // 双联粗炮管，先画后被车体覆盖根部。
  bossBarrel(g, 22, 0, 27, 23);
  bossBarrel(g, 36, 0, 41, 23);

  // 底盘（宽）+ 炮塔（窄高），双层结构。
  bossPlate(g, 9, 20, 54, 60, 3);
  bossPlate(g, 17, 11, 46, 47, 4);

  // 两侧外挂炮舱：左亮右暗，强化立体感与“武装到牙齿”的剪影。
  fillRectG(g, 4, 27, 14, 43, 'O');
  fillRectG(g, 6, 29, 13, 41, 'S');
  fillRectG(g, 49, 27, 59, 43, 'O');
  fillRectG(g, 50, 29, 57, 41, 'Z');

  // 炮塔面：两道散热槽 + 中央能量核心（核心色随阶段变化）。
  fillRectG(g, 22, 31, 29, 35, 'B');
  fillRectG(g, 34, 31, 41, 35, 'B');
  ringG(g, 31.5, 42, 7, 5, 'B');
  fillCircleG(g, 31.5, 42, 5, 'R');

  // 底盘铆钉：四枚亮点，缩小后仍可见。
  for (const [rx, ry] of [
    [13, 24],
    [49, 24],
    [13, 55],
    [49, 55],
  ]) {
    fillRectG(g, rx, ry, rx + 2, ry + 2, 'L');
  }

  shadeBossInterior(g);
  return assertGrid(gridToRows(g), BOSS_ART, BOSS_ART, 'boss');
}

const BOSS_TEMPLATE = makeBossTemplate();

// 记号 → 调色板字符 的重着色映射（'.' 与未列出的字符原样透传）。
type ColorMap = Record<string, string>;
// 玩家 1：黄车体（高光 Y / 过渡 h/z / 主体 y / 阴影 d），钢制履带 c/a + 黑分隔，炮管亮黄。
const MAP_PLAYER1: ColorMap = { T: 'c', t: 'a', E: 'e', H: 'y', S: 'h', Z: 'z', L: 'Y', D: 'd', O: 'e', K: 'd', B: 'e', R: 'Y' };
// 玩家 2：绿车体（高光 A / 过渡 B/M / 主体 C / 阴影 N），炮管亮绿。
const MAP_PLAYER2: ColorMap = { T: 'c', t: 'a', E: 'e', H: 'C', S: 'B', Z: 'M', L: 'A', D: 'N', O: 'e', K: 'N', B: 'e', R: 'A' };
// 玩家 3：蓝/青车体（高光 I / 过渡 J/P / 主体 K / 阴影 Q），炮管亮青。
const MAP_PLAYER3: ColorMap = { T: 'c', t: 'a', E: 'e', H: 'K', S: 'J', Z: 'P', L: 'I', D: 'Q', O: 'e', K: 'Q', B: 'e', R: 'I' };
// 玩家 4：粉/品红车体（高光 U / 过渡 V/X / 主体 W / 阴影 F），炮管亮粉。
const MAP_PLAYER4: ColorMap = { T: 'c', t: 'a', E: 'e', H: 'W', S: 'V', Z: 'X', L: 'U', D: 'F', O: 'e', K: 'F', B: 'e', R: 'U' };
// 按 playerIndex 索引的四套玩家配色。
const MAP_PLAYERS: ColorMap[] = [MAP_PLAYER1, MAP_PLAYER2, MAP_PLAYER3, MAP_PLAYER4];
// 玩家非致命受击：保留深色轮廓，其余整体提亮成白色。
const MAP_PLAYER_HIT: ColorMap = { T: 'w', t: 'c', E: 'b', H: 'w', S: 'w', Z: 'c', L: 'w', D: 'c', O: 'e', K: 'b', B: 'e', R: 'w' };
// 全体普通敌军共用冷灰钢材；类型差异主要由剪影表达，彩色仅作为小面积功能核心。
const MAP_ENEMY_STEEL: ColorMap = { T: 'c', t: 'a', E: 'e', H: 'b', S: 's', Z: 'v', L: 'c', D: 'a', O: 'e', K: 'a', B: 'e', R: 'c' };
const MAP_BASIC: ColorMap = MAP_ENEMY_STEEL;
// 威力型：仅中央能量芯保留绿色。
const MAP_POWER: ColorMap = { ...MAP_ENEMY_STEEL, '@': 'G' };
// 智能型：仅传感器眼与炮管芯保留霓虹青；车体与其他敌军使用同一钢材。
const MAP_SMART: ColorMap = { ...MAP_ENEMY_STEEL, '?': '7', R: '7' };
// 装甲型（常态）：靠更厚履带和双层堡垒剪影区分。
const MAP_ARMOR: ColorMap = MAP_ENEMY_STEEL;
// 装甲型（白闪）：受损时交替使用的高亮白色变体（履带 w/c、分隔灰，车体近全白）。
const MAP_ARMOR_FLASH: ColorMap = { T: 'w', t: 'c', E: 'b', H: 'w', S: 'w', Z: 'c', L: 'w', D: 'c', O: 'e', K: 'b', B: 'e', R: 'w' };
// 携带道具敌军红闪变体：红色车体家族（高光 1 / 亮过渡 2 / 主体 3 / 暗过渡 4 / 阴影 5），履带 c/a，炮管亮红。
const MAP_ENEMY_RED: ColorMap = { T: 'c', t: 'a', E: 'e', H: '3', S: '2', Z: '4', L: '1', D: '5', O: 'e', K: '5', B: 'e', R: '1', '@': '1', '?': '1' };
// Boss 阶段 1：钢蓝重甲（主体 P 暗蓝 / 高光 J / 阴影 Q），炮管与能量核心亮青 I。
const MAP_BOSS_P1: ColorMap = { T: 'c', t: 'a', E: 'e', H: 'P', S: 'K', Z: 'Q', L: 'J', D: 'Q', O: 'e', K: 'Q', B: 'e', R: 'I' };
// Boss 阶段 2：血红暴走（沿用携带者红色家族），能量核心转为高热黄 Y。
const MAP_BOSS_P2: ColorMap = { T: 'c', t: 'a', E: 'e', H: '3', S: '2', Z: '4', L: '1', D: '5', O: 'e', K: '5', B: 'e', R: 'Y' };
// Boss 受击白闪：整体提亮到白 / 浅蓝白，仅黑轮廓保留。
const MAP_BOSS_FLASH: ColorMap = { T: 'w', t: 'c', E: 'b', H: 'w', S: 'w', Z: 'p', L: 'w', D: 'p', O: 'e', K: 'c', B: 'e', R: 'w' };

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

// ── 双螺旋炎爆弹单颗火球（8×8 美术 = 4×4 逻辑）──：黄芯 + 亮红过渡 + 暗红外缘。
const BULLET_SPIRAL = ((): string[] => {
  const g = blankGrid(8);
  fillCircleG(g, 3.5, 3.5, 3.6, '3'); // 暗红外缘
  fillCircleG(g, 3.5, 3.5, 2.4, '2'); // 亮红过渡
  fillCircleG(g, 3.5, 3.5, 1.2, 'Y'); // 黄芯
  return assertGrid(gridToRows(g), 8, 8, 'bulletSpiral');
})();

// ── 激光（16×16 美术 = 8×8 逻辑）──：白芯 + 亮青边的细长亮条（2×8 逻辑），两端收窄。
// 只授权朝上帧，其余三向由 rotateCW 旋转生成；绘制时按 LASER_SPRITE_OFFSET 居中于 4×4 弹体盒。
// prettier-ignore
const BULLET_LASER_UP = assertGrid([
  '.......II.......',
  '......IwwI......',
  '......IwwI......',
  '......IwwI......',
  '......IwwI......',
  '......IwwI......',
  '......IwwI......',
  '......IwwI......',
  '......IwwI......',
  '......IwwI......',
  '......IwwI......',
  '......IwwI......',
  '......IwwI......',
  '......IwwI......',
  '......IwwI......',
  '.......II.......',
], 16, 16, 'bulletLaser');

// ── Boss 地雷（16×16 美术 = 8×8 逻辑）──
// 经典水雷造型：黑轮廓 + 深灰球体 + 四周尖刺，中央一枚指示灯。
// 未武装用银色灯（'c'），武装后用亮红灯（recolor 换成 '2'），配合渲染层的闪烁提示“会炸”。
// prettier-ignore
const MINE = assertGrid([
  '.......ee.......',
  '..e....ee....e..',
  '..ee..ebbe..ee..',
  '...ee.ebbe.ee...',
  '....ebbbbbbe....',
  '...ebbbbbbbbe...',
  '..ebbbbbbbbbbe..',
  'eeebbbbccbbbbeee',
  'eeebbbbccbbbbeee',
  '..ebbbbbbbbbbe..',
  '...ebbbbbbbbe...',
  '....ebbbbbbe....',
  '...ee.ebbe.ee...',
  '..ee..ebbe..ee..',
  '..e....ee....e..',
  '.......ee.......',
], 16, 16, 'mine');

// 武装后的地雷：指示灯换成亮红，球体略微提亮（更醒目）。
const MINE_ARMED = recolor(MINE, { c: '2', b: 'a' });

// ── HUD 迷你坦克（16×16）──
// 敌军是方炮塔宽履带，玩家是箭头车鼻窄履带；HUD 中同样不只靠颜色辨认。
// prettier-ignore
const MINI_ENEMY = assertGrid([
  '......XXXX......',
  '......XXXX......',
  '..XXXX.XX.XXXX..',
  '.XXXXXXXXXXXXXX.',
  '.XXXX.XXXX.XXXX.',
  '.XXXXXXXXXXXXXX.',
  '.XXXX.XXXX.XXXX.',
  '.XXXXXXXXXXXXXX.',
  '.XXXX.XXXX.XXXX.',
  '.XXXXXXXXXXXXXX.',
  '.XXXX.XXXX.XXXX.',
  '.XXXXXXXXXXXXXX.',
  '..XXXX....XXXX..',
  '................',
  '................',
  '................',
], 16, 16, 'miniEnemy');
// prettier-ignore
const MINI_PLAYER = assertGrid([
  '.......XX.......',
  '.......XX.......',
  '.......XX.......',
  '..XX...XX...XX..',
  '..XX..XXXX..XX..',
  '..XXXXXXXXXXXX..',
  '..XX..XXXX..XX..',
  '..XX..XXXX..XX..',
  '..XX...XX...XX..',
  '..XX..XXXX..XX..',
  '..XX..XXXX..XX..',
  '..XX..XXXX..XX..',
  '...XX......XX...',
  '................',
  '................',
  '................',
], 16, 16, 'miniPlayer');
const HUD_ENEMY = recolor(MINI_ENEMY, { X: 'e' });
// 每名玩家一套按主体色着色的生命迷你坦克（P1 黄 / P2 绿 / P3 蓝 / P4 粉）。
const HUD_LIFE_BODY = ['y', 'C', 'K', 'W'];
const HUD_LIFE_TANKS = HUD_LIFE_BODY.map((c) => recolor(MINI_PLAYER, { X: c }));

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
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '###..', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '###..', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  J: ['....#', '....#', '....#', '....#', '....#', '#...#', '.###.'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#.#.#', '#..##', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '#.#.#', '.#.#.'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  '=': ['.....', '.....', '#####', '.....', '#####', '.....', '.....'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  '_': ['.....', '.....', '.....', '.....', '.....', '.....', '#####'],
  // 标点（分享地址 / 提示行用）：句点与冒号取 2×2 方点，与粗块像素字观感一致。
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  ':': ['.....', '.##..', '.##..', '.....', '.##..', '.##..', '.....'],
  '/': ['....#', '....#', '...#.', '..#..', '.#...', '#....', '#....'],
  '?': ['.###.', '#...#', '....#', '..##.', '..#..', '.....', '..#..'],
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
// 智能坦克专属出生闪光：沿用相同轮廓与节奏，把金白色替换为霓虹青 / 青蓝。
const SMART_SPAWN_STAR_FRAMES_ART: string[][] = SPAWN_STAR_FRAMES_ART.map((rows) =>
  recolor(rows, { w: '7', Y: '8' }),
);

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

// ── 道具图标（16×16 逻辑 = 32×32 美术）──
// 经典观感：立体“卡片”（左上浅灰高光斜角、右下深灰阴影、黑色面板）+ 各具标志性的符号。
// 用简易像素绘图原语在 32×32 字符网格上作画（'.' 透明），再叠加到卡片上。
type CharGrid = string[][];
function blankGrid(size: number): CharGrid {
  return Array.from({ length: size }, () => new Array<string>(size).fill('.'));
}
function gridToRows(g: CharGrid): string[] {
  return g.map((r) => r.join(''));
}
function fillRectG(g: CharGrid, x0: number, y0: number, x1: number, y1: number, ch: string): void {
  for (let y = Math.max(0, y0); y <= Math.min(g.length - 1, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(g[0].length - 1, x1); x++) g[y][x] = ch;
  }
}
function fillCircleG(g: CharGrid, cx: number, cy: number, r: number, ch: string): void {
  for (let y = 0; y < g.length; y++) {
    for (let x = 0; x < g[0].length; x++) {
      if (Math.hypot(x - cx, y - cy) <= r) g[y][x] = ch;
    }
  }
}
function ringG(g: CharGrid, cx: number, cy: number, rOut: number, rIn: number, ch: string): void {
  for (let y = 0; y < g.length; y++) {
    for (let x = 0; x < g[0].length; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= rOut && d >= rIn) g[y][x] = ch;
    }
  }
}
// 点是否在多边形内（射线法）。
function pointInPoly(pts: Array<[number, number]>, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// 叠加：top 中非透明像素覆盖 base。
function overlayG(base: CharGrid, top: CharGrid): CharGrid {
  return base.map((row, y) => row.map((ch, x) => (top[y][x] === '.' ? ch : top[y][x])));
}
// 卡片底：2px 外黑边 + 左上 2px 浅灰高光斜角 + 右下 2px 深灰阴影斜角 + 黑色面板。
function powerupCard(): CharGrid {
  const g = blankGrid(32);
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      let ch = 'e';
      if (x < 2 || y < 2 || x >= 30 || y >= 30) ch = 'e';
      else if (x < 4 || y < 4) ch = 'c';
      else if (x >= 28 || y >= 28) ch = 'a';
      g[y][x] = ch;
    }
  }
  return g;
}
// star：5 角黄星（多边形填充，顶点朝上）。
function starSym(): CharGrid {
  const g = blankGrid(32);
  const cx = 15.5;
  const cy = 16.5;
  const rOut = 12;
  const rIn = 5;
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? rOut : rIn;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) if (pointInPoly(pts, x + 0.5, y + 0.5)) g[y][x] = 'Y';
  }
  return g;
}
// grenade：深绿菠萝手雷剪影 + 灰顶盖 / 拉环。
function grenadeSym(): CharGrid {
  const g = blankGrid(32);
  fillCircleG(g, 16, 20, 8, 'g'); // 弹体
  fillCircleG(g, 13, 17, 3, 'G'); // 高光
  fillRectG(g, 13, 8, 19, 12, 'a'); // 顶盖
  fillRectG(g, 18, 6, 24, 8, 'c'); // 拉环杆
  ringG(g, 25, 7, 3, 1.5, 'c'); // 拉环
  return g;
}
// tank：黄色迷你坦克（履带 + 车体 + 炮塔 + 炮管，朝上）。
function tankSym(): CharGrid {
  const g = blankGrid(32);
  fillRectG(g, 6, 12, 10, 26, 'y'); // 左履带
  fillRectG(g, 22, 12, 26, 26, 'y'); // 右履带
  fillRectG(g, 10, 15, 22, 26, 'Y'); // 车体
  fillRectG(g, 13, 10, 19, 17, 'Y'); // 炮塔
  fillRectG(g, 15, 4, 17, 12, 'y'); // 炮管
  return g;
}
// timer：钟面（白盘灰边）+ 时 / 分指针 + 轴心 + 顶部按钮。
function timerSym(): CharGrid {
  const g = blankGrid(32);
  fillCircleG(g, 16, 17, 11, 'w'); // 表盘
  ringG(g, 16, 17, 11, 9, 'c'); // 灰边圈
  fillRectG(g, 15, 10, 16, 17, 'e'); // 时针（上）
  fillRectG(g, 16, 16, 22, 17, 'e'); // 分针（右）
  fillCircleG(g, 16, 17, 1.6, 'a'); // 轴心
  fillRectG(g, 14, 2, 18, 5, 'c'); // 顶部按钮
  return g;
}
// shovel：木柄 + T 型握把 + 金属梯形铲头。
function shovelSym(): CharGrid {
  const g = blankGrid(32);
  fillRectG(g, 14, 5, 18, 18, 'z'); // 手柄
  fillRectG(g, 10, 4, 22, 7, 'z'); // T 型握把
  for (let y = 18; y <= 27; y++) {
    const inset = Math.floor((y - 18) * 0.7);
    fillRectG(g, 9 + inset, y, 23 - inset, y, 'c'); // 梯形铲头（逐行收窄）
  }
  return g;
}
// helmet：圆顶头盔（上半圆）+ 帽檐 + 高光。
function helmetSym(): CharGrid {
  const g = blankGrid(32);
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      if (Math.hypot(x - 16, y - 19) <= 11 && y <= 19) g[y][x] = 'c';
    }
  }
  fillRectG(g, 4, 19, 28, 22, 'b'); // 帽檐
  fillCircleG(g, 13, 14, 3, 'w'); // 高光
  return g;
}
// 武器道具：卡片内叠画一个放大的像素字母（S / F / L / M），沿用 FONT 的 5×7 掩码，
// 按 scale 逐点放大后居中于 32×32 卡片。四种武器各用一色，与 HUD 字母配色一致。
function letterSym(ch: string, scale: number, color: string): CharGrid {
  const g = blankGrid(32);
  const glyph = FONT[ch];
  if (!glyph) return g;
  const ox = Math.round((32 - 5 * scale) / 2);
  const oy = Math.round((32 - 7 * scale) / 2);
  for (let gy = 0; gy < glyph.length; gy++) {
    const line = glyph[gy];
    for (let gx = 0; gx < line.length; gx++) {
      if (line[gx] !== '#') continue;
      const x0 = ox + gx * scale;
      const y0 = oy + gy * scale;
      fillRectG(g, x0, y0, x0 + scale - 1, y0 + scale - 1, color);
    }
  }
  return g;
}
const WEAPON_LETTER_SCALE = 4; // 5×7 掩码 ×4 = 20×28，正好落在 32×32 卡片的黑色面板内

// boots 快靴：侧视皮靴（暗黄革面 + 灰鞋底）+ 左侧三道白色速度线，一眼即“跑得快”。
function bootsSym(): CharGrid {
  const g = blankGrid(32);
  fillRectG(g, 13, 5, 20, 21, 'z'); // 靴筒
  fillRectG(g, 13, 5, 15, 21, 'd'); // 靴筒暗侧
  fillRectG(g, 13, 18, 27, 24, 'z'); // 靴面（脚背 → 鞋头）
  fillRectG(g, 16, 18, 27, 20, 'h'); // 靴面高光
  fillRectG(g, 12, 25, 27, 27, 'c'); // 鞋底
  fillRectG(g, 4, 8, 11, 9, 'w'); // 速度线 ×3（收在面板内，不压卡片斜角）
  fillRectG(g, 6, 14, 12, 15, 'w');
  fillRectG(g, 4, 20, 11, 21, 'w');
  return g;
}
// boat 船：白帆 + 灰桅杆 + 木色梯形船身 + 蓝色水波，明示“能下水”。
function boatSym(): CharGrid {
  const g = blankGrid(32);
  for (let y = 5; y <= 18; y++) {
    fillRectG(g, 16, y, 16 + Math.floor((y - 5) * 0.7), y, 'w'); // 三角帆
  }
  fillRectG(g, 14, 4, 15, 19, 'c'); // 桅杆
  for (let y = 20; y <= 24; y++) {
    const inset = y - 20;
    fillRectG(g, 5 + inset, y, 26 - inset, y, y <= 21 ? 'z' : 'd'); // 梯形船身
  }
  fillRectG(g, 4, 26, 27, 27, 'i'); // 水面
  fillRectG(g, 5, 25, 11, 25, 'l'); // 浪花
  fillRectG(g, 19, 25, 26, 25, 'l');
  return g;
}
// ghost 幽灵：白色圆顶身躯 + 波浪下摆（镂空到黑底）+ 黑眼，右侧一道冷色阴影。
function ghostSym(): CharGrid {
  const g = blankGrid(32);
  fillCircleG(g, 16, 14, 9, 'w'); // 圆顶
  fillRectG(g, 7, 14, 25, 26, 'w'); // 身躯
  fillRectG(g, 22, 15, 25, 23, 'p'); // 右侧冷色阴影
  fillRectG(g, 9, 24, 12, 26, '.'); // 波浪下摆（三个凹口）
  fillRectG(g, 16, 25, 19, 26, '.');
  fillRectG(g, 23, 24, 25, 26, '.');
  fillCircleG(g, 12, 13, 2.4, 'e'); // 双眼
  fillCircleG(g, 20, 13, 2.4, 'e');
  return g;
}
// hourglass 沙漏：灰上下框 + 白玻璃双三角 + 黄沙（上半剩余 / 细流 / 下半堆积）。
function hourglassSym(): CharGrid {
  const g = blankGrid(32);
  fillRectG(g, 6, 3, 25, 6, 'c'); // 顶框
  fillRectG(g, 6, 25, 25, 27, 'c'); // 底框
  for (let y = 7; y <= 15; y++) fillRectG(g, 8 + (y - 7), y, 23 - (y - 7), y, 'w'); // 上玻璃
  for (let y = 16; y <= 24; y++) fillRectG(g, 8 + (24 - y), y, 23 - (24 - y), y, 'w'); // 下玻璃
  for (let y = 8; y <= 12; y++) fillRectG(g, 9 + (y - 7), y, 22 - (y - 7), y, 'Y'); // 上半余沙
  for (let y = 20; y <= 24; y++) fillRectG(g, 9 + (24 - y), y, 22 - (24 - y), y, 'Y'); // 下半积沙
  fillRectG(g, 15, 13, 16, 21, 'Y'); // 细流
  return g;
}
// wrench 扳手：银色开口钳头（环 + 朝上的缺口）+ 竖直手柄，对应“修墙”。
function wrenchSym(): CharGrid {
  const g = blankGrid(32);
  fillRectG(g, 13, 11, 19, 27, 'c'); // 手柄
  fillRectG(g, 13, 11, 14, 27, 'w'); // 手柄高光
  fillCircleG(g, 16, 10, 8, 'c'); // 钳头外圆
  fillCircleG(g, 16, 10, 4.2, '.'); // 内孔
  fillRectG(g, 13, 0, 19, 10, '.'); // 朝上的开口
  fillCircleG(g, 10, 6, 1.8, 'w'); // 高光
  return g;
}

const POWERUP_SYMBOLS: Record<PowerupKind, CharGrid> = {
  star: starSym(),
  grenade: grenadeSym(),
  tank: tankSym(),
  timer: timerSym(),
  shovel: shovelSym(),
  helmet: helmetSym(),
  wpnSpread: letterSym('S', WEAPON_LETTER_SCALE, 'Y'), // 黄
  wpnSpiral: letterSym('F', WEAPON_LETTER_SCALE, '2'), // 橙红
  wpnLaser: letterSym('L', WEAPON_LETTER_SCALE, 'I'), // 亮青
  wpnMachine: letterSym('M', WEAPON_LETTER_SCALE, 'A'), // 亮绿
  boots: bootsSym(),
  boat: boatSym(),
  ghost: ghostSym(),
  hourglass: hourglassSym(),
  wrench: wrenchSym(),
  // 钻头：沿用武器道具的“盒底板 + 放大字母”画法，取钢色银灰 —— 一眼联想到“能钻穿钢块”。
  drill: letterSym('D', WEAPON_LETTER_SCALE, 'c'), // 银灰
};
const POWERUP_ICON_ROWS: Record<PowerupKind, string[]> = POWERUP_KINDS.reduce(
  (acc, kind) => {
    acc[kind] = assertGrid(
      gridToRows(overlayG(powerupCard(), POWERUP_SYMBOLS[kind])),
      32,
      32,
      `powerup-${kind}`,
    );
    return acc;
  },
  {} as Record<PowerupKind, string[]>,
);

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
  playerTank: TankFrames[][]; // [playerIndex][level]：四套配色 × 四等级 × 四朝向 × 两帧
  playerTankHit: TankFrames[]; // 按等级索引的受击白闪剪影
  enemyTank: {
    basic: TankFrames;
    fast: TankFrames;
    power: TankFrames;
    armor: TankFrames; // 常态银色
    smart: TankFrames;
    armorFlash: TankFrames; // 受损白闪变体
  };
  enemyTankRed: {
    basic: TankFrames;
    fast: TankFrames;
    power: TankFrames;
    armor: TankFrames;
    smart: TankFrames;
  }; // 携带道具敌军红闪变体（各种类）
  powerup: Record<PowerupKind, Sprite>; // 各种道具图标（16×16 逻辑）
  bullet: Sprite;
  bulletSpiral: Sprite; // 双螺旋炎爆弹的单颗火球（4×4 逻辑）
  bulletLaser: Record<Direction, Sprite>; // 激光细长条（8×8 逻辑，四朝向）
  spawnStar: [Sprite, Sprite, Sprite, Sprite]; // 出生闪光 4 帧（32×32）
  spawnStarSmart: [Sprite, Sprite, Sprite, Sprite]; // 智能坦克青蓝出生闪光
  shield: [Sprite, Sprite]; // 出生护盾 2 帧（32×32）
  explosionSmall: [Sprite, Sprite, Sprite]; // 小爆炸 3 帧（32×32）
  explosionBig: [Sprite, Sprite]; // 大爆炸 2 帧（64×64）
  boss: Array<Record<Direction, Sprite>>; // Boss 车体（32×32 逻辑）：索引 0=阶段1、1=阶段2
  bossFlash: Record<Direction, Sprite>; // Boss 受击白闪帧
  bossMine: Sprite[]; // Boss 地雷（8×8 逻辑）：索引 0=未武装、1=已武装（闪红相）
  hudEnemy: Sprite; // HUD 剩余敌军小坦克（16×16）
  hudLifeTank: Sprite[]; // HUD 玩家生命迷你坦克（16×16），按 playerIndex 着色
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
// 追加的玩家坦克行（P1 复用 Y_PLAYER；P2/P3/P4 附在图集底部，避免打乱既有偏移）。
const Y_PLAYER2 = 336;
const Y_PLAYER3 = 368;
const Y_PLAYER4 = 400;
// 各 playerIndex 对应的图集行 y 偏移。
const PLAYER_ROW_Y = [Y_PLAYER, Y_PLAYER2, Y_PLAYER3, Y_PLAYER4];
// 携带道具敌军红闪变体行（各 32 高，附在图集底部）。
const Y_RED_BASIC = 432;
const Y_RED_FAST = 464;
const Y_RED_POWER = 496;
const Y_RED_ARMOR = 528;
// 智能型常态 / 红闪行追加在既有图集之后，避免改动旧精灵偏移。
const Y_SMART = 560;
const Y_RED_SMART = 592;
// 道具图标行（POWERUP_KINDS.length 个 32×32，x=0/32/…）。
const Y_POWERUP = 624;
const Y_SMART_SPAWN = 656;
// Boss 行（各 64 高、四朝向 × 64 宽 = 256）：阶段 1 / 阶段 2 / 受击白闪。
const Y_BOSS_P1 = 688;
const Y_BOSS_P2 = 752;
const Y_BOSS_FLASH = 816;
// 玩家升级行追加在既有图集末尾：每位玩家补 1/2/3 级三行，随后四行受击白闪。
const Y_PLAYER_LEVEL_EXTRA = 880;
const PLAYER_LEVEL_ROW_Y = PLAYER_ROW_Y.map((base, playerIndex) => [
  base,
  Y_PLAYER_LEVEL_EXTRA + (playerIndex * 3) * 32,
  Y_PLAYER_LEVEL_EXTRA + (playerIndex * 3 + 1) * 32,
  Y_PLAYER_LEVEL_EXTRA + (playerIndex * 3 + 2) * 32,
]);
const Y_PLAYER_HIT = Y_PLAYER_LEVEL_EXTRA + 12 * 32;
const PLAYER_HIT_ROW_Y = [0, 1, 2, 3].map((level) => Y_PLAYER_HIT + level * 32);

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

// 把 Boss 的朝上帧铺到某一行：旋转生成其余朝向，按 up,down,left,right 排布。
function paintBossRow(ctx: CanvasRenderingContext2D, up: string[], y: number): void {
  const right = rotateCW(up);
  const down = rotateCW(right);
  const left = rotateCW(down);
  paint(ctx, up, 0, y);
  paint(ctx, down, BOSS_ART, y);
  paint(ctx, left, BOSS_ART * 2, y);
  paint(ctx, right, BOSS_ART * 3, y);
}

// 取某 Boss 行的四朝向取样矩形（64×64 美术 = 32×32 逻辑）。
function bossFramesAt(canvas: HTMLCanvasElement, y: number): Record<Direction, Sprite> {
  const s = (sx: number): Sprite => ({ src: canvas, sx, sy: y, w: BOSS_ART, h: BOSS_ART });
  return { up: s(0), down: s(BOSS_ART), left: s(BOSS_ART * 2), right: s(BOSS_ART * 3) };
}

// 启动时调用一次，构建离屏图集并返回带取样矩形的 API。
export function createSpriteAtlas(): SpriteAtlas {
  // 宽度需容下最宽的一行：道具图标行（POWERUP_KINDS.length 个 32×32 —— 6 经典 + 4 武器 + 5 新道具）。
  // 其余行最宽为坦克行（8 帧 × 32 = 256），故按两者取大。
  // Boss 行需要 4 朝向 × 64 = 256；道具图标行为 POWERUP_KINDS.length × 32；坦克行 256。
  const width = Math.max(256, BOSS_ART * 4, POWERUP_KINDS.length * 32);
  const height = Y_PLAYER_HIT + 4 * 32;
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
  // 四套玩家生命迷你坦克：x=112/128/144/160。
  for (let i = 0; i < HUD_LIFE_TANKS.length; i++) {
    paint(ctx, HUD_LIFE_TANKS[i], 112 + i * 16, Y_TERRAIN);
  }

  // 鹰巢行（32×32）+ 子弹（8×8）+ 炎爆火球（8×8）+ 激光四朝向（各 16×16）
  paint(ctx, EAGLE, 0, Y_EAGLE);
  paint(ctx, EAGLE_DESTROYED, 32, Y_EAGLE);
  paint(ctx, HUD_FLAG, 64, Y_EAGLE);
  paint(ctx, BULLET, 96, Y_EAGLE);
  paint(ctx, BULLET_SPIRAL, 104, Y_EAGLE);
  // 激光：朝上帧 + 逐次 rotateCW 得右 / 下 / 左，排布于 x=112/128/144/160。
  const laserUp = BULLET_LASER_UP;
  const laserRight = rotateCW(laserUp);
  const laserDown = rotateCW(laserRight);
  const laserLeft = rotateCW(laserDown);
  paint(ctx, laserUp, 112, Y_EAGLE);
  paint(ctx, laserRight, 128, Y_EAGLE);
  paint(ctx, laserDown, 144, Y_EAGLE);
  paint(ctx, laserLeft, 160, Y_EAGLE);
  // Boss 地雷两帧（未武装 / 武装）：x=176 / 192，各 16×16 美术 = 8×8 逻辑。
  paint(ctx, MINE, 176, Y_EAGLE);
  paint(ctx, MINE_ARMED, 192, Y_EAGLE);

  // 玩家坦克：四套玩家配色 × 四级逐步增强的剪影。
  for (let i = 0; i < MAP_PLAYERS.length; i++) {
    const map = MAP_PLAYERS[i];
    for (let level = 0; level < TANK_PLAYER_LEVELS.length; level++) {
      const template = TANK_PLAYER_LEVELS[level];
      paintTankRow(
        ctx,
        recolor(template, map),
        recolor(swapTreads(template), map),
        PLAYER_LEVEL_ROW_Y[i][level],
      );
    }
  }
  for (let level = 0; level < TANK_PLAYER_LEVELS.length; level++) {
    const template = TANK_PLAYER_LEVELS[level];
    paintTankRow(
      ctx,
      recolor(template, MAP_PLAYER_HIT),
      recolor(swapTreads(template), MAP_PLAYER_HIT),
      PLAYER_HIT_ROW_Y[level],
    );
  }

  // 敌方坦克各行：五种独立剪影 + 履带第二帧。
  paintTankRow(ctx, recolor(TANK_BASIC, MAP_BASIC), recolor(swapTreads(TANK_BASIC), MAP_BASIC), Y_BASIC);
  paintTankRow(ctx, recolor(TANK_FAST_HD, MAP_BASIC), recolor(swapTreads(TANK_FAST_HD), MAP_BASIC), Y_FAST);
  paintTankRow(ctx, recolor(TANK_POWER, MAP_POWER), recolor(swapTreads(TANK_POWER), MAP_POWER), Y_POWER);
  paintTankRow(ctx, recolor(TANK_ARMOR_HD, MAP_ARMOR), recolor(swapTreads(TANK_ARMOR_HD), MAP_ARMOR), Y_ARMOR);
  paintTankRow(ctx, recolor(TANK_SMART, MAP_SMART), recolor(swapTreads(TANK_SMART), MAP_SMART), Y_SMART);
  paintTankRow(
    ctx,
    recolor(TANK_ARMOR_HD, MAP_ARMOR_FLASH),
    recolor(swapTreads(TANK_ARMOR_HD), MAP_ARMOR_FLASH),
    Y_ARMOR_FLASH,
  );

  // 携带道具敌军红闪变体：各种类沿用其模板（basic/power=STD，fast=FAST，armor=ARMOR），统一红色映射。
  paintTankRow(ctx, recolor(TANK_BASIC, MAP_ENEMY_RED), recolor(swapTreads(TANK_BASIC), MAP_ENEMY_RED), Y_RED_BASIC);
  paintTankRow(ctx, recolor(TANK_FAST_HD, MAP_ENEMY_RED), recolor(swapTreads(TANK_FAST_HD), MAP_ENEMY_RED), Y_RED_FAST);
  paintTankRow(ctx, recolor(TANK_POWER, MAP_ENEMY_RED), recolor(swapTreads(TANK_POWER), MAP_ENEMY_RED), Y_RED_POWER);
  paintTankRow(ctx, recolor(TANK_ARMOR_HD, MAP_ENEMY_RED), recolor(swapTreads(TANK_ARMOR_HD), MAP_ENEMY_RED), Y_RED_ARMOR);
  paintTankRow(ctx, recolor(TANK_SMART, MAP_ENEMY_RED), recolor(swapTreads(TANK_SMART), MAP_ENEMY_RED), Y_RED_SMART);

  // Boss 三行：阶段 1（钢蓝）/ 阶段 2（血红）/ 受击白闪，各四朝向。
  paintBossRow(ctx, recolor(BOSS_TEMPLATE, MAP_BOSS_P1), Y_BOSS_P1);
  paintBossRow(ctx, recolor(BOSS_TEMPLATE, MAP_BOSS_P2), Y_BOSS_P2);
  paintBossRow(ctx, recolor(BOSS_TEMPLATE, MAP_BOSS_FLASH), Y_BOSS_FLASH);

  // 道具图标行：按 POWERUP_KINDS 顺序铺于 x=0,32,…。
  POWERUP_KINDS.forEach((kind, i) => paint(ctx, POWERUP_ICON_ROWS[kind], i * 32, Y_POWERUP));

  // 特效行：出生星 4 帧（32）+ 小爆炸 3 帧（32）
  paint(ctx, SPAWN_STAR_FRAMES_ART[0], 0, Y_FX);
  paint(ctx, SPAWN_STAR_FRAMES_ART[1], 32, Y_FX);
  paint(ctx, SPAWN_STAR_FRAMES_ART[2], 64, Y_FX);
  paint(ctx, SPAWN_STAR_FRAMES_ART[3], 96, Y_FX);
  paint(ctx, EXPLOSION_SMALL_FRAMES_ART[0], 128, Y_FX);
  paint(ctx, EXPLOSION_SMALL_FRAMES_ART[1], 160, Y_FX);
  paint(ctx, EXPLOSION_SMALL_FRAMES_ART[2], 192, Y_FX);
  // 智能坦克专属青蓝出生闪光，单独占一行以保留原版金白动画给其他坦克。
  paint(ctx, SMART_SPAWN_STAR_FRAMES_ART[0], 0, Y_SMART_SPAWN);
  paint(ctx, SMART_SPAWN_STAR_FRAMES_ART[1], 32, Y_SMART_SPAWN);
  paint(ctx, SMART_SPAWN_STAR_FRAMES_ART[2], 64, Y_SMART_SPAWN);
  paint(ctx, SMART_SPAWN_STAR_FRAMES_ART[3], 96, Y_SMART_SPAWN);
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
    playerTank: PLAYER_LEVEL_ROW_Y.map((rows) => rows.map((y) => tankFramesAt(canvas, y))),
    playerTankHit: PLAYER_HIT_ROW_Y.map((y) => tankFramesAt(canvas, y)),
    enemyTank: {
      basic: tankFramesAt(canvas, Y_BASIC),
      fast: tankFramesAt(canvas, Y_FAST),
      power: tankFramesAt(canvas, Y_POWER),
      armor: tankFramesAt(canvas, Y_ARMOR),
      smart: tankFramesAt(canvas, Y_SMART),
      armorFlash: tankFramesAt(canvas, Y_ARMOR_FLASH),
    },
    enemyTankRed: {
      basic: tankFramesAt(canvas, Y_RED_BASIC),
      fast: tankFramesAt(canvas, Y_RED_FAST),
      power: tankFramesAt(canvas, Y_RED_POWER),
      armor: tankFramesAt(canvas, Y_RED_ARMOR),
      smart: tankFramesAt(canvas, Y_RED_SMART),
    },
    powerup: POWERUP_KINDS.reduce(
      (acc, kind, i) => {
        acc[kind] = s(i * 32, Y_POWERUP, 32, 32);
        return acc;
      },
      {} as Record<PowerupKind, Sprite>,
    ),
    bullet: s(96, Y_EAGLE, 8, 8),
    bulletSpiral: s(104, Y_EAGLE, 8, 8),
    bulletLaser: {
      up: s(112, Y_EAGLE, 16, 16),
      right: s(128, Y_EAGLE, 16, 16),
      down: s(144, Y_EAGLE, 16, 16),
      left: s(160, Y_EAGLE, 16, 16),
    },
    spawnStar: [
      s(0, Y_FX, 32, 32),
      s(32, Y_FX, 32, 32),
      s(64, Y_FX, 32, 32),
      s(96, Y_FX, 32, 32),
    ],
    spawnStarSmart: [
      s(0, Y_SMART_SPAWN, 32, 32),
      s(32, Y_SMART_SPAWN, 32, 32),
      s(64, Y_SMART_SPAWN, 32, 32),
      s(96, Y_SMART_SPAWN, 32, 32),
    ],
    shield: [s(128, Y_BIG, 32, 32), s(160, Y_BIG, 32, 32)],
    explosionSmall: [s(128, Y_FX, 32, 32), s(160, Y_FX, 32, 32), s(192, Y_FX, 32, 32)],
    explosionBig: [s(0, Y_BIG, 64, 64), s(64, Y_BIG, 64, 64)],
    boss: [bossFramesAt(canvas, Y_BOSS_P1), bossFramesAt(canvas, Y_BOSS_P2)],
    bossFlash: bossFramesAt(canvas, Y_BOSS_FLASH),
    bossMine: [s(176, Y_EAGLE, 16, 16), s(192, Y_EAGLE, 16, 16)],
    hudEnemy: s(96, Y_TERRAIN, 16, 16),
    hudLifeTank: HUD_LIFE_TANKS.map((_, i) => s(112 + i * 16, Y_TERRAIN, 16, 16)),
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
  paintText(ctx, atlas, text, x, y, color, 0, 0);
}

// 在美术像素级偏移下绘制字形。偏移不经过逻辑坐标换算，专供 1 美术像素描边使用。
function paintText(
  ctx: CanvasRenderingContext2D,
  atlas: SpriteAtlas,
  text: string,
  x: number,
  y: number,
  color: string,
  artOffsetX: number,
  artOffsetY: number,
): void {
  ctx.fillStyle = color;
  for (let i = 0; i < text.length; i++) {
    const glyph = atlas.font[text[i]];
    if (!glyph) continue;
    const gx0 = (x + i * FONT_ADVANCE) * ART_SCALE + artOffsetX;
    const gy0 = y * ART_SCALE + artOffsetY;
    for (let gy = 0; gy < glyph.length; gy++) {
      const line = glyph[gy];
      for (let gc = 0; gc < line.length; gc++) {
        if (line[gc] === '#') ctx.fillRect(gx0 + gc * ART_SCALE, gy0 + gy * ART_SCALE, ART_SCALE, ART_SCALE);
      }
    }
  }
}

// 1 美术像素八向硬描边。没有模糊/抗锯齿，专门用于复杂地形上的提示和小字号菜单。
export function drawTextOutlined(
  ctx: CanvasRenderingContext2D,
  atlas: SpriteAtlas,
  text: string,
  x: number,
  y: number,
  color = '#ffffff',
  outline = '#050706',
): void {
  const offsets: ReadonlyArray<readonly [number, number]> = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0], [1, 0],
    [-1, 1], [0, 1], [1, 1],
  ];
  for (const [dx, dy] of offsets) paintText(ctx, atlas, text, x, y, outline, dx, dy);
  paintText(ctx, atlas, text, x, y, color, 0, 0);
}

function paintScaledText(
  ctx: CanvasRenderingContext2D,
  atlas: SpriteAtlas,
  text: string,
  x: number,
  y: number,
  scale: number,
  color: string,
  artOffsetX: number,
  artOffsetY: number,
): void {
  const block = ART_SCALE * scale;
  ctx.fillStyle = color;
  for (let i = 0; i < text.length; i++) {
    const glyph = atlas.font[text[i]];
    if (!glyph) continue;
    const gx0 = (x + i * FONT_ADVANCE * scale) * ART_SCALE + artOffsetX;
    const gy0 = y * ART_SCALE + artOffsetY;
    for (let gy = 0; gy < glyph.length; gy++) {
      for (let gc = 0; gc < glyph[gy].length; gc++) {
        if (glyph[gy][gc] === '#') ctx.fillRect(gx0 + gc * block, gy0 + gy * block, block, block);
      }
    }
  }
}

// 结果/暂停标题使用的倍增描边字。scale 只取整数，所有方块仍严格落在美术像素网格。
export function drawTextScaledOutlined(
  ctx: CanvasRenderingContext2D,
  atlas: SpriteAtlas,
  text: string,
  x: number,
  y: number,
  scale: number,
  color = '#ffffff',
  outline = '#050706',
): void {
  const offsets: ReadonlyArray<readonly [number, number]> = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0], [1, 0],
    [-1, 1], [0, 1], [1, 1],
  ];
  for (const [dx, dy] of offsets) paintScaledText(ctx, atlas, text, x, y, scale, outline, dx, dy);
  paintScaledText(ctx, atlas, text, x, y, scale, color, 0, 0);
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

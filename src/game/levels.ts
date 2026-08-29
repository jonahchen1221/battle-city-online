import {
  FIELD_COLS,
  FIELD_ROWS,
  BRICK_FULL,
  SUBTILE,
  stageGroup,
} from '../core/constants';
import { Cell, CellType, LevelState, getCell, setCell } from './level';

// 关卡文本格式：FIELD_ROWS 行 × FIELD_COLS 字符。
//   . = 空地   B = 砖块   S = 钢块   W = 水   T = 树林   I = 冰   E = 鹰巢
const CHAR_TO_CELL: Record<string, CellType> = {
  '.': Cell.EMPTY,
  B: Cell.BRICK,
  S: Cell.STEEL,
  W: Cell.WATER,
  T: Cell.TREES,
  I: Cell.ICE,
  E: Cell.EAGLE,
};

export function parseLevel(rows: string[]): LevelState {
  if (rows.length !== FIELD_ROWS) {
    throw new Error(`Level must have ${FIELD_ROWS} rows, got ${rows.length}`);
  }
  const cells: CellType[] = new Array<CellType>(FIELD_COLS * FIELD_ROWS);
  const brickMask: number[] = new Array<number>(FIELD_COLS * FIELD_ROWS).fill(0);

  for (let row = 0; row < FIELD_ROWS; row++) {
    const line = rows[row];
    if (line.length !== FIELD_COLS) {
      throw new Error(`Row ${row} must have ${FIELD_COLS} chars, got ${line.length}`);
    }
    for (let col = 0; col < FIELD_COLS; col++) {
      const ch = line[col];
      const type = CHAR_TO_CELL[ch];
      if (type === undefined) {
        throw new Error(`Unknown map char '${ch}' at ${col},${row}`);
      }
      const idx = row * FIELD_COLS + col;
      cells[idx] = type;
      if (type === Cell.BRICK) {
        brickMask[idx] = BRICK_FULL;
      }
    }
  }

  return { cols: FIELD_COLS, rows: FIELD_ROWS, cells, brickMask, rev: 0 };
}

// 十张普通关地形（对应十个循环组）。全部 40×30 子格（20×15 大格），对称设计，逐组地形更丰富。
// 普通关共同约束：鹰巢（列 19-20 行 28-29）+ 经典 1 子格厚砖墙护盾
//（列 18-21 行 27 / 列 18,21 行 28-29）；顶部两行（0-1）全空供敌军出生；
// 底部玩家出生列（6/14/24/32）在行 28-29 留空。
// Boss 竞技场（每组第 3 关）的差异见文件末尾：无鹰巢，且各自配置地形、Boss / 玩家入场点与阶段变化。
// 命名的数字是“第几张普通图”（= 组号 t），对应关号为 4t-3：STAGE_1 → 第 1 关、STAGE_10 → 第 37 关。

// 第 1 张（第 1 关）：经典竖直砖柱走廊 —— 9 对 2 子格宽砖柱成上、中两带；正中 2×2 钢块，两侧各一段横向砖墙。
// prettier-ignore
export const STAGE_1_ROWS = [ // 经典第 1 关
  '........................................', // 0
  '........................................', // 1
  '...BB..BB..BB..BB..BB..BB..BB..BB..BB...', // 2
  '...BB..BB..BB..BB..BB..BB..BB..BB..BB...', // 3
  '...BB..BB..BB..BB..BB..BB..BB..BB..BB...', // 4
  '...BB..BB..BB..BB..BB..BB..BB..BB..BB...', // 5
  '...BB..BB..BB..BB..BB..BB..BB..BB..BB...', // 6
  '...BB..BB..BB..BB..BB..BB..BB..BB..BB...', // 7
  '...BB..BB..BB..BB..BB..BB..BB..BB..BB...', // 8
  '...BB..BB..BB..BB..BB..BB..BB..BB..BB...', // 9
  '........................................', // 10
  '........................................', // 11
  '...BB..BB..BB..BB..BB..BB..BB..BB..BB...', // 12
  '...BB..BB..BB..BB..BB..BB..BB..BB..BB...', // 13
  '...BB..BB..BB..BB..BB..BB..BB..BB..BB...', // 14
  '...BB..BB..BB..BB..BB..BB..BB..BB..BB...', // 15
  '...BB..BB..BB..BB..BB..BB..BB..BB..BB...', // 16
  '...BB..BB..BB..BB..BB..BB..BB..BB..BB...', // 17
  '...BB..BB..BB..BB..BB..BB..BB..BB..BB...', // 18
  '........................................', // 19
  '........BBBB.......SS.......BBBB........', // 20
  '........BBBB.......SS.......BBBB........', // 21
  '........................................', // 22
  '........................................', // 23
  '........................................', // 24
  '........................................', // 25
  '........................................', // 26
  '..................BBBB..................', // 27
  '..................BEEB..................', // 28
  '..................BEEB..................', // 29
];

// 第 2 张（第 5 关）：砖块迷宫 + 树林簇（坦克可藏身）+ 两块小钢块（列 2-3 / 36-37 行 13-14）。
// prettier-ignore
const STAGE_2_ROWS = [
  '........................................', // 0
  '........................................', // 1
  '..BBBBBB....BBBBBB....BBBBBB....BBBBBB..', // 2
  '..BBBBBB....BBBBBB....BBBBBB....BBBBBB..', // 3
  '........................................', // 4
  '..BB..BB..BB..BB........BB..BB..BB..BB..', // 5
  '..BB..TT..TT..BB........BB..TT..TT..BB..', // 6
  '..BB..TT..TT..BB........BB..TT..TT..BB..', // 7
  '..BB..BB..BB..BB........BB..BB..BB..BB..', // 8
  '........................................', // 9
  'BBBB....BBBB....BBBBBBBB....BBBB....BBBB', // 10
  'BBBB....BBBB....BBBBBBBB....BBBB....BBBB', // 11
  '........................................', // 12
  '..SS......BBBB............BBBB......SS..', // 13
  '..SS......BBBB............BBBB......SS..', // 14
  '........................................', // 15
  '....BB..BB..BB..BB....BB..BB..BB..BB....', // 16
  '....BB..BB..BB..BB....BB..BB..BB..BB....', // 17
  '........................................', // 18
  '........................................', // 19
  '..TT..BBBB....BBBB....BBBB....BBBB..TT..', // 20
  '..TT..BBBB....BBBB....BBBB....BBBB..TT..', // 21
  '........................................', // 22
  '......BB......BB........BB......BB......', // 23
  '......BB......BB........BB......BB......', // 24
  '........................................', // 25
  '........................................', // 26
  '..................BBBB..................', // 27
  '..................BEEB..................', // 28
  '..................BEEB..................', // 29
];

// 第 3 张（第 9 关）：横向水道大河（行 13-14，含 3 座桥：列 8-9 / 18-21 / 30-31）+ 砖块 + 钢块。
// prettier-ignore
const STAGE_3_ROWS = [
  '........................................', // 0
  '........................................', // 1
  '..BBBB....BBBB............BBBB....BBBB..', // 2
  '..BBBB....BBBB............BBBB....BBBB..', // 3
  '........................................', // 4
  '..BB....BB....BB........BB....BB....BB..', // 5
  '..BB....BB....BB........BB....BB....BB..', // 6
  '........................................', // 7
  '....SS........SS........SS........SS....', // 8
  '....SS........SS........SS........SS....', // 9
  '........................................', // 10
  '........................................', // 11
  '........................................', // 12
  'WWWWWWWW..WWWWWWWW....WWWWWWWW..WWWWWWWW', // 13
  'WWWWWWWW..WWWWWWWW....WWWWWWWW..WWWWWWWW', // 14
  '........................................', // 15
  '........................................', // 16
  '..BBBB....BBBB............BBBB....BBBB..', // 17
  '..BBBB....BBBB............BBBB....BBBB..', // 18
  '........................................', // 19
  '......BB....BB............BB....BB......', // 20
  '......BB....BB............BB....BB......', // 21
  '........................................', // 22
  '........................................', // 23
  '....BBBB....BBBB........BBBB....BBBB....', // 24
  '....BBBB....BBBB........BBBB....BBBB....', // 25
  '........................................', // 26
  '..................BBBB..................', // 27
  '..................BEEB..................', // 28
  '..................BEEB..................', // 29
];

// 第 4 张（第 13 关）：正中一大片冰面（列 8-31 行 6-19，坦克在其上滑行）+ 四周砖块结构。
// prettier-ignore
const STAGE_4_ROWS = [
  '........................................', // 0
  '........................................', // 1
  '..BBBB....BBBB............BBBB....BBBB..', // 2
  '..BBBB....BBBB............BBBB....BBBB..', // 3
  '........................................', // 4
  '........................................', // 5
  '..BBBB..IIIIIIIIIIIIIIIIIIIIIIII..BBBB..', // 6
  '..BBBB..IIIIIIIIIIIIIIIIIIIIIIII..BBBB..', // 7
  '........IIIIIIIIIIIIIIIIIIIIIIII........', // 8
  '..BB....IIIIIIIIIIIIIIIIIIIIIIII....BB..', // 9
  '..BB....IIIIIIIIIIIIIIIIIIIIIIII....BB..', // 10
  '........IIIIIIIIIIIIIIIIIIIIIIII........', // 11
  '....BB..IIIIIIIIIIIIIIIIIIIIIIII..BB....', // 12
  '....BB..IIIIIIIIIIIIIIIIIIIIIIII..BB....', // 13
  '........IIIIIIIIIIIIIIIIIIIIIIII........', // 14
  '..BBBB..IIIIIIIIIIIIIIIIIIIIIIII..BBBB..', // 15
  '..BBBB..IIIIIIIIIIIIIIIIIIIIIIII..BBBB..', // 16
  '........IIIIIIIIIIIIIIIIIIIIIIII........', // 17
  '........IIIIIIIIIIIIIIIIIIIIIIII........', // 18
  '........IIIIIIIIIIIIIIIIIIIIIIII........', // 19
  '........................................', // 20
  '..BB....BB....BB........BB....BB....BB..', // 21
  '..BB....BB....BB........BB....BB....BB..', // 22
  '........................................', // 23
  '....BBBB....BBBB........BBBB....BBBB....', // 24
  '....BBBB....BBBB........BBBB....BBBB....', // 25
  '........................................', // 26
  '..................BBBB..................', // 27
  '..................BEEB..................', // 28
  '..................BEEB..................', // 29
];

// 第 5 张（第 17 关）：要塞终局 —— 重钢块 + 砖块，小水沟护城河，少量树林。
// prettier-ignore
const STAGE_5_ROWS = [
  '........................................', // 0
  '........................................', // 1
  'SSSS....SSSS................SSSS....SSSS', // 2
  'SSSS....SSSS................SSSS....SSSS', // 3
  '........................................', // 4
  '..SS..BBBB..SS............SS..BBBB..SS..', // 5
  '..SS..BBBB..SS............SS..BBBB..SS..', // 6
  '........................................', // 7
  '..BBBB..WW..BBBB........BBBB..WW..BBBB..', // 8
  '..BBBB..WW..BBBB........BBBB..WW..BBBB..', // 9
  '........................................', // 10
  // 列 6-7 的钢块改为空地：否则第 7-9 行左右两侧（列 6-7 / 32-33）会被砖 / 钢 / 水围成
  // 死袋，随机落点的敌军一旦生在里面就只能靠随机开火炸砖才出得来。
  '....SS......SSSS........SSSS......SS....', // 11
  '....SS......SSSS........SSSS......SS....', // 12
  '........................................', // 13
  '..TT..SSSS..SSSS........SSSS..SSSS..TT..', // 14
  '..TT..SSSS..SSSS........SSSS..SSSS..TT..', // 15
  '........................................', // 16
  '..BBBB..BB..BBBB........BBBB..BB..BBBB..', // 17
  '..BBBB..BB..BBBB........BBBB..BB..BBBB..', // 18
  '........................................', // 19
  '..SS........SS............SS........SS..', // 20
  '..SS........SS............SS........SS..', // 21
  '........................................', // 22
  '....WW........WW........WW........WW....', // 23
  '....WW........WW........WW........WW....', // 24
  '........................................', // 25
  '..BBBB......BBBB........BBBB......BBBB..', // 26
  '..................BBBB..................', // 27
  '..................BEEB..................', // 28
  '..................BEEB..................', // 29
];

// ── 第 6–10 张普通图（第 16 / 19 / 22 / 25 / 28 关，难度递增的后半程）──
// 共同结构（保证连通性的硬规则）：地形只画在 2 行厚的“墙带”上，墙带之间一律留 2 行整行空的
// “走廊”。16px 坦克恰好占 2 子格，因此整行空走廊必定横向贯通，每条墙带只要留有 ≥2 子格宽的
// 缺口，全图即天然连通、不会出现把敌军困死的死袋（见 test/levels.test.ts 的 BFS 校验）。
// 底部三行沿用经典鹰巢 + 砖环；行 24–26 留空，供玩家在基地前机动。

// 第 6 张（第 21 关）：钢骨阵地 —— 砖带中成对嵌入钢柱（钢块自本关起明显增多），
// 最后一道墙带（行 22-23）把鹰巢正上方封成整片砖墙，进攻只能绕侧翼。
// prettier-ignore
const STAGE_6_ROWS = [
  '........................................', // 0
  '........................................', // 1
  '..BBBB..SSSS..BBBB....BBBB..SSSS..BBBB..', // 2
  '..BBBB..SSSS..BBBB....BBBB..SSSS..BBBB..', // 3
  '........................................', // 4
  '........................................', // 5
  '..SS..BB......BB..SSSS..BB......BB..SS..', // 6
  '..SS..BB......BB..SSSS..BB......BB..SS..', // 7
  '........................................', // 8
  '........................................', // 9
  'BBBB..SSSS..BBBB........BBBB..SSSS..BBBB', // 10
  'BBBB..SSSS..BBBB........BBBB..SSSS..BBBB', // 11
  '........................................', // 12
  '........................................', // 13
  '..SS..BBBB..SS..BBBBBBBB..SS..BBBB..SS..', // 14
  '..SS..BBBB..SS..BBBBBBBB..SS..BBBB..SS..', // 15
  '........................................', // 16
  '........................................', // 17
  '....BBBB..SSSS..BB....BB..SSSS..BBBB....', // 18
  '....BBBB..SSSS..BB....BB..SSSS..BBBB....', // 19
  '........................................', // 20
  '........................................', // 21
  '..SSSS..BBBB..BBBBBBBBBBBB..BBBB..SSSS..', // 22
  '..SSSS..BBBB..BBBBBBBBBBBB..BBBB..SSSS..', // 23
  '........................................', // 24
  '........................................', // 25
  '........................................', // 26
  '..................BBBB..................', // 27
  '..................BEEB..................', // 28
  '..................BEEB..................', // 29
];

// 第 7 张（第 25 关）：断流河谷 —— 两道水路把战场切成三段。
// 主河（行 12-13）留 3 条陆桥（列 4-7 / 18-21 / 32-35）；
// 二号河（行 20-21）只在两侧留口（列 8-13 / 26-31）与主河错开，逼迫南北往返绕行。
// prettier-ignore
const STAGE_7_ROWS = [
  '........................................', // 0
  '........................................', // 1
  '..BBBB....SSSS..BBBBBBBB..SSSS....BBBB..', // 2
  '..BBBB....SSSS..BBBBBBBB..SSSS....BBBB..', // 3
  '........................................', // 4
  '........................................', // 5
  '..BB..BB..BB..BB..BBBB..BB..BB..BB..BB..', // 6
  '..BB..BB..BB..BB..BBBB..BB..BB..BB..BB..', // 7
  '........................................', // 8
  '........................................', // 9
  '........................................', // 10
  '........................................', // 11
  'WWWW....WWWWWWWWWW....WWWWWWWWWW....WWWW', // 12
  'WWWW....WWWWWWWWWW....WWWWWWWWWW....WWWW', // 13
  '........................................', // 14
  '........................................', // 15
  '..BBBB..SS..BBBB........BBBB..SS..BBBB..', // 16
  '..BBBB..SS..BBBB........BBBB..SS..BBBB..', // 17
  '........................................', // 18
  '........................................', // 19
  '..WWWWWW......WWWWWWWWWWWW......WWWWWW..', // 20
  '..WWWWWW......WWWWWWWWWWWW......WWWWWW..', // 21
  '........................................', // 22
  '........................................', // 23
  '....BBBB....BB..BBBBBBBB..BB....BBBB....', // 24
  '....BBBB....BB..BBBBBBBB..BB....BBBB....', // 25
  '........................................', // 26
  '..................BBBB..................', // 27
  '..................BEEB..................', // 28
  '..................BEEB..................', // 29
];

// 第 8 张（第 29 关）：冰原密林 —— 中央一整片冰面（行 4-18）让坦克刹不住车，
// 冰面上散布砖 / 钢障碍与树丛，进出口两侧各有树林遮蔽，视野与走位双重考验。
// prettier-ignore
const STAGE_8_ROWS = [
  '........................................', // 0
  '........................................', // 1
  '..BBBB..TTTT..BBBB....BBBB..TTTT..BBBB..', // 2
  '..BBBB..TTTT..BBBB....BBBB..TTTT..BBBB..', // 3
  '....IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII....', // 4
  '..IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII..', // 5
  '..IIBBIIIITTIIIIIIIIIIIIIIIITTIIIIBBII..', // 6
  '..IIBBIIIITTIIIIIIIIIIIIIIIITTIIIIBBII..', // 7
  '..IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII..', // 8
  '..IISSIIIIIIIISSIIIIIIIISSIIIIIIIISSII..', // 9
  '..IISSIIIIIIIISSIIIIIIIISSIIIIIIIISSII..', // 10
  '..IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII..', // 11
  '..IIIITTIIIITTIIIIIIIIIIIITTIIIITTIIII..', // 12
  '..IIIITTIIIITTIIIIIIIIIIIITTIIIITTIIII..', // 13
  '..IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII..', // 14
  '..IIBBIIIIIIIIBBIIIIIIIIBBIIIIIIIIBBII..', // 15
  '..IIBBIIIIIIIIBBIIIIIIIIBBIIIIIIIIBBII..', // 16
  '..IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII..', // 17
  '....IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII....', // 18
  '........................................', // 19
  '..TT..BBBB....BBBB....BBBB....BBBB..TT..', // 20
  '..TT..BBBB....BBBB....BBBB....BBBB..TT..', // 21
  '........................................', // 22
  '....BBBB..TT..BBBB....BBBB..TT..BBBB....', // 23
  '....BBBB..TT..BBBB....BBBB..TT..BBBB....', // 24
  '........................................', // 25
  '........................................', // 26
  '..................BBBB..................', // 27
  '..................BEEB..................', // 28
  '..................BEEB..................', // 29
];

// 第 9 张（第 33 关）：钢铁迷宫 —— 六道几乎全钢的厚墙，缺口逐层错位且只有 2 子格宽，
// 机动空间被压到最小；普通炮打不穿钢，只能靠走位、满级星或钻头开路。
// prettier-ignore
const STAGE_9_ROWS = [
  '........................................', // 0
  '........................................', // 1
  'SS..SSSS..SSSS..SSSSSSSS..SSSS..SSSS..SS', // 2
  'SS..SSSS..SSSS..SSSSSSSS..SSSS..SSSS..SS', // 3
  '........................................', // 4
  '........................................', // 5
  '..SSSS..SS..SSSS..SSSS..SSSS..SS..SSSS..', // 6
  '..SSSS..SS..SSSS..SSSS..SSSS..SS..SSSS..', // 7
  '........................................', // 8
  '........................................', // 9
  'SSSS..SSSS..SS..SSSSSSSS..SS..SSSS..SSSS', // 10
  'SSSS..SSSS..SS..SSSSSSSS..SS..SSSS..SSSS', // 11
  '........................................', // 12
  '........................................', // 13
  '..SSSS..BBBB..SSSS....SSSS..BBBB..SSSS..', // 14
  '..SSSS..BBBB..SSSS....SSSS..BBBB..SSSS..', // 15
  '........................................', // 16
  '........................................', // 17
  'SSSS..BBBB..SSSS..SSSS..SSSS..BBBB..SSSS', // 18
  'SSSS..BBBB..SSSS..SSSS..SSSS..BBBB..SSSS', // 19
  '........................................', // 20
  '........................................', // 21
  '..SSSS..SS..BBBB..SSSS..BBBB..SS..SSSS..', // 22
  '..SSSS..SS..BBBB..SSSS..BBBB..SS..SSSS..', // 23
  '........................................', // 24
  '........................................', // 25
  '........................................', // 26
  '..................BBBB..................', // 27
  '..................BEEB..................', // 28
  '..................BEEB..................', // 29
];

// 第 10 张（第 37 关）：决战要塞 —— 上半场钢 / 水 / 冰 / 树四种地形混编，
// 鹰巢前是两道封死中路的厚墙（行 18-19 与 22-23，缺口左右错位）外加行 26 的钢顶盖：
// 正上方完全打不进，必须从两翼窄口迂回，是全场最硬的一关。
// prettier-ignore
const STAGE_10_ROWS = [
  '........................................', // 0
  '........................................', // 1
  'SSSS..BBBB..SSSS..BBBB..SSSS..BBBB..SSSS', // 2
  'SSSS..BBBB..SSSS..BBBB..SSSS..BBBB..SSSS', // 3
  '..IIII......IIII........IIII......IIII..', // 4
  '..IIII......IIII........IIII......IIII..', // 5
  '..SS..WWWW..SS..BBBBBBBB..SS..WWWW..SS..', // 6
  '..SS..WWWW..SS..BBBBBBBB..SS..WWWW..SS..', // 7
  '........................................', // 8
  '........................................', // 9
  '..SSSS..BBBB..SSSS....SSSS..BBBB..SSSS..', // 10
  '..SSSS..BBBB..SSSS....SSSS..BBBB..SSSS..', // 11
  '....TT........TT........TT........TT....', // 12
  '....TT........TT........TT........TT....', // 13
  'TT..BBBB..SSSS..BBBBBBBB..SSSS..BBBB..TT', // 14
  'TT..BBBB..SSSS..BBBBBBBB..SSSS..BBBB..TT', // 15
  '........................................', // 16
  '........................................', // 17
  '..BBBB..SSSS..BBBBBBBBBBBB..SSSS..BBBB..', // 18
  '..BBBB..SSSS..BBBBBBBBBBBB..SSSS..BBBB..', // 19
  '........................................', // 20
  '........................................', // 21
  'SSSS..BBBB....BBBBBBBBBBBB....BBBB..SSSS', // 22
  'SSSS..BBBB....BBBBBBBBBBBB....BBBB..SSSS', // 23
  '........................................', // 24
  '........................................', // 25
  '..................SSSS..................', // 26
  '..................BBBB..................', // 27
  '..................BEEB..................', // 28
  '..................BEEB..................', // 29
];

// ── Boss 竞技场（每组第 3 关：3 / 7 / … / 39；第 b 张对应第 b 位 Boss）──
// 与普通关的核心差异：
//   1. **没有鹰巢**（无 E 字符）—— 因而没有“鹰巢被毁”这条败因，过关条件改为击杀 Boss；
//   2. 每张图在 BOSS_ARENA_CONFIGS 中拥有独立的 Boss / 玩家入场点；
//   3. 第 3 / 4 / 7 / 9 张会在 phase 2 永久打开部分地形，改变后半场路线。
//
// 十张竞技场不再追求同一母版上的“掩体递减”，而是各自服务一个主要战术问题：
// 开放弹幕、错列换道、诱导冲撞、可破坏街区、断桥夹击、环形雷道、磁力锚点、
// 纵向换区、阶段迷宫和最终王座。连通性与相邻地图差异由 test/levels.test.ts 校验。

type BossArenaCellChar = '.' | 'B' | 'S' | 'W' | 'T' | 'I';
type BossArenaFill = (
  cell: BossArenaCellChar,
  col: number,
  row: number,
  width: number,
  height: number,
) => void;

interface BossArenaPlacementCells {
  boss: { col: number; row: number };
  players: ReadonlyArray<{ col: number; row: number }>;
}

// 每座竞技场可以拥有不同的入场构图。坐标仍对齐 8px 子格，避免复活或 Boss 初始位置
// 落在半格上。第 1 / 5 / 10 张保留经典中轴入场，其余地图让 Boss 从不同侧翼控场。
const BOSS_ARENA_PLACEMENTS: ReadonlyArray<BossArenaPlacementCells> = [
  {
    boss: { col: 18, row: 6 },
    players: [
      { col: 14, row: 28 }, { col: 24, row: 28 },
      { col: 6, row: 28 }, { col: 32, row: 28 },
    ],
  },
  {
    boss: { col: 18, row: 4 },
    players: [
      { col: 8, row: 28 }, { col: 28, row: 28 },
      { col: 3, row: 28 }, { col: 35, row: 28 },
    ],
  },
  {
    boss: { col: 5, row: 5 },
    players: [
      { col: 24, row: 28 }, { col: 32, row: 28 },
      { col: 8, row: 28 }, { col: 16, row: 28 },
    ],
  },
  {
    boss: { col: 28, row: 5 },
    players: [
      { col: 8, row: 28 }, { col: 18, row: 28 },
      { col: 28, row: 28 }, { col: 35, row: 28 },
    ],
  },
  {
    boss: { col: 18, row: 6 },
    players: [
      { col: 14, row: 28 }, { col: 24, row: 28 },
      { col: 6, row: 28 }, { col: 32, row: 28 },
    ],
  },
  {
    boss: { col: 6, row: 4 },
    players: [
      { col: 24, row: 28 }, { col: 32, row: 28 },
      { col: 8, row: 28 }, { col: 16, row: 28 },
    ],
  },
  {
    boss: { col: 28, row: 4 },
    players: [
      { col: 8, row: 28 }, { col: 18, row: 28 },
      { col: 28, row: 28 }, { col: 35, row: 28 },
    ],
  },
  {
    boss: { col: 18, row: 4 },
    players: [
      { col: 5, row: 28 }, { col: 33, row: 28 },
      { col: 14, row: 28 }, { col: 24, row: 28 },
    ],
  },
  {
    boss: { col: 5, row: 5 },
    players: [
      { col: 25, row: 28 }, { col: 33, row: 28 },
      { col: 7, row: 28 }, { col: 17, row: 28 },
    ],
  },
  {
    boss: { col: 18, row: 6 },
    players: [
      { col: 14, row: 28 }, { col: 24, row: 28 },
      { col: 6, row: 28 }, { col: 32, row: 28 },
    ],
  },
];

// 程序化绘制只负责把手工设计表达得更清楚，不做随机生成。最后统一清理顶部血条区、
// Boss 车体（4×4 子格，外加一格余量）和四个玩家出生席，确保配置与地图不会漂移。
function buildBossArena(ordinal: number, paint: (fill: BossArenaFill) => void): LevelState {
  const grid: BossArenaCellChar[][] = Array.from(
    { length: FIELD_ROWS },
    () => new Array<BossArenaCellChar>(FIELD_COLS).fill('.'),
  );
  const fill: BossArenaFill = (cell, col, row, width, height) => {
    for (let r = Math.max(0, row); r < Math.min(FIELD_ROWS, row + height); r++) {
      for (let c = Math.max(0, col); c < Math.min(FIELD_COLS, col + width); c++) {
        grid[r][c] = cell;
      }
    }
  };
  paint(fill);
  fill('.', 0, 0, FIELD_COLS, 2);
  const placement = BOSS_ARENA_PLACEMENTS[ordinal - 1];
  fill('.', placement.boss.col - 1, placement.boss.row - 1, 6, 6);
  // 同时清出出生点正前方一个车位：多人过关的 MVP 星星固定投放在这里。
  for (const spawn of placement.players) fill('.', spawn.col, spawn.row - 2, 2, 4);
  return parseLevel(grid.map((row) => row.join('')));
}

// 竞技场 1「环形斗兽场」（第 3 关）：上半场只在两翼立柱，中央整片空场让 Boss 一览无余；
// 下半场四道错位掩体带（砖为主、钢为辅），给首次面对弹幕的玩家足够的躲避余地。
// prettier-ignore
const STAGE_BOSS_1_ROWS = [
  '........................................', // 0
  '........................................', // 1
  '..SS....BBBB................BBBB....SS..', // 2
  '..SS....BBBB................BBBB....SS..', // 3
  '........................................', // 4
  '........................................', // 5
  '..BBBB..SS....................SS..BBBB..', // 6  ← Boss 空域自此起
  '..BBBB..SS....................SS..BBBB..', // 7
  '........................................', // 8
  '........................................', // 9
  '....SS..BBBB................BBBB..SS....', // 10
  '....SS..BBBB................BBBB..SS....', // 11 ← Boss 空域至此止
  '........................................', // 12
  '........................................', // 13
  '....SSSS..BBBB..BBBBBBBB..BBBB..SSSS....', // 14
  '....SSSS..BBBB..BBBBBBBB..BBBB..SSSS....', // 15
  '........................................', // 16
  '........................................', // 17
  '..BBBB....SSSS....BBBB....SSSS....BBBB..', // 18
  '..BBBB....SSSS....BBBB....SSSS....BBBB..', // 19
  '........................................', // 20
  '........................................', // 21
  '....BBBB....BBBB........BBBB....BBBB....', // 22
  '....BBBB....BBBB........BBBB....BBBB....', // 23
  '........................................', // 24
  '........................................', // 25
  '..SSSS......BB............BB......SSSS..', // 26
  '..SSSS......BB............BB......SSSS..', // 27
  '..........BB......BBBB......BB..........', // 28
  '..........BB......BBBB......BB..........', // 29
];

// 竞技场 2「错列防线」（第 7 关）：五道纵向掩体彼此错位，专门服务于弹幕墙。
// 玩家必须横向穿梭寻找随机缺口，不再沿第 1 张图的整行安全走廊平推。
const STAGE_BOSS_2 = buildBossArena(2, (fill) => {
  fill('S', 3, 3, 2, 8);
  fill('B', 3, 14, 2, 7);
  fill('B', 8, 7, 3, 9);
  fill('S', 9, 20, 2, 6);
  fill('S', 15, 2, 2, 7);
  fill('B', 15, 12, 2, 10);
  fill('B', 21, 8, 3, 8);
  fill('S', 22, 19, 2, 8);
  fill('S', 29, 3, 2, 10);
  fill('B', 28, 16, 3, 8);
  fill('B', 35, 6, 2, 8);
  fill('S', 35, 18, 2, 8);
  // 三块短横墙打断直上直下，但不构成贯穿全图的墙带。
  fill('B', 5, 18, 5, 2);
  fill('S', 17, 24, 5, 2);
  fill('B', 31, 12, 5, 2);
});

// 竞技场 3「冲角试验场」（第 11 关）：不对称钢柱切出长直冲锋线。
// 砖门可以被撞碎，钢柱则是玩家主动诱导 Boss 撞晕的反制点。
const STAGE_BOSS_3 = buildBossArena(3, (fill) => {
  fill('S', 12, 2, 3, 6);
  fill('S', 24, 2, 2, 9);
  fill('S', 34, 6, 3, 5);
  fill('S', 4, 14, 2, 7);
  fill('S', 17, 12, 3, 4);
  fill('S', 29, 14, 2, 7);
  fill('S', 9, 23, 3, 4);
  fill('S', 23, 22, 2, 6);
  fill('S', 35, 23, 3, 4);
  // 可破坏门横跨冲锋线；半血解锁 charge 后，场地会被 Boss 自己逐渐打开。
  fill('B', 8, 10, 9, 2);
  fill('B', 22, 17, 10, 2);
  fill('B', 2, 24, 5, 2);
  fill('B', 27, 8, 7, 2);
  fill('B', 14, 25, 6, 2);
});

// 竞技场 4「崩塌街区」（第 15 关）：数片密集砖区形成会被迫击炮永久改写的街巷。
// 少量钢制避难角提供稳定掩体；战斗越久，砖区越碎、可走路线越多。
const STAGE_BOSS_4 = buildBossArena(4, (fill) => {
  fill('B', 2, 3, 9, 6);
  fill('.', 5, 5, 3, 4);
  fill('B', 14, 2, 8, 7);
  fill('.', 17, 4, 2, 5);
  fill('B', 3, 13, 11, 7);
  fill('.', 7, 15, 3, 5);
  fill('B', 18, 12, 8, 6);
  fill('.', 20, 14, 3, 4);
  fill('B', 29, 10, 9, 8);
  fill('.', 32, 12, 3, 6);
  fill('B', 13, 21, 10, 6);
  fill('.', 16, 23, 4, 4);
  fill('B', 27, 21, 10, 6);
  fill('.', 30, 23, 4, 4);
  // 不对称的永久掩体，避免迫击炮把场地清空后只剩黑地。
  fill('S', 1, 22, 3, 3);
  fill('S', 10, 10, 2, 3);
  fill('S', 24, 4, 3, 3);
  fill('S', 35, 3, 3, 3);
  fill('S', 24, 24, 2, 4);
});

// 竞技场 5「断桥水岸」（第 19 关）：首次引入水域 —— 行 16-17 两道宽河把战场腰斩，
// 只留正中一座 12 子格的桥；被弹幕逼下桥就得绕整整半张图回来。
// prettier-ignore
const STAGE_BOSS_5_ROWS = [
  '........................................', // 0
  '........................................', // 1
  '....SSSS........................SSSS....', // 2
  '....SSSS........................SSSS....', // 3
  '........................................', // 4
  '........................................', // 5
  '..SSSS............................SSSS..', // 6  ← Boss 空域自此起
  '..SSSS............................SSSS..', // 7
  '........................................', // 8
  '........................................', // 9
  '....SSSS........................SSSS....', // 10
  '....SSSS........................SSSS....', // 11 ← Boss 空域至此止
  '........................................', // 12
  '........................................', // 13
  '....SSSS....BBBB........BBBB....SSSS....', // 14
  '....SSSS....BBBB........BBBB....SSSS....', // 15
  '..WWWWWWWWWWWW............WWWWWWWWWWWW..', // 16
  '..WWWWWWWWWWWW............WWWWWWWWWWWW..', // 17
  '..BBBB....SS................SS....BBBB..', // 18
  '..BBBB....SS................SS....BBBB..', // 19
  '........................................', // 20
  '........................................', // 21
  '....SS......BBBB........BBBB......SS....', // 22
  '....SS......BBBB........BBBB......SS....', // 23
  '........................................', // 24
  '........................................', // 25
  '..SS........BB............BB........SS..', // 26
  '..SS........BB............BB........SS..', // 27
  '..................BBBB..................', // 28
  '..................BBBB..................', // 29
];

// 竞技场 6「双环雷道」（第 23 关）：冰面画出相连的双环，钢制核心迫使 Boss 和玩家绕圈。
// Boss 在移动路径上持续布雷，安全路线会随时间从“追着打”变成“逆向换环”。
const STAGE_BOSS_6 = buildBossArena(6, (fill) => {
  // 左右两个冰环与中央交汇带。
  fill('I', 2, 4, 16, 3);
  fill('I', 2, 19, 16, 3);
  fill('I', 2, 4, 3, 18);
  fill('I', 15, 4, 3, 18);
  fill('I', 22, 4, 16, 3);
  fill('I', 22, 19, 16, 3);
  fill('I', 22, 4, 3, 18);
  fill('I', 35, 4, 3, 18);
  fill('I', 15, 11, 10, 4);
  // 两个不可穿越的内核打破横向墙带结构。
  fill('S', 7, 9, 6, 8);
  fill('S', 27, 9, 6, 8);
  fill('B', 8, 7, 4, 2);
  fill('B', 28, 17, 4, 2);
  fill('B', 18, 6, 3, 4);
  fill('B', 19, 16, 3, 4);
  fill('S', 4, 24, 3, 3);
  fill('S', 33, 23, 3, 4);
});

// 竞技场 7「磁锚庭院」（第 27 关）：四座朝向不同的钢制凹室充当磁力牵引的锚点。
// 树林遮住局部视野，中央冰池让直接横穿成为高风险捷径。
const STAGE_BOSS_7 = buildBossArena(7, (fill) => {
  // 左上开口向右。
  fill('S', 2, 3, 8, 2);
  fill('S', 2, 3, 2, 8);
  fill('S', 2, 9, 5, 2);
  // 右上开口向下。
  fill('S', 30, 2, 8, 2);
  fill('S', 36, 2, 2, 8);
  fill('S', 30, 8, 8, 2);
  // 左下开口向上，右下开口向左。
  fill('S', 3, 20, 2, 7);
  fill('S', 3, 25, 8, 2);
  fill('S', 9, 23, 2, 4);
  fill('S', 30, 21, 8, 2);
  fill('S', 36, 21, 2, 6);
  fill('S', 33, 25, 5, 2);
  fill('I', 13, 9, 14, 11);
  fill('B', 18, 7, 4, 4);
  fill('B', 14, 18, 5, 3);
  fill('B', 24, 17, 4, 4);
  fill('T', 5, 12, 7, 5);
  fill('T', 28, 11, 6, 6);
  fill('T', 16, 22, 8, 4);
});

// 竞技场 8「三闸分界线」（第 31 关）：两条纵向水墙把战场分为三列，只在不同高度开闸。
// 横扫激光逼近时，玩家要预判最近闸口换边，而不是沿水平冰带左右滑动。
const STAGE_BOSS_8 = buildBossArena(8, (fill) => {
  fill('W', 10, 2, 2, 9);
  fill('W', 10, 15, 2, 13);
  fill('W', 27, 2, 2, 5);
  fill('W', 27, 11, 2, 10);
  fill('W', 27, 25, 2, 5);
  // 闸门两侧铺短冰坡，换区时需要提前刹车。
  fill('I', 6, 10, 10, 5);
  fill('I', 23, 6, 10, 5);
  fill('I', 23, 20, 10, 5);
  fill('B', 2, 6, 5, 3);
  fill('S', 3, 17, 4, 3);
  fill('B', 14, 3, 4, 4);
  fill('S', 15, 18, 4, 4);
  fill('B', 20, 12, 4, 3);
  fill('S', 32, 4, 5, 3);
  fill('B', 33, 14, 4, 4);
  fill('S', 34, 24, 4, 3);
});

// 竞技场 9「风暴折线」（第 35 关）：水、钢、砖沿对角线交替推进，形成连续换轴的折线路线。
// 半血后四道钢闸会被解除，场地从分段迷宫转成开放弹幕场。
const STAGE_BOSS_9 = buildBossArena(9, (fill) => {
  fill('W', 2, 3, 9, 3);
  fill('W', 8, 8, 10, 3);
  fill('W', 15, 13, 10, 3);
  fill('W', 22, 18, 10, 3);
  fill('W', 29, 23, 9, 3);
  fill('I', 3, 7, 8, 4);
  fill('I', 11, 12, 8, 4);
  fill('I', 19, 17, 8, 4);
  fill('I', 27, 22, 8, 4);
  fill('B', 12, 3, 5, 4);
  fill('B', 20, 8, 5, 4);
  fill('B', 28, 13, 5, 4);
  fill('B', 4, 18, 5, 4);
  fill('B', 12, 23, 5, 4);
  // phase 2 清除的四道钢闸；位置刻意不镜像。
  fill('S', 11, 7, 2, 4);
  fill('S', 19, 12, 2, 4);
  fill('S', 27, 17, 2, 4);
  fill('S', 10, 22, 2, 4);
  fill('T', 33, 4, 5, 5);
  fill('T', 2, 23, 6, 4);
});

// 竞技场 10「末日王座」（第 39 关，最终战）：正中一座全钢王座平台（cols 17-22 / rows 19-22），
// 四周环形水沟（cols 10-29 / rows 16-25）只在正上、正下留两座 4 子格宽的桥；
// 王座外圈铺冰，全图除王座与两根钢柱外再无任何掩体 —— 狂暴 Boss 的最终舞台。
// prettier-ignore
const STAGE_BOSS_10_ROWS = [
  '........................................', // 0
  '........................................', // 1
  '....SS............................SS....', // 2
  '....SS............................SS....', // 3
  '........................................', // 4
  '........................................', // 5
  '........................................', // 6  ← Boss 空域自此起
  '........................................', // 7
  '........................................', // 8
  '........................................', // 9
  '........................................', // 10
  '........................................', // 11 ← Boss 空域至此止
  '........................................', // 12
  '........................................', // 13
  '............IIIIII....IIIIII............', // 14
  '............IIIIII....IIIIII............', // 15
  '..........WWWWWWWW....WWWWWWWW..........', // 16 ← 环形水沟（正上桥：cols 18-21）
  '..........WWWWWWWW....WWWWWWWW..........', // 17
  '..........WW................WW..........', // 18
  '..............IIISSSSSSIII..............', // 19 ← 王座平台
  '..............IIISSSSSSIII..............', // 20
  '..............IIISSSSSSIII..............', // 21
  '..............IIISSSSSSIII..............', // 22
  '..........WW................WW..........', // 23
  '..........WWWWWWWW....WWWWWWWW..........', // 24 ← 正下桥：cols 18-21
  '..........WWWWWWWW....WWWWWWWW..........', // 25
  '........................................', // 26
  '........................................', // 27
  '........................................', // 28
  '........................................', // 29
];

// 十张普通关地形，按组号取（STAGES[t-1] = 第 t 组的普通关 = 第 4t-3 关）。
// 启动时一次性解析，越界/长度错误会立即抛出。
export const STAGES: ReadonlyArray<LevelState> = [
  STAGE_1_ROWS,
  STAGE_2_ROWS,
  STAGE_3_ROWS,
  STAGE_4_ROWS,
  STAGE_5_ROWS,
  STAGE_6_ROWS,
  STAGE_7_ROWS,
  STAGE_8_ROWS,
  STAGE_9_ROWS,
  STAGE_10_ROWS,
].map(parseLevel);

// 十张 Boss 竞技场，按组号（= Boss 序号 b）取第 b 张：一位 Boss 一张独立主场。
export const BOSS_ARENAS: ReadonlyArray<LevelState> = [
  parseLevel(STAGE_BOSS_1_ROWS),
  STAGE_BOSS_2,
  STAGE_BOSS_3,
  STAGE_BOSS_4,
  parseLevel(STAGE_BOSS_5_ROWS),
  STAGE_BOSS_6,
  STAGE_BOSS_7,
  STAGE_BOSS_8,
  STAGE_BOSS_9,
  parseLevel(STAGE_BOSS_10_ROWS),
];

export interface BossArenaPhaseClear {
  col: number;
  row: number;
  width: number;
  height: number;
}

export interface BossArenaConfig {
  level: LevelState;
  bossSpawn: { x: number; y: number };
  playerSpawns: ReadonlyArray<{ x: number; y: number }>;
  phase2Clears: ReadonlyArray<BossArenaPhaseClear>;
}

const PHASE2_CLEARS: ReadonlyArray<ReadonlyArray<BossArenaPhaseClear>> = [
  [],
  [],
  [
    { col: 8, row: 10, width: 9, height: 2 },
    { col: 22, row: 17, width: 10, height: 2 },
  ],
  [
    { col: 3, row: 13, width: 11, height: 2 },
    { col: 18, row: 16, width: 8, height: 2 },
  ],
  [],
  [],
  [{ col: 18, row: 7, width: 4, height: 4 }],
  [],
  [
    { col: 11, row: 7, width: 2, height: 4 },
    { col: 19, row: 12, width: 2, height: 4 },
    { col: 27, row: 17, width: 2, height: 4 },
    { col: 10, row: 22, width: 2, height: 4 },
  ],
  [],
];

// 地图、入场点和阶段变化由同一份配置索引，避免关卡图已经重画、实体仍落在旧坐标。
export const BOSS_ARENA_CONFIGS: ReadonlyArray<BossArenaConfig> = BOSS_ARENAS.map(
  (level, index) => {
    const placement = BOSS_ARENA_PLACEMENTS[index];
    return {
      level,
      bossSpawn: {
        x: placement.boss.col * SUBTILE,
        y: placement.boss.row * SUBTILE,
      },
      playerSpawns: placement.players.map((spawn) => ({
        x: spawn.col * SUBTILE,
        y: spawn.row * SUBTILE,
      })),
      phase2Clears: PHASE2_CLEARS[index],
    };
  },
);

// ── 对战竞技场 ──
// 对战关不设鹰巢，上方四个敌方席位与下方四个玩家席位镜像对峙。地图用程序化的
// 对称矩形构造，便于明确保证 2×2 子格车体的通路宽度；最后统一清理出生区和入场通道。
type VersusCellChar = '.' | 'B' | 'S' | 'W' | 'T' | 'I';
type VersusArenaPainter = (
  fill: (cell: VersusCellChar, col: number, row: number, width: number, height: number) => void,
) => void;

function buildVersusArena(paint: VersusArenaPainter): LevelState {
  const grid: VersusCellChar[][] = Array.from(
    { length: FIELD_ROWS },
    () => new Array<VersusCellChar>(FIELD_COLS).fill('.'),
  );
  const fill = (
    cell: VersusCellChar,
    col: number,
    row: number,
    width: number,
    height: number,
  ): void => {
    for (let r = Math.max(0, row); r < Math.min(FIELD_ROWS, row + height); r++) {
      for (let c = Math.max(0, col); c < Math.min(FIELD_COLS, col + width); c++) {
        grid[r][c] = cell;
      }
    }
  };
  paint(fill);

  // AI 顶部四席与玩家底部四席各留 4 行纵深，防止出生闪光被地形卡住。
  for (const col of [0, 13, 25, 38]) fill('.', col, 0, 2, 4);
  for (const col of [6, 14, 24, 32]) fill('.', col, FIELD_ROWS - 4, 2, 4);
  return parseLevel(grid.map((row) => row.join('')));
}

// 1. 十字火网：中心钢骨把直冲路线分成四条侧翼，队友需要交叉架枪和轮转掩护。
const VERSUS_1 = buildVersusArena((fill) => {
  fill('S', 19, 5, 2, 7);
  fill('S', 19, 18, 2, 7);
  fill('S', 5, 14, 10, 2);
  fill('S', 25, 14, 10, 2);
  for (const col of [7, 29]) {
    fill('B', col, 6, 4, 2);
    fill('B', col, 22, 4, 2);
  }
  fill('T', 14, 10, 3, 3);
  fill('T', 23, 17, 3, 3);
});

// 2. 三桥争夺：河道只有三座桥，中路最短但暴露，两侧桥适合双人包抄。
const VERSUS_2 = buildVersusArena((fill) => {
  fill('W', 0, 13, 40, 4);
  for (const col of [3, 18, 33]) fill('.', col, 13, 4, 4);
  for (const col of [8, 28]) {
    fill('S', col, 10, 2, 2);
    fill('S', col, 18, 2, 2);
  }
  fill('B', 12, 8, 6, 2);
  fill('B', 22, 8, 6, 2);
  fill('B', 12, 20, 6, 2);
  fill('B', 22, 20, 6, 2);
  fill('T', 1, 9, 5, 3);
  fill('T', 34, 18, 5, 3);
});

// 3. 迷雾棋盘：树林遮挡视野、钢柱切断长射线，需要一人探路、一人从相邻走廊接应。
const VERSUS_3 = buildVersusArena((fill) => {
  for (const row of [6, 12, 18, 24]) {
    fill('T', 4, row, 8, 3);
    fill('T', 28, 27 - row, 8, 3);
  }
  for (const [col, row] of [[13, 7], [25, 7], [7, 14], [31, 14], [13, 21], [25, 21]] as const) {
    fill('S', col, row, 2, 2);
  }
  fill('B', 17, 10, 6, 2);
  fill('B', 17, 18, 6, 2);
  fill('T', 16, 13, 8, 4);
});

// 4. 冰环换位：中央高速冰面适合快速支援，四个钢堡逼迫玩家提前规划刹车与交叉角度。
const VERSUS_4 = buildVersusArena((fill) => {
  fill('I', 6, 7, 28, 16);
  for (const [col, row] of [[8, 9], [28, 9], [8, 19], [28, 19]] as const) {
    fill('S', col, row, 4, 2);
  }
  fill('B', 17, 7, 6, 2);
  fill('B', 17, 21, 6, 2);
  fill('S', 19, 12, 2, 6);
  fill('T', 2, 13, 4, 4);
  fill('T', 34, 13, 4, 4);
});

// 5. 阶梯突破：三道错位砖墙可以绕行也可集火破口，考验队伍是否能共享突破口。
const VERSUS_5 = buildVersusArena((fill) => {
  fill('B', 0, 6, 15, 2);
  fill('B', 21, 6, 19, 2);
  fill('B', 0, 14, 7, 2);
  fill('B', 13, 14, 14, 2);
  fill('B', 33, 14, 7, 2);
  fill('B', 0, 22, 19, 2);
  fill('B', 25, 22, 15, 2);
  for (const [col, row] of [[17, 5], [21, 9], [9, 13], [29, 17], [17, 21], [21, 25]] as const) {
    fill('S', col, row, 2, 2);
  }
  fill('T', 8, 9, 5, 3);
  fill('T', 27, 18, 5, 3);
});

// 6. 四堡夺点：四座开口钢堡围绕中央水池，单人守堡容易被两翼夹击，必须交替换防。
const VERSUS_6 = buildVersusArena((fill) => {
  fill('W', 16, 11, 8, 8);
  for (const [col, row] of [[5, 6], [29, 6], [5, 20], [29, 20]] as const) {
    fill('S', col, row, 6, 2);
    fill('S', col, row + 2, 2, 4);
    fill('B', col + 4, row + 2, 2, 4);
  }
  fill('B', 14, 7, 12, 2);
  fill('B', 14, 21, 12, 2);
  fill('T', 12, 12, 4, 6);
  fill('T', 24, 12, 4, 6);
});

export const VERSUS_ARENAS: ReadonlyArray<LevelState> = [
  VERSUS_1,
  VERSUS_2,
  VERSUS_3,
  VERSUS_4,
  VERSUS_5,
  VERSUS_6,
];

// 某普通关的地形（只读原型；调用方需 cloneLevel 后再改）。
export function normalLevelForStage(stage: number): LevelState {
  return STAGES[(stageGroup(stage) - 1) % STAGES.length];
}

// 某 Boss 关的完整配置：第 b 位 Boss（b = 组号）取第 b 张竞技场。
export function bossArenaConfigForStage(stage: number): BossArenaConfig {
  return BOSS_ARENA_CONFIGS[(stageGroup(stage) - 1) % BOSS_ARENA_CONFIGS.length];
}

// 兼容只关心地形原型的调用方。
export function bossArenaForStage(stage: number): LevelState {
  return bossArenaConfigForStage(stage).level;
}

export function bossPlayerSpawnForStage(
  stage: number,
  playerIndex: number,
): { x: number; y: number } {
  return bossArenaConfigForStage(stage).playerSpawns[playerIndex];
}

// 半血转阶段时只修改当前关卡实例。统一走 setCell，保证砖块掩码与 level.rev
// 同步更新，服务器会按既有增量地形协议把变化广播给所有客户端。
export function applyBossArenaPhase2(level: LevelState, stage: number): void {
  for (const clear of bossArenaConfigForStage(stage).phase2Clears) {
    for (let row = clear.row; row < clear.row + clear.height; row++) {
      for (let col = clear.col; col < clear.col + clear.width; col++) {
        if (getCell(level, col, row) !== Cell.EMPTY) setCell(level, col, row, Cell.EMPTY);
      }
    }
  }
}

// 某对战关的竞技场（只读原型）：10 个循环组在 6 张图中顺序轮换。
export function versusArenaForStage(stage: number): LevelState {
  return VERSUS_ARENAS[(stageGroup(stage) - 1) % VERSUS_ARENAS.length];
}

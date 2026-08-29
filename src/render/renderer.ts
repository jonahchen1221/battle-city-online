import {
  ART_SCALE,
  NATIVE_WIDTH,
  NATIVE_HEIGHT,
  FIELD_X,
  FIELD_Y,
  FIELD_WIDTH,
  FIELD_HEIGHT,
  SUBTILE,
  TANK_SIZE,
  PLAYER_LABEL_COLORS,
  QUARTER,
  COLOR_FRAME,
  COLOR_FIELD,
  WATER_ANIM_TICKS,
  TRACK_ANIM_TICKS,
  SPAWN_STAR_ANIM_TICKS,
  SPAWN_FLASH_TICKS,
  ARMOR_FLASH_TICKS,
  ARMOR_HP,
  EXPLOSION_SMALL_TICKS,
  EXPLOSION_SMALL_FRAMES,
  EXPLOSION_BIG_TICKS,
  EXPLOSION_BIG_FRAMES,
  BRICK_TL,
  BRICK_TR,
  BRICK_BL,
  BRICK_BR,
  COLOR_STAGE_CLEAR,
  COLOR_HUD_ICON,
  GAMEOVER_SLIDE_TICKS,
  SHIELD_ANIM_TICKS,
  FRIENDLY_FREEZE_BLINK_TICKS,
  PAUSE_BLINK_TICKS,
  CARRIER_FLASH_TICKS,
  POWERUP_BLINK_VISIBLE_TICKS,
  POWERUP_BLINK_CYCLE_TICKS,
  GHOST_RENDER_ALPHA,
  LASER_SPRITE_OFFSET,
  COLOR_WEAPON_SPREAD,
  COLOR_WEAPON_SPIRAL,
  COLOR_WEAPON_LASER,
  COLOR_WEAPON_MACHINE,
  SMART_MARKER_PULSE_TICKS,
  COLOR_SMART_MARKER,
} from '../core/constants';
import { GameState } from '../game/state';
import { Cell, LevelState, cellIndex, getCell } from '../game/level';
import { TankState, EnemyKind, WeaponKind } from '../game/tank';
import {
  SpriteAtlas,
  TankFrames,
  createSpriteAtlas,
  drawTile,
  drawQuarter,
  drawText,
  drawTextOutlined,
  drawTextScaledOutlined,
  textWidth,
} from './sprites';

// 把逻辑坐标吸附到最近的“美术像素”（1/ART_SCALE 逻辑像素）。
// 直接对逻辑坐标取整会把运动量化成 2 美术像素一跳，浪费高清分辨率的平滑度。
function snapArt(v: number): number {
  return Math.round(v * ART_SCALE) / ART_SCALE;
}

// HUD 上标注当前武器用的单字母与配色（32px 栏放不下全名）。cannon 标 'C'（黑，与其余 HUD 图标同色）。
const WEAPON_LETTER: Record<WeaponKind, string> = {
  cannon: 'C',
  spread: 'S',
  spiral: 'F',
  laser: 'L',
  machine: 'M',
};
const WEAPON_LETTER_COLOR: Record<WeaponKind, string> = {
  cannon: COLOR_HUD_ICON,
  spread: COLOR_WEAPON_SPREAD,
  spiral: COLOR_WEAPON_SPIRAL,
  laser: COLOR_WEAPON_LASER,
  machine: COLOR_WEAPON_MACHINE,
};

// 渲染层只读 GameState，不做任何逻辑推进。
export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private atlas: SpriteAtlas;

  // 只读暴露图集，供 src/client 的标题/大厅 UI 复用精灵（如菜单光标用的迷你坦克）。
  // 客户端 UI 层绝不修改图集，仅取样绘制。
  get spriteAtlas(): SpriteAtlas {
    return this.atlas;
  }

  constructor(canvas: HTMLCanvasElement) {
    // 画布内部分辨率 = 原生尺寸 × 美术倍数（512×448）。所有布局数学仍以逻辑像素书写，
    // 仅在 ctx 调用处（fillRect/clip）与 drawTile/drawText/drawQuarter 内部乘以 ART_SCALE，
    // 不使用 ctx.scale（否则 2× 精灵会被二次缩放）。
    canvas.width = NATIVE_WIDTH * ART_SCALE;
    canvas.height = NATIVE_HEIGHT * ART_SCALE;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.ctx = ctx;
    this.ctx.imageSmoothingEnabled = false;
    this.atlas = createSpriteAtlas();
  }

  draw(state: GameState, _alpha: number, playerNames: readonly string[] = []): void {
    const { ctx } = this;

    this.drawCabinetFrame();
    this.drawFieldBackdrop();

    // 第一遍：地形中除树林外的一切（在实体之下）
    this.drawGround(state.level, state.tick, state.eagleDestroyed);

    // ── 实体绘制在两遍地形之间（地面之上、树林之下）──
    // 顺序：出生星 → 坦克 → 子弹 → 爆炸。
    // 硬裁剪到战场矩形（NES 同款）：边缘的大爆炸等特效不得溢出到灰边/HUD。
    ctx.save();
    ctx.beginPath();
    ctx.rect(FIELD_X * ART_SCALE, FIELD_Y * ART_SCALE, FIELD_WIDTH * ART_SCALE, FIELD_HEIGHT * ART_SCALE);
    ctx.clip();
    this.drawSpawnStars(state);
    this.drawTanks(state, playerNames);
    this.drawBullets(state);
    this.drawExplosions(state);

    // 第二遍：树林（覆盖在实体之上，坦克可藏于其下）
    this.drawTrees(state.level);
    // 智能坦克标记在树林之后绘制：即使车体藏在树下，也能明确辨认其 AI 身份和位置。
    this.drawSmartTankMarkers(state);
    // 道具浮标：绘于树林之上（经典 —— 浮于一切之上），仍在战场裁剪区内。
    this.drawPowerup(state);
    ctx.restore();

    // 右侧 HUD 栏（剩余敌军 / 生命 / 关卡旗）
    this.drawHud(state, playerNames);

    // 结果覆盖层（GAME OVER / STAGE CLEAR），绘制在最上层
    this.drawOverlay(state, playerNames);

    // 暂停覆盖层（黄色 "PAUSE" 闪烁），凌驾于一切之上
    this.drawPause(state, playerNames);

    // 关卡开场幕布（STAGE N）：铺满战场的灰色幕布 + 黑字，凌驾于战场内一切之上。
    this.drawStageStart(state);
  }

  // 战场外框改成硬边阶梯明暗，比一整块中灰更容易分辨战场 / HUD，
  // 且全部边缘落在 ART_SCALE 像素网格上。
  private drawCabinetFrame(): void {
    const { ctx } = this;
    const w = NATIVE_WIDTH * ART_SCALE;
    const h = NATIVE_HEIGHT * ART_SCALE;
    ctx.fillStyle = COLOR_FRAME;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#7a807d';
    ctx.fillRect(0, 0, w, 3 * ART_SCALE);
    ctx.fillRect(0, 0, 3 * ART_SCALE, h);
    ctx.fillStyle = '#343937';
    ctx.fillRect(0, h - 3 * ART_SCALE, w, 3 * ART_SCALE);
    ctx.fillRect(w - 3 * ART_SCALE, 0, 3 * ART_SCALE, h);

    // 战场的 2px 内凹暗边。
    ctx.fillStyle = '#202422';
    ctx.fillRect((FIELD_X - 2) * ART_SCALE, (FIELD_Y - 2) * ART_SCALE, (FIELD_WIDTH + 4) * ART_SCALE, 2 * ART_SCALE);
    ctx.fillRect((FIELD_X - 2) * ART_SCALE, (FIELD_Y - 2) * ART_SCALE, 2 * ART_SCALE, (FIELD_HEIGHT + 4) * ART_SCALE);
    ctx.fillStyle = '#8b918e';
    ctx.fillRect((FIELD_X - 2) * ART_SCALE, (FIELD_Y + FIELD_HEIGHT) * ART_SCALE, (FIELD_WIDTH + 4) * ART_SCALE, 2 * ART_SCALE);
    ctx.fillRect((FIELD_X + FIELD_WIDTH) * ART_SCALE, (FIELD_Y - 2) * ART_SCALE, 2 * ART_SCALE, (FIELD_HEIGHT + 4) * ART_SCALE);
  }

  // 不再用完全扁平的黑色：以极暗绿灰稀疏点出 8px 网格节点。对比度很低，
  // 只为空地提供尺度感，坦克轮廓仍以黑底为主。
  private drawFieldBackdrop(): void {
    const { ctx } = this;
    ctx.fillStyle = COLOR_FIELD;
    ctx.fillRect(FIELD_X * ART_SCALE, FIELD_Y * ART_SCALE, FIELD_WIDTH * ART_SCALE, FIELD_HEIGHT * ART_SCALE);
    ctx.fillStyle = '#07100d';
    for (let y = 0; y < FIELD_HEIGHT; y += SUBTILE) {
      for (let x = 0; x < FIELD_WIDTH; x += SUBTILE) {
        if (((x / SUBTILE) + (y / SUBTILE) * 3) % 4 !== 0) continue;
        ctx.fillRect((FIELD_X + x + 1) * ART_SCALE, (FIELD_Y + y + 1) * ART_SCALE, 1, 1);
      }
    }
  }

  // 复杂地形上的文字统一放进不透明硬边信息牌，避免砖墙/树林穿过字形造成误读。
  private drawOverlayPlate(x: number, y: number, w: number, h: number, accent = '#6f2720'): void {
    const { ctx } = this;
    ctx.fillStyle = '#020303';
    ctx.fillRect((x + 2) * ART_SCALE, (y + 2) * ART_SCALE, w * ART_SCALE, h * ART_SCALE);
    ctx.fillStyle = '#0a0e0c';
    ctx.fillRect(x * ART_SCALE, y * ART_SCALE, w * ART_SCALE, h * ART_SCALE);
    ctx.fillStyle = accent;
    ctx.fillRect(x * ART_SCALE, y * ART_SCALE, w * ART_SCALE, ART_SCALE);
    ctx.fillRect(x * ART_SCALE, y * ART_SCALE, ART_SCALE, h * ART_SCALE);
    ctx.fillStyle = '#28302c';
    ctx.fillRect(x * ART_SCALE, (y + h - 1) * ART_SCALE, w * ART_SCALE, ART_SCALE);
    ctx.fillRect((x + w - 1) * ART_SCALE, y * ART_SCALE, ART_SCALE, h * ART_SCALE);
  }

  // 关卡开场幕布：用灰色（frame gray）铺满战场矩形，居中黑字 "STAGE N"（经典过场观感）。
  private drawStageStart(state: GameState): void {
    if (state.phase !== 'stagestart') return;
    const { ctx, atlas } = this;
    ctx.fillStyle = COLOR_FRAME;
    ctx.fillRect(
      FIELD_X * ART_SCALE,
      FIELD_Y * ART_SCALE,
      FIELD_WIDTH * ART_SCALE,
      FIELD_HEIGHT * ART_SCALE,
    );
    const text = `STAGE ${state.stage}`;
    const cx = FIELD_X + Math.round(FIELD_WIDTH / 2);
    const cy = FIELD_Y + FIELD_HEIGHT / 2 - 4;
    drawText(ctx, atlas, text, cx - Math.round(textWidth(text) / 2), cy, COLOR_HUD_ICON);
    // 不显眼的操作提示：教会玩家 P 可暂停（每关开场都会看到，不占游戏画面）。
    const hint = 'P = PAUSE';
    drawText(ctx, atlas, hint, cx - Math.round(textWidth(hint) / 2), cy + 40, COLOR_HUD_ICON);
  }

  // 右侧 32px 灰栏 HUD：黑色图标/文字，经典 NES 布局。
  private drawHud(state: GameState, playerNames: readonly string[]): void {
    const { ctx, atlas } = this;
    const hudX = FIELD_X + FIELD_WIDTH;

    // HUD 独立内凹面板，与外框分开，小图标在更亮的底色上更清楚。
    ctx.fillStyle = '#292e2c';
    ctx.fillRect((hudX + 2) * ART_SCALE, (FIELD_Y - 1) * ART_SCALE, 29 * ART_SCALE, (FIELD_HEIGHT + 2) * ART_SCALE);
    ctx.fillStyle = '#9aa09c';
    ctx.fillRect((hudX + 3) * ART_SCALE, FIELD_Y * ART_SCALE, 27 * ART_SCALE, FIELD_HEIGHT * ART_SCALE);
    ctx.fillStyle = '#c2c6c3';
    ctx.fillRect((hudX + 3) * ART_SCALE, FIELD_Y * ART_SCALE, 27 * ART_SCALE, ART_SCALE);
    ctx.fillRect((hudX + 3) * ART_SCALE, FIELD_Y * ART_SCALE, ART_SCALE, FIELD_HEIGHT * ART_SCALE);
    drawText(ctx, atlas, 'LEFT', hudX + 5, FIELD_Y + 5, '#242826');

    // 剩余敌军图标：未出生队列每台一格 8×8，2 个一行，自顶向下。
    for (let i = 0; i < state.enemyQueue.length; i++) {
      const col = i % 2;
      const row = Math.floor(i / 2);
      drawTile(ctx, atlas.hudEnemy, hudX + 5 + col * 12, FIELD_Y + 16 + row * 10);
    }

    // 玩家生命：每名在场玩家一行（自上而下堆叠于 32px 栏内）。
    // 每行：2 位玩家名 + 该玩家配色的迷你坦克 + 存量数字（= lives-1，与 NES 一致）。
    const livesTop = FIELD_Y + 124;
    const rowH = 19;
    ctx.fillStyle = '#676d69';
    ctx.fillRect((hudX + 5) * ART_SCALE, (livesTop - 6) * ART_SCALE, 23 * ART_SCALE, ART_SCALE);
    for (let i = 0; i < state.playerCount; i++) {
      const rowY = livesTop + i * rowH;
      drawText(ctx, atlas, this.playerName(playerNames, i), hudX + 6, rowY, COLOR_HUD_ICON);
      // 当前武器字母，紧贴 2 位名字右侧（栏宽 32px：名字 6..18、字母 24..30）。
      const weapon = this.playerWeapon(state, i);
      drawText(ctx, atlas, WEAPON_LETTER[weapon], hudX + 24, rowY, WEAPON_LETTER_COLOR[weapon]);
      const stock = Math.max(0, state.livesByPlayer[i] - 1);
      drawTile(ctx, atlas.hudLifeTank[i], hudX + 3, rowY + 8);
      // 数字与迷你坦克顶对齐；旧版下沉 4px，会和下一段分隔线相撞。
      drawText(ctx, atlas, String(stock), hudX + 20, rowY + 9, COLOR_HUD_ICON);
    }

    // 关卡旗 + 当前关号：置于生命块下方。
    const flagY = livesTop + state.playerCount * rowH + 2;
    ctx.fillStyle = '#676d69';
    ctx.fillRect((hudX + 5) * ART_SCALE, (flagY - 4) * ART_SCALE, 23 * ART_SCALE, ART_SCALE);
    drawTile(ctx, atlas.hudFlag, hudX + 7, flagY);
    drawText(ctx, atlas, String(state.stage), hudX + 12, flagY + 20, COLOR_HUD_ICON);
  }

  // 正常本地/联机路径都会传入真实的 2 位名字。备用值仅供旧调试钩子或不完整快照渲染，
  // 仍保持两字符宽度，避免挤破 HUD 与结算表格。
  private playerName(playerNames: readonly string[], playerIndex: number): string {
    return playerNames[playerIndex] ?? `P${playerIndex + 1}`;
  }

  // 某玩家当前的武器：优先取在场坦克，其次取出生闪光中（复活）的坦克；都没有则视为 cannon。
  private playerWeapon(state: GameState, playerIndex: number): WeaponKind {
    for (const t of state.tanks) {
      if (t.alive && t.kind === 'player' && t.playerIndex === playerIndex) return t.weapon;
    }
    for (const sp of state.spawning) {
      if (sp.tank.kind === 'player' && sp.tank.playerIndex === playerIndex) return sp.tank.weapon;
    }
    return 'cannon';
  }

  // 结果覆盖层。GAME OVER：经典红，phaseTicks 前 GAMEOVER_SLIDE_TICKS 帧由底部滑到中央后停住。
  // STAGE CLEAR：白色，居中静止。
  private drawOverlay(state: GameState, playerNames: readonly string[]): void {
    const { ctx, atlas } = this;
    const cx = FIELD_X + Math.round(FIELD_WIDTH / 2);
    const cy = FIELD_Y + FIELD_HEIGHT / 2 - 4;
    ctx.save();
    ctx.beginPath();
    ctx.rect(FIELD_X * ART_SCALE, FIELD_Y * ART_SCALE, FIELD_WIDTH * ART_SCALE, FIELD_HEIGHT * ART_SCALE);
    ctx.clip();

    if (state.phase === 'gameover') {
      const text = 'GAME OVER';
      const titleScale = 2;
      const titleWidth = textWidth(text) * titleScale;
      const x = cx - Math.round(titleWidth / 2);
      const t = Math.min(state.phaseTicks, GAMEOVER_SLIDE_TICKS) / GAMEOVER_SLIDE_TICKS;
      const startY = FIELD_Y + FIELD_HEIGHT; // 屏幕底部
      const y = Math.round(startY + (cy - startY) * t);
      const settled = state.phaseTicks > GAMEOVER_SLIDE_TICKS;
      let hintY = cy + 24;
      if (settled && state.playerCount > 1) hintY = cy + 20 + state.playerCount * 12 + 8;

      // 滑入阶段用紧凑牌；停稳后扩大成完整结果牌，把得分和重开提示一并从地形中隔离。
      if (settled) {
        const plateW = Math.max(titleWidth + 20, state.playerCount > 1 ? 132 : 118);
        this.drawOverlayPlate(cx - plateW / 2, cy - 7, plateW, hintY - cy + 23, '#9b3027');
      } else {
        this.drawOverlayPlate(x - 8, y - 5, titleWidth + 16, 24, '#9b3027');
      }
      drawTextScaledOutlined(ctx, atlas, text, x, y, titleScale, '#ff5b49');
      // 滑入完成后：多人局在 GAME OVER 下方逐行列出各玩家最终得分（各自配色），再提示重开操作。
      if (settled) {
        if (state.playerCount > 1) {
          let ly = cy + 20;
          for (let i = 0; i < state.playerCount; i++) {
            const line = `${this.playerName(playerNames, i)} ${state.scoreByPlayer[i]}`;
            const color = PLAYER_LABEL_COLORS[i] ?? COLOR_STAGE_CLEAR;
            drawTextOutlined(ctx, atlas, line, cx - Math.round(textWidth(line) / 2), ly, color);
            ly += 12;
          }
        }
        this.drawRestartHint(state, hintY);
      }
    } else if (state.phase === 'stageclear') {
      this.drawStageClear(state, playerNames);
    }
    ctx.restore();
  }

  // 闪烁的 "PRESS ENTER" 重开提示（gameover / stageclear 共用），与 PAUSE 同款闪烁节奏。
  private drawRestartHint(state: GameState, y: number): void {
    if (Math.floor(state.phaseTicks / PAUSE_BLINK_TICKS) % 2 !== 0) return; // 灭相
    const { ctx, atlas } = this;
    const cx = FIELD_X + Math.round(FIELD_WIDTH / 2);
    const text = 'PRESS ENTER';
    drawTextOutlined(ctx, atlas, text, cx - Math.round(textWidth(text) / 2), y, COLOR_STAGE_CLEAR);
  }

  // 通关结算画面：标题 + 每名玩家一列的战果表（逐类击毁数 + 累计总分），经典多人战果统计版式。
  private drawStageClear(state: GameState, playerNames: readonly string[]): void {
    const { ctx, atlas } = this;
    const cx = FIELD_X + Math.round(FIELD_WIDTH / 2);
    const white = COLOR_STAGE_CLEAR;
    const pc = state.playerCount;

    // 列几何：左侧行标签列（48px）+ 每名玩家一列（56px），整块水平居中于 320px 战场。
    // 4 人时 48 + 4×56 = 272 ≤ 320；人数少时整块更窄、仍居中，观感干净。
    const labelColW = 48;
    const playerColW = 56;
    const blockWidth = labelColW + pc * playerColW;
    const blockLeft = FIELD_X + Math.round((FIELD_WIDTH - blockWidth) / 2);
    const cellPadL = 4; // 表头 / 击毁数在列内的左内边距
    const cellPadR = 8; // 总分右对齐时距列右缘的内边距
    const colLeft = (i: number): number => blockLeft + labelColW + i * playerColW;

    // 整份战报使用一块不透明底板，地图纹理不再穿过表格文字。
    this.drawOverlayPlate(blockLeft - 8, FIELD_Y + 29, blockWidth + 16, 174, '#456a56');

    // 标题："STAGE N CLEAR"，居中于战场顶部三分之一处。
    const title = `STAGE ${state.stage} CLEAR`;
    drawTextOutlined(ctx, atlas, title, cx - Math.round(textWidth(title) / 2), FIELD_Y + 40, white);

    // 表头行：每列显示 2 位玩家名，用各玩家 PLAYER_LABEL_COLORS 配色。
    const headerY = FIELD_Y + 58;
    for (let i = 0; i < pc; i++) {
      const label = this.playerName(playerNames, i);
      const color = PLAYER_LABEL_COLORS[i] ?? white;
      drawTextOutlined(ctx, atlas, label, colLeft(i) + cellPadL, headerY, color);
    }

    // 五种敌军行：左侧种类名（白），随后每列该玩家 "X<击毁数>"（白）。
    const kinds: Array<[EnemyKind, string]> = [
      ['basic', 'BASIC'],
      ['fast', 'FAST'],
      ['power', 'POWER'],
      ['armor', 'ARMOR'],
      ['smart', 'SMART'],
    ];
    let y = FIELD_Y + 76;
    for (const [kind, label] of kinds) {
      drawTextOutlined(ctx, atlas, label, blockLeft, y, white);
      for (let i = 0; i < pc; i++) {
        const kills = state.killsByPlayer[i][kind];
        drawTextOutlined(ctx, atlas, 'X' + kills, colLeft(i) + cellPadL, y, white);
      }
      y += 16;
    }

    // 分隔 + 总分行：每列显示该玩家累计总分（列内右对齐），用玩家配色。
    y += 8;
    drawTextOutlined(ctx, atlas, 'TOTAL', blockLeft, y, white);
    for (let i = 0; i < pc; i++) {
      const scoreStr = String(state.scoreByPlayer[i]);
      const color = PLAYER_LABEL_COLORS[i] ?? white;
      const rx = colLeft(i) + playerColW - cellPadR - textWidth(scoreStr);
      drawTextOutlined(ctx, atlas, scoreStr, rx, y, color);
    }

    // 重开提示。
    this.drawRestartHint(state, y + 24);
  }

  // 暂停覆盖层：黄色 "PAUSE" 居中，按 PAUSE_BLINK_TICKS 周期闪烁（半亮半灭）。
  private drawPause(state: GameState, playerNames: readonly string[]): void {
    if (!state.paused) return;
    if (Math.floor(state.tick / (PAUSE_BLINK_TICKS / 2)) % 2 !== 0) return; // 灭相
    const { ctx, atlas } = this;
    const cx = FIELD_X + Math.round(FIELD_WIDTH / 2);
    const cy = FIELD_Y + FIELD_HEIGHT / 2 - 4;
    this.drawOverlayPlate(cx - 58, cy - 8, 116, 52, '#8e6c28');
    drawTextScaledOutlined(
      ctx,
      atlas,
      'PAUSE',
      cx - Math.round(textWidth('PAUSE')),
      cy,
      2,
      '#ffc94d',
    );

    // 多人局显示是谁暂停的（该玩家配色）；单人不显示。均提示 "P = RESUME"。
    if (state.playerCount > 1 && state.pausedBy >= 0) {
      const who = `${this.playerName(playerNames, state.pausedBy)} PAUSED`;
      const color = PLAYER_LABEL_COLORS[state.pausedBy] ?? COLOR_STAGE_CLEAR;
      drawTextOutlined(ctx, atlas, who, cx - Math.round(textWidth(who) / 2), cy + 16, color);
    }
    const hint = 'P = RESUME';
    drawTextOutlined(ctx, atlas, hint, cx - Math.round(textWidth(hint) / 2), cy + 32, COLOR_STAGE_CLEAR);
  }

  // 出生闪光星：坦克实体化前循环播放 4 帧；智能坦克使用专属青蓝动画。
  private drawSpawnStars(state: GameState): void {
    const { ctx, atlas } = this;
    for (const sp of state.spawning) {
      const elapsed = SPAWN_FLASH_TICKS - sp.ticksLeft;
      const frame = Math.floor(elapsed / SPAWN_STAR_ANIM_TICKS) % 4;
      const frames = sp.tank.kind === 'smart' ? atlas.spawnStarSmart : atlas.spawnStar;
      drawTile(ctx, frames[frame], snapArt(FIELD_X + sp.tank.x), snapArt(FIELD_Y + sp.tank.y));
    }
  }

  // 坦克。按 kind 选用精灵；装甲坦克受损时每 ARMOR_FLASH_TICKS 帧在银/白间闪烁。
  // 履带动画：移动时每 TRACK_ANIM_TICKS 帧切换两帧，静止时冻结在第 0 帧。
  private drawTanks(state: GameState, playerNames: readonly string[]): void {
    const { ctx, atlas } = this;
    const enemiesFrozen = state.enemyFreezeTicks > 0;
    const playersFrozen = state.playerFreezeTicks > 0;
    for (const tank of state.tanks) {
      if (!tank.alive) continue;
      const px = snapArt(FIELD_X + tank.x);
      const py = snapArt(FIELD_Y + tank.y);
      // 冻结中履带定格第 0 帧：敌军由玩家 timer 冻结，玩家由友军弹或敌方 timer 冻结；
      // 其余按移动状态播放两帧。
      const frozen = tank.kind === 'player'
        ? tank.freezeTicks > 0 || playersFrozen
        : enemiesFrozen;
      const frame = tank.moving && !frozen ? Math.floor(state.tick / TRACK_ANIM_TICKS) % 2 : 0;
      const frames = this.tankFrames(tank, state.tick);
      const sprite = frames[tank.dir][frame];
      // 冻结反馈：被冻的玩家坦克每 FRIENDLY_FREEZE_BLINK_TICKS 帧明灭一次。
      const freezeBlinkOff =
        tank.kind === 'player' &&
        (tank.freezeTicks > 0 || playersFrozen) &&
        Math.floor(
          (playersFrozen ? state.playerFreezeTicks : tank.freezeTicks) /
            FRIENDLY_FREEZE_BLINK_TICKS,
        ) % 2 === 0;
      // 幽灵态（ghost 道具）：整台坦克半透明绘制 —— 与友军冻结的“明灭闪烁”是两种观感，不会混淆。
      const ghosting = tank.ghostTicks > 0;
      if (ghosting) ctx.globalAlpha = GHOST_RENDER_ALPHA;
      if (!freezeBlinkOff) drawTile(ctx, sprite, px, py);
      if (ghosting) ctx.globalAlpha = 1;

      // 出生护盾：每 SHIELD_ANIM_TICKS 帧切换两帧流光，覆盖在坦克之上。
      if (tank.invulnTicks > 0) {
        const shieldFrame = Math.floor(state.tick / SHIELD_ANIM_TICKS) % 2;
        drawTile(ctx, atlas.shield[shieldFrame], px, py);
      }

      // 多人局：在每台在场玩家坦克上方绘制该玩家配色的 2 位名字，
      // 居中于坦克、夹紧在战场矩形内（与坦克同处裁剪区内，故也会被树林遮挡）。
      // 单机局（playerCount===1）不绘制，保持原版清爽观感。
      if (state.playerCount > 1 && tank.kind === 'player') {
        const label = this.playerName(playerNames, tank.playerIndex);
        const w = textWidth(label);
        const color = PLAYER_LABEL_COLORS[tank.playerIndex] ?? COLOR_HUD_ICON;
        let lx = Math.round(px + TANK_SIZE / 2 - w / 2);
        let ly = py - 9;
        lx = Math.max(FIELD_X, Math.min(lx, FIELD_X + FIELD_WIDTH - w));
        ly = Math.max(FIELD_Y, ly);
        drawTextOutlined(ctx, atlas, label, lx, ly, color);
      }
    }
  }

  // 智能坦克的高辨识度覆盖标记：青色四角瞄准框，轻微脉冲但不闪灭。
  // 该层位于树林之上，避免只有车身配色时被地形完全遮住。
  private drawSmartTankMarkers(state: GameState): void {
    const { ctx } = this;
    const pulse = Math.floor(state.tick / SMART_MARKER_PULSE_TICKS) % 2;
    const offset = pulse === 0 ? 2 : 1;
    const color = COLOR_SMART_MARKER;
    const corner = 4;
    const thickness = 1;

    for (const tank of state.tanks) {
      if (!tank.alive || tank.kind !== 'smart') continue;
      const px = snapArt(FIELD_X + tank.x);
      const py = snapArt(FIELD_Y + tank.y);
      const left = px - offset;
      const top = py - offset;
      const right = px + TANK_SIZE + offset;
      const bottom = py + TANK_SIZE + offset;
      ctx.fillStyle = color;

      // 左上 / 右上横线。
      ctx.fillRect(left * ART_SCALE, top * ART_SCALE, corner * ART_SCALE, thickness * ART_SCALE);
      ctx.fillRect((right - corner) * ART_SCALE, top * ART_SCALE, corner * ART_SCALE, thickness * ART_SCALE);
      // 左下 / 右下横线。
      ctx.fillRect(left * ART_SCALE, (bottom - thickness) * ART_SCALE, corner * ART_SCALE, thickness * ART_SCALE);
      ctx.fillRect((right - corner) * ART_SCALE, (bottom - thickness) * ART_SCALE, corner * ART_SCALE, thickness * ART_SCALE);
      // 四角纵线。
      ctx.fillRect(left * ART_SCALE, top * ART_SCALE, thickness * ART_SCALE, corner * ART_SCALE);
      ctx.fillRect((right - thickness) * ART_SCALE, top * ART_SCALE, thickness * ART_SCALE, corner * ART_SCALE);
      ctx.fillRect(left * ART_SCALE, (bottom - corner) * ART_SCALE, thickness * ART_SCALE, corner * ART_SCALE);
      ctx.fillRect((right - thickness) * ART_SCALE, (bottom - corner) * ART_SCALE, thickness * ART_SCALE, corner * ART_SCALE);
    }
  }

  // 根据坦克种类（及装甲受损闪烁 / 携带者红闪）取对应精灵组。
  private tankFrames(tank: TankState, tick: number): TankFrames {
    const { atlas } = this;
    if (tank.kind === 'player') return atlas.playerTank[tank.playerIndex];

    // 携带道具敌军：每 CARRIER_FLASH_TICKS 帧在常态 / 红色变体间交替（红色相优先于装甲受损闪烁）。
    const flashRed = tank.carriesPowerup && Math.floor(tick / CARRIER_FLASH_TICKS) % 2 === 1;
    switch (tank.kind) {
      case 'fast':
        return flashRed ? atlas.enemyTankRed.fast : atlas.enemyTank.fast;
      case 'power':
        return flashRed ? atlas.enemyTankRed.power : atlas.enemyTank.power;
      case 'armor': {
        if (flashRed) return atlas.enemyTankRed.armor;
        // 受损（hp 未满）时每 ARMOR_FLASH_TICKS 帧在银/白间闪烁。
        const damaged = tank.hp < ARMOR_HP;
        const flash = damaged && Math.floor(tick / ARMOR_FLASH_TICKS) % 2 === 1;
        return flash ? atlas.enemyTank.armorFlash : atlas.enemyTank.armor;
      }
      case 'smart':
        return flashRed ? atlas.enemyTankRed.smart : atlas.enemyTank.smart;
      default:
        return flashRed ? atlas.enemyTankRed.basic : atlas.enemyTank.basic;
    }
  }

  // 道具浮标：场上可同时存在多枚，逐一绘制。按 32 帧周期整体闪烁（前 24 帧可见、后 8 帧隐藏），
  // 画于战场裁剪区内、树林之上。
  private drawPowerup(state: GameState): void {
    if (state.tick % POWERUP_BLINK_CYCLE_TICKS >= POWERUP_BLINK_VISIBLE_TICKS) return; // 隐藏相
    const { ctx, atlas } = this;
    for (const p of state.powerups) {
      drawTile(ctx, atlas.powerup[p.kind], snapArt(FIELD_X + p.x), snapArt(FIELD_Y + p.y));
    }
  }

  // 子弹按 kind 区分观感：normal / pellet 用经典银弹，spiral 用橙红火球，
  // laser 用沿 dir 的细长亮条（精灵比弹体盒大，按 LASER_SPRITE_OFFSET 居中绘制）。
  private drawBullets(state: GameState): void {
    const { ctx, atlas } = this;
    for (const bullet of state.bullets) {
      if (!bullet.alive) continue;
      const px = FIELD_X + bullet.x;
      const py = FIELD_Y + bullet.y;
      switch (bullet.kind) {
        case 'laser':
          drawTile(
            ctx,
            atlas.bulletLaser[bullet.dir],
            snapArt(px - LASER_SPRITE_OFFSET),
            snapArt(py - LASER_SPRITE_OFFSET),
          );
          break;
        case 'spiral':
          drawTile(ctx, atlas.bulletSpiral, snapArt(px), snapArt(py));
          break;
        default:
          drawTile(ctx, atlas.bullet, snapArt(px), snapArt(py));
          break;
      }
    }
  }

  // 爆炸：帧号由剩余时间推算（tick 驱动）。小爆炸 3 帧 / 大爆炸 2 帧。
  private drawExplosions(state: GameState): void {
    const { ctx, atlas } = this;
    for (const e of state.explosions) {
      let sprite;
      if (e.big) {
        const elapsed = EXPLOSION_BIG_TICKS - e.ticksLeft;
        const frame = Math.min(
          EXPLOSION_BIG_FRAMES - 1,
          Math.floor(elapsed / (EXPLOSION_BIG_TICKS / EXPLOSION_BIG_FRAMES)),
        );
        sprite = atlas.explosionBig[frame];
      } else {
        const elapsed = EXPLOSION_SMALL_TICKS - e.ticksLeft;
        const frame = Math.min(
          EXPLOSION_SMALL_FRAMES - 1,
          Math.floor(elapsed / (EXPLOSION_SMALL_TICKS / EXPLOSION_SMALL_FRAMES)),
        );
        sprite = atlas.explosionSmall[frame];
      }
      drawTile(ctx, sprite, snapArt(FIELD_X + e.x), snapArt(FIELD_Y + e.y));
    }
  }

  // 除 TREES 外的所有地形。砖块按存活象限渲染，水面按 tick 播放两帧。
  // eagleDestroyed 为真时鹰巢画成废墟精灵。
  private drawGround(level: LevelState, tick: number, eagleDestroyed: boolean): void {
    const { ctx, atlas } = this;
    const waterFrame = Math.floor(tick / WATER_ANIM_TICKS) % 2;

    for (let row = 0; row < level.rows; row++) {
      for (let col = 0; col < level.cols; col++) {
        const idx = cellIndex(level, col, row);
        const type = level.cells[idx];
        if (type === Cell.EMPTY || type === Cell.TREES) continue;

        const px = FIELD_X + col * SUBTILE;
        const py = FIELD_Y + row * SUBTILE;

        switch (type) {
          case Cell.BRICK:
            this.drawBrick(px, py, level.brickMask[idx]);
            break;
          case Cell.STEEL:
            drawTile(ctx, atlas.steel, px, py);
            break;
          case Cell.WATER:
            drawTile(ctx, atlas.water[waterFrame], px, py);
            break;
          case Cell.ICE:
            drawTile(ctx, atlas.ice, px, py);
            break;
          case Cell.EAGLE:
            // 2×2 子格鹰巢：仅在左上角格绘制一次 16×16 精灵；被毁后画废墟。
            if (getCell(level, col - 1, row) !== Cell.EAGLE && getCell(level, col, row - 1) !== Cell.EAGLE) {
              drawTile(ctx, eagleDestroyed ? atlas.eagleDestroyed : atlas.eagle, px, py);
            }
            break;
          default:
            break;
        }
      }
    }
  }

  // 树林单独一遍，绘制在实体之上。
  private drawTrees(level: LevelState): void {
    const { ctx, atlas } = this;
    for (let row = 0; row < level.rows; row++) {
      for (let col = 0; col < level.cols; col++) {
        if (level.cells[cellIndex(level, col, row)] !== Cell.TREES) continue;
        drawTile(ctx, atlas.trees, FIELD_X + col * SUBTILE, FIELD_Y + row * SUBTILE);
      }
    }
  }

  // 按 4 个 4×4 象限的存活位绘制砖块。
  private drawBrick(px: number, py: number, mask: number): void {
    const { ctx, atlas } = this;
    if (mask & BRICK_TL) drawQuarter(ctx, atlas.brick, 0, 0, px, py);
    if (mask & BRICK_TR) drawQuarter(ctx, atlas.brick, QUARTER, 0, px + QUARTER, py);
    if (mask & BRICK_BL) drawQuarter(ctx, atlas.brick, 0, QUARTER, px, py + QUARTER);
    if (mask & BRICK_BR) drawQuarter(ctx, atlas.brick, QUARTER, QUARTER, px + QUARTER, py + QUARTER);
  }
}

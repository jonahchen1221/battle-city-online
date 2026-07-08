import {
  ART_SCALE,
  NATIVE_WIDTH,
  NATIVE_HEIGHT,
  FIELD_X,
  FIELD_Y,
  FIELD_WIDTH,
  FIELD_HEIGHT,
  SUBTILE,
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
  COLOR_GAMEOVER,
  COLOR_STAGE_CLEAR,
  COLOR_HUD_ICON,
  COLOR_PAUSE,
  GAMEOVER_SLIDE_TICKS,
  SHIELD_ANIM_TICKS,
  PAUSE_BLINK_TICKS,
  ENEMY_SCORE,
} from '../core/constants';
import { GameState } from '../game/state';
import { Cell, LevelState, cellIndex, getCell } from '../game/level';
import { TankState } from '../game/tank';
import {
  SpriteAtlas,
  TankFrames,
  createSpriteAtlas,
  drawTile,
  drawQuarter,
  drawText,
  textWidth,
} from './sprites';

// 把逻辑坐标吸附到最近的“美术像素”（1/ART_SCALE 逻辑像素）。
// 直接对逻辑坐标取整会把运动量化成 2 美术像素一跳，浪费高清分辨率的平滑度。
function snapArt(v: number): number {
  return Math.round(v * ART_SCALE) / ART_SCALE;
}

// 渲染层只读 GameState，不做任何逻辑推进。
export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private atlas: SpriteAtlas;

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

  draw(state: GameState, _alpha: number): void {
    const { ctx } = this;

    // 屏幕灰边 + 战场黑底（直接的 ctx 矩形按 ART_SCALE 放大）
    ctx.fillStyle = COLOR_FRAME;
    ctx.fillRect(0, 0, NATIVE_WIDTH * ART_SCALE, NATIVE_HEIGHT * ART_SCALE);
    ctx.fillStyle = COLOR_FIELD;
    ctx.fillRect(FIELD_X * ART_SCALE, FIELD_Y * ART_SCALE, FIELD_WIDTH * ART_SCALE, FIELD_HEIGHT * ART_SCALE);

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
    this.drawTanks(state);
    this.drawBullets(state);
    this.drawExplosions(state);

    // 第二遍：树林（覆盖在实体之上，坦克可藏于其下）
    this.drawTrees(state.level);
    ctx.restore();

    // 右侧 HUD 栏（剩余敌军 / 生命 / 关卡旗）
    this.drawHud(state);

    // 结果覆盖层（GAME OVER / STAGE CLEAR），绘制在最上层
    this.drawOverlay(state);

    // 暂停覆盖层（黄色 "PAUSE" 闪烁），凌驾于一切之上
    this.drawPause(state);
  }

  // 右侧 32px 灰栏 HUD（x 224..256）：黑色图标/文字，经典 NES 布局。
  private drawHud(state: GameState): void {
    const { ctx, atlas } = this;
    const hudX = FIELD_X + FIELD_WIDTH; // 224

    // 剩余敌军图标：未出生队列每台一格 8×8，2 个一行，自顶向下。
    for (let i = 0; i < state.enemyQueue.length; i++) {
      const col = i % 2;
      const row = Math.floor(i / 2);
      drawTile(ctx, atlas.hudEnemy, hudX + 5 + col * 12, FIELD_Y + 8 + row * 10);
    }

    // 玩家生命：IP 标签 + 迷你黄坦克 + 存量（= lives-1，与 NES 一致，不含当前在场）。
    const labelY = FIELD_Y + 120;
    drawText(ctx, atlas, 'IP', hudX + 6, labelY, COLOR_HUD_ICON);
    const stock = Math.max(0, state.playerLives - 1);
    drawTile(ctx, atlas.hudLifeTank, hudX + 5, labelY + 12);
    drawText(ctx, atlas, String(stock), hudX + 16, labelY + 13, COLOR_HUD_ICON);

    // 关卡旗 + 关号（当前恒为第 1 关）。
    drawTile(ctx, atlas.hudFlag, hudX + 7, labelY + 34);
    drawText(ctx, atlas, '1', hudX + 12, labelY + 54, COLOR_HUD_ICON);
  }

  // 结果覆盖层。GAME OVER：经典红，phaseTicks 前 GAMEOVER_SLIDE_TICKS 帧由底部滑到中央后停住。
  // STAGE CLEAR：白色，居中静止。
  private drawOverlay(state: GameState): void {
    const { ctx, atlas } = this;
    const cx = FIELD_X + Math.round(FIELD_WIDTH / 2);
    const cy = FIELD_Y + FIELD_HEIGHT / 2 - 4;

    if (state.phase === 'gameover') {
      const text = 'GAME OVER';
      const x = cx - Math.round(textWidth(text) / 2);
      const t = Math.min(state.phaseTicks, GAMEOVER_SLIDE_TICKS) / GAMEOVER_SLIDE_TICKS;
      const startY = FIELD_Y + FIELD_HEIGHT; // 屏幕底部
      const y = Math.round(startY + (cy - startY) * t);
      drawText(ctx, atlas, text, x, y, COLOR_GAMEOVER);
    } else if (state.phase === 'stageclear') {
      this.drawStageClear(state);
    }
  }

  // 通关结算画面：标题 + 逐类击毁数/得分 + 总分，白字，经典战果统计版式。
  private drawStageClear(state: GameState): void {
    const { ctx, atlas } = this;
    const cx = FIELD_X + Math.round(FIELD_WIDTH / 2);
    const white = COLOR_STAGE_CLEAR;

    // 标题："STAGE 1 CLEAR"（当前恒为第 1 关），居中于战场顶部三分之一处。
    const title = 'STAGE 1 CLEAR';
    drawText(ctx, atlas, title, cx - Math.round(textWidth(title) / 2), FIELD_Y + 40, white);

    // 战果表：每行 = 种类名 + "X"计数 + 右对齐得分。四列坐标固定，整体居中于战场。
    const nameX = FIELD_X + 24; // 种类名左缘
    const countX = FIELD_X + 96; // "X"+计数 左缘
    const scoreRightX = FIELD_X + 184; // 得分右缘（右对齐）
    const kinds: Array<['basic' | 'fast' | 'power' | 'armor', string]> = [
      ['basic', 'BASIC'],
      ['fast', 'FAST'],
      ['power', 'POWER'],
      ['armor', 'ARMOR'],
    ];
    let y = FIELD_Y + 74;
    for (const [kind, label] of kinds) {
      const kills = state.killsByKind[kind];
      const pts = kills * ENEMY_SCORE[kind];
      drawText(ctx, atlas, label, nameX, y, white);
      drawText(ctx, atlas, 'X' + kills, countX, y, white);
      const ptsStr = String(pts);
      drawText(ctx, atlas, ptsStr, scoreRightX - textWidth(ptsStr), y, white);
      y += 16;
    }

    // 分隔与总分行。
    y += 8;
    drawText(ctx, atlas, 'TOTAL', nameX, y, white);
    const totalStr = String(state.score);
    drawText(ctx, atlas, totalStr, scoreRightX - textWidth(totalStr), y, white);
  }

  // 暂停覆盖层：黄色 "PAUSE" 居中，按 PAUSE_BLINK_TICKS 周期闪烁（半亮半灭）。
  private drawPause(state: GameState): void {
    if (!state.paused) return;
    if (Math.floor(state.tick / (PAUSE_BLINK_TICKS / 2)) % 2 !== 0) return; // 灭相
    const { ctx, atlas } = this;
    const cx = FIELD_X + Math.round(FIELD_WIDTH / 2);
    const cy = FIELD_Y + FIELD_HEIGHT / 2 - 4;
    const text = 'PAUSE';
    drawText(ctx, atlas, text, cx - Math.round(textWidth(text) / 2), cy, COLOR_PAUSE);
  }

  // 出生闪光星：坦克实体化前在出生点循环播放 4 帧星形。
  private drawSpawnStars(state: GameState): void {
    const { ctx, atlas } = this;
    for (const sp of state.spawning) {
      const elapsed = SPAWN_FLASH_TICKS - sp.ticksLeft;
      const frame = Math.floor(elapsed / SPAWN_STAR_ANIM_TICKS) % 4;
      drawTile(ctx, atlas.spawnStar[frame], snapArt(FIELD_X + sp.tank.x), snapArt(FIELD_Y + sp.tank.y));
    }
  }

  // 坦克。按 kind 选用精灵；装甲坦克受损时每 ARMOR_FLASH_TICKS 帧在银/白间闪烁。
  // 履带动画：移动时每 TRACK_ANIM_TICKS 帧切换两帧，静止时冻结在第 0 帧。
  private drawTanks(state: GameState): void {
    const { ctx, atlas } = this;
    for (const tank of state.tanks) {
      if (!tank.alive) continue;
      const px = snapArt(FIELD_X + tank.x);
      const py = snapArt(FIELD_Y + tank.y);
      const frame = tank.moving ? Math.floor(state.tick / TRACK_ANIM_TICKS) % 2 : 0;
      const frames = this.tankFrames(tank, state.tick);
      const sprite = frames[tank.dir][frame];
      drawTile(ctx, sprite, px, py);

      // 出生护盾：每 SHIELD_ANIM_TICKS 帧切换两帧流光，覆盖在坦克之上。
      if (tank.invulnTicks > 0) {
        const shieldFrame = Math.floor(state.tick / SHIELD_ANIM_TICKS) % 2;
        drawTile(ctx, atlas.shield[shieldFrame], px, py);
      }
    }
  }

  // 根据坦克种类（及装甲受损闪烁）取对应精灵组。
  private tankFrames(tank: TankState, tick: number): TankFrames {
    const { atlas } = this;
    switch (tank.kind) {
      case 'player1':
        return atlas.playerTank;
      case 'fast':
        return atlas.enemyTank.fast;
      case 'power':
        return atlas.enemyTank.power;
      case 'armor': {
        // 受损（hp 未满）时每 ARMOR_FLASH_TICKS 帧在银/白间闪烁。
        const damaged = tank.hp < ARMOR_HP;
        const flash = damaged && Math.floor(tick / ARMOR_FLASH_TICKS) % 2 === 1;
        return flash ? atlas.enemyTank.armorFlash : atlas.enemyTank.armor;
      }
      default:
        return atlas.enemyTank.basic;
    }
  }

  private drawBullets(state: GameState): void {
    const { ctx, atlas } = this;
    for (const bullet of state.bullets) {
      if (!bullet.alive) continue;
      drawTile(ctx, atlas.bullet, snapArt(FIELD_X + bullet.x), snapArt(FIELD_Y + bullet.y));
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

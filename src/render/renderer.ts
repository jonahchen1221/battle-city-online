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
  COLOR_GAMEOVER,
  COLOR_STAGE_CLEAR,
  COLOR_HUD_ICON,
  COLOR_PAUSE,
  GAMEOVER_SLIDE_TICKS,
  SHIELD_ANIM_TICKS,
  PAUSE_BLINK_TICKS,
  CARRIER_FLASH_TICKS,
  POWERUP_BLINK_VISIBLE_TICKS,
  POWERUP_BLINK_CYCLE_TICKS,
} from '../core/constants';
import { GameState } from '../game/state';
import { Cell, LevelState, cellIndex, getCell } from '../game/level';
import { TankState, EnemyKind } from '../game/tank';
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
    // 道具浮标：绘于树林之上（经典 —— 浮于一切之上），仍在战场裁剪区内。
    this.drawPowerup(state);
    ctx.restore();

    // 右侧 HUD 栏（剩余敌军 / 生命 / 关卡旗）
    this.drawHud(state);

    // 结果覆盖层（GAME OVER / STAGE CLEAR），绘制在最上层
    this.drawOverlay(state);

    // 暂停覆盖层（黄色 "PAUSE" 闪烁），凌驾于一切之上
    this.drawPause(state);

    // 关卡开场幕布（STAGE N）：铺满战场的灰色幕布 + 黑字，凌驾于战场内一切之上。
    this.drawStageStart(state);
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

    // 玩家生命：每名在场玩家一行（自上而下堆叠于 32px 栏内）。
    // 每行：'nP' 标签 + 该玩家配色的迷你坦克 + 存量数字（= lives-1，与 NES 一致，不含当前在场）。
    const livesTop = FIELD_Y + 116;
    const rowH = 20;
    for (let i = 0; i < state.playerCount; i++) {
      const rowY = livesTop + i * rowH;
      drawText(ctx, atlas, `${i + 1}P`, hudX + 6, rowY, COLOR_HUD_ICON);
      const stock = Math.max(0, state.livesByPlayer[i] - 1);
      drawTile(ctx, atlas.hudLifeTank[i], hudX + 3, rowY + 8);
      drawText(ctx, atlas, String(stock), hudX + 20, rowY + 13, COLOR_HUD_ICON);
    }

    // 关卡旗 + 当前关号：置于生命块下方。
    const flagY = livesTop + state.playerCount * rowH + 2;
    drawTile(ctx, atlas.hudFlag, hudX + 7, flagY);
    drawText(ctx, atlas, String(state.stage), hudX + 12, flagY + 20, COLOR_HUD_ICON);
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
      // 滑入完成后：多人局在 GAME OVER 下方逐行列出各玩家最终得分（各自配色），再提示重开操作。
      if (state.phaseTicks > GAMEOVER_SLIDE_TICKS) {
        let hintY = cy + 24;
        if (state.playerCount > 1) {
          let ly = cy + 20;
          for (let i = 0; i < state.playerCount; i++) {
            const line = `${i + 1}P ${state.scoreByPlayer[i]}`;
            const color = PLAYER_LABEL_COLORS[i] ?? COLOR_STAGE_CLEAR;
            drawText(ctx, atlas, line, cx - Math.round(textWidth(line) / 2), ly, color);
            ly += 12;
          }
          hintY = ly + 8;
        }
        this.drawRestartHint(state, hintY);
      }
    } else if (state.phase === 'stageclear') {
      this.drawStageClear(state);
    }
  }

  // 闪烁的 "PRESS ENTER" 重开提示（gameover / stageclear 共用），与 PAUSE 同款闪烁节奏。
  private drawRestartHint(state: GameState, y: number): void {
    if (Math.floor(state.phaseTicks / PAUSE_BLINK_TICKS) % 2 !== 0) return; // 灭相
    const { ctx, atlas } = this;
    const cx = FIELD_X + Math.round(FIELD_WIDTH / 2);
    const text = 'PRESS ENTER';
    drawText(ctx, atlas, text, cx - Math.round(textWidth(text) / 2), y, COLOR_STAGE_CLEAR);
  }

  // 通关结算画面：标题 + 每名玩家一列的战果表（逐类击毁数 + 累计总分），经典多人战果统计版式。
  private drawStageClear(state: GameState): void {
    const { ctx, atlas } = this;
    const cx = FIELD_X + Math.round(FIELD_WIDTH / 2);
    const white = COLOR_STAGE_CLEAR;
    const pc = state.playerCount;

    // 标题："STAGE N CLEAR"，居中于战场顶部三分之一处。
    const title = `STAGE ${state.stage} CLEAR`;
    drawText(ctx, atlas, title, cx - Math.round(textWidth(title) / 2), FIELD_Y + 40, white);

    // 列几何：左侧行标签列（48px）+ 每名玩家一列（56px），整块水平居中于 320px 战场。
    // 4 人时 48 + 4×56 = 272 ≤ 320；人数少时整块更窄、仍居中，观感干净。
    const labelColW = 48;
    const playerColW = 56;
    const blockWidth = labelColW + pc * playerColW;
    const blockLeft = FIELD_X + Math.round((FIELD_WIDTH - blockWidth) / 2);
    const cellPadL = 4; // 表头 / 击毁数在列内的左内边距
    const cellPadR = 8; // 总分右对齐时距列右缘的内边距
    const colLeft = (i: number): number => blockLeft + labelColW + i * playerColW;

    // 表头行：每列 "1P".."4P"，用各玩家 PLAYER_LABEL_COLORS 配色。
    const headerY = FIELD_Y + 58;
    for (let i = 0; i < pc; i++) {
      const label = `${i + 1}P`;
      const color = PLAYER_LABEL_COLORS[i] ?? white;
      drawText(ctx, atlas, label, colLeft(i) + cellPadL, headerY, color);
    }

    // 四种敌军行：左侧种类名（白），随后每列该玩家 "X<击毁数>"（白）。
    const kinds: Array<[EnemyKind, string]> = [
      ['basic', 'BASIC'],
      ['fast', 'FAST'],
      ['power', 'POWER'],
      ['armor', 'ARMOR'],
    ];
    let y = FIELD_Y + 76;
    for (const [kind, label] of kinds) {
      drawText(ctx, atlas, label, blockLeft, y, white);
      for (let i = 0; i < pc; i++) {
        const kills = state.killsByPlayer[i][kind];
        drawText(ctx, atlas, 'X' + kills, colLeft(i) + cellPadL, y, white);
      }
      y += 16;
    }

    // 分隔 + 总分行：每列显示该玩家累计总分（列内右对齐），用玩家配色。
    y += 8;
    drawText(ctx, atlas, 'TOTAL', blockLeft, y, white);
    for (let i = 0; i < pc; i++) {
      const scoreStr = String(state.scoreByPlayer[i]);
      const color = PLAYER_LABEL_COLORS[i] ?? white;
      const rx = colLeft(i) + playerColW - cellPadR - textWidth(scoreStr);
      drawText(ctx, atlas, scoreStr, rx, y, color);
    }

    // 重开提示。
    this.drawRestartHint(state, y + 24);
  }

  // 暂停覆盖层：黄色 "PAUSE" 居中，按 PAUSE_BLINK_TICKS 周期闪烁（半亮半灭）。
  private drawPause(state: GameState): void {
    if (!state.paused) return;
    if (Math.floor(state.tick / (PAUSE_BLINK_TICKS / 2)) % 2 !== 0) return; // 灭相
    const { ctx, atlas } = this;
    const cx = FIELD_X + Math.round(FIELD_WIDTH / 2);
    const cy = FIELD_Y + FIELD_HEIGHT / 2 - 4;
    drawText(ctx, atlas, 'PAUSE', cx - Math.round(textWidth('PAUSE') / 2), cy, COLOR_PAUSE);

    // 多人局显示是谁暂停的（该玩家配色）；单人不显示。均提示 "P = RESUME"。
    if (state.playerCount > 1 && state.pausedBy >= 0) {
      const who = `${state.pausedBy + 1}P PAUSED`;
      const color = PLAYER_LABEL_COLORS[state.pausedBy] ?? COLOR_STAGE_CLEAR;
      drawText(ctx, atlas, who, cx - Math.round(textWidth(who) / 2), cy + 16, color);
    }
    const hint = 'P = RESUME';
    drawText(ctx, atlas, hint, cx - Math.round(textWidth(hint) / 2), cy + 32, COLOR_STAGE_CLEAR);
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
    const enemiesFrozen = state.enemyFreezeTicks > 0;
    for (const tank of state.tanks) {
      if (!tank.alive) continue;
      const px = snapArt(FIELD_X + tank.x);
      const py = snapArt(FIELD_Y + tank.y);
      // 冻结中的敌军履带定格第 0 帧（timer 道具）；其余按移动状态播放两帧。
      const frozen = enemiesFrozen && tank.kind !== 'player';
      const frame = tank.moving && !frozen ? Math.floor(state.tick / TRACK_ANIM_TICKS) % 2 : 0;
      const frames = this.tankFrames(tank, state.tick);
      const sprite = frames[tank.dir][frame];
      drawTile(ctx, sprite, px, py);

      // 出生护盾：每 SHIELD_ANIM_TICKS 帧切换两帧流光，覆盖在坦克之上。
      if (tank.invulnTicks > 0) {
        const shieldFrame = Math.floor(state.tick / SHIELD_ANIM_TICKS) % 2;
        drawTile(ctx, atlas.shield[shieldFrame], px, py);
      }

      // 多人局：在每台在场玩家坦克上方绘制该玩家配色的 "1P".."4P" 小标签，
      // 居中于坦克、夹紧在战场矩形内（与坦克同处裁剪区内，故也会被树林遮挡）。
      // 单机局（playerCount===1）不绘制，保持原版清爽观感。
      if (state.playerCount > 1 && tank.kind === 'player') {
        const label = `${tank.playerIndex + 1}P`;
        const w = textWidth(label);
        const color = PLAYER_LABEL_COLORS[tank.playerIndex] ?? COLOR_HUD_ICON;
        let lx = Math.round(px + TANK_SIZE / 2 - w / 2);
        let ly = py - 9;
        lx = Math.max(FIELD_X, Math.min(lx, FIELD_X + FIELD_WIDTH - w));
        ly = Math.max(FIELD_Y, ly);
        drawText(ctx, atlas, label, lx, ly, color);
      }
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
      default:
        return flashRed ? atlas.enemyTankRed.basic : atlas.enemyTank.basic;
    }
  }

  // 道具浮标：按 32 帧周期闪烁（前 24 帧可见、后 8 帧隐藏），画于战场裁剪区内、树林之上。
  private drawPowerup(state: GameState): void {
    const p = state.powerup;
    if (!p) return;
    if (state.tick % POWERUP_BLINK_CYCLE_TICKS >= POWERUP_BLINK_VISIBLE_TICKS) return; // 隐藏相
    const { ctx, atlas } = this;
    drawTile(ctx, atlas.powerup[p.kind], snapArt(FIELD_X + p.x), snapArt(FIELD_Y + p.y));
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

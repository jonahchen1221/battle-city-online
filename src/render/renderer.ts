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
  WATER_FOAM_ANIM_TICKS,
  COLOR_WATER_EDGE,
  COLOR_WATER_FOAM,
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
  SPIRAL_RADIUS,
  SPIRAL_PERIOD_TICKS,
  COLOR_WEAPON_SPREAD,
  COLOR_WEAPON_SPIRAL,
  COLOR_WEAPON_LASER,
  COLOR_WEAPON_MACHINE,
  SMART_MARKER_PULSE_TICKS,
  COLOR_SMART_MARKER,
  BOSS_LASER_WIDTH,
  BOSS_AIM_BLINK_TICKS,
  COLOR_BOSS_HP_BACK,
  COLOR_BOSS_HP_HIGH,
  COLOR_BOSS_HP_MID,
  COLOR_BOSS_HP_LOW,
  COLOR_BOSS_AIM,
  COLOR_BOSS_LASER_CORE,
  COLOR_BOSS_LASER_EDGE,
  COLOR_BOSS_FREEZE,
  COLOR_BOSS_CHARGE_WARN,
  COLOR_BOSS_MORTAR_MARK,
  COLOR_BOSS_MAGNET,
  BOSS_CHARGE_BLINK_TICKS,
  BOSS_MORTAR_BLAST,
  BOSS_MORTAR_MARK_BLINK_TICKS,
  BOSS_MINE_BLINK_TICKS,
  BOSS_MAGNET_PULSE_TICKS,
  ESCORT_SIZE,
  TICKS_PER_SECOND,
  DASH_COOLDOWN_TICKS,
  DASH_RING_RADIUS,
  DASH_RING_SAMPLES,
  DASH_READY_BLINK_TICKS,
  DASH_TRAIL_STEPS,
  COLOR_DASH_RING,
  COLOR_DASH_READY,
  isVersusStage,
} from '../core/constants';
import type { Direction } from '../core/types';
import { GameState } from '../game/state';
import type { BulletState } from '../game/bullet';
import { Cell, LevelState, cellIndex, getCell } from '../game/level';
import { TankState, EnemyKind, WeaponKind } from '../game/tank';
import {
  escortGuardOccupancy,
  escortGuardSlots,
  escortHasGuard,
  escortProgress,
} from '../game/escort';
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
  FONT_ADVANCE,
} from './sprites';

// 冲刺残影的偏移方向：坦克朝向的反方向（残影落在车尾）。
const DASH_TRAIL_BACK: Record<Direction, { x: number; y: number }> = {
  up: { x: 0, y: 1 },
  down: { x: 0, y: -1 },
  left: { x: 1, y: 0 },
  right: { x: -1, y: 0 },
};

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
  private cameraX = 0;
  private cameraY = 0;
  private cameraLevelEpoch = -1;

  // 只读暴露图集，供 src/client 的标题/大厅 UI 复用精灵（如菜单光标用的迷你坦克）。
  // 客户端 UI 层绝不修改图集，仅取样绘制。
  get spriteAtlas(): SpriteAtlas {
    return this.atlas;
  }

  constructor(canvas: HTMLCanvasElement) {
    // 画布内部分辨率 = 原生尺寸 × 美术倍数（736×512）。所有布局数学仍以逻辑像素书写，
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

  draw(
    state: GameState,
    _alpha: number,
    playerNames: readonly string[] = [],
    localPlayerIndex = 0,
  ): void {
    const { ctx } = this;
    const camera = this.updateCamera(state, localPlayerIndex);

    this.drawCabinetFrame();
    this.drawFieldBackdrop();

    // 大地图的世界层在固定视口内裁剪，再整体平移镜头偏移。
    ctx.save();
    ctx.beginPath();
    ctx.rect(FIELD_X * ART_SCALE, FIELD_Y * ART_SCALE, FIELD_WIDTH * ART_SCALE, FIELD_HEIGHT * ART_SCALE);
    ctx.clip();
    ctx.translate(-camera.x * ART_SCALE, -camera.y * ART_SCALE);
    // 路线是地表标记，先画它再画地形：砖墙/水路会自然覆盖路线，表明正在堵路。
    this.drawEscortRoute(state);
    // 第一遍：地形中除树林外的一切（在实体之下）。
    this.drawGround(state.level, state.tick, state.eagleDestroyed);
    this.drawEscortGoal(state);
    this.drawEscort(state);
    this.drawSpawnStars(state);
    // Boss 地雷是地表物件：绘于地形之上、坦克之下（不遮挡自己的车）。
    this.drawBossMines(state);
    // 冲撞预警带同样是地表警戒标记，压在地形上、实体之下。
    this.drawBossCharge(state);
    // Boss 车体绘于坦克之下：玩家贴到车体边缘时仍能看清自己的坦克。
    this.drawBoss(state);
    this.drawBossMagnet(state);
    this.drawTanks(state, playerNames);
    // 护卫位压在坦克轮廓上：玩家就位后仍能看到绿色角标确认已激活。
    this.drawEscortGuardSlots(state);
    this.drawBullets(state);
    // 瞄准线 / 激光绘于坦克之上：前摇与激活相都必须一眼可辨（这是全部躲避判断的依据）。
    this.drawBossBeams(state);
    // 迫击炮落点十字同理：必须压在坦克之上，站在标记里的人一眼看见。
    this.drawBossMortarMarks(state);
    this.drawExplosions(state);

    // 第二遍：树林（覆盖在实体之上，坦克可藏于其下）
    this.drawTrees(state.level);
    // 智能坦克标记在树林之后绘制：即使车体藏在树下，也能明确辨认其 AI 身份和位置。
    this.drawSmartTankMarkers(state);
    // 道具浮标：绘于树林之上（经典 —— 浮于一切之上），仍在战场裁剪区内。
    this.drawPowerup(state);
    // Boss 血条：战场顶部整宽度条，压在一切战场元素之上（Boss 关地图顶部两行本就留空）。
    this.drawBossHealth(state);
    ctx.restore();

    this.drawEscortHud(state, camera.x, camera.y);

    // 右侧 HUD 栏（剩余敌军 / 生命 / 关卡旗）
    this.drawHud(state, playerNames);

    // 结果覆盖层（GAME OVER / STAGE CLEAR），绘制在最上层
    this.drawOverlay(state, playerNames);

    // 暂停覆盖层（黄色 "PAUSE" 闪烁），凌驾于一切之上
    this.drawPause(state, playerNames);

    // 关卡开场幕布（STAGE N）：铺满战场的灰色幕布 + 黑字，凌驾于战场内一切之上。
    this.drawStageStart(state);
  }

  // 镜头直接跟随本地玩家；世界尺寸不超过视口时始终回到 (0,0)。
  // 首帧/跨关直接对齐，其余帧缓动，避免坦克每个逻辑帧都拉扯画面。
  private updateCamera(
    state: GameState,
    localPlayerIndex: number,
  ): { x: number; y: number } {
    const maxX = Math.max(0, state.level.cols * SUBTILE - FIELD_WIDTH);
    const maxY = Math.max(0, state.level.rows * SUBTILE - FIELD_HEIGHT);
    if (maxX === 0 && maxY === 0) {
      this.cameraX = 0;
      this.cameraY = 0;
      this.cameraLevelEpoch = state.levelEpoch;
      return { x: 0, y: 0 };
    }

    let target = state.tanks.find(
      (tank) => tank.alive && tank.kind === 'player' && tank.playerIndex === localPlayerIndex,
    );
    if (!target) {
      target = state.spawning.find(
        (spawn) => spawn.tank.kind === 'player' && spawn.tank.playerIndex === localPlayerIndex,
      )?.tank;
    }
    const targetX = target ? target.x + TANK_SIZE / 2 : (state.escort?.x ?? 0) + ESCORT_SIZE / 2;
    const targetY = target ? target.y + TANK_SIZE / 2 : (state.escort?.y ?? 0) + ESCORT_SIZE / 2;
    const desiredX = Math.max(0, Math.min(maxX, targetX - FIELD_WIDTH / 2));
    const desiredY = Math.max(0, Math.min(maxY, targetY - FIELD_HEIGHT / 2));
    if (this.cameraLevelEpoch !== state.levelEpoch) {
      this.cameraX = desiredX;
      this.cameraY = desiredY;
      this.cameraLevelEpoch = state.levelEpoch;
    } else {
      this.cameraX += (desiredX - this.cameraX) * 0.14;
      this.cameraY += (desiredY - this.cameraY) * 0.14;
    }
    this.cameraX = snapArt(this.cameraX);
    this.cameraY = snapArt(this.cameraY);
    return { x: this.cameraX, y: this.cameraY };
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

  // 绘制本关完整折线路线：每段都有深色车道、边界和两条履带印。
  private drawEscortRoute(state: GameState): void {
    const escort = state.escort;
    if (!escort) return;
    const { ctx } = this;
    const laneWidth = ESCORT_SIZE + 16;
    for (let i = 1; i < escort.route.length; i++) {
      const a = escort.route[i - 1];
      const b = escort.route[i];
      if (a.x === b.x) {
        const left = FIELD_X + a.x - 8;
        const top = FIELD_Y + Math.min(a.y, b.y);
        const height = Math.abs(a.y - b.y) + ESCORT_SIZE;
        ctx.fillStyle = '#111813';
        ctx.fillRect(left * ART_SCALE, top * ART_SCALE, laneWidth * ART_SCALE, height * ART_SCALE);
        ctx.fillStyle = '#343d34';
        ctx.fillRect(left * ART_SCALE, top * ART_SCALE, 2 * ART_SCALE, height * ART_SCALE);
        ctx.fillRect(
          (left + laneWidth - 2) * ART_SCALE,
          top * ART_SCALE,
          2 * ART_SCALE,
          height * ART_SCALE,
        );
        for (let y = top + 10; y < top + height; y += 16) {
          ctx.fillStyle = '#465044';
          ctx.fillRect((left + 7) * ART_SCALE, y * ART_SCALE, 7 * ART_SCALE, 3 * ART_SCALE);
          ctx.fillRect((left + laneWidth - 14) * ART_SCALE, y * ART_SCALE, 7 * ART_SCALE, 3 * ART_SCALE);
        }
      } else {
        const left = FIELD_X + Math.min(a.x, b.x);
        const top = FIELD_Y + a.y - 8;
        const width = Math.abs(a.x - b.x) + ESCORT_SIZE;
        ctx.fillStyle = '#111813';
        ctx.fillRect(left * ART_SCALE, top * ART_SCALE, width * ART_SCALE, laneWidth * ART_SCALE);
        ctx.fillStyle = '#343d34';
        ctx.fillRect(left * ART_SCALE, top * ART_SCALE, width * ART_SCALE, 2 * ART_SCALE);
        ctx.fillRect(
          left * ART_SCALE,
          (top + laneWidth - 2) * ART_SCALE,
          width * ART_SCALE,
          2 * ART_SCALE,
        );
        for (let x = left + 10; x < left + width; x += 16) {
          ctx.fillStyle = '#465044';
          ctx.fillRect(x * ART_SCALE, (top + 7) * ART_SCALE, 3 * ART_SCALE, 7 * ART_SCALE);
          ctx.fillRect(x * ART_SCALE, (top + laneWidth - 14) * ART_SCALE, 3 * ART_SCALE, 7 * ART_SCALE);
        }
      }
    }
  }

  // 护送终点：黄黑棋盘线垂直于最后一段路线。
  private drawEscortGoal(state: GameState): void {
    const escort = state.escort;
    if (!escort) return;
    const { ctx } = this;
    const goal = escort.route.at(-1)!;
    const before = escort.route.at(-2)!;
    const horizontal = goal.y === before.y;
    if (horizontal) {
      const x = FIELD_X + goal.x + (goal.x > before.x ? ESCORT_SIZE - 2 : -2);
      const y = FIELD_Y + goal.y - 16;
      for (let i = 0; i < 8; i++) {
        ctx.fillStyle = i % 2 === 0 ? '#f0c840' : '#242826';
        ctx.fillRect(x * ART_SCALE, (y + i * 8) * ART_SCALE, 4 * ART_SCALE, 8 * ART_SCALE);
      }
    } else {
      const x = FIELD_X + goal.x - 16;
      const y = FIELD_Y + goal.y + (goal.y > before.y ? ESCORT_SIZE - 2 : -2);
      for (let i = 0; i < 8; i++) {
        ctx.fillStyle = i % 2 === 0 ? '#f0c840' : '#242826';
        ctx.fillRect((x + i * 8) * ART_SCALE, y * ART_SCALE, 8 * ART_SCALE, 4 * ART_SCALE);
      }
    }
  }

  // 32×32 移动鹰巢：宽履带 + 装甲车体 + 原作鹰巢标志。
  private drawEscort(state: GameState): void {
    const escort = state.escort;
    if (!escort) return;
    const { ctx, atlas } = this;
    const x = snapArt(FIELD_X + escort.x);
    const y = snapArt(FIELD_Y + escort.y);
    const treadShift = escort.moving && Math.floor(state.tick / TRACK_ANIM_TICKS) % 2 === 1 ? 2 : 0;

    const horizontal = escort.dir === 'left' || escort.dir === 'right';
    ctx.fillStyle = '#171c19';
    if (horizontal) {
      ctx.fillRect(x * ART_SCALE, y * ART_SCALE, ESCORT_SIZE * ART_SCALE, 7 * ART_SCALE);
      ctx.fillRect(x * ART_SCALE, (y + 25) * ART_SCALE, ESCORT_SIZE * ART_SCALE, 7 * ART_SCALE);
      ctx.fillStyle = '#786838';
      for (let col = -treadShift; col < ESCORT_SIZE; col += 6) {
        ctx.fillRect((x + col) * ART_SCALE, (y + 1) * ART_SCALE, 3 * ART_SCALE, 5 * ART_SCALE);
        ctx.fillRect((x + col) * ART_SCALE, (y + 26) * ART_SCALE, 3 * ART_SCALE, 5 * ART_SCALE);
      }
      ctx.fillStyle = '#6f8c4b';
      ctx.fillRect((x + 2) * ART_SCALE, (y + 6) * ART_SCALE, 28 * ART_SCALE, 20 * ART_SCALE);
      ctx.fillStyle = '#a3b65f';
      ctx.fillRect((x + 5) * ART_SCALE, (y + 9) * ART_SCALE, 4 * ART_SCALE, 14 * ART_SCALE);
      drawTile(ctx, atlas.eagle, x + 8, y + 8);
    } else {
      ctx.fillRect(x * ART_SCALE, y * ART_SCALE, 7 * ART_SCALE, ESCORT_SIZE * ART_SCALE);
      ctx.fillRect((x + 25) * ART_SCALE, y * ART_SCALE, 7 * ART_SCALE, ESCORT_SIZE * ART_SCALE);
      ctx.fillStyle = '#786838';
      for (let row = -treadShift; row < ESCORT_SIZE; row += 6) {
        ctx.fillRect((x + 1) * ART_SCALE, (y + row) * ART_SCALE, 5 * ART_SCALE, 3 * ART_SCALE);
        ctx.fillRect((x + 26) * ART_SCALE, (y + row) * ART_SCALE, 5 * ART_SCALE, 3 * ART_SCALE);
      }
      ctx.fillStyle = '#6f8c4b';
      ctx.fillRect((x + 6) * ART_SCALE, (y + 2) * ART_SCALE, 20 * ART_SCALE, 28 * ART_SCALE);
      ctx.fillStyle = '#a3b65f';
      ctx.fillRect((x + 9) * ART_SCALE, (y + 5) * ART_SCALE, 14 * ART_SCALE, 4 * ART_SCALE);
      drawTile(ctx, atlas.eagle, x + 8, y + 10);
    }
  }

  // 车辆护卫位：每位由连续两格组成；四角框、分格线与箭头均不使用容易误读为路线的“+”。
  private drawEscortGuardSlots(state: GameState): void {
    const escort = state.escort;
    if (!escort || escort.timeExpired || escort.arrived) return;
    const { ctx } = this;
    const slots = escortGuardSlots(escort, state.activePlayerCount);
    const occupied = escortGuardOccupancy(state);

    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const x = snapArt(FIELD_X + slot.x);
      const y = snapArt(FIELD_Y + slot.y);
      const active = occupied[i];
      const color = active
        ? '#78e048'
        : Math.floor(state.tick / 12) % 2 === 0
          ? '#f0c840'
          : '#a89848';

      ctx.fillStyle = active ? 'rgba(24,72,30,0.45)' : 'rgba(58,48,18,0.38)';
      ctx.fillRect(x * ART_SCALE, y * ART_SCALE, slot.width * ART_SCALE, slot.height * ART_SCALE);
      ctx.fillStyle = color;
      const arm = 5;
      const thick = 2;
      ctx.fillRect(x * ART_SCALE, y * ART_SCALE, arm * ART_SCALE, thick * ART_SCALE);
      ctx.fillRect(x * ART_SCALE, y * ART_SCALE, thick * ART_SCALE, arm * ART_SCALE);
      ctx.fillRect((x + slot.width - arm) * ART_SCALE, y * ART_SCALE, arm * ART_SCALE, thick * ART_SCALE);
      ctx.fillRect((x + slot.width - thick) * ART_SCALE, y * ART_SCALE, thick * ART_SCALE, arm * ART_SCALE);
      ctx.fillRect(x * ART_SCALE, (y + slot.height - thick) * ART_SCALE, arm * ART_SCALE, thick * ART_SCALE);
      ctx.fillRect(x * ART_SCALE, (y + slot.height - arm) * ART_SCALE, thick * ART_SCALE, arm * ART_SCALE);
      ctx.fillRect(
        (x + slot.width - arm) * ART_SCALE,
        (y + slot.height - thick) * ART_SCALE,
        arm * ART_SCALE,
        thick * ART_SCALE,
      );
      ctx.fillRect(
        (x + slot.width - thick) * ART_SCALE,
        (y + slot.height - arm) * ART_SCALE,
        thick * ART_SCALE,
        arm * ART_SCALE,
      );
      // 两个坦克格之间的分隔短线，让有效站位范围一眼可见。
      ctx.globalAlpha = 0.55;
      if (slot.width > TANK_SIZE) {
        for (let offset = TANK_SIZE; offset < slot.width; offset += TANK_SIZE) {
          ctx.fillRect((x + offset) * ART_SCALE, y * ART_SCALE, ART_SCALE, slot.height * ART_SCALE);
        }
      } else {
        for (let offset = TANK_SIZE; offset < slot.height; offset += TANK_SIZE) {
          ctx.fillRect(x * ART_SCALE, (y + offset) * ART_SCALE, slot.width * ART_SCALE, ART_SCALE);
        }
      }
      ctx.globalAlpha = 1;
      // 五个 2×2 像素块组成朝向车身的尖括号，不依赖字体字符。
      const arrowDots: Record<'up' | 'down' | 'left' | 'right', Array<[number, number]>> = {
        right: [[4, 3], [6, 5], [8, 7], [6, 9], [4, 11]],
        left: [[10, 3], [8, 5], [6, 7], [8, 9], [10, 11]],
        down: [[3, 4], [5, 6], [7, 8], [9, 6], [11, 4]],
        up: [[3, 10], [5, 8], [7, 6], [9, 8], [11, 10]],
      };
      const arrowX = x + (slot.width - TANK_SIZE) / 2;
      const arrowY = y + (slot.height - TANK_SIZE) / 2;
      for (const [ox, oy] of arrowDots[slot.inward]) {
        ctx.fillRect((arrowX + ox) * ART_SCALE, (arrowY + oy) * ART_SCALE, 2 * ART_SCALE, 2 * ART_SCALE);
      }
    }
  }

  // 固定在视口左上的护送状态条，并在车队离开本地玩家画面时给出方向标记。
  private drawEscortHud(state: GameState, cameraX: number, cameraY: number): void {
    const escort = state.escort;
    if (!escort || state.phase === 'stagestart') return;
    const { ctx, atlas } = this;
    const x = FIELD_X + 4;
    const y = FIELD_Y + 4;
    ctx.fillStyle = 'rgba(0,0,0,0.82)';
    ctx.fillRect(x * ART_SCALE, y * ART_SCALE, 176 * ART_SCALE, 27 * ART_SCALE);
    drawTextOutlined(ctx, atlas, 'ESCORT', x + 4, y + 3, '#ffffff');
    const guarded = escortHasGuard(state);
    const timerPaused = state.shovelTicks > 0;
    const status = escort.timeExpired
      ? 'TIME'
      : escort.arrived
        ? 'SAFE'
        : timerPaused
          ? 'HOLD'
        : escort.moving
          ? 'GO'
          : !guarded
            ? 'WAIT'
            : 'STOP';
    const urgent = escort.timeLeftTicks <= 30 * TICKS_PER_SECOND;
    const statusColor = escort.timeExpired || urgent
      ? '#f85838'
      : timerPaused
        ? '#78d8f8'
        : escort.moving
          ? '#78e048'
          : '#f0c840';
    drawTextOutlined(ctx, atlas, status, x + 56, y + 3, statusColor);
    const secondsLeft = Math.ceil(escort.timeLeftTicks / TICKS_PER_SECOND);
    drawTextOutlined(ctx, atlas, `${secondsLeft}`, x + 104, y + 3, statusColor);
    const progress = escortProgress(escort);
    const progressPercent = escort.arrived ? 100 : Math.min(99, Math.floor(progress * 100));
    drawTextOutlined(ctx, atlas, `${progressPercent}%`, x + 140, y + 3, '#78d8f8');
    const barX = x + 4;
    const barY = y + 14;
    const barW = 168;
    ctx.fillStyle = '#303632';
    ctx.fillRect(barX * ART_SCALE, barY * ART_SCALE, barW * ART_SCALE, 4 * ART_SCALE);
    const ratio = escort.timeLimitTicks > 0 ? escort.timeLeftTicks / escort.timeLimitTicks : 0;
    ctx.fillStyle = timerPaused ? '#78d8f8' : ratio > 0.5 ? '#70dc58' : ratio > 0.25 ? '#f0c840' : '#f85838';
    ctx.fillRect(barX * ART_SCALE, barY * ART_SCALE, Math.round(barW * ratio) * ART_SCALE, 4 * ART_SCALE);
    ctx.fillStyle = '#303632';
    ctx.fillRect(barX * ART_SCALE, (barY + 7) * ART_SCALE, barW * ART_SCALE, 3 * ART_SCALE);
    ctx.fillStyle = '#78d8f8';
    ctx.fillRect(
      barX * ART_SCALE,
      (barY + 7) * ART_SCALE,
      Math.round(barW * progress) * ART_SCALE,
      3 * ART_SCALE,
    );

    const screenX = escort.x + ESCORT_SIZE / 2 - cameraX;
    const screenY = escort.y + ESCORT_SIZE / 2 - cameraY;
    if (screenX >= 0 && screenX <= FIELD_WIDTH && screenY >= 0 && screenY <= FIELD_HEIGHT) return;
    const markerX = FIELD_X + Math.max(8, Math.min(FIELD_WIDTH - 14, screenX));
    const markerY = FIELD_Y + Math.max(36, Math.min(FIELD_HEIGHT - 14, screenY));
    ctx.fillStyle = '#050706';
    ctx.fillRect((markerX - 3) * ART_SCALE, (markerY - 3) * ART_SCALE, 13 * ART_SCALE, 13 * ART_SCALE);
    drawTextOutlined(ctx, atlas, 'E', markerX, markerY, statusColor);
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
    if (state.escort || isVersusStage(state.stage)) {
      const versus = isVersusStage(state.stage);
      const mission = versus ? 'VERSUS' : 'ESCORT';
      drawText(
        ctx,
        atlas,
        mission,
        cx - Math.round(textWidth(mission) / 2),
        cy + 20,
        '#31472c',
      );
      if (versus) {
        const matchup = `${state.playerCount}P VS ${state.playerCount}AI`;
        drawText(
          ctx,
          atlas,
          matchup,
          cx - Math.round(textWidth(matchup) / 2),
          cy + 32,
          '#31472c',
        );
      }
    }
    // 不显眼的操作提示：教会玩家 P 可暂停（每关开场都会看到，不占游戏画面）。
    const hint = 'P = PAUSE';
    const hintY = isVersusStage(state.stage) ? cy + 50 : cy + 40;
    drawText(ctx, atlas, hint, cx - Math.round(textWidth(hint) / 2), hintY, COLOR_HUD_ICON);
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
    const versus = isVersusStage(state.stage);
    drawText(ctx, atlas, versus ? 'AI' : 'LEFT', hudX + 5, FIELD_Y + 5, '#242826');

    if (versus) {
      // 对战关按 AI 席位显示各自备用命，与下方玩家“lives-1”口径一致。
      for (let i = 0; i < state.versusLivesByEnemy.length; i++) {
        const rowY = FIELD_Y + 18 + i * 22;
        drawText(ctx, atlas, `A${i + 1}`, hudX + 5, rowY, COLOR_SMART_MARKER);
        drawTile(ctx, atlas.hudEnemy, hudX + 5, rowY + 8);
        drawText(
          ctx,
          atlas,
          String(Math.max(0, state.versusLivesByEnemy[i] - 1)),
          hudX + 20,
          rowY + 9,
          COLOR_HUD_ICON,
        );
      }
    } else {
      // 剩余敌军图标：未出生队列每台一格 8×8，2 个一行，自顶向下。
      for (let i = 0; i < state.enemyQueue.length; i++) {
        const col = i % 2;
        const row = Math.floor(i / 2);
        drawTile(ctx, atlas.hudEnemy, hudX + 5 + col * 12, FIELD_Y + 16 + row * 10);
      }
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
    // 关号在旗子（16px 宽，中心 hudX+15）正下方居中：第 10 关起是两位数，需再左移半个字宽。
    const stageText = String(state.stage);
    const stageX = hudX + 15 - Math.round((stageText.length * FONT_ADVANCE) / 2);
    drawText(ctx, atlas, stageText, stageX, flagY + 20, COLOR_HUD_ICON);
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

  // 闪烁的推进提示：GAME OVER 重试当前关，STAGE CLEAR 进入下一关。
  private drawRestartHint(state: GameState, y: number): void {
    if (Math.floor(state.phaseTicks / PAUSE_BLINK_TICKS) % 2 !== 0) return; // 灭相
    const { ctx, atlas } = this;
    const cx = FIELD_X + Math.round(FIELD_WIDTH / 2);
    const text = state.phase === 'gameover' ? 'ENTER RETRY STAGE' : 'PRESS ENTER';
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
      // 冲刺残影：在坦克后方（朝向反方向）按 DASH_TRAIL_STEPS 各画一份当前精灵。
      // 画在车体之下（先绘制），远的更淡，形成拖尾。
      if (tank.dashTicks > 0) {
        const back = DASH_TRAIL_BACK[tank.dir];
        for (const step of DASH_TRAIL_STEPS) {
          ctx.globalAlpha = step.alpha;
          drawTile(ctx, sprite, snapArt(px + back.x * step.dist), snapArt(py + back.y * step.dist));
        }
        ctx.globalAlpha = 1;
      }

      // 幽灵态（ghost 道具）：整台坦克半透明绘制 —— 与友军冻结的“明灭闪烁”是两种观感，不会混淆。
      const ghosting = tank.ghostTicks > 0;
      if (ghosting) ctx.globalAlpha = GHOST_RENDER_ALPHA;
      if (!freezeBlinkOff) drawTile(ctx, sprite, px, py);
      if (ghosting) ctx.globalAlpha = 1;

      // 冲刺技能的倒计时圆环 / 就绪黄闪：所有存活玩家坦克都画（多人时能看到队友的 CD）。
      if (tank.kind === 'player') {
        const cx = px + TANK_SIZE / 2;
        const cy = py + TANK_SIZE / 2;
        if (tank.dashCooldown > 0) {
          // 剩余比例 × 360°，自 12 点方向顺时针。
          this.drawDashRing(cx, cy, tank.dashCooldown / DASH_COOLDOWN_TICKS, COLOR_DASH_RING);
        } else if (tank.dashReadyFlashTicks > 0) {
          // 就绪：满圈黄色，每 DASH_READY_BLINK_TICKS 帧明灭一次（约闪三下后消失）。
          const on =
            Math.floor(tank.dashReadyFlashTicks / DASH_READY_BLINK_TICKS) % 2 === 0;
          if (on) this.drawDashRing(cx, cy, 1, COLOR_DASH_READY);
        }
        if (!freezeBlinkOff) {
          // 车尾的 1–3 枚亮色等级标记，让实际游戏尺寸下的升级模型仍能快速辨级。
          this.drawPlayerLevelPips(tank, px, py);
          if (tank.level >= 3) {
            if (tank.armor > 0) this.drawPlayerArmorPlates(px, py, state.tick);
            else this.drawPlayerBrokenArmor(px, py, state.tick);
          }
          // 车体生命只剩 1 点时持续冒烟并闪烁红色故障核心。
          if (tank.level >= 1 && tank.hp === 1) this.drawPlayerDamageSmoke(px, py, state.tick);
        }
      }

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
        lx = Math.max(FIELD_X, Math.min(lx, FIELD_X + state.level.cols * SUBTILE - w));
        ly = Math.max(FIELD_Y, ly);
        drawTextOutlined(ctx, atlas, label, lx, ly, color);
      }
    }
  }

  // 冲刺技能的像素风圆环：以坦克中心为圆心、DASH_RING_RADIUS 为半径，
  // 自 12 点方向（-90°）起顺时针画「ratio × 360°」的弧段。
  // 刻意不用 ctx.arc（抗锯齿曲线不合 NES 观感）：沿弧等角采样、逐点画 1 逻辑像素的方点，
  // 并先用黑色 3×3 垫底，保证在砖 / 钢 / 冰 / 树林任何地形上都读得出来。
  private drawDashRing(cx: number, cy: number, ratio: number, color: string): void {
    const { ctx } = this;
    if (ratio <= 0) return;
    const steps = Math.max(1, Math.round(DASH_RING_SAMPLES * Math.min(1, ratio)));
    // 相邻采样点取整后可能落在同一像素，去重避免重复填充（也让垫底一次画完）。
    const pts: Array<{ x: number; y: number }> = [];
    const seen = new Set<number>();
    for (let i = 0; i < steps; i++) {
      const a = -Math.PI / 2 + (i / DASH_RING_SAMPLES) * Math.PI * 2;
      const x = Math.round(cx + Math.cos(a) * DASH_RING_RADIUS);
      const y = Math.round(cy + Math.sin(a) * DASH_RING_RADIUS);
      const key = x * 4096 + y;
      if (seen.has(key)) continue;
      seen.add(key);
      pts.push({ x, y });
    }
    ctx.fillStyle = COLOR_FIELD; // 黑色垫底（两趟绘制：垫底不会盖掉相邻的亮点）
    for (const p of pts) {
      ctx.fillRect((p.x - 1) * ART_SCALE, (p.y - 1) * ART_SCALE, 3 * ART_SCALE, 3 * ART_SCALE);
    }
    ctx.fillStyle = color;
    for (const p of pts) ctx.fillRect(p.x * ART_SCALE, p.y * ART_SCALE, ART_SCALE, ART_SCALE);
  }

  private drawArtRect(x: number, y: number, w: number, h: number, color: string): void {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(
      Math.round(x * ART_SCALE),
      Math.round(y * ART_SCALE),
      Math.max(1, Math.round(w * ART_SCALE)),
      Math.max(1, Math.round(h * ART_SCALE)),
    );
  }

  private drawPlayerLevelPips(tank: TankState, px: number, py: number): void {
    const count = Math.max(0, Math.min(3, tank.level));
    const color = PLAYER_LABEL_COLORS[tank.playerIndex] ?? '#ffffff';
    const startX = px + 8 - (count * 2 - 0.5) / 2;
    for (let i = 0; i < count; i++) {
      this.drawArtRect(startX + i * 2, py + 13.5, 1.5, 1, '#101010');
      this.drawArtRect(startX + i * 2, py + 13, 1.5, 1, color);
    }
  }

  // 完整的 3 级护甲使用高亮银蓝外挂侧板；与 helmet 的环形流光护盾明显区分。
  private drawPlayerArmorPlates(px: number, py: number, tick: number): void {
    const bright = Math.floor(tick / 8) % 2 === 0;
    const steel = bright ? '#e8f8ff' : '#78c8e8';
    const shadow = '#305878';
    this.drawArtRect(px - 1, py + 3, 1.5, 10, shadow);
    this.drawArtRect(px - 1, py + 3, 1, 8.5, steel);
    this.drawArtRect(px + 15.5, py + 3, 1.5, 10, shadow);
    this.drawArtRect(px + 16, py + 3, 1, 8.5, steel);
    this.drawArtRect(px + 2, py - 0.5, 4, 1, steel);
    this.drawArtRect(px + 10, py - 0.5, 4, 1, steel);
    this.drawArtRect(px - 0.5, py + 5, 1, 1, '#ffffff');
    this.drawArtRect(px + 15.5, py + 5, 1, 1, '#ffffff');
  }

  // 护甲已碎时保留四段暗色断口，并偶尔冒出橙色电火花，避免只靠换回 2 级车身来表达。
  private drawPlayerBrokenArmor(px: number, py: number, tick: number): void {
    const metal = '#586068';
    this.drawArtRect(px - 0.5, py + 4, 1, 3, metal);
    this.drawArtRect(px - 0.5, py + 10, 1, 2, metal);
    this.drawArtRect(px + 15.5, py + 4, 1, 2, metal);
    this.drawArtRect(px + 15.5, py + 9, 1, 3, metal);
    if (Math.floor(tick / 6) % 3 === 0) {
      this.drawArtRect(px + 16.5, py + 7, 1, 1, '#ffb830');
      this.drawArtRect(px - 1.5, py + 8, 1, 1, '#ff5038');
    }
  }

  // 残血烟雾直接以美术像素绘制，三相循环向上漂移；红色核心在车体中央持续闪烁。
  private drawPlayerDamageSmoke(px: number, py: number, tick: number): void {
    const phase = Math.floor(tick / 6) % 3;
    const puffs = [
      { x: 10 + (phase % 2), y: 2 - phase, size: 2.5, color: '#505050' },
      { x: 12 - (phase % 2), y: -1 - phase, size: 2, color: '#989898' },
      { x: 8, y: -3 - phase, size: 1.5, color: '#383838' },
    ];
    for (const puff of puffs) {
      this.drawArtRect(px + puff.x, py + puff.y, puff.size, puff.size, puff.color);
    }
    const warning = Math.floor(tick / 5) % 2 === 0 ? '#ff3828' : '#ffb830';
    this.drawArtRect(px + 6.5, py + 8.5, 3, 2, '#301008');
    this.drawArtRect(px + 7, py + 8, 2, 2, warning);
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
    if (tank.kind === 'player') {
      // 3 级外层护甲被击破后，持续显示 2 级无甲车体；短暂白闪强调本次命中。
      const visualLevel = Math.max(
        0,
        Math.min(3, tank.level >= 3 && tank.armor <= 0 ? 2 : tank.level),
      );
      const hitFlash = tank.hitFlashTicks > 0 && Math.floor(tank.hitFlashTicks / 3) % 2 === 1;
      return hitFlash
        ? atlas.playerTankHit[visualLevel]
        : atlas.playerTank[tank.playerIndex][visualLevel];
    }

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

  // Boss 车体（32×32，即普通坦克 2×2）：按朝向取帧；阶段 2 换血红配色；受击时整体提亮。
  // 被时钟冻住（freezeTicks>0）时在车体上蒙一层冷蓝罩，与玩家的白闪一样只是覆盖绘制。
  private drawBoss(state: GameState): void {
    const boss = state.boss;
    if (!boss || boss.dead) return;
    const { ctx, atlas } = this;
    const frames = boss.hitFlash > 0 ? atlas.bossFlash : atlas.boss[boss.phase - 1];
    const x = snapArt(FIELD_X + boss.x);
    const y = snapArt(FIELD_Y + boss.y);
    drawTile(ctx, frames[boss.dir], x, y);
    if (boss.freezeTicks > 0) {
      ctx.save();
      ctx.globalAlpha = 0.4;
      ctx.fillStyle = COLOR_BOSS_FREEZE;
      ctx.fillRect(x * ART_SCALE, y * ART_SCALE, boss.size * ART_SCALE, boss.size * ART_SCALE);
      ctx.restore();
    }
  }

  // Boss 地雷（8×8）：未武装用银灯帧；武装后按 BOSS_MINE_BLINK_TICKS 周期在两帧间闪红。
  // 绘于地形之上、坦克之下 —— 玩家能看清它躺在哪，但不会挡住自己的车。
  private drawBossMines(state: GameState): void {
    if (state.mines.length === 0) return;
    const { ctx, atlas } = this;
    for (const mine of state.mines) {
      const armed = mine.armTicks <= 0;
      const blink = Math.floor(state.tick / BOSS_MINE_BLINK_TICKS) % 2 === 0;
      const frame = armed && blink ? atlas.bossMine[1] : atlas.bossMine[0];
      drawTile(ctx, frame, snapArt(FIELD_X + mine.x), snapArt(FIELD_Y + mine.y));
    }
  }

  // 迫击炮落点：16×16 的闪烁十字标记（外框 + 十字线），引信越短闪得越快 —— 一眼可辨“快炸了”。
  private drawBossMortarMarks(state: GameState): void {
    const boss = state.boss;
    if (!boss || boss.dead || boss.mortarMarks.length === 0) return;
    const { ctx } = this;
    const size = BOSS_MORTAR_BLAST;
    ctx.save();
    for (const mark of boss.mortarMarks) {
      // 引信过半后闪烁周期减半，形成“临爆加速”的节奏。
      const period = mark.ticksLeft <= BOSS_MORTAR_MARK_BLINK_TICKS * 4
        ? Math.max(1, Math.floor(BOSS_MORTAR_MARK_BLINK_TICKS / 2))
        : BOSS_MORTAR_MARK_BLINK_TICKS;
      const bright = Math.floor(mark.ticksLeft / period) % 2 === 0;
      ctx.globalAlpha = bright ? 0.95 : 0.4;
      ctx.fillStyle = COLOR_BOSS_MORTAR_MARK;
      const x = (FIELD_X + mark.x) * ART_SCALE;
      const y = (FIELD_Y + mark.y) * ART_SCALE;
      const w = size * ART_SCALE;
      const t = ART_SCALE; // 1 逻辑像素线宽
      // 外框
      ctx.fillRect(x, y, w, t);
      ctx.fillRect(x, y + w - t, w, t);
      ctx.fillRect(x, y, t, w);
      ctx.fillRect(x + w - t, y, t, w);
      // 十字线
      ctx.fillRect(x + w / 2 - t / 2, y, t, w);
      ctx.fillRect(x, y + w / 2 - t / 2, w, t);
    }
    ctx.restore();
  }

  // 蓄力冲撞预警：把整条冲撞路径（Boss 车体宽、直到战场边缘）画成闪烁的黄色警戒带。
  // 冲锋相则在车体后方拖一条渐隐尾迹，表达“正在高速碾过来”。
  private drawBossCharge(state: GameState): void {
    const boss = state.boss;
    if (!boss || boss.dead || boss.attack !== 'charge') return;
    const { ctx } = this;
    const size = boss.size;
    // 路径矩形：从车体当前位置沿 chargeDir 一直延伸到战场边界。
    let x = boss.x;
    let y = boss.y;
    let w = size;
    let h = size;
    switch (boss.chargeDir) {
      case 'up':
        y = 0;
        h = boss.y + size;
        break;
      case 'down':
        h = FIELD_HEIGHT - boss.y;
        break;
      case 'left':
        x = 0;
        w = boss.x + size;
        break;
      default:
        w = FIELD_WIDTH - boss.x;
    }
    ctx.save();
    if (boss.windupTicks > 0) {
      const bright = Math.floor(boss.windupTicks / BOSS_CHARGE_BLINK_TICKS) % 2 === 0;
      ctx.globalAlpha = bright ? 0.42 : 0.16;
      ctx.fillStyle = COLOR_BOSS_CHARGE_WARN;
      ctx.fillRect((FIELD_X + x) * ART_SCALE, (FIELD_Y + y) * ART_SCALE, w * ART_SCALE, h * ART_SCALE);
    } else {
      // 冲锋拖尾：车体正后方 32px，一段半透明的速度线。
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = COLOR_BOSS_CHARGE_WARN;
      let tx = boss.x;
      let ty = boss.y;
      let tw = size;
      let th = size;
      if (boss.chargeDir === 'up') ty = boss.y + size;
      else if (boss.chargeDir === 'down') ty = boss.y - size;
      else if (boss.chargeDir === 'left') tx = boss.x + size;
      else tx = boss.x - size;
      if (boss.chargeDir === 'up' || boss.chargeDir === 'down') th = size;
      else tw = size;
      ctx.fillRect((FIELD_X + tx) * ART_SCALE, (FIELD_Y + ty) * ART_SCALE, tw * ART_SCALE, th * ART_SCALE);
    }
    ctx.restore();
  }

  // 磁力牵引：Boss 周围一圈紫色脉冲环（预警相收缩、牵引相扩张），一眼看出“正在被吸过去”。
  private drawBossMagnet(state: GameState): void {
    const boss = state.boss;
    if (!boss || boss.dead || boss.attack !== 'magnet') return;
    const { ctx } = this;
    const cx = FIELD_X + boss.x + boss.size / 2;
    const cy = FIELD_Y + boss.y + boss.size / 2;
    const step = Math.floor(state.tick / BOSS_MAGNET_PULSE_TICKS) % 3;
    const warn = boss.windupTicks > 0;
    ctx.save();
    ctx.strokeStyle = COLOR_BOSS_MAGNET;
    ctx.lineWidth = 2 * ART_SCALE;
    for (let ring = 0; ring < 3; ring++) {
      // 预警相由外向内收缩（吸力将至），牵引相由内向外扩张（正在拉扯）。
      const phase = (ring + step) % 3;
      const radius = boss.size / 2 + 6 + (warn ? 2 - phase : phase) * 8;
      ctx.globalAlpha = 0.55 - phase * 0.15;
      ctx.beginPath();
      ctx.arc(cx * ART_SCALE, cy * ART_SCALE, radius * ART_SCALE, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Boss 激光：前摇期为整列闪烁的半透明红瞄准线（不伤人），激活期为亮白芯 + 青边的粗光柱。
  // 横扫激光（sweepLaser）复用同一套画法：laserCols 每帧被模拟层写成当前 sweepX，
  // 预警期另在起始列两侧画一枚朝 sweepDir 的箭头，提示“往哪边扫”。
  private drawBossBeams(state: GameState): void {
    const boss = state.boss;
    if (!boss || boss.dead || boss.laserCols.length === 0) return;
    const { ctx } = this;
    const top = FIELD_Y * ART_SCALE;
    const height = FIELD_HEIGHT * ART_SCALE;
    const half = BOSS_LASER_WIDTH / 2;

    if (boss.windupTicks > 0) {
      // 前摇：按 BOSS_AIM_BLINK_TICKS 周期明灭，半透明红 + 两侧 1px 实色描边。
      const bright = Math.floor(boss.windupTicks / BOSS_AIM_BLINK_TICKS) % 2 === 0;
      ctx.save();
      ctx.globalAlpha = bright ? 0.45 : 0.2;
      ctx.fillStyle = COLOR_BOSS_AIM;
      for (const center of boss.laserCols) {
        const x = (FIELD_X + center - half) * ART_SCALE;
        ctx.fillRect(x, top, BOSS_LASER_WIDTH * ART_SCALE, height);
      }
      ctx.globalAlpha = bright ? 1 : 0.5;
      for (const center of boss.laserCols) {
        const x = (FIELD_X + center - half) * ART_SCALE;
        ctx.fillRect(x, top, ART_SCALE, height);
        ctx.fillRect(x + (BOSS_LASER_WIDTH - 1) * ART_SCALE, top, ART_SCALE, height);
      }
      // 横扫预警：在战场中线高度画一排朝 sweepDir 的箭头（三段递减的横条 + 尖角）。
      if (boss.sweepDir !== 0) {
        const dir = boss.sweepDir;
        const baseX = FIELD_X + boss.sweepX;
        const baseY = FIELD_Y + FIELD_HEIGHT / 2;
        ctx.globalAlpha = bright ? 1 : 0.45;
        for (let i = 1; i <= 3; i++) {
          const ax = (baseX + dir * (half + i * 10)) * ART_SCALE;
          const w = (4 - i) * 2 * ART_SCALE;
          ctx.fillRect(ax - (dir > 0 ? 0 : w), (baseY - 1) * ART_SCALE, w, 2 * ART_SCALE);
        }
      }
      ctx.restore();
      return;
    }

    if (boss.activeTicks <= 0) return;
    for (const center of boss.laserCols) {
      const x = (FIELD_X + center - half) * ART_SCALE;
      ctx.fillStyle = COLOR_BOSS_LASER_EDGE;
      ctx.fillRect(x, top, BOSS_LASER_WIDTH * ART_SCALE, height);
      // 亮白芯：居中于 16px 光柱，宽 8px。
      ctx.fillStyle = COLOR_BOSS_LASER_CORE;
      ctx.fillRect(x + (half / 2) * ART_SCALE, top, half * ART_SCALE, height);
    }
  }

  // Boss 血条：战场顶部整宽度，左侧小字 "BOSS"，前景按剩余比例 红 → 橙 → 黄。
  private drawBossHealth(state: GameState): void {
    const boss = state.boss;
    if (!boss) return;
    const { ctx, atlas } = this;
    const barX = FIELD_X + 32;
    const barY = FIELD_Y + 3;
    const barW = FIELD_WIDTH - 35;
    const barH = 5;
    drawTextOutlined(ctx, atlas, 'BOSS', FIELD_X + 3, FIELD_Y + 2, COLOR_BOSS_HP_LOW);
    // 1px 黑描边 + 暗底槽。
    ctx.fillStyle = '#000000';
    ctx.fillRect((barX - 1) * ART_SCALE, (barY - 1) * ART_SCALE, (barW + 2) * ART_SCALE, (barH + 2) * ART_SCALE);
    ctx.fillStyle = COLOR_BOSS_HP_BACK;
    ctx.fillRect(barX * ART_SCALE, barY * ART_SCALE, barW * ART_SCALE, barH * ART_SCALE);
    const ratio = Math.max(0, Math.min(1, boss.hp / boss.maxHp));
    if (ratio <= 0) return;
    ctx.fillStyle = ratio > 0.6 ? COLOR_BOSS_HP_HIGH : ratio > 0.3 ? COLOR_BOSS_HP_MID : COLOR_BOSS_HP_LOW;
    ctx.fillRect(barX * ART_SCALE, barY * ART_SCALE, Math.round(barW * ratio) * ART_SCALE, barH * ART_SCALE);
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

  // F 双螺旋炎爆弹：权威碰撞核心始终沿准星直飞；这里只把两颗火球画在中心线两侧。
  // 外层护焰烧掉一发敌弹后，spiralGuard 归零并缩成单核心，让防弹次数有明确视觉反馈。
  private drawSpiralBullet(bullet: BulletState, px: number, py: number): void {
    const { ctx, atlas } = this;
    if ((bullet.spiralGuard ?? 0) <= 0) {
      drawTile(ctx, atlas.bulletSpiral, snapArt(px), snapArt(py));
      return;
    }

    const phase = (bullet.age / SPIRAL_PERIOD_TICKS) * Math.PI * 2;
    const wave = Math.sin(phase) * SPIRAL_RADIUS;
    const depth = Math.cos(phase);
    const vertical = bullet.dir === 'up' || bullet.dir === 'down';
    const ox = vertical ? wave : 0;
    const oy = vertical ? 0 : wave;
    const extent = Math.abs(wave);

    // 两火球之间保留一条亮热芯，碰撞上对应恒定的 16px 连续热区，不会在交叉相位出现空洞。
    if (vertical) {
      this.drawArtRect(px + 2 - extent, py + 1.5, extent * 2, 1, COLOR_WEAPON_SPIRAL);
    } else {
      this.drawArtRect(px + 1.5, py + 2 - extent, 1, extent * 2, COLOR_WEAPON_SPIRAL);
    }
    this.drawArtRect(px + 1, py + 1, 2, 2, '#fff0a0');

    ctx.save();
    ctx.globalAlpha = depth >= 0 ? 1 : 0.62;
    drawTile(ctx, atlas.bulletSpiral, snapArt(px + ox), snapArt(py + oy));
    ctx.globalAlpha = depth < 0 ? 1 : 0.62;
    drawTile(ctx, atlas.bulletSpiral, snapArt(px - ox), snapArt(py - oy));
    ctx.restore();
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
          this.drawSpiralBullet(bullet, px, py);
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

  // 除 TREES 外的所有地形。砖块按存活象限渲染，水面按 tick 播放四帧行进波。
  // eagleDestroyed 为真时鹰巢画成废墟精灵。
  private drawGround(level: LevelState, tick: number, eagleDestroyed: boolean): void {
    const { ctx, atlas } = this;
    const waterFrame = Math.floor(tick / WATER_ANIM_TICKS) % atlas.water.length;

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
            this.drawWaterFoam(level, col, row, px, py, tick);
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

  // 只在水陆交界处画 1 美术像素宽的青色水线与流动白沫。连续水格之间不描边，
  // 因此大面积海面仍保持一整片；浪花相位按世界坐标错开，避免整条岸线同步闪烁。
  private drawWaterFoam(
    level: LevelState,
    col: number,
    row: number,
    px: number,
    py: number,
    tick: number,
  ): void {
    const artX = px * ART_SCALE;
    const artY = py * ART_SCALE;
    const span = SUBTILE * ART_SCALE;
    const phase = Math.floor(tick / WATER_FOAM_ANIM_TICKS);
    const seed = col * 3 + row * 5;

    if (getCell(level, col, row - 1) !== Cell.WATER) {
      this.drawWaterFoamLine(artX, artY, 1, 0, 0, 1, span, phase + seed);
    }
    if (getCell(level, col + 1, row) !== Cell.WATER) {
      this.drawWaterFoamLine(artX + span - 1, artY, 0, 1, -1, 0, span, phase + seed + 2);
    }
    if (getCell(level, col, row + 1) !== Cell.WATER) {
      this.drawWaterFoamLine(artX, artY + span - 1, 1, 0, 0, -1, span, -phase + seed);
    }
    if (getCell(level, col - 1, row) !== Cell.WATER) {
      this.drawWaterFoamLine(artX, artY, 0, 1, 1, 0, span, -phase + seed + 2);
    }
  }

  // (dx,dy) 是岸线方向，(innerX,innerY) 指向水域内部。每 7 美术像素一段 3px 浪花，
  // 并隔段向内溅一个亮点；全部用整数 fillRect，镜头移动时也不会产生抗锯齿。
  private drawWaterFoamLine(
    x: number,
    y: number,
    dx: number,
    dy: number,
    innerX: number,
    innerY: number,
    length: number,
    phase: number,
  ): void {
    const { ctx } = this;
    ctx.fillStyle = COLOR_WATER_EDGE;
    ctx.fillRect(x, y, dx === 0 ? 1 : length, dy === 0 ? 1 : length);

    const cycle = 7;
    const shift = ((phase * 2) % cycle + cycle) % cycle;
    ctx.fillStyle = COLOR_WATER_FOAM;
    for (let start = -shift; start < length; start += cycle) {
      const clippedStart = Math.max(0, start);
      const dashLength = Math.min(3 - Math.max(0, -start), length - clippedStart);
      if (dashLength <= 0) continue;
      ctx.fillRect(
        x + dx * clippedStart,
        y + dy * clippedStart,
        dx === 0 ? 1 : dashLength,
        dy === 0 ? 1 : dashLength,
      );
      if (((phase + Math.floor(start / cycle)) & 1) === 0) {
        const sparkle = Math.min(length - 1, clippedStart + 1);
        ctx.fillRect(x + dx * sparkle + innerX, y + dy * sparkle + innerY, 1, 1);
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

// src/client 专用绘制助手：复用 sprites 的像素字体，但可按整数倍放大（标题用），
// 以及若干居中/清屏便捷函数。所有坐标为 *逻辑* 像素（内部乘 ART_SCALE 落到画布）。
// 不修改 sprites.ts：大字通过读取 atlas.font 掩码、以 ART_SCALE×scale 的方块自行绘制。

import { ART_SCALE, NATIVE_WIDTH, NATIVE_HEIGHT } from '../core/constants';
import type { PowerupKind } from '../game/powerup';
import type { PowerupPickupEvent } from '../game/state';
import type { LobbyPlayer } from '../net/protocol';
import { SpriteAtlas, FONT_ADVANCE, drawText, drawTextOutlined, textWidth } from '../render/sprites';

// 跑马灯文案保持短促、口语化，让玩家在战斗中一眼读懂道具效果。
const POWERUP_TICKER_COPY: Record<PowerupKind, { name: string; effect: string }> = {
  star: { name: '星星', effect: '火炮升级' },
  grenade: { name: '手榴弹', effect: '摧毁所有敌军' },
  tank: { name: '奖励坦克', effect: '增加一条生命' },
  timer: { name: '时钟', effect: '冻结敌军 10 秒' },
  shovel: { name: '铁铲', effect: '强化基地；护送关暂停计时 20 秒' },
  helmet: { name: '头盔', effect: '无敌 10 秒' },
  wpnSpread: { name: '散射炮', effect: '三向射击' },
  wpnSpiral: { name: '螺旋炮', effect: '波浪弹道' },
  wpnLaser: { name: '激光炮', effect: '穿透射击' },
  wpnMachine: { name: '机关枪', effect: '高速连射，最多 3 弹在场' },
  boots: { name: '战靴', effect: '加速 20 秒' },
  boat: { name: '船', effect: '阵亡前可以渡水' },
  ghost: { name: '幽灵', effect: '穿越砖墙 10 秒' },
  hourglass: { name: '沙漏', effect: '敌军减速 12 秒' },
  wrench: { name: '扳手', effect: '修复基地；护送关增加 15 秒' },
  drill: { name: '钻头', effect: '炮弹击穿钢墙' },
};

// 敌方拾取全局型道具时效果会反转阵营；个人强化类沿用同一说明。
const ENEMY_POWERUP_EFFECT: Partial<Record<PowerupKind, string>> = {
  grenade: '摧毁所有玩家',
  tank: '增加一辆援军',
  timer: '冻结玩家 10 秒',
  shovel: '移除基地围墙',
  hourglass: '玩家减速 12 秒',
  wrench: '修复坦克装甲',
};

export function powerupTickerText(event: PowerupPickupEvent, playerName: string): string {
  const copy = POWERUP_TICKER_COPY[event.kind];
  const effect = event.playerIndex < 0 ? ENEMY_POWERUP_EFFECT[event.kind] ?? copy.effect : copy.effect;
  return `${playerName} 获得【${copy.name}】：${effect}`;
}

// 大厅座位可能有空洞，开局后会按旧座位号压紧成连续的对局 playerIndex。
// 这里与服务端 gameSlots 使用同样的排序，让 HUD / 坦克标签稳定取到真实名字。
export function gamePlayerNames(players: readonly LobbyPlayer[], playerCount: number): string[] {
  const sorted = [...players].sort((a, b) => a.playerIndex - b.playerIndex);
  return Array.from({ length: playerCount }, (_, i) => sorted[i]?.name ?? `P${i + 1}`);
}

// 用黑色铺满整个画布（标题/大厅/连接界面的底）。
export function clearScreen(ctx: CanvasRenderingContext2D, color = '#000000'): void {
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, NATIVE_WIDTH * ART_SCALE, NATIVE_HEIGHT * ART_SCALE);

  // 极暗的网格纹理只用 1 个美术像素绘制，让黑场有老式显示器的层次，
  // 但不使用半透明滤镜，保留锐利像素边缘。
  ctx.fillStyle = '#090d0c';
  for (let x = 0; x < NATIVE_WIDTH * ART_SCALE; x += 32) {
    ctx.fillRect(x, 0, 1, NATIVE_HEIGHT * ART_SCALE);
  }
  for (let y = 0; y < NATIVE_HEIGHT * ART_SCALE; y += 32) {
    ctx.fillRect(0, y, NATIVE_WIDTH * ART_SCALE, 1);
  }
}

// 逻辑坐标下的像素面板：1px 硬边高光 + 1px 深色底边，不用模糊阴影。
export function drawPixelPanel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  fill = '#0d1210',
  highlight = '#39413d',
  shadow = '#020303',
): void {
  const s = ART_SCALE;
  ctx.fillStyle = shadow;
  ctx.fillRect((x + 2) * s, (y + 2) * s, w * s, h * s);
  ctx.fillStyle = fill;
  ctx.fillRect(x * s, y * s, w * s, h * s);
  ctx.fillStyle = highlight;
  ctx.fillRect(x * s, y * s, w * s, s);
  ctx.fillRect(x * s, y * s, s, h * s);
  ctx.fillStyle = '#1d2421';
  ctx.fillRect(x * s, (y + h - 1) * s, w * s, s);
  ctx.fillRect((x + w - 1) * s, y * s, s, h * s);
}

// 放大后的字体行宽（逻辑像素）：与 textWidth 同口径，再乘 scale。
export function bigTextWidth(text: string, scale: number): number {
  return textWidth(text) * scale;
}

// 大字：把 5×7 字体掩码的每个点绘制为 (ART_SCALE×scale) 见方的块，字距 FONT_ADVANCE×scale。
// scale=1 时等价于 drawText。用于标题“BATTLE CITY”的粗块像素观感。
export function drawBigText(
  ctx: CanvasRenderingContext2D,
  atlas: SpriteAtlas,
  text: string,
  x: number,
  y: number,
  scale: number,
  color = '#ffffff',
): void {
  if (scale === 1) {
    drawText(ctx, atlas, text, x, y, color);
    return;
  }
  ctx.fillStyle = color;
  const block = ART_SCALE * scale; // 每个字体像素点在画布上的方块边长
  for (let i = 0; i < text.length; i++) {
    const glyph = atlas.font[text[i]];
    if (!glyph) continue;
    const gx0 = (x + i * FONT_ADVANCE * scale) * ART_SCALE;
    const gy0 = y * ART_SCALE;
    for (let gy = 0; gy < glyph.length; gy++) {
      const line = glyph[gy];
      for (let gc = 0; gc < line.length; gc++) {
        if (line[gc] === '#') ctx.fillRect(gx0 + gc * block, gy0 + gy * block, block, block);
      }
    }
  }
}

// 居中绘制一行普通字体文本，返回其左缘 x（少数场景需要）。
export function drawTextCentered(
  ctx: CanvasRenderingContext2D,
  atlas: SpriteAtlas,
  text: string,
  cx: number,
  y: number,
  color = '#ffffff',
): number {
  const x = cx - Math.round(textWidth(text) / 2);
  drawTextOutlined(ctx, atlas, text, x, y, color);
  return x;
}

// 居中绘制大字。
export function drawBigTextCentered(
  ctx: CanvasRenderingContext2D,
  atlas: SpriteAtlas,
  text: string,
  cx: number,
  y: number,
  scale: number,
  color = '#ffffff',
): void {
  const x = cx - Math.round(bigTextWidth(text, scale) / 2);
  drawBigText(ctx, atlas, text, x, y, scale, color);
}

// 标题专用的“金属砖字”：每个字体点仍是完整方块，只叠加像素级高光/暗面。
// 这比 Canvas shadowBlur 更清楚，也不会破坏像素风。
export function drawLogoTextCentered(
  ctx: CanvasRenderingContext2D,
  atlas: SpriteAtlas,
  text: string,
  cx: number,
  y: number,
  scale: number,
  base = '#e64635',
  light = '#ff8a43',
  dark = '#7b1e18',
): void {
  const x = cx - Math.round(bigTextWidth(text, scale) / 2);
  const block = ART_SCALE * scale;
  const edge = ART_SCALE;

  // 整字硬阴影，偏移一个逻辑像素。
  drawBigText(ctx, atlas, text, x + 2, y + 2, scale, '#260908');

  for (let i = 0; i < text.length; i++) {
    const glyph = atlas.font[text[i]];
    if (!glyph) continue;
    const gx0 = (x + i * FONT_ADVANCE * scale) * ART_SCALE;
    const gy0 = y * ART_SCALE;
    for (let gy = 0; gy < glyph.length; gy++) {
      const line = glyph[gy];
      for (let gc = 0; gc < line.length; gc++) {
        if (line[gc] !== '#') continue;
        const px = gx0 + gc * block;
        const py = gy0 + gy * block;
        ctx.fillStyle = base;
        ctx.fillRect(px, py, block, block);
        ctx.fillStyle = light;
        ctx.fillRect(px, py, block, edge);
        ctx.fillRect(px, py, edge, block);
        ctx.fillStyle = dark;
        ctx.fillRect(px, py + block - edge, block, edge);
        ctx.fillRect(px + block - edge, py, edge, block);
      }
    }
  }
}

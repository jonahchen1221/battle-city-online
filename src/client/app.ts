// 客户端应用状态机：串起标题 / 房间码输入 / 大厅 / 本地游戏 / 联机游戏五个画面。
// 固定 60Hz 逻辑循环由 main.ts 驱动，每帧调用 tick()（逻辑）与 render(alpha)（绘制），
// 本类按当前 screen 分发。菜单类画面用一个轻量 keydown 监听（仅在菜单画面响应，避免与游戏 Keyboard 打架）。
//
// 联机渲染：客户端不做权威模拟，只持有最近两份快照并在渲染帧间做位置插值；
// 其余一切（地形 / HUD / 爆炸 / 阶段）直接取最新快照。

import { createGameState, resetGameState, GameState } from '../game/state';
import { update } from '../game/update';
import type { LevelState } from '../game/level';
import { Renderer } from '../render/renderer';
import { Sfx } from '../audio/sfx';
import { Keyboard } from '../input/keyboard';
import { InputState, emptyInput } from '../core/types';
import { createRng, Rng } from '../core/rng';
import { GameEvent } from '../game/state';
import {
  ART_SCALE,
  NATIVE_WIDTH,
  NATIVE_HEIGHT,
  FIELD_X,
  FIELD_Y,
  FIELD_WIDTH,
  FIELD_HEIGHT,
} from '../core/constants';
import { drawText, textWidth, drawTile } from '../render/sprites';
import {
  Snapshot,
  ServerMessage,
  ServerErrorCode,
  LobbyPlayer,
  MAX_PLAYERS,
  ROOM_CODE_LENGTH,
} from '../net/protocol';
import { NetClient } from './net';
import { clearScreen, drawBigTextCentered, drawTextCentered } from './ui';

export type ScreenName = 'title' | 'joinCode' | 'lobby' | 'localGame' | 'netGame';

// 标题菜单项。
const TITLE_ITEMS = ['1 PLAYER', 'CREATE ROOM', 'JOIN ROOM'] as const;

// 联机输入心跳：即便输入未变化，也每 500ms 重发一次最近输入（对抗丢包 / 保活）。
const INPUT_HEARTBEAT_MS = 500;

// ── 抖动缓冲（jitter buffer）参数 ──
// 客户端不做权威模拟：保留最近若干份快照 + 到达时刻，按 renderTime = now - interpDelay
// 在其间插值所有实体（含本地玩家坦克）。面向良好线路（低 RTT / 零丢包）调优——把延迟压到
// 刚好盖住一个快照间隔 + 抖动，手感紧、又不至于卡顿外推。
const SNAP_BUFFER_SIZE = 16; // 快照环缓冲容量
const GAP_SAMPLE_COUNT = 20; // 参与自适应的最近到达间隔样本数
// 一个快照间隔在 20Hz 下约 50ms（base）；插值延迟至少要盖住它 + 抖动，故下限取略高的 70ms。
const INTERP_DELAY_START = 90; // 插值延迟起步（ms）
const INTERP_DELAY_MIN = 70; // 自适应下限（ms）：略高于一个快照间隔（~50ms @ 20Hz）
const INTERP_DELAY_MAX = 250; // 自适应上限（ms）
const INTERP_DELAY_EASE = 0.01; // 每渲染帧向目标缓动的比例（约 1%/帧，避免可见的时间扭曲）

// 主体色（复用调色板取色，避免魔法散落太多）。
const COLOR_TITLE = '#e44437'; // 砖红标题
const COLOR_MENU = '#ffffff';
const COLOR_MENU_DIM = '#9c9c9c';
const COLOR_HIGHLIGHT = '#e0a030'; // 自己所在行 / 光标黄
const COLOR_ERROR = '#e44437';
const COLOR_OK = '#58c840';

// 服务器错误码 → 可读英文短句（用像素字体，只用大写字母 / 数字，故全大写无标点）。
const ERROR_TEXT: Record<ServerErrorCode, string> = {
  room_not_found: 'ROOM NOT FOUND',
  room_full: 'ROOM FULL',
  already_started: 'GAME ALREADY STARTED',
  not_host: 'NOT HOST',
  not_all_ready: 'NOT ALL READY',
  bad_message: 'BAD MESSAGE',
};

// 抖动缓冲中的一份快照：原始快照 + 已解析出的完整地形（增量下发下 snap.level 可能缺省）+ 到达时刻。
interface BufferedSnap {
  snap: Snapshot;
  level: LevelState;
  arrival: number; // performance.now() 到达时刻（ms）
}

export class App {
  private ctx: CanvasRenderingContext2D;
  private renderer: Renderer;
  private keyboard: Keyboard;
  private sfx: Sfx;

  private screen: ScreenName = 'title';

  // ── 本地游戏 ──
  private localState: GameState;

  // ── 标题菜单 ──
  private titleSel = 0;

  // ── 房间码输入 ──
  private codeBuffer = '';

  // ── 联机 ──
  private net: NetClient;
  private roomCode = '';
  private myPlayerIndex = 0;
  private players: LobbyPlayer[] = [];
  private statusMsg = ''; // 普通状态行（如 CONNECTING）
  private statusError = ''; // 红色错误行
  private pendingAction: { t: 'create' } | { t: 'join'; code: string } | null = null;

  // 联机游戏快照 / 插值（抖动缓冲）。客户端不做预测：本地与远程坦克全部走同一条插值路径。
  private snapBuf: BufferedSnap[] = []; // 最近 SNAP_BUFFER_SIZE 份快照（按到达时间升序）
  private arrivalGaps: number[] = []; // 最近 GAP_SAMPLE_COUNT 个到达间隔（ms），用于自适应
  private lastArrival = 0; // 上一份快照到达时刻
  private interpDelay = INTERP_DELAY_START; // 当前插值延迟（ms），逐帧向目标缓动
  private clientLevel: LevelState | null = null; // 客户端持有的地形（增量下发：无 level 的快照沿用它）
  private readonly dummyRng: Rng = createRng(1); // 仅为凑齐 GameState 形状，永不用于权威
  private lastSentInput: InputState = emptyInput();
  private lastSendTime = 0;
  private disconnected = false;

  constructor(canvas: HTMLCanvasElement, renderer: Renderer, keyboard: Keyboard, sfx: Sfx) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    // 与 Renderer 复用同一 2D 上下文（imageSmoothing 已由 Renderer 关闭）。
    this.ctx = ctx;
    this.renderer = renderer;
    this.keyboard = keyboard;
    this.sfx = sfx;
    this.localState = createGameState(20260708, 1);

    this.net = new NetClient();
    this.net.onOpen = () => this.onNetOpen();
    this.net.onMessage = (m) => this.onNetMessage(m);
    this.net.onClose = () => this.onNetClose();
    this.net.onError = () => {
      // error 后通常紧跟 close；此处仅在无更明确状态时给出提示。
      if (!this.statusError) this.statusError = 'CONNECTION ERROR';
    };

    window.addEventListener('keydown', (e) => this.onKeyDown(e));
  }

  get currentScreen(): ScreenName {
    return this.screen;
  }

  get netClient(): NetClient {
    return this.net;
  }

  get localGameState(): GameState {
    return this.localState;
  }

  // ───────────────────────── 循环钩子 ─────────────────────────

  tick(): void {
    if (this.screen === 'localGame') {
      update(this.localState, [this.keyboard.snapshot()]);
      for (const e of this.localState.events) this.sfx.play(e);
      this.localState.events.length = 0;
    } else if (this.screen === 'netGame') {
      this.tickNet();
    }
    // 菜单类画面为事件驱动，逻辑帧无需处理。
  }

  render(alpha: number): void {
    switch (this.screen) {
      case 'title':
        this.drawTitle();
        break;
      case 'joinCode':
        this.drawJoinCode();
        break;
      case 'lobby':
        this.drawLobby();
        break;
      case 'localGame':
        this.renderer.draw(this.localState, alpha);
        break;
      case 'netGame':
        this.drawNet();
        break;
    }
  }

  // ───────────────────────── 联机逻辑帧 ─────────────────────────

  private tickNet(): void {
    if (this.disconnected) return;
    // 客户端不做权威模拟：本帧只负责把输入发给服务器（变化即发 + 心跳保活）。
    // 渲染完全由抖动缓冲插值驱动（见 buildNetRenderState）。
    const input = this.keyboard.snapshot();
    const now = performance.now();
    const changed = !sameInput(input, this.lastSentInput);
    if (changed || now - this.lastSendTime >= INPUT_HEARTBEAT_MS) {
      this.net.send({ t: 'input', input });
      this.lastSentInput = input;
      this.lastSendTime = now;
    }
  }

  // ───────────────────────── 网络事件 ─────────────────────────

  private onNetOpen(): void {
    this.statusError = '';
    if (this.pendingAction?.t === 'create') {
      this.net.send({ t: 'create' });
      this.statusMsg = 'CREATING ROOM';
    } else if (this.pendingAction?.t === 'join') {
      this.net.send({ t: 'join', code: this.pendingAction.code });
      this.statusMsg = 'JOINING';
    }
  }

  private onNetMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case 'joined':
        this.roomCode = msg.code;
        this.myPlayerIndex = msg.playerIndex;
        this.players = msg.players;
        this.statusMsg = '';
        this.statusError = '';
        this.pendingAction = null;
        this.screen = 'lobby';
        break;
      case 'lobby':
        this.players = msg.players;
        break;
      case 'started':
        // 清空快照缓冲，等待第一份 snapshot 才真正进入渲染。
        this.resetNetPlayState();
        this.disconnected = false;
        this.lastSentInput = emptyInput();
        this.lastSendTime = 0;
        this.statusMsg = '';
        this.statusError = '';
        this.screen = 'netGame';
        break;
      case 'snapshot':
        this.onSnapshot(msg.snap, msg.events);
        break;
      case 'error':
        this.statusError = ERROR_TEXT[msg.code] ?? msg.msg.toUpperCase();
        this.statusMsg = '';
        this.pendingAction = null;
        break;
    }
  }

  private onSnapshot(snap: Snapshot, events: GameEvent[]): void {
    const now = performance.now();

    // 增量地形：带 level 则更新客户端地形，否则沿用上一份。
    // 服务器保证新连接的首份快照必含 level，故此后 clientLevel 恒非空。
    if (snap.level) this.clientLevel = snap.level;
    if (!this.clientLevel) return; // 理论不达（首份必含 level）；无地形无法渲染，丢弃
    const level = this.clientLevel;

    // 入环缓冲（保留最近 SNAP_BUFFER_SIZE 份，按到达时间升序）。
    this.snapBuf.push({ snap, level, arrival: now });
    if (this.snapBuf.length > SNAP_BUFFER_SIZE) this.snapBuf.shift();

    // 记录到达间隔（自适应插值延迟用）。
    if (this.lastArrival > 0) {
      this.arrivalGaps.push(now - this.lastArrival);
      if (this.arrivalGaps.length > GAP_SAMPLE_COUNT) this.arrivalGaps.shift();
    }
    this.lastArrival = now;

    // 快照携带的音效事件立即播放（覆盖两份快照之间累积的事件，避免漏音）。
    for (const e of events) this.sfx.play(e);
  }

  private onNetClose(): void {
    if (this.screen === 'netGame') {
      // 游戏中断线：冻结当前帧并提示，Enter 返回标题。
      this.disconnected = true;
    } else if (this.screen === 'lobby') {
      this.statusError = 'CONNECTION LOST';
      this.resetNetToTitle();
    } else {
      // 连接 / 加入过程中断开：留在当前菜单画面并提示。
      if (!this.statusError) this.statusError = 'DISCONNECTED';
      this.statusMsg = '';
      this.pendingAction = null;
    }
  }

  private resetNetToTitle(): void {
    this.net.close();
    this.pendingAction = null;
    this.statusMsg = '';
    this.players = [];
    this.roomCode = '';
    this.disconnected = false;
    this.resetNetPlayState();
    this.screen = 'title';
  }

  // 清空一切联机对局态（快照缓冲 / 自适应统计 / 地形）。开局与返回标题共用。
  private resetNetPlayState(): void {
    this.snapBuf = [];
    this.arrivalGaps = [];
    this.lastArrival = 0;
    this.interpDelay = INTERP_DELAY_START;
    this.clientLevel = null;
  }

  // 自适应插值延迟：目标 = clamp(p95(到达间隔) × 1.5, MIN, MAX)，逐帧缓动 1% 靠拢。
  private adaptInterpDelay(): void {
    const gaps = this.arrivalGaps;
    if (gaps.length < 2) return;
    const sorted = [...gaps].sort((a, b) => a - b);
    // p95：取排序后约 95% 分位（floor(0.95×(n-1))）；样本少时自然退化为接近最大值。
    const p95 = sorted[Math.floor(0.95 * (sorted.length - 1))];
    const target = clamp(p95 * 1.5, INTERP_DELAY_MIN, INTERP_DELAY_MAX);
    this.interpDelay += (target - this.interpDelay) * INTERP_DELAY_EASE;
  }

  // ───────────────────────── 键盘（仅菜单画面 + 断线覆盖层）─────────────────────────

  private onKeyDown(e: KeyboardEvent): void {
    // 断线覆盖层：任意时刻的 netGame 断线态下，Enter 返回标题。
    if (this.screen === 'netGame') {
      if (this.disconnected && e.code === 'Enter' && !e.repeat) {
        e.preventDefault();
        this.resetNetToTitle();
      }
      return;
    }
    // 仅菜单画面响应，避免与游戏 Keyboard 抢键。
    if (this.screen !== 'title' && this.screen !== 'joinCode' && this.screen !== 'lobby') return;
    if (e.repeat) return; // 边沿触发：忽略按住的自动重复

    switch (this.screen) {
      case 'title':
        this.onTitleKey(e);
        break;
      case 'joinCode':
        this.onJoinCodeKey(e);
        break;
      case 'lobby':
        this.onLobbyKey(e);
        break;
    }
  }

  private onTitleKey(e: KeyboardEvent): void {
    switch (e.code) {
      case 'ArrowUp':
      case 'KeyW':
        e.preventDefault();
        this.titleSel = (this.titleSel + TITLE_ITEMS.length - 1) % TITLE_ITEMS.length;
        break;
      case 'ArrowDown':
      case 'KeyS':
        e.preventDefault();
        this.titleSel = (this.titleSel + 1) % TITLE_ITEMS.length;
        break;
      case 'Enter':
        e.preventDefault();
        this.confirmTitle();
        break;
    }
  }

  private confirmTitle(): void {
    this.statusError = '';
    if (this.titleSel === 0) {
      // 1 PLAYER：全新本地单机局。设 prevStart=true，避免刚按下的 Enter 被当作暂停边沿。
      resetGameState(this.localState, (Date.now() >>> 0) || 20260708);
      this.localState.prevStart = true;
      this.screen = 'localGame';
    } else if (this.titleSel === 1) {
      // CREATE ROOM：连接并建房。
      this.pendingAction = { t: 'create' };
      this.statusMsg = 'CONNECTING';
      this.net.connect();
    } else {
      // JOIN ROOM：进入房间码输入。
      this.codeBuffer = '';
      this.statusMsg = '';
      this.screen = 'joinCode';
    }
  }

  private onJoinCodeKey(e: KeyboardEvent): void {
    if (e.code === 'Escape') {
      e.preventDefault();
      this.net.close();
      this.pendingAction = null;
      this.statusMsg = '';
      this.statusError = '';
      this.screen = 'title';
      return;
    }
    if (e.code === 'Backspace') {
      e.preventDefault();
      this.codeBuffer = this.codeBuffer.slice(0, -1);
      this.statusError = '';
      return;
    }
    if (e.code === 'Enter') {
      e.preventDefault();
      if (this.codeBuffer.length === ROOM_CODE_LENGTH) {
        this.pendingAction = { t: 'join', code: this.codeBuffer };
        this.statusMsg = 'CONNECTING';
        this.statusError = '';
        this.net.connect();
      } else {
        this.statusError = `NEED ${ROOM_CODE_LENGTH} LETTERS`;
      }
      return;
    }
    // 字母键：A-Z 直接录入（code 形如 'KeyA'）。
    const m = /^Key([A-Z])$/.exec(e.code);
    if (m && this.codeBuffer.length < ROOM_CODE_LENGTH) {
      e.preventDefault();
      this.codeBuffer += m[1];
      this.statusError = '';
    }
  }

  private onLobbyKey(e: KeyboardEvent): void {
    if (e.code === 'Escape') {
      e.preventDefault();
      this.net.send({ t: 'leave' });
      this.resetNetToTitle();
      return;
    }
    if (e.code === 'Enter') {
      e.preventDefault();
      const me = this.players.find((p) => p.playerIndex === this.myPlayerIndex);
      const nextReady = !(me?.ready ?? false);
      this.net.send({ t: 'ready', ready: nextReady });
      return;
    }
    if (e.code === 'KeyS') {
      e.preventDefault();
      // 房主（0 号位）在全员 ready 时按 S 开局。
      if (this.isHost() && this.allReady()) {
        this.net.send({ t: 'start' });
      }
      return;
    }
  }

  private isHost(): boolean {
    return this.myPlayerIndex === 0;
  }

  private allReady(): boolean {
    const connected = this.players.filter((p) => p.connected);
    return connected.length > 0 && connected.every((p) => p.ready);
  }

  // ───────────────────────── 绘制：标题 ─────────────────────────

  private drawTitle(): void {
    const { ctx } = this;
    const atlas = this.renderer.spriteAtlas;
    clearScreen(ctx);
    const cx = NATIVE_WIDTH / 2;

    // 大字标题“BATTLE / CITY”，砖红，两行居中。
    drawBigTextCentered(ctx, atlas, 'BATTLE', cx, 34, 4, COLOR_TITLE);
    drawBigTextCentered(ctx, atlas, 'CITY', cx, 74, 4, COLOR_TITLE);

    // 菜单项 + 黄色迷你坦克光标。
    const menuTop = 130;
    const rowH = 20;
    for (let i = 0; i < TITLE_ITEMS.length; i++) {
      const y = menuTop + i * rowH;
      const selected = i === this.titleSel;
      const label = TITLE_ITEMS[i];
      const labelX = cx - Math.round(textWidth(label) / 2);
      drawText(ctx, atlas, label, labelX, y, selected ? COLOR_MENU : COLOR_MENU_DIM);
      if (selected) {
        // 光标：复用 HUD 生命迷你坦克（P1 黄），置于文字左侧。
        drawTile(ctx, atlas.hudLifeTank[0], labelX - 22, y - 4);
      }
    }

    this.drawStatusLines(200);
  }

  // ───────────────────────── 绘制：房间码输入 ─────────────────────────

  private drawJoinCode(): void {
    const { ctx } = this;
    const atlas = this.renderer.spriteAtlas;
    clearScreen(ctx);
    const cx = NATIVE_WIDTH / 2;

    drawBigTextCentered(ctx, atlas, 'JOIN', cx, 40, 3, COLOR_TITLE);
    drawTextCentered(ctx, atlas, 'ENTER ROOM CODE', cx, 90, COLOR_MENU);

    // 4 个字符槽：已输入的字母或下划线，等宽居中。
    const slotScale = 3;
    const slotAdvance = 24; // 每槽逻辑宽（含间隙）
    const totalW = ROOM_CODE_LENGTH * slotAdvance;
    let sx = cx - Math.round(totalW / 2) + 6;
    const slotY = 120;
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      const ch = this.codeBuffer[i] ?? '';
      const filled = i < this.codeBuffer.length;
      // 光标位（下一个待输入槽）高亮，其余暗。
      const isCursor = i === this.codeBuffer.length;
      const color = filled ? COLOR_HIGHLIGHT : isCursor ? COLOR_MENU : COLOR_MENU_DIM;
      drawBigTextCentered(ctx, atlas, ch || '_', sx + slotAdvance / 2, slotY, slotScale, color);
      sx += slotAdvance;
    }

    drawTextCentered(ctx, atlas, 'TYPE A-Z   ENTER TO JOIN', cx, 170, COLOR_MENU_DIM);
    drawTextCentered(ctx, atlas, 'ESC TO CANCEL', cx, 184, COLOR_MENU_DIM);
    this.drawStatusLines(200);
  }

  // ───────────────────────── 绘制：大厅 ─────────────────────────

  private drawLobby(): void {
    const { ctx } = this;
    const atlas = this.renderer.spriteAtlas;
    clearScreen(ctx);
    const cx = NATIVE_WIDTH / 2;

    drawTextCentered(ctx, atlas, 'ROOM CODE', cx, 20, COLOR_MENU);
    // 房间码大字（房主可念给同伴）。
    drawBigTextCentered(ctx, atlas, this.roomCode || '----', cx, 34, 4, COLOR_HIGHLIGHT);

    // 玩家列表：4 行 1P..4P。
    const listTop = 96;
    const rowH = 18;
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const y = listTop + i * rowH;
      const p = this.players.find((pl) => pl.playerIndex === i);
      const mine = i === this.myPlayerIndex;
      let text: string;
      let color: string;
      if (!p || !p.connected) {
        if (p && !p.connected) {
          text = `${i + 1}P  DISCONNECTED`;
          color = COLOR_MENU_DIM;
        } else {
          text = `${i + 1}P  ---`;
          color = COLOR_MENU_DIM;
        }
      } else {
        text = `${i + 1}P  ${p.ready ? 'READY' : 'JOINED'}`;
        color = p.ready ? COLOR_OK : COLOR_MENU;
      }
      if (mine) color = COLOR_HIGHLIGHT;
      const x = cx - 60;
      drawText(ctx, atlas, text, x, y, color);
      if (mine) drawText(ctx, atlas, '<', x - 12, y, COLOR_HIGHLIGHT);
    }

    // 操作提示。
    const hintY = listTop + MAX_PLAYERS * rowH + 12;
    drawTextCentered(ctx, atlas, 'ENTER = READY', cx, hintY, COLOR_MENU);
    if (this.isHost()) {
      const allReady = this.allReady();
      drawTextCentered(
        ctx,
        atlas,
        allReady ? 'S = START' : 'WAIT ALL READY',
        cx,
        hintY + 14,
        allReady ? COLOR_OK : COLOR_MENU_DIM,
      );
    } else {
      drawTextCentered(ctx, atlas, 'WAIT FOR HOST', cx, hintY + 14, COLOR_MENU_DIM);
    }
    drawTextCentered(ctx, atlas, 'ESC = LEAVE', cx, hintY + 28, COLOR_MENU_DIM);

    this.drawStatusLines(hintY + 46);
  }

  // ───────────────────────── 绘制：联机游戏 ─────────────────────────

  private drawNet(): void {
    const rs = this.buildNetRenderState();
    if (rs) {
      this.renderer.draw(rs, 0);
    } else {
      // 尚未收到首份快照：黑屏 + 提示。
      clearScreen(this.ctx);
      drawTextCentered(this.ctx, this.renderer.spriteAtlas, 'LOADING', NATIVE_WIDTH / 2, 104, COLOR_MENU);
    }
    if (this.disconnected) this.drawDisconnectOverlay();
  }

  // 用抖动缓冲构建插值后的可渲染 GameState 形状对象；无快照时返回 null。
  // renderTime = now - interpDelay，落在缓冲区两份快照 [from, to] 之间：
  //   • 全部坦克 / 子弹（含本地玩家坦克）的 x/y 在 from→to 间按 alpha 插值（其余字段取 to）；
  //     本地与远程走同一路径——纯服务器权威，无预测、无对账。
  //   • 非位置状态（地形 / HUD / 阶段 / 爆炸）取自 to，避免阶段闪烁；
  //   • renderTime 超出最新快照（卡顿）→ 冻结在最新，不外推；早于最旧 → 用最旧。
  private buildNetRenderState(): GameState | null {
    const buf = this.snapBuf;
    if (buf.length === 0) return null;

    this.adaptInterpDelay();
    const renderTime = performance.now() - this.interpDelay;

    // 找到 ≤renderTime 的最新一份 from，其后一份为 to（越界则 to=from，冻结）。
    let idx = 0;
    for (let k = 0; k < buf.length; k++) {
      if (buf[k].arrival <= renderTime) idx = k;
      else break;
    }
    const from = buf[idx];
    const to = buf[Math.min(idx + 1, buf.length - 1)];
    const span = to.arrival - from.arrival;
    // span=0（from===to，卡顿冻结）→ alpha 0；早于最旧时 renderTime<from.arrival → clamp 到 0。
    const alpha = span > 0 ? clamp01((renderTime - from.arrival) / span) : 0;

    const base = to.snap; // 非位置状态基准（较新那份）
    const level = to.level; // 增量地形：始终用已解析出的完整 level

    // 全部坦克（含本地玩家）：以 to 为准，按 id 匹配 from 旧位置插值。本地与远程走同一路径。
    const fromTankById = new Map<number, { x: number; y: number }>();
    for (const t of from.snap.tanks) fromTankById.set(t.id, { x: t.x, y: t.y });
    const tanks = base.tanks.map((t) => {
      const p = fromTankById.get(t.id);
      if (!p) return t; // 新出生：直接取 to 位置
      return { ...t, x: lerp(p.x, t.x, alpha), y: lerp(p.y, t.y, alpha) };
    });

    // 子弹按 ownerId 匹配（每坦克同时仅一发，ownerId 唯一）；方向不同或找不到则不插值。
    const fromBulletByOwner = new Map<number, { x: number; y: number; dir: string }>();
    for (const b of from.snap.bullets) fromBulletByOwner.set(b.ownerId, { x: b.x, y: b.y, dir: b.dir });
    const bullets = base.bullets.map((b) => {
      const p = fromBulletByOwner.get(b.ownerId);
      if (!p || p.dir !== b.dir) return b;
      return { ...b, x: lerp(p.x, b.x, alpha), y: lerp(p.y, b.y, alpha) };
    });

    // 拼成 GameState 形状：塞入解析后的 level、dummy rng 与空 events（渲染层均不读取后二者）。
    return { ...base, level, rng: this.dummyRng, events: [], tanks, bullets };
  }

  private drawDisconnectOverlay(): void {
    const { ctx } = this;
    const atlas = this.renderer.spriteAtlas;
    // 半透明黑幕压暗冻结帧。
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, NATIVE_WIDTH * ART_SCALE, NATIVE_HEIGHT * ART_SCALE);
    const cx = FIELD_X + FIELD_WIDTH / 2;
    const cy = FIELD_Y + FIELD_HEIGHT / 2;
    drawTextCentered(ctx, atlas, 'CONNECTION LOST', cx, cy - 12, COLOR_ERROR);
    drawTextCentered(ctx, atlas, 'PRESS ENTER', cx, cy + 8, COLOR_MENU);
  }

  // ───────────────────────── 状态行 ─────────────────────────

  private drawStatusLines(y: number): void {
    const atlas = this.renderer.spriteAtlas;
    const cx = NATIVE_WIDTH / 2;
    if (this.statusMsg) drawTextCentered(this.ctx, atlas, this.statusMsg, cx, y, COLOR_MENU_DIM);
    if (this.statusError) drawTextCentered(this.ctx, atlas, this.statusError, cx, y + 14, COLOR_ERROR);
  }
}

// ───────────────────────── 纯函数工具 ─────────────────────────

function sameInput(a: InputState, b: InputState): boolean {
  return (
    a.up === b.up &&
    a.down === b.down &&
    a.left === b.left &&
    a.right === b.right &&
    a.fire === b.fire &&
    a.start === b.start
  );
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

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
import { GamepadInput, MenuEdges } from '../input/gamepad';
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
  TICKS_PER_SECOND,
} from '../core/constants';
import { drawTextOutlined, textWidth, drawTile } from '../render/sprites';
import {
  Snapshot,
  ServerMessage,
  ServerErrorCode,
  LobbyPlayer,
  MAX_PLAYERS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
} from '../net/protocol';
import { NetClient } from './net';
import {
  clearScreen,
  drawBigTextCentered,
  drawLogoTextCentered,
  drawPixelPanel,
  drawTextCentered,
} from './ui';

export type ScreenName = 'title' | 'joinCode' | 'lobby' | 'localGame' | 'netGame';

// 标题菜单项。
const TITLE_ITEMS = ['1 PLAYER', 'CREATE ROOM', 'JOIN ROOM'] as const;

// 联机输入心跳：即便输入未变化，也每 500ms 重发一次最近输入（对抗丢包 / 保活）。
const INPUT_HEARTBEAT_MS = 500;

// ── 房间分享 URL ──
// 地址栏查询参数名：`?room=ABCD`。进房后写入地址栏，同伴打开即自动加入。
const URL_ROOM_PARAM = 'room';
// 从任意粘贴文本里捞房间码用的 URL 形态匹配（大小写不敏感）。
const ROOM_PARAM_RE = new RegExp(`[?&]${URL_ROOM_PARAM}=([A-Za-z]+)`, 'i');
// “LINK COPIED”提示的存续时长（ms）。菜单每帧重绘，靠时间戳比较自然消失。
const LINK_COPIED_MS = 2000;

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
const COLOR_TITLE = '#e64635'; // 砖红标题
const COLOR_MENU = '#ffffff';
const COLOR_MENU_DIM = '#89918d';
const COLOR_HIGHLIGHT = '#ffc14a'; // 自己所在行 / 光标黄
const COLOR_ERROR = '#ff5947';
const COLOR_OK = '#70dc58';

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
  private gamepad: GamepadInput;
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
  private linkCopiedUntil = 0; // 复制成功提示的截止时刻（performance.now() 口径，0 = 无提示）

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

  constructor(
    canvas: HTMLCanvasElement,
    renderer: Renderer,
    keyboard: Keyboard,
    gamepad: GamepadInput,
    sfx: Sfx,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    // 与 Renderer 复用同一 2D 上下文（imageSmoothing 已由 Renderer 关闭）。
    this.ctx = ctx;
    this.renderer = renderer;
    this.keyboard = keyboard;
    this.gamepad = gamepad;
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
    window.addEventListener('paste', (e) => this.onPaste(e));
    window.addEventListener('blur', () => this.releaseAllInputs());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.releaseAllInputs();
    });

    // 地址栏带 ?room=ABCD 时跳过标题菜单，直接连服务器加入。
    this.tryAutoJoinFromUrl();
  }

  // 解析 location.search 里的房间码（参数名与值均大小写不敏感）。
  // 值必须恰为 ROOM_CODE_LENGTH 个字母表内字符才算有效；否则维持标题画面。
  private tryAutoJoinFromUrl(): void {
    let raw: string | null = null;
    new URLSearchParams(location.search).forEach((v, k) => {
      if (raw === null && k.toLowerCase() === URL_ROOM_PARAM) raw = v;
    });
    if (raw === null) return;
    const code = (raw as string).toUpperCase();
    if (code.length !== ROOM_CODE_LENGTH) return;
    for (const ch of code) if (!ROOM_CODE_ALPHABET.includes(ch)) return;

    this.codeBuffer = code;
    this.screen = 'joinCode';
    this.pendingAction = { t: 'join', code };
    this.statusMsg = 'CONNECTING';
    this.net.connect();
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
    // 手柄没有事件，只能逐帧轮询；每帧无条件取走按下沿，当前画面用不到的直接丢弃，
    // 这样切画面时不会重放上一个画面残留的按下。
    this.gamepad.poll();
    const pad = this.gamepad.takeMenuEdges();

    if (this.screen === 'localGame') {
      update(this.localState, [this.playerInput()]);
      for (const e of this.localState.events) this.sfx.play(e);
      this.localState.events.length = 0;
    } else if (this.screen === 'netGame') {
      // 断线覆盖层：键盘走 Enter，手柄走 A / Start。
      if (this.disconnected) {
        if (pad.confirm || pad.start) this.resetNetToTitle();
      } else {
        this.tickNet();
      }
    } else {
      // 菜单类画面键盘侧为事件驱动，这里只补手柄的按下沿。
      this.handleMenuPad(pad);
    }
  }

  // 键盘与手柄按位或合并：两者可随时混用，任一按下即生效。
  private playerInput(): InputState {
    return mergeInput(this.keyboard.snapshot(), this.gamepad.snapshot());
  }

  // 手柄菜单操作：与键盘处理走同一批动作方法，避免逻辑分叉。
  private handleMenuPad(pad: MenuEdges): void {
    switch (this.screen) {
      case 'title':
        if (pad.up) this.moveTitleSel(-1);
        if (pad.down) this.moveTitleSel(1);
        if (pad.confirm || pad.start) this.confirmTitle();
        break;
      case 'joinCode':
        // 手柄不做文字输入：房间码仍只能键盘敲或粘贴。
        if (pad.back) this.cancelJoinCode();
        else if (pad.confirm || pad.start) this.submitJoinCode();
        break;
      case 'lobby':
        if (pad.back) this.leaveLobby();
        else if (pad.confirm) this.toggleReady();
        else if (pad.start) this.hostStartGame();
        break;
    }
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
    const input = this.playerInput();
    const now = performance.now();
    const changed = !sameInput(input, this.lastSentInput);
    if (changed || now - this.lastSendTime >= INPUT_HEARTBEAT_MS) {
      this.net.send({ t: 'input', input });
      this.lastSentInput = input;
      this.lastSendTime = now;
    }
  }

  // 失焦后 keyup 可能永远不会到达。先清空本地键盘状态；联机中还要立即把中立输入
  // 发给权威服务器，因为后台页的 rAF 会被暂停，不能等下一次 tick/心跳再停止坦克。
  private releaseAllInputs(): void {
    this.keyboard.reset();
    if (this.screen !== 'netGame' || this.disconnected || !this.net.connected) return;
    const input = emptyInput();
    this.net.send({ t: 'input', input });
    this.lastSentInput = input;
    this.lastSendTime = performance.now();
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
        this.linkCopiedUntil = 0;
        this.screen = 'lobby';
        // 地址栏始终带上房间码：建房者直接复制地址栏即可分享。
        history.replaceState(null, '', `${location.pathname}?${URL_ROOM_PARAM}=${msg.code}`);
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

    // 整局重开会把权威 tick 归零。不得把重开前后的同 id 实体放在同一插值窗口里，
    // 否则会从旧局终点插到新局出生点。
    const previous = this.snapBuf[this.snapBuf.length - 1];
    if (previous && snap.tick < previous.snap.tick) {
      this.snapBuf = [];
      this.arrivalGaps = [];
      this.lastArrival = 0;
      this.interpDelay = INTERP_DELAY_START;
    }

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
    this.linkCopiedUntil = 0;
    this.resetNetPlayState();
    this.screen = 'title';
    // 清掉地址栏的房间码，避免刷新后又自动加入已退出的房间。
    history.replaceState(null, '', location.pathname);
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
        this.moveTitleSel(-1);
        break;
      case 'ArrowDown':
      case 'KeyS':
        e.preventDefault();
        this.moveTitleSel(1);
        break;
      case 'Enter':
        e.preventDefault();
        this.confirmTitle();
        break;
    }
  }

  // 菜单选择上下移动（循环）。delta 为 -1 / +1。
  private moveTitleSel(delta: number): void {
    this.titleSel = (this.titleSel + TITLE_ITEMS.length + delta) % TITLE_ITEMS.length;
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
      this.cancelJoinCode();
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
      this.submitJoinCode();
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

  private cancelJoinCode(): void {
    this.net.close();
    this.pendingAction = null;
    this.statusMsg = '';
    this.statusError = '';
    this.screen = 'title';
  }

  private submitJoinCode(): void {
    if (this.codeBuffer.length === ROOM_CODE_LENGTH) {
      this.pendingAction = { t: 'join', code: this.codeBuffer };
      this.statusMsg = 'CONNECTING';
      this.statusError = '';
      this.net.connect();
    } else {
      this.statusError = `NEED ${ROOM_CODE_LENGTH} LETTERS`;
    }
  }

  // 粘贴：仅房间码输入画面响应。整段 URL 或裸房间码都能识别。
  private onPaste(e: ClipboardEvent): void {
    if (this.screen !== 'joinCode') return;
    e.preventDefault();
    const code = extractRoomCode(e.clipboardData?.getData('text') ?? '');
    if (!code) return; // 捞不出任何合法字符则保持原输入
    this.codeBuffer = code;
    this.statusError = '';
  }

  private onLobbyKey(e: KeyboardEvent): void {
    if (e.code === 'Escape') {
      e.preventDefault();
      this.leaveLobby();
      return;
    }
    if (e.code === 'Enter') {
      e.preventDefault();
      this.toggleReady();
      return;
    }
    if (e.code === 'KeyS') {
      e.preventDefault();
      this.hostStartGame();
      return;
    }
    if (e.code === 'KeyC') {
      e.preventDefault();
      this.copyRoomLink();
      return;
    }
  }

  private leaveLobby(): void {
    this.net.send({ t: 'leave' });
    this.resetNetToTitle();
  }

  private toggleReady(): void {
    const me = this.players.find((p) => p.playerIndex === this.myPlayerIndex);
    const nextReady = !(me?.ready ?? false);
    this.net.send({ t: 'ready', ready: nextReady });
  }

  // 房主（0 号位）在全员 ready 时开局；非房主 / 未齐时按键无效。
  private hostStartGame(): void {
    if (this.isHost() && this.allReady()) this.net.send({ t: 'start' });
  }

  // 把完整分享链接（含协议）写进剪贴板。局域网 http 非安全上下文没有 navigator.clipboard，
  // 故失败/缺失时回退到临时 textarea + execCommand。
  private copyRoomLink(): void {
    if (!this.roomCode) return;
    const url = `${location.origin}${location.pathname}?${URL_ROOM_PARAM}=${this.roomCode}`;
    const done = () => {
      this.linkCopiedUntil = performance.now() + LINK_COPIED_MS;
    };
    const clipboard = navigator.clipboard;
    if (clipboard?.writeText) {
      clipboard.writeText(url).then(done, () => {
        if (copyViaTextarea(url)) done();
      });
    } else if (copyViaTextarea(url)) {
      done();
    }
  }

  // 大厅里展示的分享地址：去掉协议前缀、全大写以匹配像素字体（只有大写字母/数字/少量标点）。
  private shareUrlText(): string {
    const path = location.pathname === '/' ? '' : location.pathname;
    return `${location.host}${path}?${URL_ROOM_PARAM}=${this.roomCode}`.toUpperCase();
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

    // 砖块金属高光的两行主标：仍是 5×7 点阵，但比纯色大字更有层次。
    drawLogoTextCentered(ctx, atlas, 'BATTLE', cx, 24, 4, COLOR_TITLE);
    drawLogoTextCentered(ctx, atlas, 'CITY', cx, 62, 4, COLOR_TITLE);
    drawTextCentered(ctx, atlas, 'ONLINE CO-OP', cx, 99, '#d08b32');

    // 两台对向坦克做成小徽标，同时说明“合作对战”的核心主题。
    drawTile(ctx, atlas.playerTank[0].right[0], cx - 76, 95);
    drawTile(ctx, atlas.enemyTank.basic.left[0], cx + 60, 95);

    drawPixelPanel(ctx, cx - 86, 116, 172, 70);

    // 菜单项 + 黄色迷你坦克光标。
    const menuTop = 126;
    const rowH = 18;
    for (let i = 0; i < TITLE_ITEMS.length; i++) {
      const y = menuTop + i * rowH;
      const selected = i === this.titleSel;
      const label = TITLE_ITEMS[i];
      const labelX = cx - Math.round(textWidth(label) / 2);
      if (selected) {
        ctx.fillStyle = '#3b160c';
        ctx.fillRect((cx - 72) * ART_SCALE, (y - 4) * ART_SCALE, 144 * ART_SCALE, 15 * ART_SCALE);
        ctx.fillStyle = '#b83424';
        ctx.fillRect((cx - 72) * ART_SCALE, (y - 4) * ART_SCALE, 2 * ART_SCALE, 15 * ART_SCALE);
      }
      drawTextOutlined(ctx, atlas, label, labelX, y, selected ? COLOR_MENU : COLOR_MENU_DIM);
      if (selected) {
        // 光标：复用 HUD 生命迷你坦克（P1 黄），置于文字左侧、与文字垂直居中对齐。
        // 文字 7px 高、视觉中心在 y+3.5；迷你坦克车体只占格子上部、内容中心在格顶 +3；
        // 令两中心相等 → 格顶 = y+0.5（×ART_SCALE 后为整数美术像素，保持清晰）。
        drawTile(ctx, atlas.hudLifeTank[0], labelX - 20, y + 0.5);
      }
    }

    drawTextCentered(ctx, atlas, 'ARROWS SELECT   ENTER CONFIRM', cx, 203, '#606966');
    this.drawStatusLines(221);
  }

  // ───────────────────────── 绘制：房间码输入 ─────────────────────────

  private drawJoinCode(): void {
    const { ctx } = this;
    const atlas = this.renderer.spriteAtlas;
    clearScreen(ctx);
    const cx = NATIVE_WIDTH / 2;

    drawLogoTextCentered(ctx, atlas, 'JOIN', cx, 30, 3, COLOR_TITLE);
    drawTextCentered(ctx, atlas, 'ENTER ROOM CODE', cx, 79, COLOR_MENU);
    drawPixelPanel(ctx, cx - 66, 103, 132, 48);

    // 4 个字符槽：已输入的字母或下划线，等宽居中。
    const slotScale = 3;
    const slotAdvance = 24; // 每槽逻辑宽（含间隙）
    const totalW = ROOM_CODE_LENGTH * slotAdvance;
    let sx = cx - Math.round(totalW / 2) + 6;
    const slotY = 113;
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      const ch = this.codeBuffer[i] ?? '';
      const filled = i < this.codeBuffer.length;
      // 光标位（下一个待输入槽）高亮，其余暗。
      const isCursor = i === this.codeBuffer.length;
      const color = filled ? COLOR_HIGHLIGHT : isCursor ? COLOR_MENU : COLOR_MENU_DIM;
      drawBigTextCentered(ctx, atlas, ch || '_', sx + slotAdvance / 2, slotY, slotScale, color);
      sx += slotAdvance;
    }

    drawTextCentered(ctx, atlas, 'TYPE A-Z OR PASTE', cx, 169, COLOR_MENU_DIM);
    drawTextCentered(ctx, atlas, 'ENTER TO JOIN   ESC TO CANCEL', cx, 185, COLOR_MENU_DIM);
    this.drawStatusLines(207);
  }

  // ───────────────────────── 绘制：大厅 ─────────────────────────

  private drawLobby(): void {
    const { ctx } = this;
    const atlas = this.renderer.spriteAtlas;
    clearScreen(ctx);
    const cx = NATIVE_WIDTH / 2;

    drawTextCentered(ctx, atlas, 'ROOM CODE', cx, 16, COLOR_MENU);
    // 房间码大字（房主可念给同伴）。
    drawLogoTextCentered(ctx, atlas, this.roomCode || '----', cx, 30, 4, '#d89a31', '#ffe083', '#74501a');

    // 分享地址：同伴直接打开即自动加入。可能超出画面宽度，故左边界钳到 0（宁可贴边不换行）。
    if (this.roomCode) {
      const link = this.shareUrlText();
      const linkX = Math.max(0, cx - Math.round(textWidth(link) / 2));
      drawTextOutlined(ctx, atlas, link, linkX, 72, COLOR_MENU_DIM);
    }

    drawPixelPanel(ctx, cx - 82, 86, 164, 82);

    // 玩家列表：4 行 1P..4P。
    const listTop = 94;
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
      drawTextOutlined(ctx, atlas, text, x, y, color);
      if (mine) drawTextOutlined(ctx, atlas, '<', x - 12, y, COLOR_HIGHLIGHT);
    }

    // 操作提示（4 行等距；比原先多一行 COPY LINK，故整体上提 6px 给底部状态行留位）。
    const hintRowH = 14;
    const hintY = listTop + MAX_PLAYERS * rowH + 6;
    drawTextCentered(ctx, atlas, 'ENTER = READY', cx, hintY, COLOR_MENU);
    if (this.isHost()) {
      const allReady = this.allReady();
      drawTextCentered(
        ctx,
        atlas,
        allReady ? 'S = START' : 'WAIT ALL READY',
        cx,
        hintY + hintRowH,
        allReady ? COLOR_OK : COLOR_MENU_DIM,
      );
    } else {
      drawTextCentered(ctx, atlas, 'WAIT FOR HOST', cx, hintY + hintRowH, COLOR_MENU_DIM);
    }
    drawTextCentered(ctx, atlas, 'ESC = LEAVE', cx, hintY + hintRowH * 2, COLOR_MENU_DIM);
    // 复制提示态：菜单每帧重绘，时间戳过期即自然复原为默认行。
    const copied = performance.now() < this.linkCopiedUntil;
    drawTextCentered(
      ctx,
      atlas,
      copied ? 'LINK COPIED' : 'C = COPY LINK',
      cx,
      hintY + hintRowH * 3,
      copied ? COLOR_OK : COLOR_MENU_DIM,
    );

    this.drawStatusLines(hintY + hintRowH * 4 + 2);
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
  // 把 now - interpDelay 映射到权威 tick，落在缓冲区两份快照 [from, to] 之间：
  //   • 全部坦克 / 子弹（含本地玩家坦克）的 x/y 在 from→to 间按 alpha 插值（其余字段取 to）；
  //     本地与远程走同一路径——纯服务器权威，无预测、无对账。
  //   • 非位置状态（地形 / HUD / 阶段 / 爆炸）取自 to，避免阶段闪烁；
  //   • renderTime 超出最新快照（卡顿）→ 冻结在最新，不外推；早于最旧 → 用最旧。
  private buildNetRenderState(): GameState | null {
    const buf = this.snapBuf;
    if (buf.length === 0) return null;

    this.adaptInterpDelay();
    const now = performance.now();

    // 用权威逻辑 tick 选插值区间；arrival 只负责把本地当前时刻换算到服务器时间轴。
    // 服务器补帧时可能在同一次事件循环连续发出多份快照，它们的 arrival 几乎相同，但 tick
    // 始终严格递增。按 tick 插值可避免把数帧累计移动压缩进接近 0ms 的到达间隔。
    const window = snapshotInterpolationWindow(buf, now, this.interpDelay);
    const from = buf[window.fromIndex];
    const to = buf[window.toIndex];
    const alpha = window.alpha;

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

// 从粘贴文本里提取房间码：先试 URL 形态（?room=XXXX），失败则把整段当作裸码，
// 统一大写后只保留字母表内字符，截取前 ROOM_CODE_LENGTH 位。捞不到返回空串。
function extractRoomCode(text: string): string {
  const m = ROOM_PARAM_RE.exec(text);
  const raw = (m ? m[1] : text).toUpperCase();
  let out = '';
  for (const ch of raw) {
    if (!ROOM_CODE_ALPHABET.includes(ch)) continue;
    out += ch;
    if (out.length === ROOM_CODE_LENGTH) break;
  }
  return out;
}

// 剪贴板回退：非安全上下文（局域网 http）没有 navigator.clipboard，
// 用离屏 textarea + execCommand('copy')。返回是否复制成功。
function copyViaTextarea(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  // 固定定位 + 全透明：不触发滚动、不可见。
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

// 多输入设备合并：逐字段按位或。方向字段各自只有一个为真（各设备内部已折成唯一方向），
// 两设备同时推不同方向时会同时为真，交由游戏层的固定优先级裁决。
function mergeInput(a: InputState, b: InputState): InputState {
  return {
    up: a.up || b.up,
    down: a.down || b.down,
    left: a.left || b.left,
    right: a.right || b.right,
    fire: a.fire || b.fire,
    start: a.start || b.start,
    pause: a.pause || b.pause,
  };
}

function sameInput(a: InputState, b: InputState): boolean {
  return (
    a.up === b.up &&
    a.down === b.down &&
    a.left === b.left &&
    a.right === b.right &&
    a.fire === b.fire &&
    a.start === b.start &&
    a.pause === b.pause
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

// 把本地渲染时刻映射到权威 tick 时间轴，并返回包围它的两份快照及插值比例。
// 导出纯函数便于覆盖服务器补帧（多份快照同时到达）的回归测试。
export function snapshotInterpolationWindow(
  snapshots: ReadonlyArray<{ snap: { tick: number }; arrival: number }>,
  renderTime: number,
  interpDelayMs: number,
): { fromIndex: number; toIndex: number; alpha: number } {
  if (snapshots.length === 0) return { fromIndex: 0, toIndex: 0, alpha: 0 };

  const latest = snapshots[snapshots.length - 1];
  const ticksPerMs = TICKS_PER_SECOND / 1000;
  const estimatedNowTick = latest.snap.tick + Math.max(0, renderTime - latest.arrival) * ticksPerMs;
  const renderTick = estimatedNowTick - interpDelayMs * ticksPerMs;

  let fromIndex = 0;
  for (let i = 0; i < snapshots.length; i++) {
    if (snapshots[i].snap.tick <= renderTick) fromIndex = i;
    else break;
  }
  const toIndex = Math.min(fromIndex + 1, snapshots.length - 1);
  const fromTick = snapshots[fromIndex].snap.tick;
  const spanTicks = snapshots[toIndex].snap.tick - fromTick;
  const alpha = spanTicks > 0 ? clamp01((renderTick - fromTick) / spanTicks) : 0;
  return { fromIndex, toIndex, alpha };
}

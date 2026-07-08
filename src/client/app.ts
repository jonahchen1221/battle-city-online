// 客户端应用状态机：串起标题 / 房间码输入 / 大厅 / 本地游戏 / 联机游戏五个画面。
// 固定 60Hz 逻辑循环由 main.ts 驱动，每帧调用 tick()（逻辑）与 render(alpha)（绘制），
// 本类按当前 screen 分发。菜单类画面用一个轻量 keydown 监听（仅在菜单画面响应，避免与游戏 Keyboard 打架）。
//
// 联机渲染：客户端不做权威模拟，只持有最近两份快照并在渲染帧间做位置插值；
// 其余一切（地形 / HUD / 爆炸 / 阶段）直接取最新快照。

import { createGameState, resetGameState, GameState } from '../game/state';
import { update } from '../game/update';
import { applyInput, isPlayerTank, TankState } from '../game/tank';
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
// 保留最近若干份快照 + 到达时刻，按 renderTime = now - interpDelay 在其间插值远程实体。
const SNAP_BUFFER_SIZE = 16; // 快照环缓冲容量
const GAP_SAMPLE_COUNT = 20; // 参与自适应的最近到达间隔样本数
const INTERP_DELAY_START = 150; // 插值延迟起步（ms）
const INTERP_DELAY_MIN = 120; // 自适应下限（ms）
const INTERP_DELAY_MAX = 400; // 自适应上限（ms）
const INTERP_DELAY_EASE = 0.01; // 每渲染帧向目标缓动的比例（约 1%/帧，避免可见的时间扭曲）

// ── 本地坦克客户端预测 / 输入回放对账参数 ──
// 对账采用「输入回放」（input replay）：服务器回执已应用的输入 seq（snap.inputAck），
// 客户端以权威快照为基准、回放尚未确认的本地输入重建预测位置——领先的预测不再被拽回（消除橡皮筋）。
const INPUT_HISTORY_SIZE = 512; // 输入历史环缓冲容量（2 的幂，便于 & 掩码）
const INPUT_HISTORY_MASK = INPUT_HISTORY_SIZE - 1;
const REPLAY_WINDOW_MAX = 480; // 回放窗口上限（tick）：predTick-ack 超此值视为历史越界，退回旧式吸附
const CORRECTION_HARD_SNAP = 24; // 回放结果与当前预测误差超此值（px）即硬吸附（错位 / 被夹 / 丢包补偿）
const CORRECTION_MAX = 12; // 平滑修正的渲染偏移量上限（px）
const CORRECTION_DECAY = 0.85; // 修正偏移每 tick 的衰减系数
const CORRECTION_EPS = 0.1; // 偏移小于此值（px）即归零，避免无尽的浮点尾巴
const PREDICT_SNAP_DIST = 16; // 退回路径（无 ack / 越界）下预测与服务器误差超此值（px）即硬吸附

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

  // 联机游戏快照 / 插值（抖动缓冲）。
  private snapBuf: BufferedSnap[] = []; // 最近 SNAP_BUFFER_SIZE 份快照（按到达时间升序）
  private arrivalGaps: number[] = []; // 最近 GAP_SAMPLE_COUNT 个到达间隔（ms），用于自适应
  private lastArrival = 0; // 上一份快照到达时刻
  private interpDelay = INTERP_DELAY_START; // 当前插值延迟（ms），逐帧向目标缓动
  private clientLevel: LevelState | null = null; // 客户端持有的地形（增量下发：无 level 的快照沿用它）
  // 本地玩家坦克的预测状态：本地即时响应输入，服务器仍权威。null = 未预测（缺席 / 非 playing）。
  private predicted: TankState | null = null;
  // 本地预测 tick 计数（每次 tickNet ++）与输入历史环缓冲：对账时据 seq 回放尚未确认的输入。
  private predTick = 0;
  private inputHistory: InputState[] = makeInputHistory();
  // 平滑修正的渲染偏移：回放把 predicted 瞬间挪到新位置时，把「旧-新」差塞进此偏移并逐帧衰减，
  // 保证渲染连续（不跳变）。仅影响渲染，碰撞 / 逻辑仍用 predicted 本体。
  private correction = { x: 0, y: 0 };
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
    // 本帧预测 tick 号（自增在前：seq 即为本帧号，回放上界 t<=predTick 恰好闭合）。
    this.predTick++;
    const input = this.keyboard.snapshot();
    // 每帧记录输入历史（无论是否发送）：对账回放据 seq 逐帧取用。
    this.inputHistory[this.predTick & INPUT_HISTORY_MASK] = input;
    const now = performance.now();
    const changed = !sameInput(input, this.lastSentInput);
    if (changed || now - this.lastSendTime >= INPUT_HEARTBEAT_MS) {
      // seq = 本帧预测 tick；服务器据此回执 inputAck，客户端据此确定回放窗口。
      this.net.send({ t: 'input', input, seq: this.predTick });
      this.lastSentInput = input;
      this.lastSendTime = now;
    }
    // 本地坦克预测：每逻辑帧（60Hz）用与服务器完全相同的纯移动逻辑推进一步，
    // 使本地转向 / 移动 / 轴吸附即时响应（消除一个 RTT 的输入手感延迟）。
    this.stepPrediction(input);
  }

  // 用本帧输入推进本地预测坦克一步（仅在 playing 且未暂停时；开火 / 敌人 / 子弹不预测）。
  private stepPrediction(input: InputState): void {
    // 修正偏移逐帧（60Hz）衰减：无论预测是否活跃都推进，保证平滑归零。
    this.decayCorrection();
    const predicted = this.predicted;
    const level = this.clientLevel;
    const newest = this.newestSnap();
    if (!predicted || !level || !newest) return;
    if (newest.phase !== 'playing' || newest.paused) return;
    // 碰撞用最新快照里的其他坦克（排除自身——其服务器位置已过时，留着会与预测体互撞）。
    const others = newest.tanks.filter((t) => t.id !== predicted.id);
    applyInput(predicted, input, level, others);
  }

  // 修正渲染偏移的逐帧衰减（*0.85），小于阈值即归零。
  private decayCorrection(): void {
    const c = this.correction;
    c.x = Math.abs(c.x * CORRECTION_DECAY) < CORRECTION_EPS ? 0 : c.x * CORRECTION_DECAY;
    c.y = Math.abs(c.y * CORRECTION_DECAY) < CORRECTION_EPS ? 0 : c.y * CORRECTION_DECAY;
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
        // 清空快照缓冲 / 预测，等待第一份 snapshot 才真正进入渲染。
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

    // 本地坦克预测对账（reconciliation）。
    this.reconcile(snap);

    // 快照携带的音效事件立即播放（覆盖两份快照之间累积的事件，避免漏音）。
    for (const e of events) this.sfx.play(e);
  }

  // 每份快照到达时对账本地预测坦克：服务器权威，预测只做“即时手感”。
  // 核心为「输入回放」：以权威快照为基准，回放 ack 之后尚未确认的本地输入重建预测位置，
  // 领先的预测因此不会被拽回一个 RTT 之前的服务器位置（消除橡皮筋）。
  private reconcile(snap: Snapshot): void {
    // 阶段边界 / 暂停：不预测，渲染纯服务器状态；丢弃预测与修正偏移（重新出现时再克隆）。
    if (snap.phase !== 'playing' || snap.paused) {
      this.clearPrediction();
      return;
    }
    const server = snap.tanks.find((t) => isPlayerTank(t) && t.playerIndex === this.myPlayerIndex);
    // 本地坦克缺席（阵亡 / 出生闪光中）：丢弃预测，渲染服务器真值，重新出现时再克隆。
    if (!server) {
      this.clearPrediction();
      return;
    }
    // 首次出现 / 重新出现：直接克隆服务器坦克，偏移清零。
    if (!this.predicted) {
      this.predicted = { ...server };
      this.correction.x = 0;
      this.correction.y = 0;
      return;
    }

    const level = this.clientLevel;
    const ack = snap.inputAck?.[this.myPlayerIndex] ?? -1;
    const p = this.predicted;

    // 退回路径：尚无回执（ack<0）/ 历史窗口越界（predTick-ack 过大）/ 无地形。
    // 罕见——沿用旧式行为：误差过大则硬吸附，否则保持预测。
    if (!level || ack < 0 || this.predTick - ack > REPLAY_WINDOW_MAX) {
      const err = Math.hypot(server.x - p.x, server.y - p.y);
      if (err > PREDICT_SNAP_DIST) {
        this.predicted = { ...server };
        this.correction.x = 0;
        this.correction.y = 0;
      } else {
        this.copyAuthFields(p, server); // 保持预测位置，仅同步非位置权威字段
      }
      return;
    }

    // 输入回放：从权威坦克克隆一份 sim，逐帧回放 ack+1..predTick 的本地输入。
    // 碰撞用本份（最新）快照里的其他坦克。窗口通常 20–60 tick（10Hz 快照），开销可忽略。
    const others = snap.tanks.filter((t) => t.id !== server.id);
    const sim: TankState = { ...server };
    for (let t = ack + 1; t <= this.predTick; t++) {
      applyInput(sim, this.inputHistory[t & INPUT_HISTORY_MASK], level, others);
    }

    const oldX = p.x;
    const oldY = p.y;
    const err = Math.hypot(sim.x - oldX, sim.y - oldY);
    if (err > CORRECTION_HARD_SNAP) {
      // 误差过大：硬吸附到回放结果，清偏移。
      this.predicted = sim;
      this.correction.x = 0;
      this.correction.y = 0;
    } else {
      // 平滑修正：predicted 直接采用回放结果，但把「旧-新」差累加进渲染偏移（限幅 ≤12px）后逐帧衰减，
      // 使渲染位置连续、不跳变。
      this.predicted = sim;
      let ox = this.correction.x + (oldX - sim.x);
      let oy = this.correction.y + (oldY - sim.y);
      const mag = Math.hypot(ox, oy);
      if (mag > CORRECTION_MAX) {
        const s = CORRECTION_MAX / mag;
        ox *= s;
        oy *= s;
      }
      this.correction.x = ox;
      this.correction.y = oy;
    }
    // 克隆自权威坦克 + applyInput 只改 x/y/dir/moving/slideTicks，故非位置权威字段已是服务器真值；
    // 此处显式再同步一次以防未来 applyInput 触及更多字段（审计：当前不会）。
    this.copyAuthFields(this.predicted, server);
  }

  // 丢弃预测并清零修正偏移（阶段边界 / 缺席时用）。
  private clearPrediction(): void {
    this.predicted = null;
    this.correction.x = 0;
    this.correction.y = 0;
  }

  // 把服务器权威的非位置字段同步到预测坦克（位置 x/y/dir/moving/slideTicks 由回放维持）。
  private copyAuthFields(dst: TankState, src: TankState): void {
    dst.hp = src.hp;
    dst.level = src.level;
    dst.invulnTicks = src.invulnTicks;
    dst.carriesPowerup = src.carriesPowerup;
    dst.speed = src.speed;
    dst.bulletSpeed = src.bulletSpeed;
    dst.alive = src.alive;
    dst.prevFire = src.prevFire;
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

  // 清空一切联机对局态（快照缓冲 / 自适应统计 / 地形 / 预测 / 输入历史）。开局与返回标题共用。
  private resetNetPlayState(): void {
    this.snapBuf = [];
    this.arrivalGaps = [];
    this.lastArrival = 0;
    this.interpDelay = INTERP_DELAY_START;
    this.clientLevel = null;
    this.predicted = null;
    this.predTick = 0;
    this.inputHistory = makeInputHistory();
    this.correction.x = 0;
    this.correction.y = 0;
  }

  // 缓冲中最新（到达时间最晚）的一份快照；空缓冲返回 null。
  private newestSnap(): Snapshot | null {
    const n = this.snapBuf.length;
    return n > 0 ? this.snapBuf[n - 1].snap : null;
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
  //   • 远程坦克 / 子弹的 x/y 在 from→to 间按 alpha 插值（其余字段取 to）；
  //   • 本地坦克用预测位置覆盖（预测活跃时）；
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

    // 远程坦克：以 to 为准，按 id 匹配 from 旧位置插值；本地玩家坦克用预测覆盖。
    const fromTankById = new Map<number, { x: number; y: number }>();
    for (const t of from.snap.tanks) fromTankById.set(t.id, { x: t.x, y: t.y });
    const predicted = this.predicted;
    const corr = this.correction;
    const tanks = base.tanks.map((t) => {
      if (predicted && isPlayerTank(t) && t.playerIndex === this.myPlayerIndex) {
        // 本地坦克：渲染预测位置 + 平滑修正偏移（仅视觉；碰撞 / 逻辑用 predicted 本体）。
        return { ...predicted, x: predicted.x + corr.x, y: predicted.y + corr.y };
      }
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

// 建一个填满 emptyInput 的输入历史环缓冲（开局 / 返回标题时重置用）。
function makeInputHistory(): InputState[] {
  const h = new Array<InputState>(INPUT_HISTORY_SIZE);
  for (let i = 0; i < INPUT_HISTORY_SIZE; i++) h[i] = emptyInput();
  return h;
}

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

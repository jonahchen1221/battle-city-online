// 房间 / 大厅 / 对局生命周期。服务器权威：每个房间独立持有一份 GameState，
// 以固定 60Hz 推进，并按 SNAPSHOT_INTERVAL_TICKS 向房内所有连接广播快照。
//
// 本文件位于服务器层（src/server/），可自由使用 Node API / crypto / 计时器 ——
// 但绝不修改 src/game 的纯模拟层，只调用 createGameState / update / pickSnapshot。

import { randomInt } from 'node:crypto';
import type { WebSocket } from 'ws';

import {
  MAX_PLAYERS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  SNAPSHOT_INTERVAL_TICKS,
  pickSnapshot,
  type LobbyPlayer,
  type ServerMessage,
  type ServerErrorCode,
} from '../net/protocol';
import { InputState, emptyInput } from '../core/types';
import { GameState, GameEvent, createGameState } from '../game/state';
import { update } from '../game/update';

// ── 计时常量（服务器层，非模拟；以毫秒为单位）──
const TICK_HZ = 60;
const TICK_MS = 1000 / TICK_HZ; // ≈16.667ms
// 单次定时器唤醒最多补跑的帧数上限：防止长时间卡顿后的“追帧螺旋”。
const MAX_CATCHUP_TICKS = 30;
// 全员断线后的销毁宽限期：期间保留房间与对局，等待重连。
const EMPTY_ROOM_GRACE_MS = 60_000;
// 快照背压阈值：连接的未送出缓冲超过此值则跳过本次快照（防弱网延迟滚雪球）。
const SNAPSHOT_BACKPRESSURE_BYTES = 16 * 1024;

// 房内一个座位。playerIndex 即游戏内座位号（0..3），决定出生点/配色/输入映射。
interface Slot {
  playerIndex: number;
  ready: boolean;
  connected: boolean;
  isHost: boolean;
  ws: WebSocket | null; // 断线时置 null
  input: InputState; // 该玩家最新输入（逐帧应用，收到新消息才更新）
  // 该座位已应用的最新一条 input 消息的 seq（输入回放对账用，随快照以 inputAck 回执客户端）。
  // -1 = 尚未收到任何输入；入房 / 重连 / 建房时重置为 -1。
  inputSeq: number;
  // 已成功下发给该连接的 level.rev（增量地形，见 protocol.ts）。-1 = 尚未发过任何 level；
  // 入房 / 重连时重置为 -1，保证新连接的第一份快照必含完整地形。
  sentLevelRev: number;
}

export type RoomPhase = 'lobby' | 'in-game';

export class Room {
  readonly code: string;
  phase: RoomPhase = 'lobby';
  private readonly slots = new Map<number, Slot>(); // key = playerIndex
  private game: GameState | null = null;
  // 两次快照之间累积的音效事件；随 snapshot 消息一并下发后清空。
  private eventAccumulator: GameEvent[] = [];

  // 循环 / 计时状态
  private loopTimer: ReturnType<typeof setInterval> | null = null;
  private lastTickTime = 0; // 上一逻辑帧的“应发生”时刻（用于漂移校正）
  private destroyTimer: ReturnType<typeof setTimeout> | null = null;

  // 房间被销毁时回调（由 RoomManager 注入，用于从注册表移除）。
  constructor(code: string, private readonly onDestroy: (code: string) => void) {
    this.code = code;
  }

  // ── 查询 ──
  private connectedCount(): number {
    let n = 0;
    for (const s of this.slots.values()) if (s.connected) n++;
    return n;
  }

  private slotCount(): number {
    return this.slots.size;
  }

  // 大厅玩家列表（按座位号升序），用于 joined / lobby 广播。
  private toLobbyPlayers(): LobbyPlayer[] {
    return [...this.slots.values()]
      .sort((a, b) => a.playerIndex - b.playerIndex)
      .map((s) => ({ playerIndex: s.playerIndex, ready: s.ready, connected: s.connected }));
  }

  // 找出最低空闲座位号（0..MAX_PLAYERS-1）；满则返回 -1。
  private lowestFreeIndex(): number {
    for (let i = 0; i < MAX_PLAYERS; i++) {
      if (!this.slots.has(i)) return i;
    }
    return -1;
  }

  // ── 发送辅助 ──
  private static send(ws: WebSocket | null, msg: ServerMessage): void {
    // ws.OPEN === 1；避免在未连接的 socket 上发送导致抛错。
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  private broadcast(msg: ServerMessage): void {
    for (const s of this.slots.values()) Room.send(s.ws, msg);
  }

  private broadcastLobby(): void {
    this.broadcast({ t: 'lobby', players: this.toLobbyPlayers() });
  }

  // 座位号 → 该座位的 WebSocket（供 server.ts 反查连接归属）。
  wsForIndex(playerIndex: number): WebSocket | null {
    return this.slots.get(playerIndex)?.ws ?? null;
  }

  // ── 加入 / 建房 ──
  // 建房者：分配 0 号位并成为房主。
  addHost(ws: WebSocket): number {
    const slot: Slot = {
      playerIndex: 0,
      ready: false,
      connected: true,
      isHost: true,
      ws,
      input: emptyInput(),
      inputSeq: -1,
      sentLevelRev: -1,
    };
    this.slots.set(0, slot);
    this.cancelDestroyTimer();
    Room.send(ws, { t: 'joined', code: this.code, playerIndex: 0, players: this.toLobbyPlayers() });
    return 0;
  }

  // 加入：大厅内取最低空位；进行中的房间仅允许顶替断线座位（重连）。
  // 返回分配到的 playerIndex，失败返回错误码。
  join(ws: WebSocket): number | ServerErrorCode {
    if (this.phase === 'in-game') {
      // 重连：寻找一个断线且已保留的座位顶替。
      const reclaimed = [...this.slots.values()]
        .filter((s) => !s.connected)
        .sort((a, b) => a.playerIndex - b.playerIndex)[0];
      if (!reclaimed) return 'already_started';
      reclaimed.ws = ws;
      reclaimed.connected = true;
      reclaimed.input = emptyInput();
      reclaimed.inputSeq = -1; // 重连：输入回执从头开始
      reclaimed.sentLevelRev = -1; // 重连：强制下一份快照重发完整地形
      this.cancelDestroyTimer();
      // 先发 joined（含旧座位号），再补一条 started 让客户端直接进入游戏画面。
      Room.send(ws, {
        t: 'joined',
        code: this.code,
        playerIndex: reclaimed.playerIndex,
        players: this.toLobbyPlayers(),
      });
      Room.send(ws, { t: 'started', playerCount: this.game?.playerCount ?? this.slotCount() });
      return reclaimed.playerIndex;
    }

    // 大厅：分配最低空位。
    const idx = this.lowestFreeIndex();
    if (idx < 0) return 'room_full';
    const slot: Slot = {
      playerIndex: idx,
      ready: false,
      connected: true,
      isHost: false,
      ws,
      input: emptyInput(),
      inputSeq: -1,
      sentLevelRev: -1,
    };
    this.slots.set(idx, slot);
    this.cancelDestroyTimer();
    Room.send(ws, { t: 'joined', code: this.code, playerIndex: idx, players: this.toLobbyPlayers() });
    this.broadcastLobby();
    return idx;
  }

  // ── 大厅操作 ──
  setReady(playerIndex: number, ready: boolean): void {
    if (this.phase !== 'lobby') return; // 非大厅阶段忽略
    const slot = this.slots.get(playerIndex);
    if (!slot) return;
    slot.ready = ready;
    this.broadcastLobby();
  }

  // 房主开局：要求发起者是房主，且所有在线玩家（含房主）均已准备。
  start(playerIndex: number): void {
    if (this.phase !== 'lobby') return;
    const host = this.slots.get(playerIndex);
    if (!host || !host.isHost) {
      Room.send(host?.ws ?? null, { t: 'error', code: 'not_host', msg: '只有房主可以开局' });
      return;
    }
    const connected = [...this.slots.values()].filter((s) => s.connected);
    if (connected.length === 0 || !connected.every((s) => s.ready)) {
      Room.send(host.ws, { t: 'error', code: 'not_all_ready', msg: '需全员准备就绪' });
      return;
    }
    this.startGame();
  }

  // ── 输入 ──
  // seq 为客户端本地预测 tick（单调递增）。仅接受 seq >= 已记录值，忽略乱序 / 迟到的旧包，
  // 避免 inputAck 回退导致客户端回放窗口错乱。seq 随快照以 inputAck 回执，供客户端输入回放对账。
  setInput(playerIndex: number, input: InputState, seq: number): void {
    const slot = this.slots.get(playerIndex);
    if (!slot || !slot.connected) return;
    if (seq < slot.inputSeq) return; // 陈旧 / 乱序：丢弃
    slot.input = input;
    slot.inputSeq = seq;
  }

  // ── 断线 ──
  // 大厅：彻底释放座位。进行中：保留座位待重连，输入清零。
  handleDisconnect(playerIndex: number): void {
    const slot = this.slots.get(playerIndex);
    if (!slot) return;

    if (this.phase === 'lobby') {
      const wasHost = slot.isHost;
      this.slots.delete(playerIndex);
      // 房主离开则把房主转交给剩余最低座位，避免房间无人能开局。
      if (wasHost) {
        const next = [...this.slots.values()].sort((a, b) => a.playerIndex - b.playerIndex)[0];
        if (next) next.isHost = true;
      }
      if (this.slotCount() === 0) {
        this.destroyNow(); // 大厅空房：立即销毁
      } else {
        this.broadcastLobby();
      }
      return;
    }

    // 进行中：保留座位（供重连顶替），仅标记断线并清零输入。
    slot.connected = false;
    slot.ws = null;
    slot.input = emptyInput();
    if (this.connectedCount() === 0) this.scheduleDestroy(); // 全员断线 → 宽限期后销毁
  }

  // ── 对局循环 ──
  private startGame(): void {
    // 座位可能存在空洞（大厅内有人离开），playerCount 取“最高座位号 + 1”，
    // 以保证引擎按 playerIndex 映射输入不错位；空洞座位以 emptyInput 驱动（静止的幽灵坦克）。
    let maxIndex = -1;
    for (const i of this.slots.keys()) if (i > maxIndex) maxIndex = i;
    const playerCount = maxIndex + 1;

    // 游戏种子来自 crypto（对局外，不影响“注入 Rng 后确定性”这一铁律）。
    const seed = randomInt(0, 0x7fffffff);
    this.game = createGameState(seed, playerCount);
    this.eventAccumulator = [];
    this.phase = 'in-game';

    this.broadcast({ t: 'started', playerCount });

    this.lastTickTime = Date.now();
    this.loopTimer = setInterval(() => this.pump(), TICK_MS);
  }

  // 定时器每次唤醒：按“应发生时刻 vs 现在”补跑相应数量的逻辑帧（漂移校正）。
  private pump(): void {
    if (!this.game) return;
    const now = Date.now();
    let catchup = 0;
    while (now - this.lastTickTime >= TICK_MS && catchup < MAX_CATCHUP_TICKS) {
      this.tick();
      this.lastTickTime += TICK_MS;
      catchup++;
    }
    // 达到补帧上限说明积压过多（如进程被挂起）：丢弃积压，重新对齐到当前时刻。
    if (catchup >= MAX_CATCHUP_TICKS) this.lastTickTime = now;
  }

  // 单个逻辑帧：组装各座位最新输入 → update → 抽干事件 → 按间隔广播快照。
  private tick(): void {
    const game = this.game;
    if (!game) return;

    const inputs: InputState[] = new Array(game.playerCount);
    for (let i = 0; i < game.playerCount; i++) {
      const slot = this.slots.get(i);
      inputs[i] = slot && slot.connected ? slot.input : emptyInput();
    }

    update(game, inputs);

    // 抽干本帧事件到累加器（服务器代替 main.ts 消费 state.events，避免其无限增长）。
    if (game.events.length > 0) {
      for (const e of game.events) this.eventAccumulator.push(e);
      game.events.length = 0;
    }

    // 每 SNAPSHOT_INTERVAL_TICKS 帧广播一次权威快照 + 累积事件，随后清空累加器。
    // 背压保护：某连接的发送缓冲积压超过阈值时跳过本次快照（弱网下宁可少发、
    // 只发新鲜数据，否则积压滚雪球、延迟无限增长）。只跳快照，其余消息照发。
    //
    // 增量地形（见 protocol.ts）：每 tick 至多构造两份序列化——「含 level」与「不含 level」。
    // 逐连接按其 sentLevelRev 是否等于当前 game.level.rev 决定用哪份；两份都按需惰性构造。
    // 关键：仅在“真正发出含 level 的那份”后才推进 slot.sentLevelRev——被背压跳过的连接
    // 保持 sentLevelRev 不变，下次仍会补发完整地形，绝不会漏掉地形更新。
    if (game.tick % SNAPSHOT_INTERVAL_TICKS === 0) {
      const events = this.eventAccumulator;
      const levelRev = game.level.rev;
      // 输入回执：按座位 0..playerCount-1 取各自已应用的最新 seq（缺席座位 -1）。
      // 全体连接共享同一份 inputAck（各客户端只读自己那一格），故两份缓存负载仍可复用。
      const inputAck: number[] = new Array(game.playerCount);
      for (let i = 0; i < game.playerCount; i++) inputAck[i] = this.slots.get(i)?.inputSeq ?? -1;
      let payloadWithLevel: string | null = null;
      let payloadNoLevel: string | null = null;
      for (const s of this.slots.values()) {
        if (!s.ws || s.ws.readyState !== 1) continue;
        if (s.ws.bufferedAmount > SNAPSHOT_BACKPRESSURE_BYTES) continue; // 背压：跳过，sentLevelRev 不动
        const includeLevel = s.sentLevelRev !== levelRev;
        let payload: string;
        if (includeLevel) {
          payloadWithLevel ??= JSON.stringify({
            t: 'snapshot',
            snap: pickSnapshot(game, true, inputAck),
            events,
          });
          payload = payloadWithLevel;
        } else {
          payloadNoLevel ??= JSON.stringify({
            t: 'snapshot',
            snap: pickSnapshot(game, false, inputAck),
            events,
          });
          payload = payloadNoLevel;
        }
        s.ws.send(payload);
        if (includeLevel) s.sentLevelRev = levelRev; // 仅在实际发出后推进
      }
      this.eventAccumulator = [];
    }
  }

  // ── 销毁 ──
  private scheduleDestroy(): void {
    if (this.destroyTimer) return;
    this.destroyTimer = setTimeout(() => this.destroyNow(), EMPTY_ROOM_GRACE_MS);
  }

  private cancelDestroyTimer(): void {
    if (this.destroyTimer) {
      clearTimeout(this.destroyTimer);
      this.destroyTimer = null;
    }
  }

  private destroyNow(): void {
    this.cancelDestroyTimer();
    if (this.loopTimer) {
      clearInterval(this.loopTimer);
      this.loopTimer = null;
    }
    this.game = null;
    this.slots.clear();
    this.onDestroy(this.code);
  }
}

// 房间注册表：建房 / 按码查房 / 生成唯一房间码。
export class RoomManager {
  private readonly rooms = new Map<string, Room>();

  private genCode(): string {
    // 4 个来自 ROOM_CODE_ALPHABET 的大写字母（crypto 随机），确保未被占用。
    for (;;) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
        code += ROOM_CODE_ALPHABET[randomInt(0, ROOM_CODE_ALPHABET.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
  }

  createRoom(): Room {
    const code = this.genCode();
    const room = new Room(code, (c) => this.rooms.delete(c));
    this.rooms.set(code, room);
    return room;
  }

  getRoom(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  get size(): number {
    return this.rooms.size;
  }
}

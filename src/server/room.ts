// 房间 / 大厅 / 对局生命周期。服务器权威：每个房间独立持有一份 GameState，
// 以固定 60Hz 推进，并按 SNAPSHOT_INTERVAL_TICKS 向房内所有连接广播快照。
//
// 本文件位于服务器层（src/server/），可自由使用 Node API / crypto / 计时器 ——
// 但绝不修改 src/game 的纯模拟层，只调用 createGameState / update / pickSnapshot。

import { randomBytes, randomInt } from 'node:crypto';
import type { WebSocket } from 'ws';

import {
  LOCAL_ROOM_CODE,
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

// 房内一个大厅座位。开局时在线座位会按座位号排序并紧凑映射为对局 playerIndex，
// 避免大厅中间座位离开后生成没有连接的幽灵玩家。
interface Slot {
  playerIndex: number;
  name: string;
  ready: boolean;
  connected: boolean;
  isHost: boolean;
  ws: WebSocket | null; // 断线时置 null
  // 服务端签发的不可猜测座位凭证。每次成功接管连接后轮换，避免旧凭证重放。
  resumeToken: string;
  input: InputState; // 该玩家最新输入（逐帧应用，收到新消息才更新）
  // 已成功下发给该连接的地形 epoch / rev（增量地形，见 protocol.ts）。-1 = 尚未发过；
  // 入房 / 重连时二者都重置为 -1，保证新连接的第一份快照必含完整地形。
  sentLevelEpoch: number;
  sentLevelRev: number;
}

export type RoomPhase = 'lobby' | 'in-game';

export class Room {
  readonly code: string;
  readonly persistent: boolean;
  phase: RoomPhase = 'lobby';
  private readonly slots = new Map<number, Slot>(); // key = playerIndex
  // 对局 playerIndex → 大厅 Slot。只在开局时建立，之后即使断线也保持稳定供重连复用。
  private gameSlots: Slot[] = [];
  private game: GameState | null = null;
  // 两次快照之间累积的音效事件；随 snapshot 消息一并下发后清空。
  private eventAccumulator: GameEvent[] = [];

  // 循环 / 计时状态
  private loopTimer: ReturnType<typeof setInterval> | null = null;
  private lastTickTime = 0; // 上一逻辑帧的“应发生”时刻（用于漂移校正）
  private destroyTimer: ReturnType<typeof setTimeout> | null = null;

  // 房间被销毁时回调（由 RoomManager 注入，用于从注册表移除）。
  // persistent：局域网固定房，空房不销毁，下一批人还能直接加入。
  constructor(
    code: string,
    private readonly onDestroy: (code: string) => void,
    options: { persistent?: boolean } = {},
  ) {
    this.code = code;
    this.persistent = options.persistent === true;
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
      .map((s) => ({
        playerIndex: s.playerIndex,
        name: s.name,
        ready: s.ready,
        connected: s.connected,
        isHost: s.isHost,
      }));
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
  private static newResumeToken(): string {
    return randomBytes(24).toString('base64url');
  }

  private attach(slot: Slot, ws: WebSocket, name: string): void {
    const previous = slot.ws;
    slot.ws = ws;
    slot.name = name;
    slot.connected = true;
    slot.input = emptyInput();
    slot.sentLevelEpoch = -1;
    slot.sentLevelRev = -1;
    slot.resumeToken = Room.newResumeToken();
    this.cancelDestroyTimer();
    // 刷新页面时新连接可能先于旧连接的 close 到达。主动关闭旧 socket；server.ts 还会按
    // wsForIndex 校验连接归属，旧 socket 的迟到消息 / close 都不能影响新连接。
    if (previous && previous !== ws && previous.readyState === 1) previous.close(1000, 'session replaced');
  }

  // 建房者：分配 0 号位并成为房主。
  addHost(ws: WebSocket, name: string): number {
    const slot: Slot = {
      playerIndex: 0,
      name,
      ready: false,
      connected: true,
      isHost: true,
      ws,
      resumeToken: Room.newResumeToken(),
      input: emptyInput(),
      sentLevelEpoch: -1,
      sentLevelRev: -1,
    };
    this.slots.set(0, slot);
    this.cancelDestroyTimer();
    Room.send(ws, {
      t: 'joined',
      code: this.code,
      playerIndex: 0,
      players: this.toLobbyPlayers(),
      resumeToken: slot.resumeToken,
    });
    return 0;
  }

  // 加入：大厅内取最低空位；进行中的房间仅允许顶替断线座位（重连）。
  // 返回分配到的 playerIndex，失败返回错误码。
  join(ws: WebSocket, name: string, resumeToken?: string): number | ServerErrorCode {
    // 有效凭证始终精确恢复其原座位。允许替换仍被服务器视为在线的旧 socket，以修复网络
    // 半开 / 刷新竞态；旧连接会被 attach 主动关闭，且其后续消息会被 server.ts 拒绝。
    const resumed = resumeToken
      ? [...this.slots.values()].find((s) => s.resumeToken === resumeToken)
      : undefined;
    if (resumed) {
      this.attach(resumed, ws, name);
      Room.send(ws, {
        t: 'joined',
        code: this.code,
        playerIndex: resumed.playerIndex,
        players: this.toLobbyPlayers(),
        resumeToken: resumed.resumeToken,
      });
      if (this.phase === 'in-game') {
        const gamePlayerIndex = this.gameSlots.indexOf(resumed);
        Room.send(ws, {
          t: 'started',
          playerCount: this.game?.playerCount ?? this.gameSlots.length,
          playerIndex: gamePlayerIndex,
        });
      } else {
        this.broadcastLobby();
      }
      return resumed.playerIndex;
    }

    if (this.phase === 'in-game') {
      // 对局开始后不再按“最低断线座位”猜身份；缺失 / 过期 / 伪造凭证一律拒绝。
      return 'invalid_resume';
    }

    // 大厅：分配最低空位。空的常驻房由第一个加入者当房主。
    const idx = this.lowestFreeIndex();
    if (idx < 0) return 'room_full';
    const slot: Slot = {
      playerIndex: idx,
      name,
      ready: false,
      connected: true,
      isHost: this.slots.size === 0,
      ws,
      resumeToken: Room.newResumeToken(),
      input: emptyInput(),
      sentLevelEpoch: -1,
      sentLevelRev: -1,
    };
    this.slots.set(idx, slot);
    this.cancelDestroyTimer();
    Room.send(ws, {
      t: 'joined',
      code: this.code,
      playerIndex: idx,
      players: this.toLobbyPlayers(),
      resumeToken: slot.resumeToken,
    });
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
  // 保留该座位最新输入，逐帧应用。
  setInput(playerIndex: number, input: InputState): void {
    const slot = this.slots.get(playerIndex);
    if (!slot || !slot.connected) return;
    slot.input = input;
  }

  // ── 断线 ──
  // 大厅：彻底释放座位。进行中：保留座位待重连，输入清零。
  handleDisconnect(playerIndex: number, ws?: WebSocket): void {
    const slot = this.slots.get(playerIndex);
    if (!slot) return;
    // 被新连接替换的旧 socket 迟到 close 时不得删除 / 断开新连接的座位。
    if (ws && slot.ws !== ws) return;

    if (this.phase === 'lobby') {
      const wasHost = slot.isHost;
      this.slots.delete(playerIndex);
      // 房主离开则把房主转交给剩余最低座位，避免房间无人能开局。
      if (wasHost) {
        const next = [...this.slots.values()].sort((a, b) => a.playerIndex - b.playerIndex)[0];
        if (next) next.isHost = true;
      }
      if (this.slotCount() === 0) {
        if (!this.persistent) this.destroyNow(); // 大厅空房：立即销毁；常驻房留着等人
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
    // 大厅座位可能有空洞：只取在线座位并按旧座位号排序，紧凑映射到对局 0..N-1。
    // gameSlots 在整局内保持稳定；断线座位仍留在数组中，重连后继续控制原来的坦克。
    this.gameSlots = [...this.slots.values()]
      .filter((s) => s.connected)
      .sort((a, b) => a.playerIndex - b.playerIndex);
    const playerCount = this.gameSlots.length;

    // 游戏种子来自 crypto（对局外，不影响“注入 Rng 后确定性”这一铁律）。
    const seed = randomInt(0, 0x7fffffff);
    this.game = createGameState(seed, playerCount);
    this.eventAccumulator = [];
    this.phase = 'in-game';

    // started 必须逐连接发送，因为大厅座位有空洞时，每人的对局 playerIndex 需要重新映射。
    for (let i = 0; i < this.gameSlots.length; i++) {
      Room.send(this.gameSlots[i].ws, { t: 'started', playerCount, playerIndex: i });
    }

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
      const slot = this.gameSlots[i];
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
    // 逐连接按其已发出的 (levelEpoch, level.rev) 是否等于当前版本决定用哪份。
    // 关键：仅在真正发出含 level 的那份后才推进两个版本号；被背压跳过的连接下次仍会补发。
    if (game.tick % SNAPSHOT_INTERVAL_TICKS === 0) {
      const events = this.eventAccumulator;
      const levelEpoch = game.levelEpoch;
      const levelRev = game.level.rev;
      let payloadWithLevel: string | null = null;
      let payloadNoLevel: string | null = null;
      for (const s of this.slots.values()) {
        if (!s.ws || s.ws.readyState !== 1) continue;
        if (s.ws.bufferedAmount > SNAPSHOT_BACKPRESSURE_BYTES) continue; // 背压：版本号保持不动
        const includeLevel = s.sentLevelEpoch !== levelEpoch || s.sentLevelRev !== levelRev;
        let payload: string;
        if (includeLevel) {
          payloadWithLevel ??= JSON.stringify({
            t: 'snapshot',
            snap: pickSnapshot(game, true),
            events,
          });
          payload = payloadWithLevel;
        } else {
          payloadNoLevel ??= JSON.stringify({
            t: 'snapshot',
            snap: pickSnapshot(game, false),
            events,
          });
          payload = payloadNoLevel;
        }
        s.ws.send(payload);
        if (includeLevel) {
          s.sentLevelEpoch = levelEpoch;
          s.sentLevelRev = levelRev;
        }
      }
      this.eventAccumulator = [];
    }
  }

  // ── 销毁 ──
  private scheduleDestroy(): void {
    if (this.destroyTimer) return;
    this.destroyTimer = setTimeout(() => {
      this.destroyTimer = null;
      if (this.persistent) this.resetToEmptyLobby();
      else this.destroyNow();
    }, EMPTY_ROOM_GRACE_MS);
  }

  // 常驻房在全员离开后回到空大厅，房间码与注册表条目保持不变。
  private resetToEmptyLobby(): void {
    this.cancelDestroyTimer();
    if (this.loopTimer) {
      clearInterval(this.loopTimer);
      this.loopTimer = null;
    }
    this.game = null;
    this.gameSlots = [];
    this.slots.clear();
    this.eventAccumulator = [];
    this.phase = 'lobby';
    this.lastTickTime = 0;
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
    this.gameSlots = [];
    this.slots.clear();
    this.onDestroy(this.code);
  }

  // 服务器整体停机时立即释放循环与宽限期定时器；常规房间生命周期仍走内部销毁策略。
  shutdown(): void {
    this.destroyNow();
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

  // 局域网固定房：不存在则创建，空了也不从注册表拿掉。
  getOrCreateLocalRoom(): Room {
    let room = this.rooms.get(LOCAL_ROOM_CODE);
    if (!room) {
      room = new Room(LOCAL_ROOM_CODE, (c) => this.rooms.delete(c), { persistent: true });
      this.rooms.set(LOCAL_ROOM_CODE, room);
    }
    return room;
  }

  get size(): number {
    return this.rooms.size;
  }

  shutdown(): void {
    for (const room of [...this.rooms.values()]) room.shutdown();
    this.rooms.clear();
  }
}

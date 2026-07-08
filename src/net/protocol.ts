// 客户端 ↔ 服务器消息契约（JSON over WebSocket）。
// 本文件是纯类型 + 常量：可同时被浏览器客户端与 Node 服务器导入，不得引用 DOM / Node API。
//
// 架构：服务器权威。服务器以 60Hz 跑共享模拟（src/game/），客户端只发输入、收快照渲染。
// 快照按 SNAPSHOT_INTERVAL_TICKS 广播；两次快照间客户端做位置插值。

import { InputState } from '../core/types';
import { GameEvent } from '../game/state';

// 每隔多少逻辑帧广播一次快照（60Hz / 3 = 20Hz）。
export const SNAPSHOT_INTERVAL_TICKS = 3;

// 房间码：4 个大写字母（避开易混淆的 I/O）。
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const ROOM_CODE_LENGTH = 4;

export const MAX_PLAYERS = 4;

// 大厅中的玩家条目。playerIndex 即游戏内座位（0..3，决定出生点与配色）。
export interface LobbyPlayer {
  playerIndex: number;
  ready: boolean;
  connected: boolean;
}

// ── 客户端 → 服务器 ──
export type ClientMessage =
  | { t: 'create' } // 建房；成功后收到 joined（自己为 0 号位/房主）
  | { t: 'join'; code: string } // 按房间码加入（进行中的房间若有断线空位则顶替重连）
  | { t: 'ready'; ready: boolean } // 大厅内切换准备状态
  | { t: 'start' } // 房主开局（要求全员 ready）
  | { t: 'input'; input: InputState } // 输入快照；状态变化时发送，服务器保留每人最新值逐帧应用
  | { t: 'leave' }; // 主动离开房间

// ── 服务器 → 客户端 ──
export type ServerMessage =
  | { t: 'joined'; code: string; playerIndex: number; players: LobbyPlayer[] } // 入房成功（含重连）
  | { t: 'lobby'; players: LobbyPlayer[] } // 大厅状态变更广播
  | { t: 'started'; playerCount: number } // 开局；随后开始收 snapshot
  | { t: 'snapshot'; snap: Snapshot; events: GameEvent[] } // 权威快照 + 自上次快照以来累积的音效事件
  | { t: 'error'; code: ServerErrorCode; msg: string };

export type ServerErrorCode =
  | 'room_not_found'
  | 'room_full'
  | 'already_started'
  | 'not_host'
  | 'not_all_ready'
  | 'bad_message';

// ── 快照 ──
// GameState 的可传输形态：剔除 rng（闭包，且客户端不做权威模拟故不需要）与
// events（事件按快照窗口累积、随 snapshot 消息单独携带，避免客户端漏掉两快照之间的事件）。
// 其余字段全部为纯数据，直接 JSON 序列化。
// 注意：这里以 import type 依赖 GameState 的结构，游戏层字段演进时快照自动跟随。
import type { GameState } from '../game/state';
export type Snapshot = Omit<GameState, 'rng' | 'events'>;

// 从权威 state 摘取快照字段（浅取引用，调用方须立即序列化，不得跨 tick 持有）。
export function pickSnapshot(state: GameState): Snapshot {
  const { rng: _rng, events: _events, ...snap } = state;
  return snap;
}

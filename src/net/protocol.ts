// 客户端 ↔ 服务器消息契约（JSON over WebSocket）。
// 本文件是纯类型 + 常量：可同时被浏览器客户端与 Node 服务器导入，不得引用 DOM / Node API。
//
// 架构：服务器权威。服务器以 60Hz 跑共享模拟（src/game/），客户端只发输入、收快照渲染。
// 快照按 SNAPSHOT_INTERVAL_TICKS 广播；两次快照间客户端做位置插值。

import { InputState } from '../core/types';
import { GameEvent } from '../game/state';

// 每隔多少逻辑帧广播一次快照（60Hz / 6 = 10Hz）。
// 客户端在两快照间做位置插值，10Hz 视觉依旧平滑；相比 20Hz 带宽减半，
// 对跨境等弱网线路（高丢包时 TCP 有效吞吐骤降）更友好。
export const SNAPSHOT_INTERVAL_TICKS = 6;

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
  // 输入快照；状态变化时发送，服务器保留每人最新值逐帧应用。
  // seq = 客户端发出时的本地预测 tick（单调递增整数），用于服务器回执 + 客户端输入回放对账（消除橡皮筋）。
  | { t: 'input'; input: InputState; seq: number }
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
import type { LevelState } from '../game/level';

// 增量地形契约（弱网带宽优化的关键）：
// 全量地形（40×30 的 cells + brickMask 两个数组）是快照里最大的负载，且极少逐帧变化。
// 因此 level 变为「可选」字段——只在需要时下发：
//   • 服务器为每个连接跟踪其“最后确认收到的 level.rev”；当该值与当前 game.level.rev 不一致
//     （新客户端 / 重连 / 地形刚被破坏）时，本次快照携带完整 level，并记录已下发的 rev；
//   • rev 一致时省略 level，客户端沿用它上一次收到的 level 对象。
// 客户端据此重建：snap.level 存在则替换本地地形，否则复用上一份（渲染永远有 level 可用）。
//
// inputAck：按 playerIndex 索引，服务器已应用的“该座位最新一条 input 消息的 seq”（尚无则 -1）。
// 客户端据此从权威快照回放尚未确认的本地输入，重建预测位置（输入回放对账，消除橡皮筋）。
// 全体客户端共享（对账时各自只读自己那一格），故仍可复用同一份缓存序列化负载。
export type Snapshot = Omit<GameState, 'rng' | 'events' | 'level'> & {
  level?: LevelState;
  inputAck: number[];
};

// 从权威 state 摘取快照字段（浅取引用，调用方须立即序列化，不得跨 tick 持有）。
// includeLevel=true 时携带完整地形；false 时省略（增量：客户端沿用上一份 level）。
// inputAck 由调用方（Room）按各座位当前 inputSeq 组装后传入。
export function pickSnapshot(state: GameState, includeLevel: boolean, inputAck: number[]): Snapshot {
  const { rng: _rng, events: _events, level, ...rest } = state;
  return includeLevel ? { ...rest, level, inputAck } : { ...rest, inputAck };
}

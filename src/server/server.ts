// Node WebSocket 服务器入口：接线 ws、解析客户端消息、按连接归属分发到对应房间。
// 服务器权威模型：客户端只发输入，服务器跑模拟并广播快照（见 src/net/protocol.ts 契约）。
//
// 本文件与 room.ts 属服务器层，可自由使用 Node API；不修改 src/game 纯模拟层。

import { pathToFileURL } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';

import type { ClientMessage, ServerMessage, ServerErrorCode } from '../net/protocol';
import { InputState } from '../core/types';
import { Room, RoomManager } from './room';

// 端口：默认 8080，可用 PORT 环境变量覆盖。
export const DEFAULT_PORT = 8080;

// 一个连接的房间归属上下文。未入房时为 null。
interface ConnContext {
  room: Room;
  playerIndex: number;
}

// 校验 input 形状：必须是对象且六个字段皆为 boolean，否则视为非法。
function sanitizeInput(raw: unknown): InputState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const keys = ['up', 'down', 'left', 'right', 'fire', 'start'] as const;
  for (const k of keys) if (typeof o[k] !== 'boolean') return null;
  return {
    up: o.up as boolean,
    down: o.down as boolean,
    left: o.left as boolean,
    right: o.right as boolean,
    fire: o.fire as boolean,
    start: o.start as boolean,
  };
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function sendError(ws: WebSocket, code: ServerErrorCode, msg: string): void {
  send(ws, { t: 'error', code, msg });
}

export function createServer(port: number): WebSocketServer {
  const manager = new RoomManager();
  const wss = new WebSocketServer({ port });
  // 每个连接的归属（哪个房间、哪个座位）。连接关闭后移除。
  const contexts = new Map<WebSocket, ConnContext>();

  wss.on('connection', (ws: WebSocket) => {
    ws.on('message', (data: Buffer) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString()) as ClientMessage;
      } catch {
        sendError(ws, 'bad_message', '无法解析的 JSON');
        return;
      }
      if (typeof msg !== 'object' || msg === null || typeof (msg as { t?: unknown }).t !== 'string') {
        sendError(ws, 'bad_message', '缺少消息类型');
        return;
      }

      const ctx = contexts.get(ws);

      try {
        switch (msg.t) {
          case 'create': {
            // 已在房内则忽略（对当前阶段无效的消息一律安全忽略）。
            if (ctx) return;
            const room = manager.createRoom();
            const idx = room.addHost(ws);
            contexts.set(ws, { room, playerIndex: idx });
            break;
          }

          case 'join': {
            if (ctx) return; // 已在房内，忽略
            if (typeof msg.code !== 'string') {
              sendError(ws, 'bad_message', 'join 缺少房间码');
              return;
            }
            const room = manager.getRoom(msg.code.toUpperCase());
            if (!room) {
              sendError(ws, 'room_not_found', '房间不存在');
              return;
            }
            const res = room.join(ws);
            if (typeof res === 'string') {
              sendError(ws, res, '无法加入房间');
              return;
            }
            contexts.set(ws, { room, playerIndex: res });
            break;
          }

          case 'ready': {
            if (!ctx) return;
            if (typeof msg.ready !== 'boolean') {
              sendError(ws, 'bad_message', 'ready 需为布尔');
              return;
            }
            ctx.room.setReady(ctx.playerIndex, msg.ready);
            break;
          }

          case 'start': {
            if (!ctx) return;
            ctx.room.start(ctx.playerIndex);
            break;
          }

          case 'input': {
            if (!ctx) return;
            const input = sanitizeInput(msg.input);
            if (!input) {
              sendError(ws, 'bad_message', 'input 形状非法');
              return;
            }
            ctx.room.setInput(ctx.playerIndex, input);
            break;
          }

          case 'leave': {
            if (!ctx) return;
            // 主动离开：走断线清理路径（大厅释放座位 / 进行中保留待重连），随后关闭连接。
            ctx.room.handleDisconnect(ctx.playerIndex);
            contexts.delete(ws);
            ws.close();
            break;
          }

          default: {
            sendError(ws, 'bad_message', '未知消息类型');
          }
        }
      } catch (err) {
        // 单个客户端的异常绝不拖垮房间：兜底捕获并回一条错误。
        console.error(`[room] 处理消息出错 (${(msg as { t?: string }).t}):`, err);
        sendError(ws, 'bad_message', '服务器处理消息失败');
      }
    });

    ws.on('close', () => {
      const ctx = contexts.get(ws);
      if (ctx) {
        ctx.room.handleDisconnect(ctx.playerIndex);
        contexts.delete(ws);
      }
    });

    // 忽略 socket 层错误（如异常断开），close 事件会随后触发清理。
    ws.on('error', () => {});
  });

  return wss;
}

// 仅当作为入口直接运行时启动监听（tsx src/server/server.ts）；被 import 时（如 smoke.ts）不自启。
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = process.env.PORT ? Number(process.env.PORT) : DEFAULT_PORT;
  const wss = createServer(port);
  wss.on('listening', () => {
    console.log(`[server] Battle City 服务器已启动，监听 :${port}`);
  });
}

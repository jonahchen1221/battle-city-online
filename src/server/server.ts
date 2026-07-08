// Node 服务器入口：单进程同端口托管「HTTP 静态客户端（dist/）+ 游戏 WebSocket」。
// 服务器权威模型：客户端只发输入，服务器跑模拟并广播快照（见 src/net/protocol.ts 契约）。
//
// 部署形态：一个容器 = 整个应用。HTTP 服务 dist/ 下的构建产物，WebSocket 经 upgrade
// 复用同一端口；TLS / 域名由托管平台（Zeabur / Railway / Fly.io）负责。见 DEPLOY.md。
//
// 本文件与 room.ts 属服务器层，可自由使用 Node API；不修改 src/game 纯模拟层。

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';

import type { ClientMessage, ServerMessage, ServerErrorCode } from '../net/protocol';
import { InputState } from '../core/types';
import { Room, RoomManager } from './room';

// 端口：默认 8080，可用 PORT 环境变量覆盖。
export const DEFAULT_PORT = 8080;

// 构建产物目录：相对本模块定位（src/server/ → ../../dist），与运行时 cwd 无关。
const DIST_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist');

// 静态资源白名单 content-type：只服务客户端构建会产出的这几类，其余一律 application/octet-stream。
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// 静态文件请求处理：/healthz 健康检查、/ → index.html、防目录穿越、无客户端路由（未命中即 404）。
function handleStatic(req: IncomingMessage, res: ServerResponse, distExists: boolean): void {
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
    return;
  }

  // 去掉查询串并解码；健康检查最优先（平台探活用，dist 不存在时也需返回 ok）。
  let urlPath: string;
  try {
    urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }
  if (urlPath === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }

  // 开发模式（vite 在另一端口提供客户端）下 dist 不存在：静态请求 404 并给出提示；WS 不受影响。
  if (!distExists) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('dist/ 未找到。开发模式请用 vite（npm run dev）提供客户端；生产模式请先 npm run build 再 npm start。');
    return;
  }

  // 根路径 → index.html；其余去掉前导斜杠后相对 dist 解析。
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = resolve(DIST_DIR, rel);
  // 防目录穿越：解析后的绝对路径必须仍落在 dist 目录内。
  if (filePath !== DIST_DIR && !filePath.startsWith(DIST_DIR + sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  let stat: ReturnType<typeof statSync> | null = null;
  try {
    stat = statSync(filePath);
  } catch {
    stat = null;
  }
  // 未命中真实文件即 404（无 SPA 回退：本应用无客户端路由）。
  if (!stat || !stat.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }

  const type = CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size });
  if (method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
}

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

// 启动服务器：创建 HTTP 服务（静态 + /healthz），并把 WebSocket 挂到同一 http.Server 上
// （同端口 upgrade）。返回 { httpServer, wss } 以便 smoke.ts / 入口把控生命周期。
export function createServer(port: number): { httpServer: HttpServer; wss: WebSocketServer } {
  const manager = new RoomManager();
  // 启动时探测一次 dist/index.html 是否存在，决定静态层行为并写入启动日志。
  const distExists = existsSync(join(DIST_DIR, 'index.html'));
  const httpServer = createHttpServer((req, res) => handleStatic(req, res, distExists));
  // 关键：{ server } 而非 { port } —— WS 与 HTTP 复用同一端口（平台仅需暴露一个端口）。
  const wss = new WebSocketServer({ server: httpServer });
  // 每个连接的归属（哪个房间、哪个座位）。连接关闭后移除。
  const contexts = new Map<WebSocket, ConnContext>();

  // 保活心跳：每 30s 对所有连接 ping 一次（浏览器自动回 pong）。
  // 大厅等阶段没有任何应用层流量，公网上的 NAT/代理会按空闲超时静默断开连接
  //（实测：大厅闲置约 2 分钟即掉线、房间随之销毁），心跳可避免这一点。
  const PING_INTERVAL_MS = 30_000;
  const pingTimer = setInterval(() => {
    for (const client of wss.clients) {
      if (client.readyState === 1) client.ping();
    }
  }, PING_INTERVAL_MS);
  wss.on('close', () => clearInterval(pingTimer));

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

  httpServer.listen(port, () => {
    const distNote = distExists
      ? 'dist/ 已找到，托管静态客户端 + WS（生产模式）'
      : 'dist/ 未找到，仅提供 WS；静态客户端请用 vite dev（开发模式）';
    console.log(`[server] Battle City 服务器已启动，监听 :${port}（${distNote}）`);
  });

  return { httpServer, wss };
}

// 仅当作为入口直接运行时启动监听（tsx src/server/server.ts）；被 import 时（如 smoke.ts）不自启。
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = process.env.PORT ? Number(process.env.PORT) : DEFAULT_PORT;
  createServer(port);
}

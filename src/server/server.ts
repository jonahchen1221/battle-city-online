// Node 服务器入口：单进程同端口托管「HTTP 静态客户端（dist/）+ 游戏 WebSocket」。
// 服务器权威模型：客户端只发输入，服务器跑模拟并广播快照（见 src/net/protocol.ts 契约）。
//
// 部署形态：一个容器 = 整个应用。HTTP 服务 dist/ 下的构建产物，WebSocket 经 upgrade
// 复用同一端口；TLS / 域名由托管平台（Zeabur / Railway / Fly.io）负责。见 DEPLOY.md。
//
// 本文件与 room.ts 属服务器层，可自由使用 Node API；不修改 src/game 纯模拟层。

import { createReadStream, existsSync, statSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { createServer as createHttpServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';

import {
  URL_LOCAL_PARAM,
  isLocalRoomCode,
  isPrivateAddress,
  normalizePlayerName,
  type ClientMessage,
  type ServerMessage,
  type ServerErrorCode,
} from '../net/protocol';
import { InputState } from '../core/types';
import { Room, RoomManager } from './room';

// 端口：默认 8080，可用 PORT 环境变量覆盖。
export const DEFAULT_PORT = 8080;

// 所有客户端消息都远小于 1 KiB。显式限制负载，避免 ws 默认 100 MiB 上限在 JSON.parse 前
// 造成巨额字符串复制 / 解压内存；其余限额防止未认证连接或建房请求耗尽单进程资源。
export const MAX_WS_PAYLOAD_BYTES = 4 * 1024;
export const MAX_WS_CONNECTIONS = 256;
export const MAX_WS_CONNECTIONS_PER_IP = 16;
export const MAX_ROOMS = 128;
export const MAX_MESSAGES_PER_SECOND = 120;
const UNJOINED_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_PING_INTERVAL_MS = 30_000;

export interface ServerOptions {
  heartbeatIntervalMs?: number;
}

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
  const keys = ['up', 'down', 'left', 'right', 'fire', 'start', 'pause'] as const;
  for (const k of keys) if (typeof o[k] !== 'boolean') return null;
  // dash 为后加字段：旧客户端可能不带，缺省按未按下处理（宽容旧版本，避免联机握手期硬断）。
  const dash = typeof o.dash === 'boolean' ? (o.dash as boolean) : false;
  return {
    up: o.up as boolean,
    down: o.down as boolean,
    left: o.left as boolean,
    right: o.right as boolean,
    fire: o.fire as boolean,
    start: o.start as boolean,
    pause: o.pause as boolean,
    dash,
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
export function createServer(
  port: number,
  options: ServerOptions = {},
): { httpServer: HttpServer; wss: WebSocketServer } {
  const manager = new RoomManager();
  // 启动时探测一次 dist/index.html 是否存在，决定静态层行为并写入启动日志。
  const distExists = existsSync(join(DIST_DIR, 'index.html'));
  const httpServer = createHttpServer((req, res) => handleStatic(req, res, distExists));
  // 关键：{ server } 而非 { port } —— WS 与 HTTP 复用同一端口（平台仅需暴露一个端口）。
  // permessage-deflate：快照含全量地图数组、重复度极高，压缩后体积约为原来的 1/10，
  // 是跨境等弱网线路可玩性的关键（阈值 512B：小消息不压，省 CPU）。
  const wss = new WebSocketServer({
    server: httpServer,
    maxPayload: MAX_WS_PAYLOAD_BYTES,
    perMessageDeflate: { threshold: 512 },
  });
  // 每个连接的归属（哪个房间、哪个座位）。连接关闭后移除。
  const contexts = new Map<WebSocket, ConnContext>();

  // 保活心跳：每 30s 对所有连接 ping 一次（浏览器自动回 pong）。
  // 大厅等阶段没有任何应用层流量，公网上的 NAT/代理会按空闲超时静默断开连接
  //（实测：大厅闲置约 2 分钟即掉线、房间随之销毁），心跳可避免这一点。
  const heartbeatAlive = new WeakMap<WebSocket, boolean>();
  const pingIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  const pingTimer = setInterval(() => {
    for (const client of wss.clients) {
      if (client.readyState !== 1) continue;
      if (heartbeatAlive.get(client) === false) {
        client.terminate();
        continue;
      }
      heartbeatAlive.set(client, false);
      client.ping();
    }
  }, pingIntervalMs);
  wss.on('close', () => {
    clearInterval(pingTimer);
    manager.shutdown();
  });

  const connectionsByIp = new Map<string, number>();

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // 关闭 Nagle 算法：快照以 ~100ms 固定节奏发出的小帧，不应为等待合并而滞留在内核缓冲，
    // 否则跨境高 RTT 线路上会额外叠加一段延迟。逐连接设置（底层 TCP socket）。
    req.socket.setNoDelay(true);
    // 先挂 error 处理，确保下面因容量拒绝而 close 的连接也不会产生未处理事件。
    ws.on('error', () => {});
    heartbeatAlive.set(ws, true);
    ws.on('pong', () => heartbeatAlive.set(ws, true));

    const remoteIp = req.socket.remoteAddress ?? 'unknown';
    const ipConnections = connectionsByIp.get(remoteIp) ?? 0;
    if (wss.clients.size > MAX_WS_CONNECTIONS || ipConnections >= MAX_WS_CONNECTIONS_PER_IP) {
      ws.close(1013, 'server busy');
      return;
    }
    connectionsByIp.set(remoteIp, ipConnections + 1);

    let cleanedUp = false;
    let joined = false;
    let rateWindowStartedAt = Date.now();
    let messagesInWindow = 0;
    const unjoinedTimer = setTimeout(() => {
      if (!joined && ws.readyState === 1) ws.close(1008, 'join timeout');
    }, UNJOINED_CONNECTION_TIMEOUT_MS);

    ws.on('message', (data: RawData) => {
      const now = Date.now();
      if (now - rateWindowStartedAt >= 1000) {
        rateWindowStartedAt = now;
        messagesInWindow = 0;
      }
      messagesInWindow++;
      if (messagesInWindow > MAX_MESSAGES_PER_SECOND) {
        sendError(ws, 'bad_message', '消息发送过快');
        ws.close(1008, 'rate limit');
        return;
      }

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
      // 刷新 / 重连会用新 socket 替换旧连接。旧 socket 的迟到消息不得再操作同一座位。
      if (ctx && ctx.room.wsForIndex(ctx.playerIndex) !== ws) {
        contexts.delete(ws);
        ws.close(1008, 'session replaced');
        return;
      }

      try {
        switch (msg.t) {
          case 'create': {
            // 已在房内则忽略（对当前阶段无效的消息一律安全忽略）。
            if (ctx) return;
            const name = normalizePlayerName(msg.name);
            if (!name) {
              sendError(ws, 'bad_message', 'name 必须为 2 位字母或数字');
              return;
            }
            if (manager.size >= MAX_ROOMS) {
              sendError(ws, 'server_busy', '房间数量已达上限');
              return;
            }
            const room = manager.createRoom();
            const idx = room.addHost(ws, name);
            contexts.set(ws, { room, playerIndex: idx });
            joined = true;
            clearTimeout(unjoinedTimer);
            break;
          }

          case 'join': {
            if (ctx) return; // 已在房内，忽略
            if (typeof msg.code !== 'string') {
              sendError(ws, 'bad_message', 'join 缺少房间码');
              return;
            }
            const name = normalizePlayerName(msg.name);
            if (!name) {
              sendError(ws, 'bad_message', 'name 必须为 2 位字母或数字');
              return;
            }
            if (
              msg.resumeToken !== undefined &&
              (typeof msg.resumeToken !== 'string' || msg.resumeToken.length > 128)
            ) {
              sendError(ws, 'bad_message', 'resumeToken 非法');
              return;
            }
            const code = msg.code.toUpperCase();
            if (isLocalRoomCode(code) && !isPrivateAddress(remoteIp)) {
              sendError(ws, 'room_not_found', '局域网本地局仅限同一局域网');
              return;
            }
            const room = isLocalRoomCode(code) ? manager.getOrCreateLocalRoom() : manager.getRoom(code);
            if (!room) {
              sendError(ws, 'room_not_found', '房间不存在');
              return;
            }
            const res = room.join(ws, name, msg.resumeToken);
            if (typeof res === 'string') {
              sendError(ws, res, '无法加入房间');
              return;
            }
            contexts.set(ws, { room, playerIndex: res });
            joined = true;
            clearTimeout(unjoinedTimer);
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
            ctx.room.handleDisconnect(ctx.playerIndex, ws);
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
      if (!cleanedUp) {
        cleanedUp = true;
        clearTimeout(unjoinedTimer);
        const count = connectionsByIp.get(remoteIp) ?? 0;
        if (count <= 1) connectionsByIp.delete(remoteIp);
        else connectionsByIp.set(remoteIp, count - 1);
      }
      const ctx = contexts.get(ws);
      if (ctx) {
        ctx.room.handleDisconnect(ctx.playerIndex, ws);
        contexts.delete(ws);
      }
    });
  });

  httpServer.listen(port, () => {
    const distNote = distExists
      ? 'dist/ 已找到，托管静态客户端 + WS（生产模式）'
      : 'dist/ 未找到，仅提供 WS；静态客户端请用 vite dev（开发模式）';
    console.log(`[server] Battle City 服务器已启动，监听 :${port}（${distNote}）`);
    // 局域网联机：打印本机各网卡的 IPv4 地址，同一 WiFi 的朋友用任一地址即可加入。
    if (distExists) {
      const lanUrls = Object.values(networkInterfaces())
        .flatMap((addrs) => addrs ?? [])
        .filter((a) => a.family === 'IPv4' && !a.internal)
        .map((a) => `http://${a.address}:${port}`);
      console.log(`[server] 本机访问：http://localhost:${port}`);
      console.log(`[server] 本机本地局：http://localhost:${port}/?${URL_LOCAL_PARAM}`);
      for (const url of lanUrls) {
        console.log(`[server] 局域网访问：${url}`);
        console.log(`[server] 局域网本地局：${url}/?${URL_LOCAL_PARAM}`);
      }
    }
  });

  return { httpServer, wss };
}

// 仅当作为入口直接运行时启动监听（tsx src/server/server.ts）；被 import 时（如 smoke.ts）不自启。
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = process.env.PORT ? Number(process.env.PORT) : DEFAULT_PORT;
  createServer(port);
}

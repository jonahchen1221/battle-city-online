// 冒烟测试：进程内启动服务器，连两个 ws 客户端跑通完整流程 ——
// 建房 / 加入 / 双方准备 / 房主开局 / 发输入 / 收快照（校验 2 台玩家坦克且 tick 递增）/
// 断开其一并确认房间存活（快照继续到达）。
//
// 运行：npx tsx src/server/smoke.ts  （前台跑完自动退出，不残留进程）

import { WebSocket } from 'ws';
import { createServer } from './server';
import type { ServerMessage } from '../net/protocol';

const PORT = 8123; // 测试专用端口，避开默认 8080
const URL = `ws://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}`);
  }
}

// 建立一个客户端，暴露：等待特定类型消息、发送消息、原始消息队列。
function client(name: string): Promise<{
  ws: WebSocket;
  waitFor: (t: ServerMessage['t'], timeoutMs?: number) => Promise<ServerMessage>;
  send: (msg: unknown) => void;
  snapshots: () => Extract<ServerMessage, { t: 'snapshot' }>[];
}> {
  const ws = new WebSocket(URL);
  const inbox: ServerMessage[] = [];
  const waiters: { t: ServerMessage['t']; resolve: (m: ServerMessage) => void }[] = [];
  const snaps: Extract<ServerMessage, { t: 'snapshot' }>[] = [];

  ws.on('message', (data: Buffer) => {
    const msg = JSON.parse(data.toString()) as ServerMessage;
    inbox.push(msg);
    if (msg.t === 'snapshot') snaps.push(msg);
    const i = waiters.findIndex((w) => w.t === msg.t);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
  });

  const waitFor = (t: ServerMessage['t'], timeoutMs = 2000): Promise<ServerMessage> => {
    const existing = inbox.find((m) => m.t === t);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${name} 等待 ${t} 超时`)), timeoutMs);
      waiters.push({
        t,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  };

  const send = (msg: unknown): void => ws.send(JSON.stringify(msg));

  return new Promise((resolve) => {
    ws.on('open', () => resolve({ ws, waitFor, send, snapshots: () => snaps }));
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log(`[smoke] 启动服务器 :${PORT}`);
  // createServer 现返回 { httpServer, wss }：WS 挂在 http.Server 上（同端口）。
  const { httpServer, wss } = createServer(PORT);
  await new Promise<void>((r) => httpServer.on('listening', () => r()));

  const c1 = await client('P1');
  const c2 = await client('P2');

  // 1) 建房
  c1.send({ t: 'create' });
  const joined1 = (await c1.waitFor('joined')) as Extract<ServerMessage, { t: 'joined' }>;
  console.log('[smoke] 建房成功', { code: joined1.code, playerIndex: joined1.playerIndex });
  assert(joined1.playerIndex === 0, 'P1 建房分配到 playerIndex 0（房主）');
  assert(/^[A-Z]{4}$/.test(joined1.code), '房间码为 4 个大写字母');

  // 2) 加入
  c2.send({ t: 'join', code: joined1.code });
  const joined2 = (await c2.waitFor('joined')) as Extract<ServerMessage, { t: 'joined' }>;
  console.log('[smoke] P2 加入', { playerIndex: joined2.playerIndex });
  assert(joined2.playerIndex === 1, 'P2 加入分配到 playerIndex 1');

  // 3) 双方准备
  c1.send({ t: 'ready', ready: true });
  c2.send({ t: 'ready', ready: true });
  await sleep(50);

  // 4) 未全员准备时开局应报错的反向校验（先让 P2 取消准备再尝试）——顺带验证 not_all_ready。
  c2.send({ t: 'ready', ready: false });
  await sleep(30);
  c1.send({ t: 'start' });
  const err = (await c1.waitFor('error')) as Extract<ServerMessage, { t: 'error' }>;
  assert(err.code === 'not_all_ready', '未全员准备时开局返回 not_all_ready');
  c2.send({ t: 'ready', ready: true });
  await sleep(30);

  // 5) 房主开局
  c1.send({ t: 'start' });
  const started1 = (await c1.waitFor('started')) as Extract<ServerMessage, { t: 'started' }>;
  await c2.waitFor('started');
  console.log('[smoke] 开局', { playerCount: started1.playerCount });
  assert(started1.playerCount === 2, 'started.playerCount 为 2');

  // 6) 发送一些输入（服务器保留每人最新值逐帧应用）
  c1.send({ t: 'input', input: { up: false, down: false, left: false, right: true, fire: true, start: false, pause: false } });
  c2.send({ t: 'input', input: { up: true, down: false, left: false, right: false, fire: false, start: false, pause: false } });

  // 7) 收快照：校验含 2 台玩家坦克，且 tick 随时间递增
  await sleep(300);
  const snaps = c1.snapshots();
  console.log(`[smoke] P1 收到 ${snaps.length} 个快照`);
  assert(snaps.length >= 2, '至少收到 2 个快照');
  const playerTanks = snaps[0].snap.tanks.filter((t) => t.kind === 'player');
  console.log('[smoke] 首个快照玩家坦克数 =', playerTanks.length, ' tick =', snaps[0].snap.tick);
  assert(playerTanks.length === 2, '快照中有 2 台玩家坦克');
  const firstTick = snaps[0].snap.tick;
  const lastTick = snaps[snaps.length - 1].snap.tick;
  console.log('[smoke] tick 递进', { firstTick, lastTick });
  assert(lastTick > firstTick, 'tick 随时间递增');

  // 8) 断开 P2，校验房间存活（P1 仍持续收到快照，且座位保留 → 仍 2 台玩家坦克）
  const beforeCount = c1.snapshots().length;
  c2.ws.close();
  await sleep(300);
  const afterCount = c1.snapshots().length;
  console.log('[smoke] 断开 P2 后 P1 快照数', { beforeCount, afterCount });
  assert(afterCount > beforeCount, '断开一名玩家后房间存活，快照继续到达');
  const latestSnap = c1.snapshots()[c1.snapshots().length - 1];
  const tanksAfter = latestSnap.snap.tanks.filter((t) => t.kind === 'player').length;
  assert(tanksAfter === 2, '断线玩家座位保留（进行中不释放），仍为 2 台玩家坦克');

  // 收尾：关闭连接与服务器，确保无残留进程。先终结所有残留 ws 连接，
  // 否则 httpServer.close 会等待未关闭的 socket 而挂起。
  c1.ws.close();
  for (const client of wss.clients) client.terminate();
  wss.close();
  await new Promise<void>((r) => httpServer.close(() => r()));

  console.log(`\n[smoke] 结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[smoke] 未捕获错误：', err);
  process.exit(1);
});

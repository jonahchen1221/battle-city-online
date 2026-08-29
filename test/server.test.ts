import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import {
  createServer,
  MAX_MESSAGES_PER_SECOND,
  MAX_WS_PAYLOAD_BYTES,
  type ServerOptions,
} from '../src/server/server';
import { LOCAL_ROOM_CODE, type ServerMessage } from '../src/net/protocol';

function waitForMessage<T extends ServerMessage['t']>(
  ws: WebSocket,
  type: T,
  predicate: (message: Extract<ServerMessage, { t: T }>) => boolean = () => true,
): Promise<Extract<ServerMessage, { t: T }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error(`timed out waiting for ${type}`));
    }, 2_000);
    const onMessage = (data: WebSocket.RawData): void => {
      const message = JSON.parse(data.toString()) as ServerMessage;
      if (message.t !== type) return;
      const typed = message as Extract<ServerMessage, { t: T }>;
      if (!predicate(typed)) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(typed);
    };
    ws.on('message', onMessage);
  });
}

async function withServer(
  options: ServerOptions,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const { httpServer, wss } = createServer(0, options);
  await once(httpServer, 'listening');
  const { port } = httpServer.address() as AddressInfo;
  try {
    await run(`ws://127.0.0.1:${port}`);
  } finally {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve, reject) =>
      httpServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test('heartbeat terminates a half-open client that does not pong', async () => {
  await withServer({ heartbeatIntervalMs: 20 }, async (url) => {
    const ws = new WebSocket(url, { autoPong: false });
    await once(ws, 'open');
    const [code] = (await once(ws, 'close')) as [number, Buffer];
    assert.equal(code, 1006);
  });
});

test('oversized websocket payloads are rejected before JSON parsing', async () => {
  await withServer({}, async (url) => {
    const ws = new WebSocket(url);
    await once(ws, 'open');
    ws.send('x'.repeat(MAX_WS_PAYLOAD_BYTES + 1));
    const [code] = (await once(ws, 'close')) as [number, Buffer];
    assert.equal(code, 1009);
  });
});

test('a connection exceeding the message rate limit is closed', async () => {
  await withServer({}, async (url) => {
    const ws = new WebSocket(url);
    await once(ws, 'open');
    for (let i = 0; i <= MAX_MESSAGES_PER_SECOND; i++) ws.send('{"t":"unknown"}');
    const [code] = (await once(ws, 'close')) as [number, Buffer];
    assert.equal(code, 1008);
  });
});

test('the websocket protocol resumes the credentialed player at the same game index', async () => {
  await withServer({}, async (url) => {
    const host = new WebSocket(url);
    const player = new WebSocket(url);
    await Promise.all([once(host, 'open'), once(player, 'open')]);

    const hostJoinedPromise = waitForMessage(host, 'joined');
    host.send(JSON.stringify({ t: 'create', name: 'H1' }));
    const hostJoined = await hostJoinedPromise;

    const playerJoinedPromise = waitForMessage(player, 'joined');
    player.send(JSON.stringify({ t: 'join', code: hostJoined.code, name: 'P2' }));
    const playerJoined = await playerJoinedPromise;
    const allReadyPromise = waitForMessage(host, 'lobby', (message) =>
      message.players.every((entry) => entry.ready),
    );
    host.send(JSON.stringify({ t: 'ready', ready: true }));
    player.send(JSON.stringify({ t: 'ready', ready: true }));
    await allReadyPromise;

    const hostStartedPromise = waitForMessage(host, 'started');
    const playerStartedPromise = waitForMessage(player, 'started');
    host.send(JSON.stringify({ t: 'start' }));
    await Promise.all([hostStartedPromise, playerStartedPromise]);

    player.close();
    await once(player, 'close');
    const resumed = new WebSocket(url);
    await once(resumed, 'open');
    const rejoinedPromise = waitForMessage(resumed, 'joined');
    const restartedPromise = waitForMessage(resumed, 'started');
    resumed.send(
      JSON.stringify({
        t: 'join',
        code: hostJoined.code,
        name: 'P2',
        resumeToken: playerJoined.resumeToken,
      }),
    );

    const [rejoined, restarted] = await Promise.all([rejoinedPromise, restartedPromise]);
    assert.equal(rejoined.playerIndex, playerJoined.playerIndex);
    assert.equal(restarted.playerIndex, 1);
    assert.notEqual(rejoined.resumeToken, playerJoined.resumeToken);
  });
});

test('lan clients join the same local room without a created code', async () => {
  await withServer({}, async (url) => {
    const first = new WebSocket(url);
    const second = new WebSocket(url);
    await Promise.all([once(first, 'open'), once(second, 'open')]);

    const firstJoinedPromise = waitForMessage(first, 'joined');
    first.send(JSON.stringify({ t: 'join', code: LOCAL_ROOM_CODE, name: 'A1' }));
    const firstJoined = await firstJoinedPromise;
    assert.equal(firstJoined.code, LOCAL_ROOM_CODE);
    assert.equal(firstJoined.playerIndex, 0);
    assert.equal(firstJoined.players[0]?.isHost, true);

    const secondJoinedPromise = waitForMessage(second, 'joined');
    second.send(JSON.stringify({ t: 'join', code: LOCAL_ROOM_CODE, name: 'B2' }));
    const secondJoined = await secondJoinedPromise;
    assert.equal(secondJoined.code, LOCAL_ROOM_CODE);
    assert.equal(secondJoined.playerIndex, 1);
    assert.equal(secondJoined.players.find((p) => p.playerIndex === 0)?.isHost, true);
    assert.equal(secondJoined.players.find((p) => p.playerIndex === 1)?.isHost, false);
  });
});

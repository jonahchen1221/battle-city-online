import test from 'node:test';
import assert from 'node:assert/strict';
import type { WebSocket } from 'ws';
import type { GameState } from '../src/game/state';
import { nextStage, resetGameState } from '../src/game/state';
import type { ServerMessage } from '../src/net/protocol';
import { Room } from '../src/server/room';

class FakeWebSocket {
  readyState = 1;
  bufferedAmount = 0;
  readonly messages: ServerMessage[] = [];

  send(payload: string): void {
    this.messages.push(JSON.parse(payload) as ServerMessage);
  }

  latest<T extends ServerMessage['t']>(type: T): Extract<ServerMessage, { t: T }> | undefined {
    return this.messages.filter((message) => message.t === type).at(-1) as
      | Extract<ServerMessage, { t: T }>
      | undefined;
  }
}

interface RoomInternals {
  game: GameState | null;
  tick(): void;
  destroyNow(): void;
}

function asWebSocket(ws: FakeWebSocket): WebSocket {
  return ws as unknown as WebSocket;
}

function internals(room: Room): RoomInternals {
  return room as unknown as RoomInternals;
}

test('host transfer is advertised and the successor can start the game', () => {
  const room = new Room('HOST', () => {});
  const host = new FakeWebSocket();
  const successor = new FakeWebSocket();
  room.addHost(asWebSocket(host), 'H1');
  assert.equal(room.join(asWebSocket(successor), 'S2'), 1);

  room.handleDisconnect(0);

  const lobby = successor.latest('lobby');
  assert.equal(lobby?.players.find((player) => player.playerIndex === 1)?.name, 'S2');
  assert.equal(lobby?.players.find((player) => player.playerIndex === 1)?.isHost, true);

  room.setReady(1, true);
  room.start(1);
  assert.deepEqual(successor.latest('started'), { t: 'started', playerCount: 1, playerIndex: 0 });

  internals(room).destroyNow();
});

test('lobby seat holes are compacted instead of creating phantom players', () => {
  const room = new Room('SEAT', () => {});
  const host = new FakeWebSocket();
  const departing = new FakeWebSocket();
  const third = new FakeWebSocket();
  room.addHost(asWebSocket(host), 'H1');
  assert.equal(room.join(asWebSocket(departing), 'D2'), 1);
  assert.equal(room.join(asWebSocket(third), 'T3'), 2);
  room.handleDisconnect(1);
  room.setReady(0, true);
  room.setReady(2, true);

  room.start(0);
  assert.deepEqual(host.latest('started'), { t: 'started', playerCount: 2, playerIndex: 0 });
  assert.deepEqual(third.latest('started'), { t: 'started', playerCount: 2, playerIndex: 1 });

  const internal = internals(room);
  internal.tick();
  internal.tick();
  internal.tick();
  const snapshot = host.latest('snapshot');
  assert.deepEqual(
    snapshot?.snap.tanks.filter((tank) => tank.kind === 'player').map((tank) => tank.playerIndex),
    [0, 1],
  );

  internal.destroyNow();
});

test('a new level epoch forces a full terrain snapshot even when rev remains zero', () => {
  const room = new Room('LEVL', () => {});
  const host = new FakeWebSocket();
  room.addHost(asWebSocket(host), 'H1');
  room.setReady(0, true);
  room.start(0);
  const internal = internals(room);

  internal.tick();
  internal.tick();
  internal.tick();
  const first = host.latest('snapshot');
  assert.equal(first?.snap.levelEpoch, 0);
  assert.equal(first?.snap.level?.rev, 0);

  assert.ok(internal.game);
  nextStage(internal.game);
  internal.tick();
  internal.tick();
  internal.tick();
  const second = host.latest('snapshot');
  assert.equal(second?.snap.stage, 2);
  assert.equal(second?.snap.levelEpoch, 1);
  assert.equal(second?.snap.level?.rev, 0);

  assert.ok(internal.game);
  resetGameState(internal.game, 99);
  internal.tick();
  internal.tick();
  internal.tick();
  const restarted = host.latest('snapshot');
  assert.equal(restarted?.snap.stage, 1);
  assert.equal(restarted?.snap.levelEpoch, 2);
  assert.equal(restarted?.snap.level?.rev, 0);

  internal.destroyNow();
});

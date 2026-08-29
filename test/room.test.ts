import test from 'node:test';
import assert from 'node:assert/strict';
import type { WebSocket } from 'ws';
import type { GameState } from '../src/game/state';
import { createGameState, nextStage, resetGameState } from '../src/game/state';
import { emptyInput } from '../src/core/types';
import { escortGuardSlots } from '../src/game/escort';
import type { ServerMessage } from '../src/net/protocol';
import { Room } from '../src/server/room';

class FakeWebSocket {
  readyState = 1;
  bufferedAmount = 0;
  readonly messages: ServerMessage[] = [];

  send(payload: string): void {
    this.messages.push(JSON.parse(payload) as ServerMessage);
  }

  close(): void {
    this.readyState = 3;
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

test('action presses survive a press and release before the next server tick', () => {
  const room = new Room('EDGE', () => {});
  const host = new FakeWebSocket();
  room.addHost(asWebSocket(host), 'H1');
  room.setReady(0, true);
  room.start(0);
  const internal = internals(room);
  assert.ok(internal.game);
  internal.game.phase = 'playing';

  room.setInput(0, { ...emptyInput(), fire: true });
  room.setInput(0, emptyInput());
  internal.tick();
  assert.equal(
    internal.game.bullets.some((bullet) => !bullet.fromEnemy && bullet.ownerPlayerIndex === 0),
    true,
    'fire press must be latched until one authoritative tick consumes it',
  );

  room.setInput(0, { ...emptyInput(), pause: true });
  room.setInput(0, emptyInput());
  internal.tick();
  assert.equal(internal.game.paused, true, 'pause press must use the same edge latch');

  internal.game.paused = false;
  internal.game.phase = 'gameover';
  internal.game.prevStart = false;
  room.setInput(0, { ...emptyInput(), start: true });
  room.setInput(0, emptyInput());
  internal.tick();
  assert.equal(internal.game.phase, 'stagestart', 'start press must be latched for retries');

  internal.destroyNow();
});

test('an escort match scales its guard requirement down after teammates disconnect', () => {
  const room = new Room('DROP', () => {});
  const sockets = [new FakeWebSocket(), new FakeWebSocket(), new FakeWebSocket()];
  room.addHost(asWebSocket(sockets[0]), 'P1');
  assert.equal(room.join(asWebSocket(sockets[1]), 'P2'), 1);
  assert.equal(room.join(asWebSocket(sockets[2]), 'P3'), 2);
  for (let i = 0; i < sockets.length; i++) room.setReady(i, true);
  room.start(0);

  const internal = internals(room);
  internal.game = createGameState(17, 3, 2);
  internal.game.phase = 'playing';
  room.handleDisconnect(1, asWebSocket(sockets[1]));
  room.handleDisconnect(2, asWebSocket(sockets[2]));

  const escort = internal.game.escort!;
  const guard = escortGuardSlots(escort, 1)[0];
  Object.assign(internal.game.tanks[0], { x: guard.x, y: guard.y });
  const beforeY = escort.y;
  internal.tick();

  assert.equal(internal.game.activePlayerCount, 1);
  assert.ok(escort.y < beforeY, 'the remaining connected player should be able to move the convoy');
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
  assert.equal('stageStartCheckpoint' in (first?.snap ?? {}), false);

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

test('resume tokens restore the exact in-game seat instead of the lowest disconnected seat', () => {
  const room = new Room('TOKN', () => {});
  const host = new FakeWebSocket();
  const second = new FakeWebSocket();
  const third = new FakeWebSocket();
  room.addHost(asWebSocket(host), 'H1');
  assert.equal(room.join(asWebSocket(second), 'S2'), 1);
  assert.equal(room.join(asWebSocket(third), 'T3'), 2);
  const secondToken = second.latest('joined')?.resumeToken;
  const thirdToken = third.latest('joined')?.resumeToken;
  assert.ok(secondToken);
  assert.ok(thirdToken);

  room.setReady(0, true);
  room.setReady(1, true);
  room.setReady(2, true);
  room.start(0);
  room.handleDisconnect(1, asWebSocket(second));
  room.handleDisconnect(2, asWebSocket(third));

  const noCredential = new FakeWebSocket();
  assert.equal(room.join(asWebSocket(noCredential), 'XX'), 'invalid_resume');

  const resumedThird = new FakeWebSocket();
  assert.equal(room.join(asWebSocket(resumedThird), 'T3', thirdToken), 2);
  assert.deepEqual(resumedThird.latest('started'), {
    t: 'started',
    playerCount: 3,
    playerIndex: 2,
  });

  const resumedSecond = new FakeWebSocket();
  assert.equal(room.join(asWebSocket(resumedSecond), 'S2', secondToken), 1);
  assert.deepEqual(resumedSecond.latest('started'), {
    t: 'started',
    playerCount: 3,
    playerIndex: 1,
  });
  assert.notEqual(resumedSecond.latest('joined')?.resumeToken, secondToken);

  internals(room).destroyNow();
});

test('a replaced socket cannot disconnect or control its resumed seat', () => {
  const room = new Room('RACE', () => {});
  const oldSocket = new FakeWebSocket();
  room.addHost(asWebSocket(oldSocket), 'H1');
  const token = oldSocket.latest('joined')?.resumeToken;
  assert.ok(token);
  room.setReady(0, true);
  room.start(0);

  const replacement = new FakeWebSocket();
  assert.equal(room.join(asWebSocket(replacement), 'H1', token), 0);
  room.handleDisconnect(0, asWebSocket(oldSocket));

  assert.equal(room.wsForIndex(0), asWebSocket(replacement));
  assert.equal(replacement.latest('started')?.playerIndex, 0);

  internals(room).destroyNow();
});

test('persistent lan room stays after the last lobby player leaves', () => {
  let destroyed = false;
  const room = new Room('LOCAL', () => {
    destroyed = true;
  }, { persistent: true });
  const host = new FakeWebSocket();
  assert.equal(room.join(asWebSocket(host), 'H1'), 0);
  assert.equal(host.latest('joined')?.players[0]?.isHost, true);

  room.handleDisconnect(0);
  assert.equal(destroyed, false);

  const next = new FakeWebSocket();
  assert.equal(room.join(asWebSocket(next), 'N1'), 0);
  assert.equal(next.latest('joined')?.playerIndex, 0);
  assert.equal(next.latest('joined')?.players[0]?.isHost, true);

  internals(room).destroyNow();
});

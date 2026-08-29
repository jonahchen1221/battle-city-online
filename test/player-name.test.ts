import test from 'node:test';
import assert from 'node:assert/strict';
import { gamePlayerNames } from '../src/client/ui';
import { normalizePlayerName } from '../src/net/protocol';

test('player names accept exactly two ASCII letters or numbers', () => {
  assert.equal(normalizePlayerName('a7'), 'A7');
  assert.equal(normalizePlayerName('Z0'), 'Z0');
  assert.equal(normalizePlayerName('A'), null);
  assert.equal(normalizePlayerName('ABC'), null);
  assert.equal(normalizePlayerName('A_'), null);
  assert.equal(normalizePlayerName('ß'), null);
});

test('lobby seat names follow the compact in-game player order', () => {
  const names = gamePlayerNames([
    { playerIndex: 2, name: 'T3', ready: true, connected: true, isHost: false },
    { playerIndex: 0, name: 'H1', ready: true, connected: true, isHost: true },
  ], 2);

  assert.deepEqual(names, ['H1', 'T3']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlayerName } from '../src/net/protocol';

test('player names accept exactly two ASCII letters or numbers', () => {
  assert.equal(normalizePlayerName('a7'), 'A7');
  assert.equal(normalizePlayerName('Z0'), 'Z0');
  assert.equal(normalizePlayerName('A'), null);
  assert.equal(normalizePlayerName('ABC'), null);
  assert.equal(normalizePlayerName('A_'), null);
  assert.equal(normalizePlayerName('ß'), null);
});

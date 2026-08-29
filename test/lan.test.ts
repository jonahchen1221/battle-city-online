import test from 'node:test';
import assert from 'node:assert/strict';
import { isLocalRoomCode, isPrivateAddress, LOCAL_ROOM_CODE } from '../src/net/protocol';

test('LOCAL is the reserved lan room code', () => {
  assert.equal(isLocalRoomCode('local'), true);
  assert.equal(isLocalRoomCode(LOCAL_ROOM_CODE), true);
  assert.equal(isLocalRoomCode('GAME'), false);
});

test('isPrivateAddress accepts loopback, rfc1918, link-local and .local', () => {
  assert.equal(isPrivateAddress('localhost'), true);
  assert.equal(isPrivateAddress('127.0.0.1'), true);
  assert.equal(isPrivateAddress('::1'), true);
  assert.equal(isPrivateAddress('[::1]'), true);
  assert.equal(isPrivateAddress('::ffff:192.168.1.8'), true);
  assert.equal(isPrivateAddress('10.0.0.4'), true);
  assert.equal(isPrivateAddress('192.168.1.87'), true);
  assert.equal(isPrivateAddress('172.16.0.2'), true);
  assert.equal(isPrivateAddress('172.31.255.1'), true);
  assert.equal(isPrivateAddress('169.254.1.1'), true);
  assert.equal(isPrivateAddress('my-mac.local'), true);
  assert.equal(isPrivateAddress('fd12:3456::1'), true);
});

test('isPrivateAddress rejects public hosts', () => {
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  assert.equal(isPrivateAddress('172.32.0.1'), false);
  assert.equal(isPrivateAddress('example.com'), false);
  assert.equal(isPrivateAddress(''), false);
});

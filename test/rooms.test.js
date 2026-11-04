'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RoomManager, normalizeRoomId, normalizeName } = require('../server/rooms');

test('normalizeRoomId accepts safe ids and lowercases them', () => {
  assert.equal(normalizeRoomId('My-Room_1'), 'my-room_1');
  assert.equal(normalizeRoomId('  spaced  '), 'spaced');
  assert.equal(normalizeRoomId('bad room'), null);
  assert.equal(normalizeRoomId('../etc'), null);
  assert.equal(normalizeRoomId(''), null);
  assert.equal(normalizeRoomId('x'.repeat(65)), null);
  assert.equal(normalizeRoomId(42), null);
});

test('normalizeName trims, strips control chars and caps length', () => {
  assert.equal(normalizeName('  Sami  '), 'Sami');
  assert.equal(normalizeName('a\u0000b\nc'), 'abc');
  assert.equal(normalizeName('a   b'), 'a b');
  assert.equal(normalizeName('   '), null);
  assert.equal(normalizeName(null), null);
  assert.equal(normalizeName('x'.repeat(100)).length, 32);
});

test('join returns existing peers and enforces capacity', () => {
  const rooms = new RoomManager({ maxPeers: 2 });
  assert.deepEqual(rooms.join('r', { id: 'a', name: 'A' }).peers, []);
  const second = rooms.join('r', { id: 'b', name: 'B' });
  assert.equal(second.ok, true);
  assert.deepEqual(second.peers.map((p) => p.id), ['a']);
  assert.deepEqual(rooms.join('r', { id: 'c', name: 'C' }), { ok: false, error: 'room-full' });
  assert.equal(rooms.size('r'), 2);
});

test('rejoining the same id does not duplicate', () => {
  const rooms = new RoomManager();
  rooms.join('r', { id: 'a', name: 'A' });
  rooms.join('r', { id: 'a', name: 'A' });
  assert.equal(rooms.size('r'), 1);
});

test('leave removes peer and empty rooms', () => {
  const rooms = new RoomManager();
  rooms.join('r', { id: 'a', name: 'A' });
  assert.equal(rooms.leave('r', 'a'), true);
  assert.equal(rooms.rooms.has('r'), false);
  assert.equal(rooms.leave('r', 'a'), false);
});

test('setMedia only accepts boolean flags', () => {
  const rooms = new RoomManager();
  rooms.join('r', { id: 'a', name: 'A' });
  rooms.setMedia('r', 'a', { audio: false, video: 'yes', evil: true });
  assert.deepEqual(rooms.get('r', 'a').media, { audio: false, video: true, screen: false });
  assert.equal(rooms.setMedia('r', 'nobody', { audio: false }), null);
});

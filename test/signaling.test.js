'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { createServer, iceServersFromEnv } = require('../server');

function startServer(opts) {
  const ctx = createServer(opts);
  return new Promise((resolve) => {
    ctx.server.listen(0, '127.0.0.1', () => {
      ctx.url = `http://127.0.0.1:${ctx.server.address().port}`;
      resolve(ctx);
    });
  });
}

function stopServer(ctx) {
  return new Promise((resolve) => {
    ctx.io.close();
    ctx.server.close(() => resolve());
  });
}

function client(url) {
  return new Promise((resolve, reject) => {
    const socket = connect(url, { transports: ['websocket'], forceNew: true, reconnection: false });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

const emit = (socket, event, payload) => new Promise((resolve) => socket.emit(event, payload, resolve));
const once = (socket, event) => new Promise((resolve) => socket.once(event, resolve));
const noEvent = (socket, event, ms = 150) =>
  new Promise((resolve, reject) => {
    const onEvent = () => reject(new Error(`unexpected ${event}`));
    socket.once(event, onEvent);
    setTimeout(() => {
      socket.off(event, onEvent);
      resolve();
    }, ms);
  });

test('signaling server', async (t) => {
  const ctx = await startServer({ maxPeers: 3, iceServers: [{ urls: ['stun:example.org'] }] });
  const sockets = [];
  const make = async () => {
    const s = await client(ctx.url);
    sockets.push(s);
    return s;
  };
  t.after(async () => {
    sockets.forEach((s) => s.close());
    await stopServer(ctx);
  });

  await t.test('serves config, health and the app', async () => {
    const cfg = await (await fetch(`${ctx.url}/config`)).json();
    assert.deepEqual(cfg.iceServers, [{ urls: ['stun:example.org'] }]);
    assert.equal(cfg.maxPeers, 3);
    assert.deepEqual(await (await fetch(`${ctx.url}/health`)).json(), { ok: true });
    const html = await (await fetch(`${ctx.url}/`)).text();
    assert.match(html, /<title>WebTalk<\/title>/);
    assert.equal((await fetch(`${ctx.url}/app.js`)).status, 200);
  });

  await t.test('rejects invalid join payloads', async () => {
    const s = await make();
    assert.deepEqual(await emit(s, 'join', { roomId: 'no spaces', name: 'A' }), { ok: false, error: 'invalid-room' });
    assert.deepEqual(await emit(s, 'join', { roomId: 'ok', name: '   ' }), { ok: false, error: 'invalid-name' });
    assert.deepEqual(await emit(s, 'join', null), { ok: false, error: 'invalid-room' });
  });

  await t.test('join, signal relay, media state, chat and leave', async () => {
    const a = await make();
    const b = await make();

    const ja = await emit(a, 'join', { roomId: 'Alpha', name: 'Alice', media: { audio: true, video: false } });
    assert.equal(ja.ok, true);
    assert.equal(ja.roomId, 'alpha');
    assert.deepEqual(ja.peers, []);

    const joined = once(a, 'peer-joined');
    const jb = await emit(b, 'join', { roomId: 'alpha', name: 'Bob' });
    assert.equal(jb.ok, true);
    assert.deepEqual(jb.peers, [{ id: a.id, name: 'Alice', media: { audio: true, video: false, screen: false } }]);
    assert.deepEqual(await joined, { id: b.id, name: 'Bob', media: { audio: true, video: true, screen: false } });

    // Signal relay goes only to the addressed peer and carries the sender id.
    const gotSignal = once(a, 'signal');
    b.emit('signal', { to: a.id, data: { description: { type: 'offer', sdp: 'v=0' } } });
    assert.deepEqual(await gotSignal, { from: b.id, data: { description: { type: 'offer', sdp: 'v=0' } } });

    const media = once(b, 'peer-media');
    a.emit('media-state', { audio: false, screen: true });
    assert.deepEqual(await media, { id: a.id, media: { audio: false, video: false, screen: true } });

    const chatAtA = once(a, 'chat');
    const sent = await emit(b, 'chat', '  hello <b>there</b>  ');
    assert.equal(sent.ok, true);
    const msg = await chatAtA;
    assert.equal(msg.text, 'hello <b>there</b>');
    assert.equal(msg.name, 'Bob');
    assert.equal(msg.from, b.id);

    assert.deepEqual(await emit(b, 'chat', 'too fast'), { ok: false, error: 'rate-limited' });
    assert.deepEqual(await emit(b, 'chat', '   '), { ok: false, error: 'invalid-message' });

    const left = once(a, 'peer-left');
    b.emit('leave');
    assert.deepEqual(await left, { id: b.id });
    assert.equal(ctx.rooms.size('alpha'), 1);
  });

  await t.test('does not relay signals across rooms', async () => {
    const a = await make();
    const b = await make();
    await emit(a, 'join', { roomId: 'room-one', name: 'A' });
    await emit(b, 'join', { roomId: 'room-two', name: 'B' });
    const silent = noEvent(a, 'signal');
    b.emit('signal', { to: a.id, data: { candidate: { candidate: 'x' } } });
    await silent;
  });

  await t.test('enforces room capacity and cleans up on disconnect', async () => {
    const [a, b, c, d] = [await make(), await make(), await make(), await make()];
    for (const [s, n] of [[a, 'A'], [b, 'B'], [c, 'C']]) assert.equal((await emit(s, 'join', { roomId: 'full', name: n })).ok, true);
    assert.deepEqual(await emit(d, 'join', { roomId: 'full', name: 'D' }), { ok: false, error: 'room-full' });

    const left = once(a, 'peer-left');
    const cId = c.id;
    c.disconnect();
    assert.deepEqual(await left, { id: cId });
    assert.equal(ctx.rooms.size('full'), 2);
    assert.equal((await emit(d, 'join', { roomId: 'full', name: 'D' })).ok, true);
  });

  await t.test('switching rooms leaves the previous one', async () => {
    const a = await make();
    const b = await make();
    await emit(a, 'join', { roomId: 'first', name: 'A' });
    await emit(b, 'join', { roomId: 'first', name: 'B' });
    const left = once(b, 'peer-left');
    await emit(a, 'join', { roomId: 'second', name: 'A' });
    assert.deepEqual(await left, { id: a.id });
    assert.equal(ctx.rooms.size('first'), 1);
    assert.equal(ctx.rooms.size('second'), 1);
  });
});

test('iceServersFromEnv builds STUN and optional TURN entries', () => {
  assert.deepEqual(iceServersFromEnv({ STUN_URLS: 'stun:a, stun:b' }), [{ urls: ['stun:a', 'stun:b'] }]);
  assert.deepEqual(
    iceServersFromEnv({ STUN_URLS: '', TURN_URLS: 'turn:t:3478', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'p' }),
    [{ urls: ['turn:t:3478'], username: 'u', credential: 'p' }],
  );
  assert.equal(iceServersFromEnv({}).length, 1);
});

'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { RoomManager, normalizeRoomId, normalizeName } = require('./rooms');

const MAX_CHAT_LENGTH = 2000;
const CHAT_MIN_INTERVAL_MS = 150;
const MAX_SIGNAL_BYTES = 64 * 1024;

/** Builds the ICE server list from environment variables. */
function iceServersFromEnv(env = process.env) {
  const stun = (env.STUN_URLS ?? 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const servers = stun.length ? [{ urls: stun }] : [];
  if (env.TURN_URLS) {
    servers.push({
      urls: env.TURN_URLS.split(',').map((s) => s.trim()).filter(Boolean),
      username: env.TURN_USERNAME || undefined,
      credential: env.TURN_CREDENTIAL || undefined,
    });
  }
  return servers;
}

function createServer({ maxPeers = Number(process.env.MAX_PEERS) || 8, iceServers = iceServersFromEnv() } = {}) {
  const app = express();
  const rooms = new RoomManager({ maxPeers });

  app.disable('x-powered-by');
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.get('/config', (_req, res) => res.json({ iceServers, maxPeers }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

  const server = http.createServer(app);
  const io = new Server(server, { maxHttpBufferSize: 1e6 });

  io.on('connection', (socket) => {
    /** @type {{roomId: string, name: string} | null} */
    let current = null;
    let lastChatAt = 0;

    const leaveCurrent = () => {
      if (!current) return;
      const { roomId } = current;
      rooms.leave(roomId, socket.id);
      socket.leave(roomId);
      socket.to(roomId).emit('peer-left', { id: socket.id });
      current = null;
    };

    socket.on('join', (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const roomId = normalizeRoomId(payload && payload.roomId);
      const name = normalizeName(payload && payload.name);
      if (!roomId) return reply({ ok: false, error: 'invalid-room' });
      if (!name) return reply({ ok: false, error: 'invalid-name' });

      leaveCurrent();
      const media = payload && typeof payload.media === 'object' && payload.media ? payload.media : {};
      const result = rooms.join(roomId, {
        id: socket.id,
        name,
        media: { audio: media.audio !== false, video: media.video !== false, screen: false },
      });
      if (!result.ok) return reply(result);

      current = { roomId, name };
      socket.join(roomId);
      const self = rooms.get(roomId, socket.id);
      // Tell existing members first so they have a peer entry before any offer arrives.
      socket.to(roomId).emit('peer-joined', { id: socket.id, name, media: { ...self.media } });
      reply({ ok: true, id: socket.id, roomId, name, peers: result.peers });
    });

    socket.on('signal', (msg) => {
      if (!current || !msg || typeof msg.to !== 'string' || typeof msg.data !== 'object' || !msg.data) return;
      if (!rooms.has(current.roomId, msg.to)) return; // only relay inside the same room
      let size = 0;
      try {
        size = Buffer.byteLength(JSON.stringify(msg.data));
      } catch {
        return;
      }
      if (size > MAX_SIGNAL_BYTES) return;
      io.to(msg.to).emit('signal', { from: socket.id, data: msg.data });
    });

    socket.on('media-state', (media) => {
      if (!current || !media || typeof media !== 'object') return;
      const updated = rooms.setMedia(current.roomId, socket.id, media);
      if (updated) socket.to(current.roomId).emit('peer-media', { id: socket.id, media: { ...updated } });
    });

    socket.on('chat', (text, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      if (!current) return reply({ ok: false, error: 'not-in-room' });
      if (typeof text !== 'string') return reply({ ok: false, error: 'invalid-message' });
      const body = text.replace(/\r\n/g, '\n').trim().slice(0, MAX_CHAT_LENGTH);
      if (!body) return reply({ ok: false, error: 'invalid-message' });
      const now = Date.now();
      if (now - lastChatAt < CHAT_MIN_INTERVAL_MS) return reply({ ok: false, error: 'rate-limited' });
      lastChatAt = now;
      const message = { id: `${socket.id}-${now}`, from: socket.id, name: current.name, text: body, ts: now };
      io.to(current.roomId).emit('chat', message);
      reply({ ok: true, message });
    });

    socket.on('leave', leaveCurrent);
    socket.on('disconnect', leaveCurrent);
  });

  return { app, server, io, rooms };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';
  const { server } = createServer();
  server.listen(port, host, () => {
    console.log(`WebTalk listening on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  });
}

module.exports = { createServer, iceServersFromEnv };

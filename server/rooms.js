'use strict';

const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_NAME_LENGTH = 32;

function normalizeRoomId(roomId) {
  if (typeof roomId !== 'string') return null;
  const trimmed = roomId.trim();
  return ROOM_ID_RE.test(trimmed) ? trimmed.toLowerCase() : null;
}

function normalizeName(name) {
  if (typeof name !== 'string') return null;
  // Collapse whitespace and strip control characters.
  const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.slice(0, MAX_NAME_LENGTH);
}

/**
 * Keeps track of who is in which room. Pure in-memory state, no I/O,
 * so it can be unit-tested without a socket server.
 */
class RoomManager {
  constructor({ maxPeers = 8 } = {}) {
    this.maxPeers = maxPeers;
    /** @type {Map<string, Map<string, {id: string, name: string, media: object, joinedAt: number}>>} */
    this.rooms = new Map();
  }

  join(roomId, peer) {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = new Map();
      this.rooms.set(roomId, room);
    }
    if (room.has(peer.id)) {
      return { ok: true, peers: this.list(roomId).filter((p) => p.id !== peer.id) };
    }
    if (room.size >= this.maxPeers) {
      if (room.size === 0) this.rooms.delete(roomId);
      return { ok: false, error: 'room-full' };
    }
    const existing = this.list(roomId);
    room.set(peer.id, {
      id: peer.id,
      name: peer.name,
      media: { audio: true, video: true, screen: false, ...(peer.media || {}) },
      joinedAt: Date.now(),
    });
    return { ok: true, peers: existing };
  }

  leave(roomId, peerId) {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    const removed = room.delete(peerId);
    if (room.size === 0) this.rooms.delete(roomId);
    return removed;
  }

  has(roomId, peerId) {
    const room = this.rooms.get(roomId);
    return Boolean(room && room.has(peerId));
  }

  get(roomId, peerId) {
    const room = this.rooms.get(roomId);
    return room ? room.get(peerId) : undefined;
  }

  setMedia(roomId, peerId, media) {
    const peer = this.get(roomId, peerId);
    if (!peer) return null;
    for (const key of ['audio', 'video', 'screen']) {
      if (typeof media[key] === 'boolean') peer.media[key] = media[key];
    }
    return peer.media;
  }

  list(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return [...room.values()].map((p) => ({ id: p.id, name: p.name, media: { ...p.media } }));
  }

  size(roomId) {
    const room = this.rooms.get(roomId);
    return room ? room.size : 0;
  }
}

module.exports = { RoomManager, normalizeRoomId, normalizeName, MAX_NAME_LENGTH };

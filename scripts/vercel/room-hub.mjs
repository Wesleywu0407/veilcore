import { randomUUID } from 'node:crypto';
import { redis } from './redis.mjs';
import { createRoomStore } from './room-store.mjs';

const RELAY_CHANNEL = 'veilcore:relay';
const RELAY_TYPES = new Set(['state', 'event', 'reset']);
const ROOM_PATTERN = /^[A-Z2-9]{4}$/;
const HEARTBEAT_MS = 10_000;
const OPEN = 1;

const globalHub = globalThis;
const hub = globalHub.__veilcoreRoomHub ?? (globalHub.__veilcoreRoomHub = {
  instanceId: randomUUID(),
  peers: new Map(),
  subscriber: null,
  bridgePromise: null,
  heartbeat: null,
});
const store = redis ? createRoomStore(redis) : null;

function send(peer, message) {
  if (peer.ws.readyState !== OPEN) return;
  try {
    peer.ws.send(JSON.stringify(message));
  } catch {
    // The close event owns cleanup.
  }
}

function deliverLocal(room, senderClientId, message) {
  for (const peer of hub.peers.values()) {
    if (!peer.ready || peer.room !== room || peer.clientId === senderClientId) continue;
    send(peer, message);
  }
}

function receiveRelay(raw) {
  try {
    const envelope = JSON.parse(raw);
    if (envelope.origin === hub.instanceId) return;
    if (!ROOM_PATTERN.test(envelope.room) || !RELAY_TYPES.has(envelope.message?.type)
      && envelope.message?.type !== 'peer') return;
    deliverLocal(envelope.room, envelope.senderClientId, envelope.message);
  } catch {
    // A malformed relay entry is isolated to Redis and ignored.
  }
}

async function startBridge() {
  if (!redis) throw new Error('REDIS_URL is not configured');
  if (hub.bridgePromise) return hub.bridgePromise;

  hub.bridgePromise = (async () => {
    const subscriber = redis.duplicate();
    subscriber.on('error', error => console.error('[veilcore subscriber]', error.message));
    subscriber.on('message', (channel, raw) => {
      if (channel === RELAY_CHANNEL) receiveRelay(raw);
    });
    await subscriber.subscribe(RELAY_CHANNEL);
    hub.subscriber = subscriber;
  })().catch(error => {
    hub.bridgePromise = null;
    throw error;
  });
  return hub.bridgePromise;
}

async function stopBridge() {
  const subscriber = hub.subscriber;
  hub.subscriber = null;
  hub.bridgePromise = null;
  if (subscriber) await subscriber.quit().catch(() => {});
}

async function publish(peer, message) {
  deliverLocal(peer.room, peer.clientId, message);
  try {
    await redis.publish(RELAY_CHANNEL, JSON.stringify({
      origin: hub.instanceId,
      room: peer.room,
      senderClientId: peer.clientId,
      message,
    }));
  } catch (error) {
    console.error('[veilcore relay]', error.message);
  }
}

function startHeartbeat() {
  if (hub.heartbeat) return;
  hub.heartbeat = setInterval(() => {
    for (const peer of hub.peers.values()) {
      if (peer.ready) void store.touch(peer).catch(error => {
        console.error('[veilcore heartbeat]', error.message);
      });
    }
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (!hub.heartbeat) return;
  clearInterval(hub.heartbeat);
  hub.heartbeat = null;
}

function normaliseClientId(value) {
  const clean = String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return clean || randomUUID();
}

async function initialise(peer, url) {
  if (!redis || !store) throw new Error('room service is missing REDIS_URL');
  await startBridge();

  const mode = url.searchParams.get('mode');
  const room = String(url.searchParams.get('room') ?? '').toUpperCase();
  let result;
  if (mode === 'create') {
    result = await store.create(peer.clientId, peer.connectionId);
  } else if ((mode === 'join' || mode === 'resume') && ROOM_PATTERN.test(room)) {
    result = await store.enter(mode, room, peer.clientId, peer.connectionId);
    if (!result.ok) throw new Error(result.message);
  } else {
    throw new Error('invalid room request');
  }

  peer.room = result.room;
  peer.role = result.role;
  peer.ready = true;
  startHeartbeat();
  send(peer, {
    type: 'welcome',
    room: result.room,
    role: result.role,
    peerPresent: result.peerPresent,
  });
  if (result.peerPresent) await publish(peer, { type: 'peer', connected: true });
}

async function relay(peer, raw) {
  if (!peer.ready) return;
  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (!RELAY_TYPES.has(message?.type)) return;
  await publish(peer, message);
}

async function unregister(peer) {
  if (peer.closed) return;
  peer.closed = true;
  hub.peers.delete(peer.ws);
  if (peer.ready) {
    try {
      const removed = await store.leave(peer);
      if (removed) await publish(peer, { type: 'peer', connected: false });
    } catch (error) {
      console.error('[veilcore leave]', error.message);
    }
  }
  if (hub.peers.size === 0) {
    stopHeartbeat();
    await stopBridge();
  }
}

export function acceptRoomSocket(ws, request) {
  const url = new URL(request.url ?? '/api/ws', 'http://veilcore.local');
  const peer = {
    ws,
    clientId: normaliseClientId(url.searchParams.get('clientId')),
    connectionId: randomUUID(),
    room: null,
    role: null,
    ready: false,
    closed: false,
  };
  hub.peers.set(ws, peer);

  ws.on('message', raw => void relay(peer, raw));
  const close = () => void unregister(peer);
  ws.on('close', close);
  ws.on('error', close);

  void initialise(peer, url).catch(error => {
    send(peer, { type: 'error', message: error.message || 'room service unavailable' });
    setTimeout(() => {
      try { ws.close(1013, 'room service unavailable'); } catch { /* already closed */ }
    }, 20);
  });
}

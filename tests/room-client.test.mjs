import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkRoomServer,
  createRoomClient,
  mirrorArenaPosition,
  normaliseRoomCode,
  roomHealthUrl,
  roomSocketUrl,
} from '../js/arena/room-client.js';

test('room codes are short, uppercase and avoid punctuation', () => {
  assert.equal(normaliseRoomCode(' a-bc9x '), 'ABC9');
});

test('room sockets follow the page security', () => {
  assert.equal(roomSocketUrl({ protocol: 'https:', host: 'duel.test' }, { mode: 'join', room: 'abcd' }),
    'wss://duel.test/ws?mode=join&room=ABCD');
  assert.equal(roomSocketUrl({ protocol: 'http:', host: '127.0.0.1:5173' }, { mode: 'create' }),
    'ws://127.0.0.1:5173/ws?mode=create');
  assert.equal(roomSocketUrl(
    { protocol: 'https:', host: 'duel.test' },
    { mode: 'resume', room: 'abcd', clientId: 'player-7' },
  ), 'wss://duel.test/ws?mode=resume&room=ABCD&clientId=player-7');
});

test('the room health check verifies the Veilcore server rather than any static server', async () => {
  const locationLike = { protocol: 'https:', host: 'duel.test' };
  assert.equal(roomHealthUrl(locationLike), 'https://duel.test/__veilcore/health');
  assert.equal(await checkRoomServer({
    locationLike,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ ok: true, service: 'veilcore-duel' }),
    }),
  }), true);
  assert.equal(await checkRoomServer({
    locationLike,
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true }) }),
  }), false);
});

test('a silent room server times out instead of leaving the menu stuck', async () => {
  class SilentSocket {
    static OPEN = 1;
    listeners = new Map();
    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }
    close() {
      for (const listener of this.listeners.get('close') ?? []) listener();
    }
  }
  const client = createRoomClient({
    locationLike: { protocol: 'https:', host: 'duel.test' },
    WebSocketImpl: SilentSocket,
    connectionTimeoutMs: 5,
  });
  await assert.rejects(client.connect({ mode: 'create' }), /timed out/);
});

test('a welcomed room reconnects with the same identity and room', async t => {
  class ReconnectingSocket {
    static OPEN = 1;
    static instances = [];
    listeners = new Map();
    readyState = 0;

    constructor(url) {
      this.url = url;
      ReconnectingSocket.instances.push(this);
      queueMicrotask(() => {
        this.readyState = ReconnectingSocket.OPEN;
        this.emit('open');
      });
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    emit(type, value) {
      for (const listener of this.listeners.get(type) ?? []) listener(value);
    }

    receive(message) {
      this.emit('message', { data: JSON.stringify(message) });
    }

    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.emit('close');
    }
  }

  const client = createRoomClient({
    locationLike: { protocol: 'https:', host: 'duel.test' },
    WebSocketImpl: ReconnectingSocket,
    reconnectBaseMs: 1,
    reconnectMaxMs: 1,
  });
  t.after(() => client.close());

  const connected = client.connect({ mode: 'create' });
  await new Promise(resolve => setTimeout(resolve, 0));
  const first = ReconnectingSocket.instances[0];
  first.receive({ type: 'welcome', room: 'ABCD', role: 'host', peerPresent: true });
  await connected;

  first.close();
  await new Promise(resolve => setTimeout(resolve, 10));
  const second = ReconnectingSocket.instances[1];
  assert.ok(second);
  const firstUrl = new URL(first.url);
  const secondUrl = new URL(second.url);
  assert.equal(secondUrl.searchParams.get('mode'), 'resume');
  assert.equal(secondUrl.searchParams.get('room'), 'ABCD');
  assert.equal(secondUrl.searchParams.get('clientId'), firstUrl.searchParams.get('clientId'));
  second.receive({ type: 'welcome', room: 'ABCD', role: 'host', peerPresent: true });
});

test('a peer position is rotated onto the opposite side of the same arena', () => {
  assert.deepEqual(mirrorArenaPosition([3, 14]), [-3, -14]);
});

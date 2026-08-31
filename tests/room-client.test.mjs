import test from 'node:test';
import assert from 'node:assert/strict';
import { mirrorArenaPosition, normaliseRoomCode, roomSocketUrl } from '../js/arena/room-client.js';

test('room codes are short, uppercase and avoid punctuation', () => {
  assert.equal(normaliseRoomCode(' a-bc9x '), 'ABC9');
});

test('room sockets follow the page security', () => {
  assert.equal(roomSocketUrl({ protocol: 'https:', host: 'duel.test' }, { mode: 'join', room: 'abcd' }),
    'wss://duel.test/ws?mode=join&room=ABCD');
  assert.equal(roomSocketUrl({ protocol: 'http:', host: '127.0.0.1:5173' }, { mode: 'create' }),
    'ws://127.0.0.1:5173/ws?mode=create');
});

test('a peer position is rotated onto the opposite side of the same arena', () => {
  assert.deepEqual(mirrorArenaPosition([3, 14]), [-3, -14]);
});

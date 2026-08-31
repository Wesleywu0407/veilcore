import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomRegistry } from '../scripts/duel-rooms.mjs';

function peer() {
  const messages = [];
  return { messages, send: text => messages.push(JSON.parse(text)) };
}

test('a host receives a code and a guest joins the same room', () => {
  const rooms = createRoomRegistry({ makeCode: () => 'ABCD' });
  const host = peer();
  const guest = peer();
  assert.equal(rooms.create(host), 'ABCD');
  assert.deepEqual(host.messages[0], { type: 'welcome', room: 'ABCD', role: 'host', peerPresent: false });
  assert.equal(rooms.join(guest, 'ABCD').ok, true);
  assert.equal(guest.messages[0].peerPresent, true);
  assert.deepEqual(host.messages.at(-1), { type: 'peer', connected: true });
});

test('room messages relay only to the other player', () => {
  const rooms = createRoomRegistry({ makeCode: () => 'ABCD' });
  const host = peer();
  const guest = peer();
  rooms.create(host);
  rooms.join(guest, 'ABCD');
  const state = { type: 'state', state: { position: [1, 2] } };
  assert.equal(rooms.relay(host, state), true);
  assert.deepEqual(guest.messages.at(-1), state);
  assert.equal(rooms.relay(host, { type: 'admin' }), false);
});

test('disconnecting tells the remaining player and frees the room', () => {
  const rooms = createRoomRegistry({ makeCode: () => 'ABCD' });
  const host = peer();
  const guest = peer();
  rooms.create(host);
  rooms.join(guest, 'ABCD');
  rooms.leave(guest);
  assert.deepEqual(host.messages.at(-1), { type: 'peer', connected: false });
  rooms.leave(host);
  assert.equal(rooms.roomCount(), 0);
});

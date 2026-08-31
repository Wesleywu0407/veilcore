import { randomInt } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RELAY_TYPES = new Set(['state', 'event', 'reset']);

function randomCode() {
  let code = '';
  for (let i = 0; i < 4; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

export function createRoomRegistry({ makeCode = randomCode } = {}) {
  const rooms = new Map();
  const membership = new Map();

  function send(peer, message) {
    peer.send(JSON.stringify(message));
  }

  function create(peer) {
    let code;
    do code = makeCode(); while (rooms.has(code));
    const room = { code, peers: [peer, null] };
    rooms.set(code, room);
    membership.set(peer, { room, slot: 0 });
    send(peer, { type: 'welcome', room: code, role: 'host', peerPresent: false });
    return code;
  }

  function join(peer, rawCode) {
    const code = String(rawCode ?? '').toUpperCase();
    const room = rooms.get(code);
    if (!room) return { ok: false, message: 'room not found' };
    const slot = room.peers[0] ? 1 : 0;
    if (room.peers[slot]) return { ok: false, message: 'room is full' };
    room.peers[slot] = peer;
    membership.set(peer, { room, slot });
    send(peer, { type: 'welcome', room: code, role: slot === 0 ? 'host' : 'guest', peerPresent: true });
    for (const roomPeer of room.peers) {
      if (roomPeer && roomPeer !== peer) send(roomPeer, { type: 'peer', connected: true });
    }
    return { ok: true, code };
  }

  function relay(peer, message) {
    if (!RELAY_TYPES.has(message?.type)) return false;
    const member = membership.get(peer);
    if (!member) return false;
    const other = member.room.peers[member.slot === 0 ? 1 : 0];
    if (!other) return false;
    send(other, message);
    return true;
  }

  function leave(peer) {
    const member = membership.get(peer);
    if (!member) return;
    membership.delete(peer);
    member.room.peers[member.slot] = null;
    const other = member.room.peers[member.slot === 0 ? 1 : 0];
    if (other) send(other, { type: 'peer', connected: false });
    if (!member.room.peers[0] && !member.room.peers[1]) rooms.delete(member.room.code);
  }

  return {
    create,
    join,
    relay,
    leave,
    roomCount: () => rooms.size,
  };
}

const ROOM_PATTERN = /^[A-Z2-9]{4}$/;

export function normaliseRoomCode(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 4);
}

export function roomSocketUrl(locationLike, { mode, room = '' }) {
  const protocol = locationLike.protocol === 'https:' ? 'wss:' : 'ws:';
  const query = new URLSearchParams({ mode });
  if (room) query.set('room', normaliseRoomCode(room));
  return `${protocol}//${locationLike.host}/ws?${query}`;
}

export function mirrorArenaPosition(position) {
  return [-Number(position?.[0] ?? 0), -Number(position?.[1] ?? 0)];
}

export function createRoomClient({
  locationLike = location,
  WebSocketImpl = WebSocket,
  onStatus = () => {},
  onPeer = () => {},
  onState = () => {},
  onEvent = () => {},
  onReset = () => {},
} = {}) {
  let socket = null;
  let room = null;
  let role = null;
  let peerPresent = false;

  function send(message) {
    if (!socket || socket.readyState !== WebSocketImpl.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  function connect({ mode, room: requestedRoom = '' }) {
    if (socket) socket.close();
    const roomCode = normaliseRoomCode(requestedRoom);
    if (mode === 'join' && !ROOM_PATTERN.test(roomCode)) {
      return Promise.reject(new Error('room code must be four characters'));
    }

    return new Promise((resolve, reject) => {
      let welcomed = false;
      socket = new WebSocketImpl(roomSocketUrl(locationLike, { mode, room: roomCode }));
      socket.addEventListener('open', () => onStatus('connected to duel server'));
      socket.addEventListener('message', event => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.type === 'welcome') {
          welcomed = true;
          room = message.room;
          role = message.role;
          peerPresent = Boolean(message.peerPresent);
          onPeer(peerPresent, { room, role });
          resolve({ room, role, peerPresent });
        } else if (message.type === 'peer') {
          peerPresent = Boolean(message.connected);
          onPeer(peerPresent, { room, role });
        } else if (message.type === 'state') {
          onState(message.state);
        } else if (message.type === 'event') {
          onEvent(message.event);
        } else if (message.type === 'reset') {
          onReset();
        } else if (message.type === 'error') {
          const error = new Error(message.message || 'room connection failed');
          onStatus(error.message);
          if (!welcomed) reject(error);
        }
      });
      socket.addEventListener('close', () => {
        peerPresent = false;
        onPeer(false, { room, role });
        if (!welcomed) reject(new Error('duel server closed the connection'));
      });
      socket.addEventListener('error', () => {
        onStatus('duel server unavailable');
        if (!welcomed) reject(new Error('duel server unavailable'));
      });
    });
  }

  return {
    connect,
    sendState: state => peerPresent && send({ type: 'state', state }),
    sendEvent: event => peerPresent && send({ type: 'event', event }),
    sendReset: () => peerPresent && send({ type: 'reset' }),
    close() {
      socket?.close();
      socket = null;
      peerPresent = false;
    },
    get connected() { return socket?.readyState === WebSocketImpl.OPEN; },
    get peerPresent() { return peerPresent; },
    get room() { return room; },
    get role() { return role; },
  };
}

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

export function roomHealthUrl(locationLike) {
  return `${locationLike.protocol}//${locationLike.host}/__veilcore/health`;
}

export async function checkRoomServer({
  locationLike = location,
  fetchImpl = fetch,
  timeoutMs = 2500,
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(roomHealthUrl(locationLike), {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.ok === true && body?.service === 'veilcore-duel';
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
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
  connectionTimeoutMs = 8000,
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
    const previous = socket;
    socket = null;
    previous?.close();
    const roomCode = normaliseRoomCode(requestedRoom);
    if (mode === 'join' && !ROOM_PATTERN.test(roomCode)) {
      return Promise.reject(new Error('room code must be four characters'));
    }

    return new Promise((resolve, reject) => {
      let welcomed = false;
      let settled = false;
      const candidate = new WebSocketImpl(roomSocketUrl(locationLike, { mode, room: roomCode }));
      socket = candidate;
      const timer = setTimeout(() => {
        if (settled || socket !== candidate) return;
        settled = true;
        candidate.close();
        reject(new Error('duel server connection timed out'));
      }, connectionTimeoutMs);
      const settle = callback => value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      const succeed = settle(resolve);
      const fail = settle(reject);

      candidate.addEventListener('open', () => {
        if (socket === candidate) onStatus('connected to duel server');
      });
      candidate.addEventListener('message', event => {
        if (socket !== candidate) return;
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
          succeed({ room, role, peerPresent });
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
          if (!welcomed) fail(error);
        }
      });
      candidate.addEventListener('close', () => {
        if (socket !== candidate) return;
        peerPresent = false;
        onPeer(false, { room, role });
        if (!welcomed) fail(new Error('duel server closed the connection'));
      });
      candidate.addEventListener('error', () => {
        if (socket !== candidate) return;
        if (!welcomed) fail(new Error('duel server unavailable'));
        else onStatus('duel server unavailable');
      });
    });
  }

  return {
    connect,
    sendState: state => peerPresent && send({ type: 'state', state }),
    sendEvent: event => peerPresent && send({ type: 'event', event }),
    sendReset: () => peerPresent && send({ type: 'reset' }),
    close() {
      const current = socket;
      socket = null;
      peerPresent = false;
      room = null;
      role = null;
      current?.close();
    },
    get connected() { return socket?.readyState === WebSocketImpl.OPEN; },
    get peerPresent() { return peerPresent; },
    get room() { return room; },
    get role() { return role; },
  };
}

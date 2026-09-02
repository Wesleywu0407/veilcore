const ROOM_PATTERN = /^[A-Z2-9]{4}$/;

export function normaliseRoomCode(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 4);
}

export function roomSocketUrl(locationLike, { mode, room = '', clientId = '' }) {
  const protocol = locationLike.protocol === 'https:' ? 'wss:' : 'ws:';
  const query = new URLSearchParams({ mode });
  if (room) query.set('room', normaliseRoomCode(room));
  if (clientId) query.set('clientId', clientId);
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
  reconnectBaseMs = 1000,
  reconnectMaxMs = 30_000,
} = {}) {
  let socket = null;
  let room = null;
  let role = null;
  let peerPresent = false;
  let desiredConnection = null;
  let reconnectTimer = null;
  let reconnectDelay = reconnectBaseMs;
  let generation = 0;
  const clientId = globalThis.crypto?.randomUUID?.()
    ?? `p_${Math.random().toString(36).slice(2, 12)}`;

  function send(message) {
    if (!socket || socket.readyState !== WebSocketImpl.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  function clearReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function scheduleReconnect() {
    if (!desiredConnection || reconnectTimer) return;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, reconnectMaxMs);
    onStatus('duel server reconnecting…');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!desiredConnection) return;
      openSocket(desiredConnection, true).catch(error => {
        if (!desiredConnection) return;
        onStatus(error.message || 'duel server unavailable');
        scheduleReconnect();
      });
    }, delay);
  }

  function openSocket({ mode, room: requestedRoom = '' }, reconnecting = false) {
    const attempt = ++generation;
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
      const candidate = new WebSocketImpl(roomSocketUrl(locationLike, {
        mode,
        room: roomCode,
        clientId,
      }));
      socket = candidate;
      const timer = setTimeout(() => {
        if (settled || socket !== candidate || generation !== attempt) return;
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
          desiredConnection = { mode: 'resume', room };
          reconnectDelay = reconnectBaseMs;
          clearReconnect();
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
          if (reconnecting && /not found|full/i.test(error.message)) desiredConnection = null;
          if (!welcomed) fail(error);
        }
      });
      candidate.addEventListener('close', () => {
        if (socket !== candidate || generation !== attempt) return;
        socket = null;
        peerPresent = false;
        onPeer(false, { room, role });
        if (!welcomed) fail(new Error('duel server closed the connection'));
        else scheduleReconnect();
      });
      candidate.addEventListener('error', () => {
        if (socket !== candidate || generation !== attempt) return;
        if (!welcomed) fail(new Error('duel server unavailable'));
        else onStatus('duel server unavailable');
      });
    });
  }

  function connect({ mode, room: requestedRoom = '' }) {
    desiredConnection = null;
    clearReconnect();
    reconnectDelay = reconnectBaseMs;
    return openSocket({ mode, room: requestedRoom });
  }

  return {
    connect,
    sendState: state => peerPresent && send({ type: 'state', state }),
    sendEvent: event => peerPresent && send({ type: 'event', event }),
    sendReset: () => peerPresent && send({ type: 'reset' }),
    close() {
      desiredConnection = null;
      clearReconnect();
      generation++;
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

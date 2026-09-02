import { randomInt } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_PREFIX = 'veilcore:room:';
const ROOM_TTL_MS = 2 * 60 * 60_000;
const PRESENCE_TTL_MS = 30_000;

const CREATE_ROOM = `
  if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
  redis.call('HSET', KEYS[1], 'host', ARGV[1])
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
`;

const ENTER_ROOM = `
  if redis.call('EXISTS', KEYS[1]) == 0 then return {'missing'} end

  local mode = ARGV[1]
  local client_id = ARGV[2]
  local member_json = ARGV[3]
  local stale_before = tonumber(ARGV[4])

  local function member(field)
    local raw = redis.call('HGET', KEYS[1], field)
    if not raw then return nil end
    local ok, value = pcall(cjson.decode, raw)
    if not ok then return nil end
    return value
  end

  local function active(value)
    return value and tonumber(value.lastSeen or 0) >= stale_before
  end

  local host = member('host')
  local guest = member('guest')
  local role = nil

  if host and tostring(host.clientId) == client_id then
    role = 'host'
  elseif guest and tostring(guest.clientId) == client_id then
    role = 'guest'
  elseif mode == 'resume' then
    return {'missing'}
  elseif not active(host) then
    role = 'host'
  elseif not active(guest) then
    role = 'guest'
  else
    return {'full'}
  end

  redis.call('HSET', KEYS[1], role, member_json)
  redis.call('PEXPIRE', KEYS[1], ARGV[5])
  local other = role == 'host' and guest or host
  return {'ok', role, active(other) and '1' or '0'}
`;

const TOUCH_ROOM = `
  local raw = redis.call('HGET', KEYS[1], ARGV[1])
  if not raw then return 0 end
  local ok, member = pcall(cjson.decode, raw)
  if not ok or tostring(member.connectionId) ~= ARGV[2] then return 0 end
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
  redis.call('PEXPIRE', KEYS[1], ARGV[4])
  return 1
`;

const LEAVE_ROOM = `
  local raw = redis.call('HGET', KEYS[1], ARGV[1])
  if not raw then return 0 end
  local ok, member = pcall(cjson.decode, raw)
  if not ok or tostring(member.connectionId) ~= ARGV[2] then return 0 end

  redis.call('HDEL', KEYS[1], ARGV[1])
  if redis.call('HLEN', KEYS[1]) == 0 then
    redis.call('DEL', KEYS[1])
  else
    redis.call('PEXPIRE', KEYS[1], ARGV[3])
  end
  return 1
`;

function roomCode() {
  let code = '';
  for (let index = 0; index < 4; index++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

function key(code) {
  return `${ROOM_PREFIX}${code}`;
}

function member(clientId, connectionId) {
  return JSON.stringify({ clientId, connectionId, lastSeen: Date.now() });
}

export function createRoomStore(redis) {
  async function create(clientId, connectionId) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const room = roomCode();
      const created = await redis.eval(
        CREATE_ROOM,
        1,
        key(room),
        member(clientId, connectionId),
        ROOM_TTL_MS,
      );
      if (Number(created) === 1) return { room, role: 'host', peerPresent: false };
    }
    throw new Error('could not allocate a room code');
  }

  async function enter(mode, room, clientId, connectionId) {
    const result = await redis.eval(
      ENTER_ROOM,
      1,
      key(room),
      mode,
      clientId,
      member(clientId, connectionId),
      Date.now() - PRESENCE_TTL_MS,
      ROOM_TTL_MS,
    );
    const status = String(result?.[0] ?? 'missing');
    if (status === 'missing') return { ok: false, message: 'room not found' };
    if (status === 'full') return { ok: false, message: 'room is full' };
    return {
      ok: true,
      room,
      role: String(result[1]),
      peerPresent: String(result[2]) === '1',
    };
  }

  async function touch({ room, role, clientId, connectionId }) {
    return Number(await redis.eval(
      TOUCH_ROOM,
      1,
      key(room),
      role,
      connectionId,
      member(clientId, connectionId),
      ROOM_TTL_MS,
    )) === 1;
  }

  async function leave({ room, role, connectionId }) {
    return Number(await redis.eval(
      LEAVE_ROOM,
      1,
      key(room),
      role,
      connectionId,
      ROOM_TTL_MS,
    )) === 1;
  }

  return { create, enter, touch, leave };
}

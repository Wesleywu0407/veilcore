import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function startServer(t) {
  const child = spawn(process.execPath, ['scripts/duel-server.mjs', '--port', '0'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGTERM'));
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`server start timed out: ${output}`)), 4000);
    child.stderr.on('data', chunk => { output += chunk; });
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      if (!match) return;
      clearTimeout(timeout);
      resolve({ child, port: Number(match[1]) });
    });
    child.once('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`server exited ${code}: ${output}`));
    });
  });
}

function connect(url) {
  const socket = new WebSocket(url);
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const firstMessage = nextMessage(socket);
  return Promise.all([opened, firstMessage]).then(([, message]) => ({ socket, message }));
}

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WebSocket message timed out')), 2000);
    socket.addEventListener('message', event => {
      clearTimeout(timeout);
      resolve(JSON.parse(event.data));
    }, { once: true });
  });
}

test('the real duel server serves health, creates a room and relays a state', async t => {
  const { port } = await startServer(t);
  const response = await fetch(`http://127.0.0.1:${port}/__veilcore/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: 'veilcore-duel', rooms: 0 });

  const host = await connect(`ws://127.0.0.1:${port}/ws?mode=create`);
  t.after(() => host.socket.close());
  assert.equal(host.message.type, 'welcome');
  assert.match(host.message.room, /^[A-Z2-9]{4}$/);
  assert.equal(host.message.role, 'host');

  const hostPeerMessage = nextMessage(host.socket);
  const guest = await connect(`ws://127.0.0.1:${port}/ws?mode=join&room=${host.message.room}`);
  t.after(() => guest.socket.close());
  assert.equal(guest.message.role, 'guest');
  assert.deepEqual(await hostPeerMessage, { type: 'peer', connected: true });

  const relayed = nextMessage(guest.socket);
  host.socket.send(JSON.stringify({ type: 'state', state: { position: [2, 7], hp: 80 } }));
  assert.deepEqual(await relayed, {
    type: 'state',
    state: { position: [2, 7], hp: 80 },
  });
});

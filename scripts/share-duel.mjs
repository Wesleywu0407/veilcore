import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.VEILCORE_PORT ?? 5174);
const healthUrl = `http://127.0.0.1:${port}/__veilcore/health`;
const children = new Set();
let stopping = false;

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function serverIsReady(url = healthUrl) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1200) });
    const body = await response.json();
    return response.ok && body.service === 'veilcore-duel';
  } catch {
    return false;
  }
}

function start(command, args, options = {}) {
  const child = spawn(command, args, { cwd: ROOT, stdio: 'inherit', ...options });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

function startTunnel(args) {
  const child = spawn('ssh', args, {
    cwd: ROOT,
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  children.add(child);
  child.once('exit', () => children.delete(child));

  let output = '';
  let found = false;
  let resolveUrl;
  let rejectUrl;
  const publicUrl = new Promise((resolve, reject) => {
    resolveUrl = resolve;
    rejectUrl = reject;
  });
  child.once('exit', code => {
    if (!found) rejectUrl(new Error(`tunnel exited ${code ?? 1}`));
  });
  function forward(chunk, stream) {
    stream.write(chunk);
    output = `${output}${chunk}`.slice(-8000);
    const match = output.match(/https:\/\/[a-z0-9-]+\.(?:run\.pinggy-free\.link|free\.pinggy\.net)/i);
    if (!found && match) {
      found = true;
      resolveUrl(match[0]);
    }
  }
  child.stdout.on('data', chunk => forward(chunk, process.stdout));
  child.stderr.on('data', chunk => forward(chunk, process.stderr));
  return { child, publicUrl };
}

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
    process.exit(exitCode);
  }, 800).unref();
  if (children.size === 0) process.exit(exitCode);
}

let server = null;
if (await serverIsReady()) {
  console.log(`Using the Veilcore server already running on port ${port}.`);
} else {
  server = start(process.execPath, ['scripts/duel-server.mjs', '--port', String(port)]);
  server.once('exit', code => {
    setTimeout(() => {
      if (!stopping) {
        console.error('The local duel server stopped before the share link was ready.');
        stop(code || 1);
      }
    }, 50);
  });
  for (let attempt = 0; attempt < 30 && !(await serverIsReady()); attempt++) await wait(100);
  if (!(await serverIsReady())) {
    console.error(`Could not start the duel server on port ${port}.`);
    stop(1);
  }
}

console.log('Opening a trusted HTTPS link. Keep this terminal open while you play.');
const tunnelResult = startTunnel([
  '-p', '443',
  '-o', 'ServerAliveInterval=30',
  '-o', 'ServerAliveCountMax=3',
  '-o', 'ExitOnForwardFailure=yes',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-R', `0:127.0.0.1:${port}`,
  '-t',
  'free.pinggy.io',
  'x:https',
]);
const tunnel = tunnelResult.child;

tunnel.once('exit', code => {
  setTimeout(() => {
    if (!stopping) {
      console.error('The public duel link closed. Run npm run share to open a new one.');
      stop(code || 1);
    }
  }, 50);
});

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

let publicUrl;
try {
  publicUrl = await Promise.race([
    tunnelResult.publicUrl,
    wait(12_000).then(() => { throw new Error('tunnel URL timed out'); }),
  ]);
} catch {
  console.error('The tunnel did not provide a public HTTPS address.');
  stop(1);
}

let publicReady = false;
if (publicUrl) {
  for (let attempt = 0; attempt < 20 && !publicReady; attempt++) {
    publicReady = await serverIsReady(`${publicUrl}/__veilcore/health`);
    if (!publicReady) await wait(250);
  }
}
if (publicUrl && !publicReady) {
  console.error('The public address could not reach the Veilcore duel server.');
  stop(1);
} else if (publicReady) {
  console.log(`\nVEILCORE READY: ${publicUrl}`);
  console.log('Send this same HTTPS address to your friend. Press Ctrl+C when finished.');
}

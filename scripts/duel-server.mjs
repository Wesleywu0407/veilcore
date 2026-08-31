import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRoomRegistry } from './duel-rooms.mjs';

const ROOT = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const useHttps = process.argv.includes('--https');
const portArg = process.argv.findIndex(value => value === '--port');
const port = Number(portArg >= 0 ? process.argv[portArg + 1] : process.env.VEILCORE_PORT ?? 5173);
const host = process.env.VEILCORE_HOST ?? '0.0.0.0';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.mp4': 'video/mp4',
  '.wasm': 'application/wasm',
  '.crt': 'application/x-x509-ca-cert',
};
const rooms = createRoomRegistry();

function staticResponse(request, response) {
  const url = new URL(request.url, `${useHttps ? 'https' : 'http'}://${request.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const relative = normalize(pathname).replace(/^([/\\])+/, '');
  const path = join(ROOT, relative);
  if (!path.startsWith(ROOT) || !existsSync(path) || !statSync(path).isFile()) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }
  const headers = {
    'Content-Type': MIME[extname(path).toLowerCase()] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'Content-Length': statSync(path).size,
  };
  response.writeHead(200, headers);
  if (request.method === 'HEAD') response.end();
  else createReadStream(path).pipe(response);
}

function encodeFrame(text, opcode = 0x1) {
  const payload = Buffer.from(text);
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
  if (payload.length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  throw new Error('message too large');
}

function createPeer(socket) {
  let buffer = Buffer.alloc(0);
  let closed = false;
  const peer = {
    send(text) {
      if (!closed && socket.writable) socket.write(encodeFrame(text));
    },
  };

  function close() {
    if (closed) return;
    closed = true;
    rooms.leave(peer);
    socket.end(encodeFrame('', 0x8));
  }

  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 0x0f;
      const masked = Boolean(buffer[1] & 0x80);
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        close();
        return;
      }
      const maskBytes = masked ? 4 : 0;
      if (length > 32_768 || buffer.length < offset + maskBytes + length) return;
      const mask = masked ? buffer.subarray(offset, offset + 4) : null;
      offset += maskBytes;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      buffer = buffer.subarray(offset + length);
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      if (opcode === 0x8) {
        close();
        return;
      }
      if (opcode === 0x9) {
        socket.write(encodeFrame(payload.toString(), 0xA));
        continue;
      }
      if (opcode !== 0x1) continue;
      try {
        rooms.relay(peer, JSON.parse(payload.toString('utf8')));
      } catch {
        peer.send(JSON.stringify({ type: 'error', message: 'invalid room message' }));
      }
    }
  });
  socket.on('close', () => { closed = true; rooms.leave(peer); });
  socket.on('error', () => { closed = true; rooms.leave(peer); });
  return peer;
}

const tls = useHttps ? {
  key: readFileSync(join(ROOT, '.cert/server.key')),
  cert: readFileSync(join(ROOT, '.cert/server.crt')),
} : null;
const server = useHttps ? createHttpsServer(tls, staticResponse) : createHttpServer(staticResponse);

server.on('upgrade', (request, socket) => {
  const url = new URL(request.url, `${useHttps ? 'https' : 'http'}://${request.headers.host}`);
  if (url.pathname !== '/ws' || request.headers.upgrade?.toLowerCase() !== 'websocket') {
    socket.destroy();
    return;
  }
  const key = request.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '\r\n',
  ].join('\r\n'));
  const peer = createPeer(socket);
  const mode = url.searchParams.get('mode');
  if (mode === 'create') {
    rooms.create(peer);
    return;
  }
  const result = rooms.join(peer, url.searchParams.get('room'));
  if (!result.ok) {
    peer.send(JSON.stringify({ type: 'error', message: result.message }));
    setTimeout(() => socket.end(encodeFrame('', 0x8)), 20);
  }
});

server.listen(port, host, () => {
  const protocol = useHttps ? 'https' : 'http';
  console.log(`Veilcore duel server: ${protocol}://127.0.0.1:${port}/`);
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        console.log(`LAN: ${protocol}://${address.address}:${port}/`);
      }
    }
  }
});

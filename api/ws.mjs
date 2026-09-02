import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { acceptRoomSocket } from '../scripts/vercel/room-hub.mjs';

const server = createServer((_request, response) => {
  response.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('WebSocket upgrade required');
});

const sockets = new WebSocketServer({ server, maxPayload: 32 * 1024 });
sockets.on('connection', acceptRoomSocket);

export default server;

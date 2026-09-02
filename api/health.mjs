import { redis, redisIsReady } from '../scripts/vercel/redis.mjs';

export default async function health(request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.status(405).json({ ok: false, error: 'method not allowed' });
    return;
  }

  const ready = Boolean(redis) && await redisIsReady();
  response.setHeader('Cache-Control', 'no-store');
  response.status(ready ? 200 : 503).json({
    ok: ready,
    service: 'veilcore-duel',
    redis: ready,
    ...(redis ? {} : { error: 'REDIS_URL is not configured' }),
  });
}

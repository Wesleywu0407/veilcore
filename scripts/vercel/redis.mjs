import Redis from 'ioredis';

const globalRedis = globalThis;

function createRedis() {
  const url = process.env.REDIS_URL;
  if (!url) return null;

  const client = new Redis(url, {
    connectTimeout: 3000,
    maxRetriesPerRequest: 3,
    retryStrategy: attempts => Math.min(attempts * 200, 5000),
  });
  client.on('error', error => console.error('[veilcore redis]', error.message));
  return client;
}

export const redis = globalRedis.__veilcoreRedis
  ?? (globalRedis.__veilcoreRedis = createRedis());

export async function redisIsReady(timeoutMs = 2000) {
  if (!redis) return false;
  let timeout;
  try {
    return await Promise.race([
      redis.ping().then(reply => reply === 'PONG'),
      new Promise(resolve => { timeout = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

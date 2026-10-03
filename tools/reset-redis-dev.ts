/**
 * The second step of `pnpm db:reset-dev`, between the database reset (packages/db/src/cli/reset-dev.ts) and
 * the seed (tools/seed.ts): deletes FlashDrop's whole keyspace (`fd:*`) from the local development Redis.
 *
 * Every drop state in Redis belonged to the database that was just dropped. Left in place, its generations
 * would be newer than the fresh database's `redis_gen`, so `fd_rebuild` would refuse every rebuild of a
 * seeded drop as STALE (§4.7) and Redis would keep serving the old stock until the reconciler's fences had
 * caught up, one per tick. With the keys gone, the seed arms each drop from scratch.
 */
import { CoreEnv, createLogger, loadEnv, RedisEnv } from '@flashdrop/config';
import { createCommandClient } from '@flashdrop/inventory';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const SCAN_BATCH = 500;

const env = loadEnv([CoreEnv, RedisEnv]);
const logger = createLogger({ name: 'db:reset-dev', level: env.LOG_LEVEL });
const { hostname } = new URL(env.REDIS_URL);
if (env.NODE_ENV === 'production' || !LOOPBACK_HOSTS.has(hostname)) {
  throw new Error(`db:reset-dev only clears a development Redis on this machine, not ${hostname}`);
}

const redis = createCommandClient({ url: env.REDIS_URL, name: 'reset-dev', logger });
try {
  await redis.connect();
  let deleted = 0;
  for await (const keys of redis.scanIterator({ MATCH: 'fd:*', COUNT: SCAN_BATCH })) {
    if (keys.length > 0) deleted += await redis.unlink(keys);
  }
  logger.info({ deleted }, 'redis keyspace cleared');
} finally {
  await redis.close();
}

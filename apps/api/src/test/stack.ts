import { createLogger, loadEnv, RedisEnv } from '@flashdrop/config';
import { createPool, drops } from '@flashdrop/db';
import {
  connectCommandClient,
  DROP_LOCK_POOL_PROFILE,
  dropKeys,
  type FlashdropRedis,
} from '@flashdrop/inventory';
import { type AppOptions, buildApp } from '../app';
import type { Api } from '../http/api';
import { type Infrastructure, type Wired, wireServices } from '../wiring';
import { createSeededDatabase, type SeededDatabase } from './database';
import { ORIGIN, SECRET } from './fakes';

/*
 * The api over the real Compose Redis and a throwaway, seeded Postgres database, composed exactly as
 * `main.ts` composes it (`wireServices`). Redis is shared, so tests only use drops they create (fresh
 * uuids), and `close()` deletes the Redis keys of every drop created after the seed. The seed's fixed drop
 * ids are never touched in Redis: they may belong to the development stack there.
 */

export const TEST_ROUTES_SECRET = 'integration-test-routes-secret';
const logger = createLogger({ name: 'api-int', level: 'silent' });
const quiet = { warn: () => undefined };

export interface TestStack {
  readonly database: SeededDatabase;
  readonly redis: FlashdropRedis;
  readonly infra: Infrastructure;
  readonly wired: Wired;
  /** The app over `wired`, with test routes mounted and generous rate limits unless overridden. */
  build(overrides?: Partial<AppOptions>): Promise<Api>;
  close(): Promise<void>;
}

export async function createTestStack(
  now: Date = new Date(),
  options: { readonly lockTimeoutMs?: number } = {},
): Promise<TestStack> {
  const database = await createSeededDatabase(now);
  const seeded = new Set((await database.db.select({ id: drops.id }).from(drops)).map((drop) => drop.id));
  const lockPool = createPool({
    connectionString: database.url,
    logger: quiet,
    ...DROP_LOCK_POOL_PROFILE,
    max: 4,
  });
  // The tests' own Redis (vitest.config.ts), so this tree's library replaces any other copy of its version.
  const redis = await connectCommandClient({
    url: loadEnv([RedisEnv]).REDIS_URL,
    name: 'api-int',
    logger,
    library: { replaceSameVersion: true },
  });
  const infra: Infrastructure = { pool: database.pool, lockPool, redis, logger, ...options };
  const wired = wireServices(infra);
  const apps = new Set<Api>();

  return {
    database,
    redis,
    infra,
    wired,
    async build(overrides = {}) {
      const app = await buildApp({
        logger,
        roles: ['http'],
        allowedOrigins: [ORIGIN],
        sessionSecret: SECRET,
        uploadDir: database.uploadDir,
        services: wired.services,
        rateLimits: { userPerSecond: 100_000, ipPerSecond: 100_000 },
        testRoutes: { secret: TEST_ROUTES_SECRET, service: wired.testRoutes },
        ...overrides,
      });
      apps.add(app);
      // A test that closes its own app takes it off the list, so close() never closes it twice.
      app.addHook('onClose', async () => {
        apps.delete(app);
      });
      return app;
    },
    async close() {
      await Promise.all([...apps].map((app) => app.close()));
      const created = (await database.db.select({ id: drops.id }).from(drops)).filter(
        (drop) => !seeded.has(drop.id),
      );
      for (const { id } of created) {
        const k = dropKeys(id);
        await redis.del([k.inv, k.rsv, k.uq, k.exp]);
      }
      await redis.close();
      await lockPool.end();
      await database.drop();
    },
  };
}

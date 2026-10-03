import type { Logger } from '@flashdrop/config';
import { createDb, type createPool } from '@flashdrop/db';
import { createSyncNudger, type FlashdropRedis, fdRateLimitHit } from '@flashdrop/inventory';
import type { AppServices } from './app';
import { createAdminDrops } from './services/admin-drops';
import { createPostgresCatalog } from './services/catalog';
import { postgresCheck, redisCheck } from './services/health';
import { createPostgresOrders } from './services/orders';
import { createPgBreaker } from './services/pg-breaker';
import { createReservationService, createReservePorts } from './services/reserve';
import { createPostgresStockReader, createRedisStockReader } from './services/stock';
import { createTestRouteService, type TestRouteService } from './services/testing';
import { createPostgresUsers } from './services/users';

/** The connections one api process owns. */
export interface Infrastructure {
  /** `POOL_PROFILES.api`: 2 s statements, 5 s transactions (§3), so no reserve outlives the 30 s grace. */
  readonly pool: ReturnType<typeof createPool>;
  /**
   * `DROP_LOCK_POOL_PROFILE`: sessions that hold drop locks (§4.7). Separate, because a lock session
   * outlives the short transactions the locked work runs on `pool`, and its transaction_timeout would kill it.
   */
  readonly lockPool: ReturnType<typeof createPool>;
  /** The command client with the Functions library loaded (`connectCommandClient`). */
  readonly redis: FlashdropRedis;
  readonly logger: Logger;
  readonly now?: () => Date;
  /** How long admin actions wait for a busy drop before 409 `DROP_BUSY`; tests shorten it. */
  readonly lockTimeoutMs?: number;
}

export interface Wired {
  readonly services: AppServices;
  /** Mounted only with `ENABLE_TEST_ROUTES=true`. */
  readonly testRoutes: TestRouteService;
}

/** Every service over Redis and Postgres: what `main.ts` serves and what the integration tests run. */
export function wireServices(infra: Infrastructure): Wired {
  const { pool, redis, logger } = infra;
  const now = infra.now ?? (() => new Date());
  const db = createDb(pool);
  const nudger = createSyncNudger({ db, logger });
  const breaker = createPgBreaker({ probe: postgresCheck(pool), logger });
  const adminDrops = createAdminDrops({
    db,
    redis,
    logger,
    lock: { pool: infra.lockPool, logger },
    ...(infra.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: infra.lockTimeoutMs }),
  });

  return {
    services: {
      catalog: createPostgresCatalog(db),
      stock: createRedisStockReader({ redis, db, postgres: createPostgresStockReader(db), nudger, logger }),
      users: createPostgresUsers(db),
      reservations: createReservationService(createReservePorts({ db, redis, breaker, nudger }), now),
      orders: createPostgresOrders(db),
      adminDrops,
      rateLimitCounter: (key, windowMs) => fdRateLimitHit(redis, key, windowMs),
      checks: { postgres: postgresCheck(pool), redis: redisCheck(redis) },
    },
    testRoutes: createTestRouteService({ db, adminDrops }),
  };
}

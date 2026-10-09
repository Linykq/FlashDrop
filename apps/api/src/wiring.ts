import { dependencyCheck, type Logger, postgresCheck } from '@flashdrop/config';
import { createDb, type createPool, readSalesTotals } from '@flashdrop/db';
import {
  createReservationService,
  createReservePorts,
  createSyncNudger,
  type FlashdropRedis,
  fdRateLimitHit,
} from '@flashdrop/inventory';
import type { AppServices } from './app';
import { instrumentReservations, timeReserveTransaction } from './metrics';
import { createAdminCatalog } from './services/admin-catalog';
import { createAdminDashboard } from './services/admin-dashboard';
import { createAdminDrops } from './services/admin-drops';
import { createAdminHealth } from './services/admin-health';
import { createAdminListings } from './services/admin-listings';
import { createPostgresCatalog } from './services/catalog';
import { createKafkaProbe, type KafkaClient } from './services/kafka-probe';
import { createOrderService, createPostgresOrderPorts } from './services/orders';
import { createPgBreaker } from './services/pg-breaker';
import { createPostgresRoomReader, createPostgresTopicIdLookup } from './services/rooms';
import { createPostgresStockReader, createRedisStockReader } from './services/stock';
import { createTestRouteService, type TestRouteService } from './services/testing';
import { createPostgresUsers } from './services/users';
import type { RealtimeOptions } from './ws/plugin';

/** The connections one api process owns. */
export interface Infrastructure {
  /** `POOL_PROFILES.api`: 2 s statements, 5 s transactions (§3), so no reserve outlives the 30 s grace. */
  readonly pool: ReturnType<typeof createPool>;
  /**
   * `DROP_LOCK_POOL_PROFILE`: sessions that hold drop locks (§4.7). Separate, because a lock session
   * outlives the short transactions the locked work runs on `pool`, and its transaction_timeout would kill it.
   */
  readonly lockPool: ReturnType<typeof createPool>;
  /**
   * A small pool of its own for the admin health checks (`main.ts`: 2 connections), which sample every
   * tracked drop: however often admins look, they never take a connection reserve and checkout need.
   * Tests leave it out and share `pool`.
   */
  readonly adminPool?: ReturnType<typeof createPool>;
  /** The command client with the Functions library loaded (`connectCommandClient`). */
  readonly redis: FlashdropRedis;
  /** For the admin health tiles' lag and dead letters (§12); without it they show Kafka as unchecked. */
  readonly kafka?: KafkaClient;
  readonly logger: Logger;
  readonly now?: () => Date;
  /** How long admin actions wait for a busy drop before 409 `DROP_BUSY`; tests shorten it. */
  readonly lockTimeoutMs?: number;
}

export interface Wired {
  readonly services: AppServices;
  /** Mounted only with `ENABLE_TEST_ROUTES=true`. */
  readonly testRoutes: TestRouteService;
  /** The WebSocket gateway's sources, for the `ws` role. */
  readonly realtime: RealtimeOptions;
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
  const stock = createRedisStockReader({
    redis,
    db,
    postgres: createPostgresStockReader(db),
    nudger,
    logger,
  });
  const adminHealth = createAdminHealth({
    db: infra.adminPool === undefined ? db : createDb(infra.adminPool),
    redis,
    logger,
    now,
    ...(infra.kafka === undefined ? {} : { kafka: createKafkaProbe(infra.kafka) }),
  });

  return {
    services: {
      catalog: createPostgresCatalog(db),
      stock,
      users: createPostgresUsers(db),
      reservations: instrumentReservations(
        createReservationService(
          timeReserveTransaction(createReservePorts({ db, redis, breaker, nudger })),
          now,
        ),
      ),
      orders: createOrderService(createPostgresOrderPorts(db), now),
      adminDrops,
      adminCatalog: createAdminCatalog(db),
      adminDashboard: createAdminDashboard({ db, stock, health: adminHealth, now }),
      adminHealth,
      listings: createAdminListings({ db, logger }),
      rateLimitCounter: (key, windowMs) => fdRateLimitHit(redis, key, windowMs),
      checks: { postgres: postgresCheck(pool), redis: dependencyCheck('redis', () => redis.ping()) },
    },
    testRoutes: createTestRouteService({ db, adminDrops }),
    realtime: {
      redis,
      rooms: createPostgresRoomReader(db),
      topicIds: createPostgresTopicIdLookup(db),
      dashboard: { totals: (dropId) => readSalesTotals(db, dropId) },
    },
  };
}

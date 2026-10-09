import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { closeAll, createLogger, installGracefulShutdown, logUncaughtExceptions } from '@flashdrop/config';
import { createDb, createPool, outboxBacklog } from '@flashdrop/db';
import {
  connectCommandClient,
  createSyncNudger,
  DROP_LOCK_POOL_PROFILE,
  type FlashdropRedis,
} from '@flashdrop/inventory';
import { createGroupLagReader, createKafka, createPublisher } from '@flashdrop/messaging';
import { consumerConnections } from './consumers';
import { loadWorkerEnv } from './env';
import { type HealthServer, startHealthServer } from './health';
import { collectProcessMetrics, consumerGroupsOf, registerScrapeGauges, registry } from './metrics';
import { WORKER_POOL_PROFILE } from './postgres';
import { createWebRevalidator } from './revalidate';
import { type RunningRole, startRoles } from './roles';

/*
 * Shutdown is bounded by `SHUTDOWN_TIMEOUT_MS` (8 s, under Compose's 10 s grace). A consumer stops within its
 * PSP timeout (5 s): no new message starts once it stops, and the one in flight finishes. The relay stops
 * at once unless a batch is mid-send, which settles within the producer's 10 s message timeout: during a
 * Kafka outage the timer can win, and the exit code 1 says so. Nothing is lost: the batch's transaction
 * rolls back with the process.
 */

/** The loops' connections: their ticks, the reconciler, the nudger. */
const LOOP_CONNECTIONS = 10;

const env = loadWorkerEnv();
const logger = createLogger({ name: 'worker', level: env.LOG_LEVEL });

logUncaughtExceptions(logger);

const instance = `worker:${hostname()}`;
const pool = createPool({
  connectionString: env.DATABASE_URL,
  logger,
  ...WORKER_POOL_PROFILE,
  applicationName: instance,
  max: LOOP_CONNECTIONS + consumerConnections(env.WORKER_ROLES),
});
// Drop-lock sessions and the reconciler's leader session: held for a while, so not from the main pool.
const lockPool = createPool({
  connectionString: env.DATABASE_URL,
  logger,
  ...DROP_LOCK_POOL_PROFILE,
  applicationName: `${instance}:locks`,
  max: 4,
});
const db = createDb(pool);
// Nothing connects until a role uses it: the relay's producer, a consumer group, or a dead letter.
const kafka = createKafka({
  brokers: env.KAFKA_BROKERS,
  clientId: instance,
  logger: logger.child({ component: 'kafka' }),
});
const publisher = createPublisher({ kafka, logger });

// The scrape-time gauges of this process's roles (§12). The lag reader never joins a group, and its clients
// connect on the first scrape, so without Prometheus it costs nothing.
const groupIds = consumerGroupsOf(env.WORKER_ROLES);
const lagReader = groupIds.length > 0 ? createGroupLagReader(kafka) : undefined;
collectProcessMetrics();
registerScrapeGauges({
  ...(env.WORKER_ROLES.includes('relay') ? { outbox: () => outboxBacklog(db) } : {}),
  ...(lagReader === undefined ? {} : { lag: { groupIds, read: (groupId) => lagReader.read(groupId) } }),
  logger,
});

let redis: FlashdropRedis | undefined;
let roles: RunningRole[] = [];
let health: HealthServer | undefined;

/**
 * Stops the roles first (each waits for its work in flight), then closes what they used, the pools last.
 * Every failure is logged by name and makes the exit code 1; nothing stops the closes after it.
 */
async function close(): Promise<void> {
  const closed = [
    await closeAll(logger, Object.fromEntries(roles.map((role) => [`role ${role.role}`, () => role.stop()]))),
    await closeAll(logger, {
      health: async () => health?.close(),
      lagReader: async () => lagReader?.close(),
      publisher: () => publisher.close(),
      redis: async () => redis?.close(),
    }),
    await closeAll(logger, { pool: () => pool.end(), lockPool: () => lockPool.end() }),
  ];
  if (closed.includes(false)) process.exitCode = 1;
}

/** Settles once the roles have started or the start failed; never rejects. */
let startup: Promise<void> = Promise.resolve();

// A role still starting (a consumer joining its group) finishes first, so that close() stops it too.
const shutdown = installGracefulShutdown({
  logger,
  close: async () => {
    await startup;
    await close();
  },
});

startup = (async () => {
  try {
    redis = await connectCommandClient({ url: env.REDIS_URL, name: 'worker-cmd', logger });
    const deps = {
      db,
      redis,
      lock: { pool: lockPool, logger },
      nudger: createSyncNudger({ db, logger }),
      logger,
      ...(env.REVALIDATE_SECRET === undefined
        ? {}
        : {
            revalidate: createWebRevalidator({
              webUrl: env.WEB_INTERNAL_URL,
              secret: env.REVALIDATE_SECRET,
              logger,
            }),
          }),
    };
    roles = await startRoles(env.WORKER_ROLES, {
      deps,
      databaseUrl: env.DATABASE_URL,
      kafka,
      publisher,
      ...(env.PSP_API_KEY === undefined
        ? {}
        : { psp: { baseUrl: env.PAYMENT_MOCK_URL, apiKey: env.PSP_API_KEY } }),
      chaosDupDelivery: env.FD_CHAOS_DUP_DELIVERY,
      // Resolved from this entry, which sits at the same depth in the source tree (src/main.ts) as in the
      // image (dist/main.js); code inlined from packages would resolve against the bundle instead.
      listing: { ...env, fixturesDir: fileURLToPath(new URL('../../../tests/fixtures', import.meta.url)) },
    });
    health = await startHealthServer({
      host: env.HEALTH_HOST,
      port: env.HEALTH_PORT,
      source: { roles: env.WORKER_ROLES, components: () => roles.flatMap((role) => role.health()) },
      metrics: registry,
      logger,
    });
    logger.info({ roles: env.WORKER_ROLES }, 'worker ready');
  } catch (err) {
    logger.fatal({ err }, 'worker failed to start');
    process.exitCode = 1;
    // Not awaited: the shutdown waits for this start to settle, then closes what it opened.
    void shutdown('startup failed');
  }
})();

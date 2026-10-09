import { hostname } from 'node:os';
import { createLogger } from '@flashdrop/config';
import { createDb, createPool } from '@flashdrop/db';
import {
  connectCommandClient,
  createSyncNudger,
  DROP_LOCK_POOL_PROFILE,
  type FlashdropRedis,
} from '@flashdrop/inventory';
import { createKafka, createPublisher } from '@flashdrop/messaging';
import { consumerConnections } from './consumers';
import { loadWorkerEnv } from './env';
import { type HealthServer, startHealthServer } from './health';
import { WORKER_POOL_PROFILE } from './postgres';
import { type RunningRole, startRoles } from './roles';

/**
 * Below Compose's 10 s stop grace period, so a stuck shutdown still exits with our own log line. A consumer
 * stops within its PSP timeout (5 s): no new message starts once it stops, and the one in flight finishes.
 * The relay stops at once unless a batch is mid-send, which settles within the producer's 10 s message
 * timeout: during a Kafka outage the timer can win, and the exit code 1 says so. Nothing is lost: the
 * batch's transaction rolls back with the process.
 */
const SHUTDOWN_TIMEOUT_MS = 8_000;

/** The loops' connections: their ticks, the reconciler, the nudger. */
const LOOP_CONNECTIONS = 10;

const env = loadWorkerEnv();
const logger = createLogger({ name: 'worker', level: env.LOG_LEVEL });

// Logged synchronously before Node prints the crash, so it reaches the JSON logs with context.
process.on('uncaughtExceptionMonitor', (err, origin) => logger.fatal({ err, origin }, 'uncaught exception'));

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

let redis: FlashdropRedis | undefined;
let roles: RunningRole[] = [];
let health: HealthServer | undefined;

/** Stops the roles first (each waits for its work in flight), then closes what they used. */
async function close(): Promise<void> {
  await Promise.all(roles.map((role) => role.stop()));
  await health?.close();
  await publisher.close();
  await redis?.close();
  await Promise.all([pool.end(), lockPool.end()]);
}

let closing = false;
/** Settles once the roles have started or the start failed (and cleaned up); never rejects. */
let startup: Promise<void> = Promise.resolve();

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (closing) return;
  closing = true;
  logger.info({ signal }, 'shutting down');
  const timer = setTimeout(() => {
    logger.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'shutdown timed out');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  timer.unref();
  try {
    // A role still starting (a consumer joining its group) finishes first, so that close() stops it too.
    await startup;
    await close();
  } catch (err) {
    logger.error({ err }, 'shutdown failed');
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
  }
}
process.once('SIGTERM', (signal) => void shutdown(signal));
process.once('SIGINT', (signal) => void shutdown(signal));

startup = (async () => {
  try {
    redis = await connectCommandClient({ url: env.REDIS_URL, name: 'worker-cmd', logger });
    const deps = {
      db,
      redis,
      lock: { pool: lockPool, logger },
      nudger: createSyncNudger({ db, logger }),
      logger,
    };
    roles = await startRoles(env.WORKER_ROLES, {
      deps,
      databaseUrl: env.DATABASE_URL,
      kafka,
      publisher,
      paymentMockUrl: env.PAYMENT_MOCK_URL,
    });
    health = await startHealthServer({
      host: env.HEALTH_HOST,
      port: env.HEALTH_PORT,
      source: { roles: env.WORKER_ROLES, components: () => roles.flatMap((role) => role.health()) },
      logger,
    });
    logger.info({ roles: env.WORKER_ROLES }, 'worker ready');
  } catch (err) {
    logger.fatal({ err }, 'worker failed to start');
    process.exitCode = 1;
    // A shutdown already waiting on this start closes everything itself.
    if (closing) return;
    closing = true;
    await close().catch((closeErr: unknown) =>
      logger.error({ err: closeErr }, 'cleanup after a failed start failed'),
    );
  }
})();

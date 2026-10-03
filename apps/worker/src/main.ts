import { hostname } from 'node:os';
import { createLogger } from '@flashdrop/config';
import { createDb, createPool } from '@flashdrop/db';
import {
  connectCommandClient,
  createSyncNudger,
  DROP_LOCK_POOL_PROFILE,
  type FlashdropRedis,
} from '@flashdrop/inventory';
import { loadWorkerEnv } from './env';
import { type HealthServer, startHealthServer } from './health';
import { WORKER_POOL_PROFILE } from './postgres';
import { type RunningRole, startRoles } from './roles';

/** Below Compose's 10 s stop grace period, so a stuck shutdown still exits with our own log line. */
const SHUTDOWN_TIMEOUT_MS = 8_000;

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
  max: 10,
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

let redis: FlashdropRedis | undefined;
let roles: RunningRole[] = [];
let health: HealthServer | undefined;

/** Stops the loops first (each waits for its tick in flight), then closes what they used. */
async function close(): Promise<void> {
  await Promise.all(roles.map((role) => role.stop()));
  await health?.close();
  await redis?.close();
  await Promise.all([pool.end(), lockPool.end()]);
}

let closing = false;
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

try {
  redis = await connectCommandClient({ url: env.REDIS_URL, name: 'worker-cmd', logger });
  const deps = {
    db,
    redis,
    lock: { pool: lockPool, logger },
    nudger: createSyncNudger({ db, logger }),
    logger,
  };
  roles = startRoles(env.WORKER_ROLES, { deps, databaseUrl: env.DATABASE_URL });
  health = await startHealthServer({
    host: env.HEALTH_HOST,
    port: env.HEALTH_PORT,
    source: {
      roles: env.WORKER_ROLES,
      loops: () => roles.flatMap((role) => role.loops.map((l) => l.health())),
    },
    logger,
  });
  logger.info({ roles: env.WORKER_ROLES }, 'worker ready');
} catch (err) {
  logger.fatal({ err }, 'worker failed to start');
  process.exitCode = 1;
  closing = true;
  await close();
}

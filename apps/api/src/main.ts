import { hostname } from 'node:os';
import { createLogger } from '@flashdrop/config';
import { createDb, createPool, POOL_PROFILES } from '@flashdrop/db';
import { buildApp } from './app';
import { loadApiEnv } from './env';
import { createPostgresCatalog } from './services/catalog';
import { postgresCheck } from './services/health';
import { createPostgresStockReader } from './services/stock';
import { createPostgresUsers } from './services/users';

/** Below Compose's 10 s stop grace period, so a stuck shutdown still exits with our own log line. */
const SHUTDOWN_TIMEOUT_MS = 8_000;

const env = loadApiEnv();
const logger = createLogger({ name: 'api', level: env.LOG_LEVEL });

// Logged synchronously before Node prints the crash, so it reaches the JSON logs with context.
process.on('uncaughtExceptionMonitor', (err, origin) => logger.fatal({ err, origin }, 'uncaught exception'));

const pool = createPool({
  connectionString: env.DATABASE_URL,
  logger,
  ...POOL_PROFILES.api,
  applicationName: `api:${hostname()}`,
});
const db = createDb(pool);

const app = await buildApp({
  logger,
  roles: env.API_ROLES,
  allowedOrigins: env.WS_ALLOWED_ORIGINS,
  sessionSecret: env.SESSION_SECRET,
  uploadDir: env.UPLOAD_DIR,
  services: {
    catalog: createPostgresCatalog(db),
    stock: createPostgresStockReader(db),
    users: createPostgresUsers(db),
    checks: { postgres: postgresCheck(pool) },
  },
});
// After the server has stopped and in-flight requests have finished, so none loses its connection.
app.addHook('onClose', () => pool.end());

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
    // Stops accepting connections, answers 503 on kept-alive ones, waits for in-flight requests.
    await app.close();
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
  await app.listen({ host: env.HOST, port: env.PORT });
  logger.info({ roles: env.API_ROLES }, 'api ready');
} catch (err) {
  logger.fatal({ err }, 'api failed to start');
  process.exitCode = 1;
  await app.close();
}

import { hostname } from 'node:os';
import { createLogger } from '@flashdrop/config';
import { createPool, POOL_PROFILES } from '@flashdrop/db';
import { connectCommandClient, DROP_LOCK_POOL_PROFILE } from '@flashdrop/inventory';
import { buildApp } from './app';
import { loadApiEnv } from './env';
import { wireServices } from './wiring';

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
const lockPool = createPool({
  connectionString: env.DATABASE_URL,
  logger,
  ...DROP_LOCK_POOL_PROFILE,
  max: 4,
  applicationName: `api-lock:${hostname()}`,
});
// Loads the Functions library (FUNCTION LOAD REPLACE); every call reloads it if Redis lost it (§4.2).
const redis = await connectCommandClient({ url: env.REDIS_URL, name: `api-cmd:${hostname()}`, logger });
const { services, testRoutes } = wireServices({ pool, lockPool, redis, logger });

const app = await buildApp({
  logger,
  roles: env.API_ROLES,
  allowedOrigins: env.WS_ALLOWED_ORIGINS,
  sessionSecret: env.SESSION_SECRET,
  uploadDir: env.UPLOAD_DIR,
  services,
  rateLimits: { userPerSecond: env.RATE_LIMIT_USER_PER_SEC, ipPerSecond: env.RATE_LIMIT_IP_PER_SEC },
  // TestingEnv requires the secret whenever the routes are enabled.
  ...(env.ENABLE_TEST_ROUTES && env.TEST_ROUTES_SECRET !== undefined
    ? { testRoutes: { secret: env.TEST_ROUTES_SECRET, service: testRoutes } }
    : {}),
});
// After the server has stopped and in-flight requests have finished, so none loses its connection.
app.addHook('onClose', async () => {
  await Promise.allSettled([pool.end(), lockPool.end(), redis.close()]);
});

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
  logger.info({ roles: env.API_ROLES, testRoutes: env.ENABLE_TEST_ROUTES }, 'api ready');
} catch (err) {
  logger.fatal({ err }, 'api failed to start');
  process.exitCode = 1;
  await app.close();
}

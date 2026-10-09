import { hostname } from 'node:os';
import { closeAll, createLogger, installGracefulShutdown, logUncaughtExceptions } from '@flashdrop/config';
import { createPool, POOL_PROFILES } from '@flashdrop/db';
import { connectCommandClient, DROP_LOCK_POOL_PROFILE } from '@flashdrop/inventory';
import { createKafka } from '@flashdrop/messaging';
import { buildApp } from './app';
import { loadApiEnv } from './env';
import { collectProcessMetrics } from './metrics';
import { wireServices } from './wiring';

const env = loadApiEnv();
const logger = createLogger({ name: 'api', level: env.LOG_LEVEL });

logUncaughtExceptions(logger);
collectProcessMetrics();

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
// The admin health checks' own (`Infrastructure.adminPool`): its samples never queue behind a burst's.
const adminPool = createPool({
  connectionString: env.DATABASE_URL,
  logger,
  ...POOL_PROFILES.api,
  max: 2,
  applicationName: `api-admin:${hostname()}`,
});
// Loads the Functions library (FUNCTION LOAD REPLACE); every call reloads it if Redis lost it (§4.2).
const redis = await connectCommandClient({ url: env.REDIS_URL, name: `api-cmd:${hostname()}`, logger });
// Nothing connects until the admin health page first reads consumer lag.
const kafka = createKafka({
  brokers: env.KAFKA_BROKERS,
  clientId: `api:${hostname()}`,
  logger: logger.child({ component: 'kafka' }),
});
const { services, testRoutes, realtime } = wireServices({ pool, lockPool, adminPool, redis, kafka, logger });

const app = await buildApp({
  logger,
  roles: env.API_ROLES,
  allowedOrigins: env.WS_ALLOWED_ORIGINS,
  sessionSecret: env.SESSION_SECRET,
  cookieSecure: env.COOKIE_SECURE,
  devLogin: env.ENABLE_DEV_LOGIN,
  trustProxy: env.TRUST_PROXY,
  uploadDir: env.UPLOAD_DIR,
  services,
  realtime: { ...realtime, maxSocketsPerAddress: env.WS_MAX_SOCKETS_PER_IP },
  rateLimits: { userPerSecond: env.RATE_LIMIT_USER_PER_SEC, ipPerSecond: env.RATE_LIMIT_IP_PER_SEC },
  // TestingEnv requires the secret whenever the routes are enabled.
  ...(env.ENABLE_TEST_ROUTES && env.TEST_ROUTES_SECRET !== undefined
    ? { testRoutes: { secret: env.TEST_ROUTES_SECRET, service: testRoutes } }
    : {}),
});
// After the server has stopped and in-flight requests have finished, so none loses its connection.
app.addHook('onClose', async () => {
  const closed = await closeAll(logger, {
    pool: () => pool.end(),
    lockPool: () => lockPool.end(),
    adminPool: () => adminPool.end(),
    redis: () => redis.close(),
    adminHealth: () => services.adminHealth.close(),
  });
  if (!closed) process.exitCode = 1;
});

// Stops accepting connections, answers 503 on kept-alive ones, waits for in-flight requests, then onClose.
const shutdown = installGracefulShutdown({ logger, close: () => app.close() });

try {
  await app.listen({ host: env.HOST, port: env.PORT });
  if (env.ENABLE_DEV_LOGIN) {
    logger.warn(
      { allowedOrigins: env.WS_ALLOWED_ORIGINS },
      'dev login is on: anyone who reaches this api can sign in as any seeded account, the admin included',
    );
  }
  logger.info(
    { roles: env.API_ROLES, testRoutes: env.ENABLE_TEST_ROUTES, devLogin: env.ENABLE_DEV_LOGIN },
    'api ready',
  );
} catch (err) {
  logger.fatal({ err }, 'api failed to start');
  process.exitCode = 1;
  await shutdown('startup failed');
}

import { hostname } from 'node:os';
import {
  createLogger,
  installGracefulShutdown,
  logUncaughtExceptions,
  postgresCheck,
} from '@flashdrop/config';
import { createDb, createPool } from '@flashdrop/db';
import { buildApp } from './app';
import { loadPaymentMockEnv } from './env';
import { createLedger } from './ledger';
import { collectProcessMetrics } from './metrics';
import { PSP_POOL_PROFILE } from './postgres';
import { createSimulation } from './simulation';

const env = loadPaymentMockEnv();
const logger = createLogger({ name: 'payment-mock', level: env.LOG_LEVEL });

logUncaughtExceptions(logger);
collectProcessMetrics();

const pool = createPool({
  connectionString: env.PSP_DATABASE_URL,
  logger,
  ...PSP_POOL_PROFILE,
  applicationName: `payment-mock:${hostname()}`,
});
const simulation = createSimulation({
  latency: env.PSP_LATENCY_MS,
  errorRate: env.PSP_ERROR_RATE,
  timeoutAfterSuccessRate: env.PSP_TIMEOUT_AFTER_SUCCESS_RATE,
});
const app = await buildApp({
  logger,
  apiKey: env.PSP_API_KEY,
  ledger: createLedger(createDb(pool)),
  simulation,
  checks: { postgres: postgresCheck(pool) },
});
// After the server has stopped and in-flight requests have finished, so none loses its connection.
app.addHook('onClose', async () => {
  await pool.end();
});

const shutdown = installGracefulShutdown({ logger, close: () => app.close() });

try {
  await app.listen({ host: env.HOST, port: env.PORT });
  logger.info(
    {
      latencyMs: env.PSP_LATENCY_MS,
      errorRate: env.PSP_ERROR_RATE,
      timeoutAfterSuccessRate: env.PSP_TIMEOUT_AFTER_SUCCESS_RATE,
    },
    'payment-mock ready',
  );
} catch (err) {
  logger.fatal({ err }, 'payment-mock failed to start');
  process.exitCode = 1;
  await shutdown('startup failed');
}

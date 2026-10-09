import { hostname } from 'node:os';
import { createLogger } from '@flashdrop/config';
import { createDb, createPool } from '@flashdrop/db';
import { buildApp } from './app';
import { loadPaymentMockEnv } from './env';
import { createLedger } from './ledger';
import { PSP_POOL_PROFILE, postgresCheck } from './postgres';
import { createSimulation } from './simulation';

/** Below Compose's 10 s stop grace period, so a stuck shutdown still exits with our own log line. */
const SHUTDOWN_TIMEOUT_MS = 8_000;

const env = loadPaymentMockEnv();
const logger = createLogger({ name: 'payment-mock', level: env.LOG_LEVEL });

process.on('uncaughtExceptionMonitor', (err, origin) => logger.fatal({ err, origin }, 'uncaught exception'));

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
  ledger: createLedger(createDb(pool)),
  simulation,
  checks: { postgres: postgresCheck(pool) },
});
// After the server has stopped and in-flight requests have finished, so none loses its connection.
app.addHook('onClose', async () => {
  await pool.end();
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
  await app.close();
}

import { parseArgs } from 'node:util';
import {
  CoreEnv,
  createLogger,
  KafkaEnv,
  loadEnv,
  PostgresEnv,
  RedisEnv,
  WorkerEnv,
} from '@flashdrop/config';
import { createDb, createPool } from '@flashdrop/db';
import { connectCommandClient, createSyncNudger } from '@flashdrop/inventory';
import { createKafka, replayDlq } from '@flashdrop/messaging';
import { type ConsumerName, consumerRegistry } from './consumers';
import { createPspClient } from './consumers/psp-client';
import { WORKER_POOL_PROFILE } from './postgres';

/*
 * `pnpm dlq:replay` (design §6.4): runs the handler named in each dead letter's `x-consumer` header
 * directly, with the same idempotency checks as its first delivery. It never re-produces to `orders.v1`,
 * which would re-feed every group. It stops at the first letter that fails again and exits 1, naming its
 * offset, so the operator fixes the cause and replays from there (`--from-offset`).
 *
 *   pnpm dlq:replay [--only payment|settlement] [--from-offset N] [--dry-run]
 *
 * Against the Compose stack that runs this file's bundle as a one-off of the consumers service, inside the
 * stack's network, because payment-mock publishes no host port: a payment letter (a close) replayed from the
 * host could never reach the PSP. `pnpm dlq:replay:dev` runs the source with tsx against the `pnpm dev`
 * processes, whose payment-mock listens on 127.0.0.1:4100 (`PAYMENT_MOCK_URL` in .env).
 */

const CONSUMER_NAMES: readonly ConsumerName[] = ['payment', 'settlement'];

const { values: args } = parseArgs({
  options: {
    only: { type: 'string' },
    'from-offset': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
  strict: true,
});
const only = args.only;
if (only !== undefined && !CONSUMER_NAMES.includes(only as ConsumerName)) {
  throw new Error(`--only must be one of ${CONSUMER_NAMES.join(', ')}`);
}
const fromOffset = args['from-offset'];
if (fromOffset !== undefined && !/^\d+$/.test(fromOffset)) throw new Error('--from-offset must be an offset');

const env = loadEnv([CoreEnv, PostgresEnv, RedisEnv, KafkaEnv, WorkerEnv.pick({ PAYMENT_MOCK_URL: true })]);
const logger = createLogger({ name: 'dlq-replay', level: env.LOG_LEVEL });
const pool = createPool({
  connectionString: env.DATABASE_URL,
  logger,
  ...WORKER_POOL_PROFILE,
  applicationName: 'worker:dlq-replay',
  max: 4,
});
const db = createDb(pool);
const redis = await connectCommandClient({ url: env.REDIS_URL, name: 'dlq-replay', logger });

try {
  const report = await replayDlq({
    kafka: createKafka({ brokers: env.KAFKA_BROKERS, clientId: 'dlq-replay', logger }),
    consumers: consumerRegistry({
      db,
      redis,
      nudger: createSyncNudger({ db, logger }),
      logger,
      psp: createPspClient({ baseUrl: env.PAYMENT_MOCK_URL }),
    }),
    logger,
    only,
    fromOffset,
    dryRun: args['dry-run'],
  });
  logger.info(
    {
      replayed: report.replayed.length,
      unhandled: report.unhandled.length,
      invalid: report.invalid,
      skipped: report.skipped,
      failed: report.failed ?? null,
    },
    report.failed === undefined ? 'dlq replay finished' : 'dlq replay stopped at a failing letter',
  );
  if (report.failed !== undefined) process.exitCode = 1;
} finally {
  await redis.close();
  await pool.end();
}

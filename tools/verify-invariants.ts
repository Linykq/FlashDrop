/**
 * `pnpm verify:invariants` (design §1.1, §13): waits until the system is quiescent (outbox drained, consumer
 * lag 0, no due orders, no unsettled terminal orders, no money in flight), then checks INV-1 to INV-9 across
 * Postgres, the PSP ledger, Redis and Kafka for every tracked drop, prints the outcome and writes it as JSON.
 * CI runs it after the E2E specs, the k6 load-smoke run, the system tests and the nightly chaos runs; a
 * non-zero exit fails the job.
 *
 *   pnpm verify:invariants                         every tracked drop (§4.1)
 *   pnpm verify:invariants --drop <id> [--drop]    only these drops (the event pipeline is always global)
 *   pnpm verify:invariants --timeout <seconds>     how long to wait for quiescence (default 60)
 *   pnpm verify:invariants --out <file>            the JSON report (default invariants-report.json)
 *   pnpm verify:invariants --max-dead-letters <n>  INV-5 fails when orders.v1.dlq holds more than n records;
 *                                                  unset, they are only reported (the topic keeps 30 days of
 *                                                  every run; CI, on a fresh broker, passes 0)
 *
 * v2 (M3/M4) adds INV-4 (the PSP ledger against orders and payments) and INV-5 (the outbox drained and the
 * payment, inventory-settlement and sales-dashboard groups at the log end; from M7 also each drop's dashboard
 * totals equal to its orders, §9). Exit codes: 0 every check passed, 1 a breach or no quiescence, 2 the
 * check could not run.
 */
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { KafkaEnv, loadEnv, PostgresEnv, RedisEnv } from '@flashdrop/config';
import { createDb, createPool } from '@flashdrop/db';
import { createCommandClient } from '@flashdrop/inventory';
import { createGroupLagReader, createKafka } from '@flashdrop/messaging';
import { z } from 'zod';
import { createEventsProbe, SAMPLE_TIMEOUT_MS, withDeadline } from './event-samples';
import { type InvariantsReport, verifyInvariants } from './invariant-samples';

const CONNECT_TIMEOUT_MS = 10_000;
const MAX_LISTED_VIOLATIONS = 25;

const Args = z.object({
  drop: z.array(z.uuid({ error: '--drop must be a drop id (uuid)' })).optional(),
  timeout: z
    .string()
    .regex(/^\d+$/, '--timeout must be whole seconds')
    .transform(Number)
    .pipe(z.int().max(3_600, '--timeout must be at most 3600 seconds'))
    .default(60),
  out: z.string().min(1).default('invariants-report.json'),
  'max-dead-letters': z
    .string()
    .regex(/^\d+$/, '--max-dead-letters must be a whole number')
    .transform(Number)
    .pipe(z.int())
    .optional(),
});

const { values } = parseArgs({
  options: {
    drop: { type: 'string', multiple: true },
    timeout: { type: 'string' },
    out: { type: 'string' },
    'max-dead-letters': { type: 'string' },
  },
});
const parsedArgs = Args.safeParse(values);
if (!parsedArgs.success) {
  console.error(z.prettifyError(parsedArgs.error));
  process.exit(2);
}
const args = parsedArgs.data;
// pnpm runs scripts from the repo root; resolve --out against the directory the command was typed in.
const reportPath = resolve(process.env.INIT_CWD ?? process.cwd(), args.out);

// Like `node --env-file`, variables already set win. Without a .env the local Compose defaults apply.
if (existsSync('.env')) process.loadEnvFile('.env');
const env = loadEnv([PostgresEnv, RedisEnv, KafkaEnv]);
const warn = { warn: (...details: unknown[]) => console.error('warning:', ...details) };

const pool = createPool({
  connectionString: env.DATABASE_URL,
  logger: warn,
  // Reads only, but a large drop's snapshot may take a while; nothing here holds a lock anyone waits on.
  settings: { statement_timeout: '30s' },
  connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  applicationName: 'verify-invariants',
  max: 2,
});
// A plain command client: it never loads the Functions library, so verifying writes nothing to Redis.
const redis = createCommandClient({ url: env.REDIS_URL, name: 'verify-invariants', logger: warn });
const kafka = createKafka({ brokers: env.KAFKA_BROKERS, clientId: 'verify-invariants', logLevel: 'error' });
const admin = kafka.admin();
const lag = createGroupLagReader(kafka, { timeoutMs: SAMPLE_TIMEOUT_MS });

try {
  // node-redis and librdkafka keep reconnecting while their server is down, so bound the first connection.
  await withDeadline(redis.connect(), CONNECT_TIMEOUT_MS, `Redis at ${env.REDIS_URL} did not answer`);
  await withDeadline(
    admin.connect(),
    CONNECT_TIMEOUT_MS,
    `Kafka at ${env.KAFKA_BROKERS.join(',')} did not answer`,
  );
  const db = createDb(pool);
  const report = await verifyInvariants(
    { db, redis, events: createEventsProbe({ db, admin, lag }) },
    {
      dropIds: args.drop?.map((id) => id.toLowerCase()),
      timeoutMs: args.timeout * 1000,
      maxDeadLetters: args['max-dead-letters'],
    },
  );
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(formatReport(report));
  console.log(`\nReport: ${reportPath}`);
  process.exitCode = report.ok ? 0 : 1;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  await writeFile(reportPath, `${JSON.stringify({ version: 2, ok: false, error: message }, null, 2)}\n`);
  console.error(`verify:invariants could not run: ${message}`);
  if (error instanceof Error && error.cause !== undefined) console.error(error.cause);
  process.exitCode = 2;
} finally {
  redis.destroy();
  // Also after a failed connect: librdkafka would otherwise keep retrying the broker and hold the process open.
  await admin.disconnect().catch(() => undefined);
  await lag.close();
  await pool.end();
}

function formatReport(report: InvariantsReport): string {
  const { quiescence, events } = report;
  const scope =
    report.scope.mode === 'tracked'
      ? `${report.drops.length} tracked drop${report.drops.length === 1 ? '' : 's'}`
      : `${report.drops.length} selected drop${report.drops.length === 1 ? '' : 's'}`;
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  const lines = [
    `verify:invariants v2: ${scope}`,
    '',
    quiescence.reached
      ? `Quiescent after ${seconds(quiescence.waitedMs)}`
      : `NOT quiescent after ${seconds(quiescence.waitedMs)} (--timeout ${seconds(quiescence.timeoutMs)})`,
    ...quiescence.checks.map((check) => `  ${label(check.status)}${check.name}${detail(check.detail)}`),
    '',
    'Invariants',
    ...report.invariants.map((result) => {
      const count = result.violations.length > 0 ? ` (${result.violations.length})` : '';
      return `  ${label(result.status)}${result.id}  ${result.title}${count}${detail(result.reason)}`;
    }),
  ];

  if (events !== null) {
    lines.push(
      '',
      'Events',
      `  outbox: ${events.outbox.pending} unpublished` +
        (events.outbox.oldestSeconds === null ? '' : `, oldest ${events.outbox.oldestSeconds.toFixed(1)} s`),
      ...events.groups.map((group) => `  ${group.name} (group ${group.groupId}): lag ${group.lag}`),
      `  dead letters in the DLQ topic: ${events.deadLetters ?? 'not counted'}` +
        (events.maxDeadLetters === null ? '' : ` (at most ${events.maxDeadLetters} allowed)`),
    );
  }

  if (report.drops.length > 0) {
    lines.push('', 'Drops');
    for (const drop of report.drops) {
      const { postgres: pg, redis: r, ledger } = drop;
      const redisSide =
        r === null
          ? drop.tracked
            ? 'Redis: none'
            : 'Redis: not checked (untracked)'
          : `Redis ${r.status} avail ${r.avail} held ${r.held} sold ${r.sold} gen ${r.gen} seq ${r.seq}`;
      const counts = (record: Readonly<Record<string, number>>) =>
        Object.entries(record)
          .map(([status, count]) => `${count} ${status}`)
          .join(', ');
      lines.push(
        `  ${drop.dropId}  ${drop.status}${drop.idle ? '' : ' (not idle)'}`,
        `    Postgres total ${pg.total} avail ${pg.available} reserved ${pg.reserved} sold ${pg.sold} gen ${pg.redisGen}; ${redisSide}`,
        `    orders: ${counts(pg.orders) || 'none'}`,
        `    PSP charges: ${counts(ledger.charges) || 'none'}; captured ${ledger.capturedCents}, refunded ${ledger.refundedCents} cents`,
      );
      const { dashboard } = drop;
      if (dashboard !== null) {
        const t = dashboard.totals;
        lines.push(
          `    dashboard: reserved ${t.reserved}, placed ${t.placed}, paid ${t.paid}, failed ${t.failed}, ` +
            `expired ${t.expired}, cancelled ${t.cancelled}, rejected ${t.rejected}; ` +
            `${t.unitsSold} units, ${t.revenueCents} cents` +
            (dashboard.eventless === 0 ? '' : `; ${dashboard.eventless} orders without events left out`) +
            (dashboard.skipped === undefined ? '' : `; not compared: ${dashboard.skipped}`),
        );
      }
    }
  }

  const violations = report.invariants.flatMap((result) => result.violations);
  if (violations.length > 0) {
    const shown = violations.slice(0, MAX_LISTED_VIOLATIONS);
    const more = violations.length > shown.length ? ` (first ${shown.length}; all in the report)` : '';
    lines.push('', `Violations: ${violations.length}${more}`);
    for (const violation of shown) {
      const where = violation.dropId === undefined ? 'events' : `drop ${violation.dropId}`;
      const order = violation.orderId === undefined ? '' : ` order ${violation.orderId}`;
      lines.push(`  ${violation.invariant}  ${where}${order}: ${violation.message}`);
    }
  }
  lines.push('', report.ok ? 'RESULT: PASS' : 'RESULT: FAIL');
  return lines.join('\n');
}

function label(status: 'pass' | 'fail' | 'skipped'): string {
  return { pass: 'PASS     ', fail: 'FAIL     ', skipped: 'SKIPPED  ' }[status];
}

function detail(text: string | undefined): string {
  return text === undefined ? '' : `: ${text}`;
}

/**
 * `pnpm dash:rebuild` (design §9): wipes the sales dashboard projection and replays `orders.v1` into it from
 * the earliest offset. The consumer is idempotent and buckets by event time, so the dashboard converges to
 * the same totals and minutes: a live demonstration of a replayable consumer. Kafka keeps 7 days; a topic
 * that has already lost its oldest events is refused (see --accept-history-loss).
 *
 * Procedure:
 *   1. Stop the sales-dashboard consumers, a Compose service of their own, so payments and settlement run on:
 *        docker compose --profile app stop dashboard-consumers
 *   2. pnpm dash:rebuild. It refuses while the group has a member, or when retention has deleted the start of
 *      a partition; otherwise it deletes the group's committed offsets (its consumers then start at the
 *      earliest offset, §6.4), zeroes the projection in one transaction (`processed_events` of
 *      sales-dashboard, `sales_minute`, `drop_sales_totals` at version + 1, so open dashboards accept what
 *      follows) and publishes the zeroed totals.
 *   3. Start the consumers again:
 *        docker compose --profile app start dashboard-consumers
 *   4. pnpm verify:invariants: INV-5 compares every tracked drop's dashboard with its orders.
 *
 *   pnpm dash:rebuild --compose                 runs steps 1 and 3 itself (also when step 2 fails)
 *   pnpm dash:rebuild --compose --wait [--timeout <s>]
 *                                               first lets the group catch up, so the totals before the wipe
 *                                               hold every event already in the topic; then, after the
 *                                               rebuild, waits until the group has caught up again (each
 *                                               wait at most --timeout, default 120 s) and compares every
 *                                               drop's totals with the ones before the wipe
 *   pnpm dash:rebuild --accept-history-loss     rebuilds from what retention left (the lost totals stay lost)
 *
 * A drop whose totals changed across the rebuild (orders placed meanwhile, or events the group had not
 * reached when it stopped) is judged by INV-5 instead: its replayed projection must equal its orders.
 *
 * Exit codes: 0 rebuilt (and, with --wait, every drop identical or equal to its orders); 1 consumers were
 * running, history was lost, the group did not catch up, or a replayed drop disagrees with its orders;
 * 2 could not run.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs, promisify } from 'node:util';
import { CONSUMER_GROUPS, KafkaEnv, loadEnv, PostgresEnv, RedisEnv } from '@flashdrop/config';
import type { DashboardTotalsMessage } from '@flashdrop/contracts';
import { createDb, createPool, POOL_PROFILES, readAllSalesTotals, readDashboardCheck } from '@flashdrop/db';
import { createCommandClient, dashboardChannel, REDIS_DEADLINE_MS, withDeadline } from '@flashdrop/inventory';
import { createKafka, fetchGroupLag } from '@flashdrop/messaging';
import { z } from 'zod';
import {
  ConsumersRunningError,
  HistoryLostError,
  judgeReplay,
  type ReplayJudgement,
  rebuildDashboardProjection,
  totalsDifferences,
} from './dashboard-rebuild';
import { withDeadline as bounded } from './event-samples';

const CONNECT_TIMEOUT_MS = 10_000;
/** The Compose service that runs only the sales-dashboard group (compose.yaml). */
const DASHBOARD_SERVICE = 'dashboard-consumers';
const exec = promisify(execFile);

const Args = z.object({
  compose: z.boolean(),
  wait: z.boolean(),
  'accept-history-loss': z.boolean(),
  timeout: z
    .string()
    .regex(/^\d+$/, '--timeout must be whole seconds')
    .transform(Number)
    .pipe(z.int().min(1).max(3_600, '--timeout must be at most 3600 seconds'))
    .default(120),
});
const { values } = parseArgs({
  options: {
    compose: { type: 'boolean', default: false },
    wait: { type: 'boolean', default: false },
    'accept-history-loss': { type: 'boolean', default: false },
    timeout: { type: 'string' },
  },
});
const parsed = Args.safeParse(values);
if (!parsed.success) {
  console.error(z.prettifyError(parsed.error));
  process.exit(2);
}
const args = parsed.data;
const timeoutMs = args.timeout * 1000;

// Like `node --env-file`, variables already set win. Without a .env the local Compose defaults apply.
if (existsSync('.env')) process.loadEnvFile('.env');
const env = loadEnv([PostgresEnv, RedisEnv, KafkaEnv]);
const warn = { warn: (...details: unknown[]) => console.error('warning:', ...details) };

const pool = createPool({
  connectionString: env.DATABASE_URL,
  logger: warn,
  ...POOL_PROFILES.maintenance,
  applicationName: 'dash-rebuild',
  max: 2,
});
const db = createDb(pool);
// A plain command client: publishing needs no Functions library.
const redis = createCommandClient({ url: env.REDIS_URL, name: 'dash-rebuild', logger: warn });
const admin = createKafka({
  brokers: env.KAFKA_BROKERS,
  clientId: 'dash-rebuild',
  logLevel: 'error',
}).admin();

/** `docker compose --profile app <args>` with this environment, so `COMPOSE_FILE` (CI's overrides) applies. */
async function compose(...composeArgs: string[]): Promise<void> {
  console.log(`docker compose --profile app ${composeArgs.join(' ')}`);
  await exec('docker', ['compose', '--profile', 'app', ...composeArgs], { env: process.env });
}

/** Polls the group's lag until it is 0 everywhere, or the deadline passes; true when it caught up. */
async function caughtUp(what: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lag = await fetchGroupLag(admin, CONSUMER_GROUPS.dashboard);
    const behind = lag.reduce((sum, partition) => sum + partition.lag, 0);
    if (behind === 0) return true;
    if (Date.now() >= deadline) return false;
    console.log(`  ${what}: ${behind} events to go`);
    await sleep(1_000);
  }
}

/**
 * INV-5 on the drops whose totals changed, until every one agrees with its orders or the timeout passes: an
 * order still on its way through the outbox and the group disagrees for a moment.
 */
async function judgeChanged(dropIds: readonly string[]): Promise<ReplayJudgement> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const checks = new Map(
      await Promise.all(dropIds.map(async (id) => [id, await readDashboardCheck(db, id)] as const)),
    );
    const judgement = judgeReplay(checks);
    if (judgement.disagree.size === 0 || Date.now() >= deadline) return judgement;
    await sleep(1_000);
  }
}

/**
 * Steps 1 to 3. Resolves with every drop's totals before the wipe, read while the consumers are stopped so
 * that nothing folds an event between the read and the wipe (were one still running, the rebuild refuses
 * before changing anything); or with null when the rebuild refused.
 */
async function rebuild(): Promise<ReadonlyMap<string, DashboardTotalsMessage> | null> {
  if (args.compose) await compose('stop', DASHBOARD_SERVICE);
  try {
    const before = await readAllSalesTotals(db);
    const zeroed = await rebuildDashboardProjection({
      db,
      admin,
      acceptHistoryLoss: args['accept-history-loss'],
      async publish(dropId, message) {
        try {
          await withDeadline('dashboard publish', REDIS_DEADLINE_MS, () =>
            redis.publish(dashboardChannel(dropId), JSON.stringify(message)),
          );
        } catch (error) {
          console.error(`warning: could not publish the zeroed totals of ${dropId}:`, error);
        }
      },
    });
    console.log(
      `Projection zeroed (${zeroed.size} drops) and group ${CONSUMER_GROUPS.dashboard} reset to the earliest offset.`,
    );
    return before;
  } catch (error) {
    if (!(error instanceof ConsumersRunningError || error instanceof HistoryLostError)) throw error;
    console.error(error.message);
    return null;
  } finally {
    // Also after a refusal or a failure: the dashboards would otherwise stay frozen.
    if (args.compose) await compose('start', DASHBOARD_SERVICE);
  }
}

async function run(): Promise<number> {
  await bounded(redis.connect(), CONNECT_TIMEOUT_MS, `Redis at ${env.REDIS_URL} did not answer`);
  await bounded(
    admin.connect(),
    CONNECT_TIMEOUT_MS,
    `Kafka at ${env.KAFKA_BROKERS.join(',')} did not answer`,
  );
  // Events the group has not reached when it stops are replayed but missing from the totals before the
  // wipe. INV-5 accepts the difference, but the demo should show identical numbers.
  if (args.compose && args.wait && !(await caughtUp('catching up before the stop'))) {
    console.log(`  still behind after ${args.timeout} s: the drops it had not reached are judged by INV-5`);
  }
  const before = await rebuild();
  if (before === null) return 1;
  if (!args.compose) {
    console.log(
      `Start the dashboard consumers again: docker compose --profile app start ${DASHBOARD_SERVICE}`,
    );
  }
  if (!args.wait) return 0;

  if (!(await caughtUp('replaying'))) {
    console.error(`The group did not catch up within ${args.timeout} s.`);
    return 1;
  }
  const after = await readAllSalesTotals(db);
  const differences = totalsDifferences(before, after);
  if (differences.length === 0) {
    console.log(`Replayed: every drop's totals are identical to before the wipe (${before.size} drops).`);
    return 0;
  }
  // Drops with totals on either side: one whose first order came meanwhile has none before the wipe.
  const drops = new Set([...before.keys(), ...after.keys()]).size;
  console.log(
    `${differences.length} drops changed across the rebuild; each must now equal its orders (INV-5):`,
  );
  for (const { dropId, detail } of differences) console.log(`  ${dropId}: ${detail}`);
  const { agree, disagree, skipped } = await judgeChanged(differences.map(({ dropId }) => dropId));
  for (const [dropId, reason] of skipped) console.error(`  ${dropId} cannot be judged: ${reason}`);
  for (const [dropId, messages] of disagree) console.error(`  ${dropId}: ${messages.join('; ')}`);
  if (disagree.size > 0 || skipped.size > 0) {
    console.error(
      'The replay is not proven: the drops above differ from before and do not match their orders.',
    );
    return 1;
  }
  console.log(
    `Replayed: ${drops - agree.length} drops identical, and ${agree.length} changed by orders placed ` +
      'meanwhile, each equal to its orders.',
  );
  return 0;
}

try {
  process.exitCode = await run();
} catch (error) {
  console.error(`dash:rebuild could not run: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
} finally {
  redis.destroy();
  await admin.disconnect().catch(() => undefined);
  await pool.end();
}

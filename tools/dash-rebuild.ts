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
 *                                               drop that has orders with them
 *   pnpm dash:rebuild --accept-history-loss     rebuilds from what the topic holds (the lost totals stay lost)
 *
 * The replay is judged on every drop with orders, not on the totals before the wipe alone: each dashboard
 * must count every order of its drop and, where the outbox still holds their events, equal them (INV-5). A
 * drop whose totals changed across the rebuild (orders placed meanwhile, or events the group had not reached
 * when it stopped) is fine when it does. A dashboard short of orders is history the topic does not hold:
 * recreated after their events were published, or orders written without events. The low-watermark check
 * before the wipe cannot see that (such a topic starts at offset 0), and an identical projection hides it.
 *
 * Exit codes: 0 rebuilt (and, with --wait, every dashboard equal to its orders); 1 consumers were running,
 * history was lost (unless --accept-history-loss), the group did not catch up, or a replayed drop disagrees
 * with its orders; 2 could not run.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs, promisify } from 'node:util';
import { CONSUMER_GROUPS, KafkaEnv, loadEnv, PostgresEnv, RedisEnv, TOPICS } from '@flashdrop/config';
import type { DashboardTotalsMessage } from '@flashdrop/contracts';
import {
  createDb,
  createPool,
  orders,
  POOL_PROFILES,
  readAllSalesTotals,
  readDashboardChecks,
} from '@flashdrop/db';
import { createCommandClient, dashboardChannel, REDIS_DEADLINE_MS, withDeadline } from '@flashdrop/inventory';
import { createGroupLagReader, createKafka } from '@flashdrop/messaging';
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
const kafka = createKafka({ brokers: env.KAFKA_BROKERS, clientId: 'dash-rebuild', logLevel: 'error' });
const admin = kafka.admin();
// Its consumer never joins the group (lag.ts), so it does not stop the rebuild from resetting the group.
const lag = createGroupLagReader(kafka, { timeoutMs: CONNECT_TIMEOUT_MS });

/** `docker compose --profile app <args>` with this environment, so `COMPOSE_FILE` (CI's overrides) applies. */
async function compose(...composeArgs: string[]): Promise<void> {
  console.log(`docker compose --profile app ${composeArgs.join(' ')}`);
  await exec('docker', ['compose', '--profile', 'app', ...composeArgs], { env: process.env });
}

/** Polls the group's lag until it is 0 everywhere, or the deadline passes; true when it caught up. */
async function caughtUp(what: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const partitions = await lag.read(CONSUMER_GROUPS.dashboard);
    const behind = partitions.reduce((sum, partition) => sum + partition.lag, 0);
    if (behind === 0) return true;
    if (Date.now() >= deadline) return false;
    console.log(`  ${what}: ${behind} events to go`);
    await sleep(1_000);
  }
}

/** How long an unresolved judgement must stay the same to be final rather than an order in flight. */
const SETTLED_MS = 5_000;
/** Drops listed per kind of problem; the counts cover the rest. */
const LISTED = 20;

/**
 * The replay judged on every drop with orders (one statement per table for all of them), until each agrees
 * or the problems stay the same for SETTLED_MS: an order still on its way through the outbox and the group
 * disagrees for a moment, a history the topic lacks for good. The timeout bounds both.
 */
async function judgeEveryDrop(): Promise<ReplayJudgement> {
  const dropIds = (await db.selectDistinct({ dropId: orders.dropId }).from(orders)).map((row) => row.dropId);
  const deadline = Date.now() + timeoutMs;
  let last = '';
  let sameSince = Date.now();
  for (;;) {
    const judgement = judgeReplay(await readDashboardChecks(db, dropIds));
    if (judgement.disagree.size === 0 && judgement.lost.size === 0) return judgement;
    const problems = JSON.stringify([[...judgement.lost], [...judgement.disagree.keys()]]);
    if (problems !== last) {
      last = problems;
      sameSince = Date.now();
    }
    if (Date.now() - sameSince >= SETTLED_MS || Date.now() >= deadline) return judgement;
    await sleep(1_000);
  }
}

function listSome<T>(entries: Iterable<T>, line: (entry: T) => string): void {
  const all = [...entries];
  for (const entry of all.slice(0, LISTED)) console.error(`  ${line(entry)}`);
  if (all.length > LISTED) console.error(`  ... and ${all.length - LISTED} more`);
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
  const changed = new Set(differences.map(({ dropId }) => dropId));
  if (differences.length > 0) {
    console.log(`${differences.length} drops changed across the rebuild; each must now equal its orders:`);
    for (const { dropId, detail } of differences.slice(0, LISTED)) console.log(`  ${dropId}: ${detail}`);
  }

  const { lost, disagree, skipped } = await judgeEveryDrop();
  // A drop that changed must now equal its orders: the change was orders placed meanwhile, or the replay is
  // wrong. One that came back identical but disagrees was short before the wipe too: the replay reproduced
  // it, so what is missing is events the topic does not hold, like the lost orders.
  const wrong = [...disagree].filter(([dropId]) => changed.has(dropId));
  const shortBefore = [...disagree].filter(([dropId]) => !changed.has(dropId));
  // Changed and not comparable: nothing shows the change was orders placed meanwhile.
  const unjudged = [...skipped].filter(([dropId]) => changed.has(dropId));
  let ok = true;
  if (wrong.length > 0 || unjudged.length > 0) {
    ok = false;
    console.error('The replay is not proven: these drops changed and do not match their orders (INV-5):');
    listSome(wrong, ([dropId, messages]) => `${dropId}: ${messages.join('; ')}`);
    listSome(unjudged, ([dropId, reason]) => `${dropId} cannot be judged: ${reason}`);
  }
  const history = lost.size + shortBefore.length;
  if (history > 0) {
    const accepted = args['accept-history-loss'];
    if (!accepted) ok = false;
    console.error(
      `${accepted ? 'warning: ' : ''}${history} dashboards are short of their orders: ${TOPICS.orders} does ` +
        'not hold all of their events (recreated after they were published, or the orders were written ' +
        'without them), so no replay can restore them.',
    );
    listSome(lost, ([dropId, n]) => {
      const orders = `${n} order${n === 1 ? '' : 's'} not counted`;
      return `${dropId}: ${orders}${changed.has(dropId) ? ', lost by this rebuild' : ''}`;
    });
    listSome(shortBefore, ([dropId, messages]) => `${dropId}: ${messages.join('; ')}, as before the wipe`);
    if (!accepted) console.error('Pass --accept-history-loss to accept dashboards short of their orders.');
  }
  if (!ok) return 1;
  if (history > 0) {
    console.log(`Rebuilt from what ${TOPICS.orders} holds; every other dashboard equals its orders.`);
    return 0;
  }
  const drops = new Set([...before.keys(), ...after.keys()]).size;
  console.log(
    `Replayed: ${drops - changed.size} drops identical and ${changed.size} changed by orders placed ` +
      'meanwhile; every dashboard equals its orders.',
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
  await lag.close();
  await pool.end();
}

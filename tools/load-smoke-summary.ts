/**
 * `tsx tools/load-smoke-summary.ts [--results <dir>] [--invariants <file>]` (design §13): the step summary
 * of the CI `load-smoke` job. It reads the k6 summaries that tests/load writes (`burst-ci.json`,
 * `idempotency-storm.json`, and `expiry-soak.json` when that ran) and the `verify:invariants` report, and
 * prints Markdown tables for `$GITHUB_STEP_SUMMARY`: reserve latency and outcomes, checkout and payment
 * (submit to PAID), and the invariants with the event pipeline. A missing or unreadable file becomes a row
 * that says so instead of an error: the step also runs after a failed burst, whose own step already fails
 * the job.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';

const { values } = parseArgs({
  options: {
    results: { type: 'string', default: 'tests/load/results' },
    invariants: { type: 'string', default: 'invariants-report.json' },
  },
});

/** The parts of a `summaryOutputs` file (tests/load/lib/summary.ts) the tables show. */
const K6Summary = z.object({
  ok: z.boolean(),
  /** The burst's mode: `full` (checkout, cancel, abandon) or `reserve-only`. */
  mode: z.string().optional(),
  /** Set by scripts whose trend leaves out `count` (the storm sends a fixed number). */
  requests: z.number().optional(),
  thresholds: z.array(z.object({ metric: z.string(), expression: z.string(), ok: z.boolean() })),
  metrics: z.record(z.string(), z.object({ values: z.record(z.string(), z.number()) })),
});
type K6Summary = z.infer<typeof K6Summary>;

/** The parts of `invariants-report.json` (tools/invariant-samples.ts) the tables show. */
const InvariantsReport = z.object({
  ok: z.boolean(),
  scope: z.object({ dropIds: z.array(z.string()) }),
  quiescence: z.object({ reached: z.boolean(), waitedMs: z.number() }),
  invariants: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      status: z.enum(['pass', 'fail', 'skipped']),
      reason: z.string().optional(),
      violations: z.array(z.unknown()),
    }),
  ),
  /** v2: the event pipeline; null when it was not checked. */
  events: z
    .object({
      outbox: z.object({ pending: z.number() }),
      groups: z.array(z.object({ name: z.string(), groupId: z.string(), lag: z.number() })),
      deadLetters: z.number().nullable(),
    })
    .nullable()
    .optional(),
});

async function read<T extends z.ZodType>(path: string, schema: T): Promise<z.output<T> | string> {
  try {
    return schema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    const reason =
      error instanceof Error && 'code' in error && error.code === 'ENOENT' ? 'missing' : 'unreadable';
    return `${path} is ${reason}`;
  }
}

const integer = new Intl.NumberFormat('en-US');
const value = (summary: K6Summary, metric: string, stat: string) => summary.metrics[metric]?.values[stat];
const count = (summary: K6Summary, metric: string) => integer.format(value(summary, metric, 'count') ?? 0);
const ms = (n: number | undefined) => (n === undefined ? 'n/a' : `${n.toFixed(n < 10 ? 1 : 0)} ms`);
const yes = (summary: K6Summary, metric: string) => {
  const rate = value(summary, metric, 'rate');
  return rate === undefined ? 'not checked' : rate === 1 ? 'yes' : '**NO**';
};

interface Run {
  readonly name: string;
  readonly file: string;
  /** Shown only when its file exists: a run CI may or may not include. */
  readonly optional?: boolean;
  /** The trend of every reserve the run sent, and the counters of its outcomes. */
  readonly trend: string;
  /** Distinct orders the run created. */
  readonly orders: string;
  /** Requests answered as replays; absent for a run without same-key repeats. */
  readonly replayed?: string;
  readonly refused: readonly string[];
  /** The longest wait for the stock to come back, in seconds. */
  readonly back?: string;
}

const RUNS: readonly Run[] = [
  {
    name: 'Burst (`ci` profile)',
    file: 'burst-ci.json',
    trend: 'reserve_duration',
    orders: 'reserve_orders',
    replayed: 'reserve_replayed',
    refused: ['reserve_sold_out', 'reserve_limit_reached'],
    back: 'stock_return_seconds',
  },
  {
    name: 'Idempotency storm',
    file: 'idempotency-storm.json',
    trend: 'storm_duration',
    orders: 'storm_created',
    replayed: 'storm_replayed',
    refused: [],
  },
  {
    name: 'Expiry soak',
    file: 'expiry-soak.json',
    optional: true,
    trend: 'soak_reserve_duration',
    orders: 'soak_reserved',
    refused: ['soak_probe_sold_out'],
    back: 'soak_return_seconds',
  },
];

function runRow(run: Run, summary: K6Summary | string): string {
  if (typeof summary === 'string') return `| ${run.name} | not run: ${summary} | | | | | | | | |`;
  const refused = run.refused.reduce((sum, metric) => sum + (value(summary, metric, 'count') ?? 0), 0);
  const back = run.back === undefined ? undefined : value(summary, run.back, 'max');
  const requests = value(summary, run.trend, 'count') ?? summary.requests ?? 0;
  const cells = [
    run.name,
    summary.ok ? 'PASS' : '**FAIL**',
    integer.format(requests),
    count(summary, run.orders),
    run.replayed === undefined ? '' : count(summary, run.replayed),
    run.refused.length > 0 ? integer.format(refused) : '',
    ms(value(summary, run.trend, 'med')),
    ms(value(summary, run.trend, 'p(95)')),
    ms(value(summary, run.trend, 'max')),
    back === undefined ? '' : `${back.toFixed(1)} s`,
  ];
  return `| ${cells.join(' | ')} |`;
}

/** The burst's winners after their reserve (§13), and the payment consumer's latency (§1: submit to PAID). */
function checkoutLines(burst: K6Summary | string, storm: K6Summary | string): string[] {
  const lines = ['', '## Checkout and payment', ''];
  if (typeof burst === 'string') {
    lines.push(`Burst not run: ${burst}.`);
  } else if (burst.mode !== 'full') {
    lines.push(`The burst ran in ${burst.mode ?? 'an unknown'} mode: no checkouts.`);
  } else {
    lines.push(
      '| Submitted | PAID | Declined | Wrong outcome | Undecided | Cancelled | Abandoned | Submit p95 | Submit to PAID p50 | p95 | max |',
      '|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|',
      `| ${[
        count(burst, 'checkout_submitted'),
        count(burst, 'payment_paid'),
        count(burst, 'payment_declined'),
        count(burst, 'payment_wrong'),
        count(burst, 'payment_timeout'),
        count(burst, 'cancel_cancelled'),
        count(burst, 'abandoned'),
        ms(value(burst, 'checkout_duration', 'p(95)')),
        ms(value(burst, 'submit_to_paid', 'med')),
        ms(value(burst, 'submit_to_paid', 'p(95)')),
        ms(value(burst, 'submit_to_paid', 'max')),
      ].join(' | ')} |`,
    );
  }
  if (typeof storm !== 'string') {
    lines.push(
      '',
      `Idempotency storm checkout: ${count(storm, 'storm_checkout_submitted')} submitted, ` +
        `${count(storm, 'storm_checkout_replayed')} replays; one PAID order: ${yes(storm, 'storm_one_paid_order')}; ` +
        `one charge: ${yes(storm, 'storm_one_charge')}; stock sold once: ${yes(storm, 'storm_stock_sold_once')}.`,
    );
  }
  return lines;
}

const lines = [
  '## Load smoke',
  '',
  '| Run | Result | Requests | Orders | Replayed | Refused | p50 | p95 | max | Stock back after expiry |',
  '|---|---|--:|--:|--:|--:|--:|--:|--:|--:|',
];
const failedThresholds: string[] = [];
const summaries = new Map<string, K6Summary | string>();
for (const run of RUNS) {
  const summary = await read(join(values.results, run.file), K6Summary);
  summaries.set(run.file, summary);
  if (run.optional && typeof summary === 'string' && summary.endsWith('missing')) continue;
  lines.push(runRow(run, summary));
  if (typeof summary !== 'string') {
    for (const t of summary.thresholds.filter((threshold) => !threshold.ok)) {
      failedThresholds.push(`- ${run.name}: \`${t.metric}: ${t.expression}\``);
    }
  }
}
if (failedThresholds.length > 0) lines.push('', '**Failed thresholds**', '', ...failedThresholds);
lines.push(
  ...checkoutLines(
    summaries.get('burst-ci.json') ?? 'burst-ci.json is missing',
    summaries.get('idempotency-storm.json') ?? 'idempotency-storm.json is missing',
  ),
);

const report = await read(values.invariants, InvariantsReport);
lines.push('', '## Invariants', '');
if (typeof report === 'string') {
  lines.push(`Not checked: ${report}.`);
} else {
  lines.push(
    `**${report.ok ? 'PASS' : 'FAIL'}** on ${integer.format(report.scope.dropIds.length)} tracked drops, ` +
      (report.quiescence.reached
        ? `quiescent after ${(report.quiescence.waitedMs / 1_000).toFixed(1)} s.`
        : 'never quiescent.'),
  );
  if (report.events) {
    const { outbox, groups, deadLetters } = report.events;
    lines.push(
      '',
      `Events: ${integer.format(outbox.pending)} outbox rows unpublished; ` +
        groups.map((group) => `${group.name} lag ${integer.format(group.lag)}`).join(', ') +
        `; ${deadLetters === null ? 'DLQ not counted' : `${integer.format(deadLetters)} dead letters`}.`,
    );
  }
  lines.push(
    '',
    '| Invariant | Status | Violations |',
    '|---|---|--:|',
    ...report.invariants.map(
      (inv) =>
        `| ${inv.id} ${inv.title} | ${inv.status === 'fail' ? '**FAIL**' : inv.status.toUpperCase()}${
          inv.reason ? ` (${inv.reason})` : ''
        } | ${inv.violations.length} |`,
    ),
  );
}
console.log(lines.join('\n'));

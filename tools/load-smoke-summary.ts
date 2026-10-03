/**
 * `tsx tools/load-smoke-summary.ts [--results <dir>] [--invariants <file>]` (design §13): the step summary
 * of the CI `load-smoke` job. It reads the k6 summaries that tests/load writes (`burst-ci.json`,
 * `idempotency-storm.json`) and the `verify:invariants` report, and prints Markdown latency and invariants
 * tables for `$GITHUB_STEP_SUMMARY`. A missing or unreadable file becomes a row that says so instead of an
 * error: the step also runs after a failed burst, whose own step already fails the job.
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

/** The parts of a `summaryOutputs` file (tests/load/lib/summary.ts) the table shows. */
const K6Summary = z.object({
  ok: z.boolean(),
  /** Set by scripts whose trend leaves out `count` (the storm sends a fixed number). */
  requests: z.number().optional(),
  thresholds: z.array(z.object({ metric: z.string(), expression: z.string(), ok: z.boolean() })),
  metrics: z.record(z.string(), z.object({ values: z.record(z.string(), z.number()) })),
});
type K6Summary = z.infer<typeof K6Summary>;

/** The parts of `invariants-report.json` (tools/invariant-samples.ts) the table shows. */
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

interface Run {
  readonly name: string;
  readonly file: string;
  /** The trend of every request the run sent, and the counters of its outcomes. */
  readonly trend: string;
  /** Distinct orders the run created. */
  readonly orders: string;
  readonly replayed: string;
  readonly refused: readonly string[];
}

const RUNS: readonly Run[] = [
  {
    name: 'Reserve burst (`ci` profile)',
    file: 'burst-ci.json',
    trend: 'reserve_duration',
    orders: 'reserve_orders',
    replayed: 'reserve_replayed',
    refused: ['reserve_sold_out', 'reserve_limit_reached'],
  },
  {
    name: 'Idempotency storm',
    file: 'idempotency-storm.json',
    trend: 'storm_duration',
    orders: 'storm_created',
    replayed: 'storm_replayed',
    refused: [],
  },
];

function runRow(run: Run, summary: K6Summary | string): string {
  if (typeof summary === 'string') return `| ${run.name} | not run: ${summary} | | | | | | | | |`;
  const refused = run.refused.reduce((sum, metric) => sum + (value(summary, metric, 'count') ?? 0), 0);
  const back = value(summary, 'stock_return_seconds', 'max');
  const requests = value(summary, run.trend, 'count') ?? summary.requests ?? 0;
  const cells = [
    run.name,
    summary.ok ? 'PASS' : '**FAIL**',
    integer.format(requests),
    count(summary, run.orders),
    count(summary, run.replayed),
    run.refused.length > 0 ? integer.format(refused) : '',
    ms(value(summary, run.trend, 'med')),
    ms(value(summary, run.trend, 'p(95)')),
    ms(value(summary, run.trend, 'max')),
    back === undefined ? '' : `${back.toFixed(1)} s`,
  ];
  return `| ${cells.join(' | ')} |`;
}

const lines = [
  '## Load smoke',
  '',
  '| Run | Result | Requests | Orders | Replayed | Refused | p50 | p95 | max | Stock back after expiry |',
  '|---|---|--:|--:|--:|--:|--:|--:|--:|--:|',
];
const failedThresholds: string[] = [];
for (const run of RUNS) {
  const summary = await read(join(values.results, run.file), K6Summary);
  lines.push(runRow(run, summary));
  if (typeof summary !== 'string') {
    for (const t of summary.thresholds.filter((threshold) => !threshold.ok)) {
      failedThresholds.push(`- ${run.name}: \`${t.metric}: ${t.expression}\``);
    }
  }
}
if (failedThresholds.length > 0) lines.push('', '**Failed thresholds**', '', ...failedThresholds);

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

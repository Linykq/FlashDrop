/**
 * `tsx tools/chaos-summary.ts [--run <dir>]` (design §13): the chaos suite's step summary in the nightly
 * workflow. It reads the scenario reports of one chaos run (by default the newest under tests/chaos/results)
 * and prints Markdown for `$GITHUB_STEP_SUMMARY`: one row per scenario with its verdict, its burst and how
 * the burst's orders ended, and the invariants the M9 demo names (oversell, double charge, lost events,
 * leaked stock) from that scenario's own `verify:invariants` report; then each failed scenario's problems,
 * and every scenario's fault and evidence.
 *
 * tests/chaos/harness.ts writes `<scenario>.json` as each scenario ends, and run.ts writes `summary.json`
 * only after the last one, so this reads the scenario files: a run cut short by the job's timeout still
 * shows the scenarios that finished. A missing or unreadable file becomes a line that says so: the step also
 * runs after a failed or timed-out chaos step, which already fails the job.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';

const RESULTS = 'tests/chaos/results';

const { values } = parseArgs({ options: { run: { type: 'string' } } });

/** The parts of a `ScenarioReport` (tests/chaos/harness.ts) the summary shows. */
const ScenarioReport = z.object({
  scenario: z.string(),
  fault: z.string(),
  ok: z.boolean(),
  problems: z.array(z.string()),
  startedAt: z.string(),
  durationMs: z.number(),
  burst: z.object({ handled: z.number(), won: z.number(), soldOut: z.number() }).nullable(),
  outcomes: z.record(z.string(), z.number()),
  evidence: z.record(z.string(), z.unknown()),
});
type ScenarioReport = z.infer<typeof ScenarioReport>;

/** The parts of `invariants-report.json` (tools/invariant-samples.ts) the summary shows. */
const InvariantsReport = z.object({
  ok: z.boolean(),
  invariants: z.array(
    z.object({
      id: z.string(),
      status: z.enum(['pass', 'fail', 'skipped']),
      violations: z.array(z.unknown()),
    }),
  ),
});
type InvariantsReport = z.infer<typeof InvariantsReport>;

/** §16 M9: "0 oversell, 0 double charge and 0 leaked units", plus §13's "0 lost events". */
const HEADLINE = [
  { id: 'INV-1', label: 'Oversell' },
  { id: 'INV-4', label: 'Double charge' },
  { id: 'INV-5', label: 'Lost events' },
  { id: 'INV-6', label: 'Leaked stock' },
] as const;

/** Final statuses in the order a buyer's choices lead to them (FINAL_STATUS in tests/chaos/burst.ts). */
const STATUSES = ['PAID', 'PAYMENT_FAILED', 'CANCELLED', 'EXPIRED'] as const;

async function read<T extends z.ZodType>(path: string, schema: T): Promise<z.output<T> | string> {
  try {
    return schema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    return `${path} is ${isMissing(error) ? 'missing' : 'unreadable'}`;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** Run directories are named by their ISO start time, so the newest sorts last. */
async function newestRun(): Promise<string | undefined> {
  try {
    const entries = await readdir(RESULTS, { withFileTypes: true });
    const runs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    const newest = runs.sort().at(-1);
    return newest === undefined ? undefined : join(RESULTS, newest);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

const integer = new Intl.NumberFormat('en-US');

/** For the reports' free text (faults, problems): GitHub would render a `<...>` in it as HTML. */
const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A headline invariant's cell: its violation count, or why it has none. */
function invariantCell(report: InvariantsReport | string, id: string): string {
  if (typeof report === 'string') return 'n/a';
  const invariant = report.invariants.find((candidate) => candidate.id === id);
  if (invariant === undefined) return 'n/a';
  if (invariant.status === 'skipped') return 'skipped';
  const violations = integer.format(invariant.violations.length);
  return invariant.status === 'fail' ? `**${violations}**` : violations;
}

function invariantsCell(report: InvariantsReport | string): string {
  if (typeof report === 'string') return '**not checked**';
  const passed = report.invariants.filter((invariant) => invariant.status === 'pass').length;
  return `${report.ok ? 'PASS' : '**FAIL**'} (${passed}/${report.invariants.length})`;
}

function row(report: ScenarioReport, invariants: InvariantsReport | string): string {
  const burst = report.burst;
  const cells = [
    `\`${report.scenario}\``,
    report.ok ? 'PASS' : '**FAIL**',
    `${Math.round(report.durationMs / 1_000)} s`,
    burst === null
      ? 'n/a'
      : `${integer.format(burst.handled)} / ${integer.format(burst.won)} / ${integer.format(burst.soldOut)}`,
    STATUSES.map((status) => integer.format(report.outcomes[status] ?? 0)).join(' / '),
    ...HEADLINE.map(({ id }) => invariantCell(invariants, id)),
    invariantsCell(invariants),
  ];
  return `| ${cells.join(' | ')} |`;
}

async function summary(dir: string): Promise<string[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (error) {
    if (isMissing(error)) return [`Not run: ${dir} does not exist.`];
    throw error;
  }
  const names = files
    .filter((name) => name.endsWith('.json') && !name.endsWith('.invariants.json') && name !== 'summary.json')
    .sort();
  const reports: ScenarioReport[] = [];
  const unreadable: string[] = [];
  for (const name of names) {
    const report = await read(join(dir, name), ScenarioReport);
    if (typeof report === 'string') unreadable.push(report);
    else reports.push(report);
  }
  // In the order the run ran them: the core cases first (tests/chaos/scenarios/index.ts).
  reports.sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  const lines = [`Run \`${dir}\`: ${reports.length} scenarios reported.`, ''];
  if (reports.length > 0) {
    const headline = HEADLINE.map(({ id, label }) => `${label} (${id})`);
    lines.push(
      `| Scenario | Result | Duration | Buyers answered / won / sold out | ${STATUSES.join(' / ')} | ${headline.join(' | ')} | Invariants |`,
      `|---|---|--:|--:|--:|${headline.map(() => '--:').join('|')}|---|`,
    );
    for (const report of reports) {
      lines.push(row(report, await read(join(dir, `${report.scenario}.invariants.json`), InvariantsReport)));
    }
  }
  const failed = reports.filter((report) => !report.ok);
  if (failed.length > 0 || unreadable.length > 0) {
    lines.push('', '**Problems**', '');
    for (const report of failed) {
      for (const problem of report.problems) lines.push(`- \`${report.scenario}\`: ${escapeHtml(problem)}`);
    }
    for (const reason of unreadable) lines.push(`- ${reason}`);
  }
  for (const report of reports) {
    lines.push(
      '',
      `<details><summary><code>${report.scenario}</code>: ${escapeHtml(report.fault)}</summary>`,
      '',
      '```json',
      JSON.stringify(report.evidence, null, 2),
      '```',
      '',
      '</details>',
    );
  }
  return lines;
}

const dir = values.run ?? (await newestRun());
const lines = ['## Chaos', ''];
if (dir === undefined) lines.push(`Not run: no chaos run under ${RESULTS}.`);
else lines.push(...(await summary(dir)));
console.log(lines.join('\n'));

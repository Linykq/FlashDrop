import { BASE_URL, RESULTS_DIR } from './config.ts';

/*
 * End-of-test output (design §13): a short text summary on stdout and a JSON file in `tests/load/results`
 * (git-ignored) that CI uploads and turns into its step summary. `setup_data` is left out of the file: it
 * holds every minted session token.
 */

interface MetricData {
  readonly type: string;
  readonly values: Readonly<Record<string, number>>;
  readonly thresholds?: Readonly<Record<string, { readonly ok: boolean }>>;
}

export interface SummaryData {
  readonly metrics: Readonly<Record<string, MetricData>>;
  readonly state: { readonly testRunDurationMs: number };
  readonly setup_data?: unknown;
}

export function count(data: SummaryData, metric: string): number {
  return data.metrics[metric]?.values.count ?? 0;
}

/** A trend statistic in ms (`p(95)`, `med`, `max`, ...), or NaN when the metric has no samples. */
export function stat(data: SummaryData, metric: string, name: string): number {
  return data.metrics[metric]?.values[name] ?? Number.NaN;
}

export function ms(value: number): string {
  return Number.isNaN(value) ? 'n/a' : `${value.toFixed(value < 10 ? 1 : 0)} ms`;
}

/**
 * The `handleSummary` result: `lines` (the script's own account of the run) and every threshold on stdout,
 * everything as JSON in `<RESULTS_DIR>/<file>.json`.
 */
export function summaryOutputs(
  file: string,
  data: SummaryData,
  context: Readonly<Record<string, unknown>>,
  lines: readonly string[],
): Record<string, string> {
  const thresholds = Object.entries(data.metrics).flatMap(([metric, summary]) =>
    Object.entries(summary.thresholds ?? {}).map(([expression, result]) => ({
      metric,
      expression,
      ok: result.ok,
    })),
  );
  const ok = thresholds.every((threshold) => threshold.ok);
  const report = {
    file,
    baseUrl: BASE_URL,
    ...context,
    ok,
    finishedAt: new Date().toISOString(),
    durationMs: data.state.testRunDurationMs,
    thresholds,
    metrics: data.metrics,
  };
  const path = `${RESULTS_DIR}/${file}.json`;
  const text = [
    '',
    ...lines,
    '',
    'Thresholds',
    ...thresholds.map((t) => `  ${t.ok ? 'PASS' : 'FAIL'}  ${t.metric}: ${t.expression}`),
    '',
    `RESULT: ${ok ? 'PASS' : 'FAIL'}   (JSON: ${path})`,
    '',
  ].join('\n');
  return { stdout: text, [path]: `${JSON.stringify(report, null, 2)}\n` };
}

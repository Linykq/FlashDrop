/**
 * The chaos suite (design §13 "Chaos", §16 M9). Each scenario makes a fresh drop, drives a scripted burst
 * on it through Caddy, injects its fault mid-burst, waits for quiescence and runs `verify:invariants`
 * (0 oversell, 0 double charge, 0 lost events, 0 leaked units, and no new dead letter), checks that every
 * order ended where its buyer's choice leads, checks the scenario's own evidence, and audits the containers
 * for restarts Docker made on its own (a crash that `restart: unless-stopped` would otherwise hide).
 *
 *   pnpm chaos:all                    every scenario, one after another (about 15 minutes)
 *   pnpm chaos:redis-restart          SIGKILL Redis mid-burst, back 5 s later from its AOF
 *   pnpm chaos:redis-lost-tail        Redis back from an AOF copy taken seconds earlier (a lost tail)
 *   pnpm chaos:relay-kill             SIGKILL the worker with a relay batch in flight
 *   pnpm chaos:consumer-kill          SIGKILL the consumers replica that owns the sale's partition
 *   pnpm chaos:psp-outage             payment-mock answers 503 for 60 s, past the 30 s backoff cap
 *   pnpm chaos:dup-delivery           the relay publishes every batch twice
 *   tsx tests/chaos/run.ts <scenario...> [--skip-up]
 *
 * The target is the isolated Compose project (compose.isolated.yaml, `flashdrop-sys`, on ports 15433, 16379,
 * 19094 and 18080), never the main stack others on the machine use, unless COMPOSE_FILE names another stack
 * and FD_SYSTEM_TESTS=1 allows breaking it (CI's nightly job; see ./target.ts). The run first brings the
 * target up from the local images (`docker buildx bake --file docker-bake.hcl --load` builds them; `pnpm
 * stack:up` does too), unless `--skip-up` says it already is. compose.isolated.yaml's header has the command
 * that removes the isolated stack again.
 *
 * Results: tests/chaos/results/<run>/<scenario>.json (verdict, problems, evidence, timeline) and
 * <scenario>.invariants.json (the verify:invariants report), plus summary.json. Exit code: 0 every scenario
 * passed, 1 one failed, 2 the run could not start.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ensureDotEnv } from '../../tools/env-file';
import { compose } from '../../tools/system/support';
import { describe, resultsDirFor, runScenario } from './harness';
import { SCENARIOS } from './scenarios/index';
import { selectTarget } from './target';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { 'skip-up': { type: 'boolean', default: false } },
});

try {
  const target = selectTarget();
  console.log(
    `chaos target: ${target === 'isolated' ? 'the isolated stack (flashdrop-sys)' : process.env.COMPOSE_FILE}`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
}

const known = new Map(SCENARIOS.map((scenario) => [scenario.name, scenario]));
const names = positionals.includes('all') ? [...known.keys()] : positionals;
const unknown = names.filter((name) => !known.has(name));
if (names.length === 0 || unknown.length > 0) {
  if (unknown.length > 0) console.error(`unknown scenario: ${unknown.join(', ')}`);
  console.error(`usage: tsx tests/chaos/run.ts <all | ${[...known.keys()].join(' | ')}>... [--skip-up]`);
  process.exit(2);
}

if (!values['skip-up']) {
  // compose.yaml requires the stack's secrets, which a fresh clone's .env does not have yet (§15).
  ensureDotEnv();
  console.log('bringing the stack up (docker compose --profile app up --wait)...');
  try {
    await compose(['up', '--detach', '--wait', '--wait-timeout', '300']);
  } catch (error) {
    console.error(
      `the stack did not come up: ${describe(error)}\n` +
        'Are the images built? docker buildx bake --file docker-bake.hcl --load',
    );
    process.exit(2);
  }
}

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const resultsDir = await resultsDirFor(runId);
const reports = [];
for (const name of names) {
  const scenario = known.get(name);
  if (scenario !== undefined) reports.push(await runScenario(scenario, resultsDir));
}

console.log('\nChaos summary');
for (const report of reports) {
  const seconds = `${Math.round(report.durationMs / 1000)} s`.padStart(6);
  const orders = Object.entries(report.outcomes)
    .map(([status, n]) => `${n} ${status}`)
    .join(', ');
  console.log(`  ${report.ok ? 'PASS' : 'FAIL'}  ${report.scenario.padEnd(16)} ${seconds}  ${orders}`);
  for (const problem of report.problems) console.log(`          - ${problem}`);
}
await writeFile(join(resultsDir, 'summary.json'), `${JSON.stringify(reports, null, 2)}\n`);
console.log(`\nResults: ${resultsDir}`);
process.exitCode = reports.every((report) => report.ok) ? 0 : 1;

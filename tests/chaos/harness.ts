import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deadLetters, liveOrders, orderStatuses } from '../../tools/system/chaos-support';
import {
  connectStores,
  createBuyers,
  logEnds,
  partitionOf,
  postTestDrop,
  type Stores,
  type TestDrop,
  until,
} from '../../tools/system/support';
import { type ContainerState, notHealthy, restartsSince } from './audit';
import { type Burst, type BurstResult, FINAL_STATUS, startBurst } from './burst';
import { containers } from './docker';

/*
 * One chaos run (design §13): a fresh drop, a scripted burst on it, the scenario's fault injected mid-burst,
 * then the verdict, from four sources:
 *   1. `verify:invariants` itself (tools/verify-invariants.ts, as CI runs it), which first waits for
 *      quiescence (outbox drained, every group at lag 0, nothing due, nothing unsettled, no money in flight),
 *      then checks INV-1 to INV-9 on every tracked drop: no oversell, no double charge, no lost event, no
 *      leaked unit. No new dead letter either: the DLQ may hold no more records than before the run;
 *   2. every order of the burst at the end its buyer chose (paid, declined, cancelled, walked away);
 *   3. the scenario's own evidence that the fault happened, and was handled the way §17 says;
 *   4. the restart audit: no container restarted by Docker (a crash brought back by `restart:
 *      unless-stopped`) and, after the scenario put back what it changed, every service running and healthy.
 */

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export interface LoadPlan {
  /** Buyers reserving one unit each; more than `stock`, so the last ones find the drop sold out. */
  readonly buyers: number;
  readonly stock: number;
  /** Buyers in flight at once, and each lane's pause between them: together the pace of the burst. */
  readonly concurrency: number;
  readonly paceMs: number;
  /** Abandoned holds expire after this: it bounds the wait for quiescence after the burst. */
  readonly holdSeconds: number;
  /** Longer than any fault that holds payments up, so every `pm_ok` order is paid, never expired. */
  readonly paymentSeconds: number;
  /** The share of buyers answered before the fault strikes: mid-burst. */
  readonly faultAt: number;
}

/**
 * About 20 buyers a second for about 40 s on a 12-thread laptop through the isolated stack's Caddy. Every
 * winner holds a unit, but cancels, declines and expired holds hand about a third back, so 450 units sell
 * out near the end of 800 buyers: the last ones are turned away, and returned units are sold again.
 */
export const DEFAULT_LOAD: LoadPlan = {
  buyers: 800,
  stock: 450,
  concurrency: 8,
  paceMs: 300,
  holdSeconds: 30,
  paymentSeconds: 300,
  faultAt: 0.3,
};

export interface SetupContext {
  readonly stores: Stores;
  readonly drop: TestDrop;
  /** The `orders.v1` partition of the drop's product, and its log end before the burst. */
  readonly partition: number;
  readonly partitionFrom: string;
  log(message: string): void;
  /** Evidence for the report: what the fault did, and what the stack did about it. */
  record(key: string, value: unknown): void;
  /** Audits Docker's restarts so far; call it before replacing a container, whose count leaves with it. */
  checkpoint(label: string): Promise<void>;
}

export interface ChaosContext extends SetupContext {
  readonly burst: Burst;
}

export interface Scenario {
  readonly name: string;
  /** The fault, in one line. */
  readonly fault: string;
  readonly load?: Partial<LoadPlan>;
  /** Before the burst starts. */
  prepare?(ctx: SetupContext): Promise<void>;
  /** Mid-burst: injects the fault, and lifts it where lifting is part of the case. */
  inject(ctx: ChaosContext): Promise<void>;
  /**
   * Once the stack is quiescent: what this fault in particular must have left behind (the evidence that it
   * struck, and was handled as §17 says). Returns the problems.
   */
  verify?(ctx: ChaosContext, burst: BurstResult): Promise<string[]>;
  /** Always runs, also after a failure: puts back whatever the scenario changed. Must be idempotent. */
  restore(): Promise<void>;
}

export interface ScenarioReport {
  readonly scenario: string;
  readonly fault: string;
  readonly ok: boolean;
  readonly problems: readonly string[];
  readonly startedAt: string;
  readonly durationMs: number;
  readonly drop: { readonly dropId: string; readonly productId: string; readonly partition: number } | null;
  readonly load: LoadPlan;
  readonly burst: Omit<BurstResult, 'orders'> | null;
  readonly outcomes: Readonly<Record<string, number>>;
  readonly invariants: { readonly exitCode: number; readonly report: string } | null;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly timeline: readonly { readonly atMs: number; readonly message: string }[];
}

/** How long verify:invariants may wait for quiescence: abandoned holds, a fault's backlog, the safety net. */
const QUIESCENCE_TIMEOUT_SECONDS = 300;

export async function runScenario(scenario: Scenario, resultsDir: string): Promise<ScenarioReport> {
  const started = Date.now();
  const plan: LoadPlan = { ...DEFAULT_LOAD, ...scenario.load };
  const problems: string[] = [];
  const timeline: { atMs: number; message: string }[] = [];
  const evidence: Record<string, unknown> = {};
  const outcomes: Record<string, number> = {};
  let dropInfo: ScenarioReport['drop'] = null;
  let burstSummary: ScenarioReport['burst'] = null;
  let invariants: ScenarioReport['invariants'] = null;

  const log = (message: string) => {
    const atMs = Date.now() - started;
    timeline.push({ atMs, message });
    console.log(`[${scenario.name} +${(atMs / 1000).toFixed(1).padStart(5)} s] ${message}`);
  };
  const record = (key: string, value: unknown) => {
    evidence[key] = value;
  };

  const finish = async (): Promise<ScenarioReport> => {
    const report: ScenarioReport = {
      scenario: scenario.name,
      fault: scenario.fault,
      ok: problems.length === 0,
      problems,
      startedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      drop: dropInfo,
      load: plan,
      burst: burstSummary,
      outcomes,
      invariants,
      evidence,
      timeline,
    };
    await writeFile(join(resultsDir, `${scenario.name}.json`), `${JSON.stringify(report, null, 2)}\n`);
    log(report.ok ? 'PASS' : `FAIL:\n  - ${problems.join('\n  - ')}`);
    return report;
  };

  let stores: Stores;
  let baseline: ContainerState[];
  try {
    baseline = await containers();
    stores = await connectStores({ redisLogger: throttledRedisLogger(log) });
  } catch (error) {
    problems.push(`the run could not start: ${describe(error)}`);
    return finish();
  }
  const restarted = new Set<string>();
  const checkpoint = async (label: string) => {
    for (const problem of restartsSince(baseline, await containers())) restarted.add(`${problem} (${label})`);
  };

  let restored = false;
  const restore = async () => {
    if (restored) return;
    restored = true;
    try {
      await scenario.restore();
    } catch (error) {
      problems.push(`restoring the stack failed: ${describe(error)}`);
    }
  };

  let burst: Burst | undefined;
  try {
    log(`fault: ${scenario.fault}`);
    const deadLettersBefore = await deadLetters(stores);
    const buyers = await createBuyers(plan.buyers);
    const drop = await postTestDrop({
      stock: plan.stock,
      perUserLimit: 1,
      holdSeconds: plan.holdSeconds,
      paymentSeconds: plan.paymentSeconds,
    });
    const partition = partitionOf(drop.productId);
    const partitionFrom = (await logEnds(stores.admin)).get(partition) ?? '0';
    dropInfo = { dropId: drop.dropId, productId: drop.productId, partition };
    log(`drop ${drop.dropId}: ${plan.stock} units, ${plan.buyers} buyers, orders.v1 partition ${partition}`);

    const setup: SetupContext = { stores, drop, partition, partitionFrom, log, record, checkpoint };
    await scenario.prepare?.(setup);

    const running = startBurst({
      baseUrl: new URL(process.env.E2E_BASE_URL ?? '').origin,
      dropId: drop.dropId,
      buyers,
      concurrency: plan.concurrency,
      paceMs: plan.paceMs,
    });
    burst = running;
    log(`burst started: ${plan.concurrency} lanes, ${plan.paceMs} ms pace`);

    let ended = false;
    running.finished.then(
      () => {
        ended = true;
      },
      () => {
        ended = true;
      },
    );
    let injected = false;
    try {
      await until(
        'the burst under way',
        async () => running.progress().handled,
        (handled) => ended || handled >= Math.ceil(plan.faultAt * plan.buyers),
        180_000,
      );
      if (ended) {
        await running.finished;
        throw new Error('the burst ended before the fault was due');
      }
      log(`mid-burst (${progressLine(running.progress())}): injecting the fault`);
      await scenario.inject({ ...setup, burst: running });
      injected = true;
      log(`fault handled; burst so far: ${progressLine(running.progress())}`);
    } catch (error) {
      problems.push(`fault injection failed: ${describe(error)}`);
      running.stop();
      // Put the stack back before judging it: the invariants must hold after a botched injection too.
      await restore();
    }

    let result: BurstResult | undefined;
    try {
      result = await running.finished;
      const { orders: _orders, ...summary } = result;
      burstSummary = summary;
      log(`burst done in ${(result.elapsedMs / 1000).toFixed(1)} s: ${progressLine(result)}`);
    } catch (error) {
      problems.push(`burst: ${describe(error)}`);
    }

    // verify:invariants' quiescence accepts a live hold that has not expired yet; the outcome check needs every
    // order ended, the abandoned ones by the sweeper once their hold runs out.
    log(`waiting for every order of the drop to end (abandoned holds expire after ${plan.holdSeconds} s)`);
    await until(
      'every order of the drop ended',
      () => liveOrders(stores, drop.dropId),
      (live) => live === 0,
      (plan.holdSeconds + QUIESCENCE_TIMEOUT_SECONDS) * 1000,
    ).catch((error: unknown) => problems.push(describe(error)));

    log(`verify:invariants (waits up to ${QUIESCENCE_TIMEOUT_SECONDS} s for quiescence)`);
    const reportPath = join(resultsDir, `${scenario.name}.invariants.json`);
    const exitCode = await verifyInvariants(reportPath, deadLettersBefore);
    invariants = { exitCode, report: reportPath };
    if (exitCode !== 0) problems.push(`verify:invariants exited ${exitCode} (report: ${reportPath})`);
    else log('verify:invariants: PASS');

    if (result !== undefined) {
      problems.push(...(await checkOutcomes(stores, result, outcomes)));
      log(`order outcomes: ${JSON.stringify(outcomes)}`);
      if (injected && scenario.verify !== undefined) {
        problems.push(...(await scenario.verify({ ...setup, burst: running }, result)));
      }
    }
    await checkpoint('end of run');
  } catch (error) {
    problems.push(`run failed: ${describe(error)}`);
  } finally {
    burst?.stop();
    await restore();
    try {
      await checkpoint('after restore');
      problems.push(...restarted, ...notHealthy(await containers()));
    } catch (error) {
      problems.push(`restart audit failed: ${describe(error)}`);
    }
    await stores.close();
  }
  return finish();
}

/** Every order the burst won ended where its buyer's choice leads; tallies them by status into `tally`. */
async function checkOutcomes(
  stores: Stores,
  burst: BurstResult,
  tally: Record<string, number>,
): Promise<string[]> {
  const statuses = await orderStatuses(stores, [...burst.orders.keys()]);
  const wrong: string[] = [];
  for (const [orderId, fate] of burst.orders) {
    const status = statuses.get(orderId) ?? 'MISSING';
    tally[status] = (tally[status] ?? 0) + 1;
    if (status !== FINAL_STATUS[fate])
      wrong.push(`${orderId} (${fate}) is ${status}, not ${FINAL_STATUS[fate]}`);
  }
  if (wrong.length === 0) return [];
  return [`${wrong.length} orders did not end as their buyers chose: ${wrong.slice(0, 5).join('; ')}`];
}

/**
 * `pnpm verify:invariants` against the target stack, its output passed through. `--max-dead-letters` is the
 * DLQ's size before the run, so a single event any consumer gave up on during the run fails INV-5.
 */
async function verifyInvariants(reportPath: string, maxDeadLetters: number): Promise<number> {
  const args = [
    '--import',
    'tsx',
    'tools/verify-invariants.ts',
    '--timeout',
    String(QUIESCENCE_TIMEOUT_SECONDS),
    '--out',
    reportPath,
    '--max-dead-letters',
    String(maxDeadLetters),
  ];
  const child = spawn(process.execPath, args, { cwd: REPO_ROOT, env: process.env, stdio: 'inherit' });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal === null ? 2 : 128)));
  });
}

export function progressLine(p: {
  readonly handled: number;
  readonly won: number;
  readonly soldOut: number;
  readonly checkedOut: number;
  readonly cancelled: number;
  readonly abandoned: number;
  readonly retries: Readonly<Record<string, number>>;
}): string {
  const retries = Object.entries(p.retries)
    .map(([cause, n]) => `${n}x ${cause}`)
    .join(', ');
  return (
    `${p.handled} answered, ${p.won} won, ${p.soldOut} sold out; ${p.checkedOut} checked out, ` +
    `${p.cancelled} cancelled, ${p.abandoned} abandoned; resends: ${retries || 'none'}`
  );
}

/**
 * The evidence client's Redis errors while a scenario has Redis down on purpose: one line per 10 s instead
 * of an error per reconnect attempt. The client reconnects by itself; nothing reads Redis through it then.
 */
function throttledRedisLogger(log: (message: string) => void): Pick<Console, 'warn'> {
  let lastAt = Number.NEGATIVE_INFINITY;
  return {
    warn: (details: unknown) => {
      const now = Date.now();
      if (now - lastAt < 10_000) return;
      lastAt = now;
      const err = typeof details === 'object' && details !== null && 'err' in details ? details.err : details;
      log(`evidence client: Redis unreachable (${describe(err)}); it reconnects by itself`);
    },
  };
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function resultsDirFor(runId: string): Promise<string> {
  const dir = join(REPO_ROOT, 'tests', 'chaos', 'results', runId);
  await mkdir(dir, { recursive: true });
  return dir;
}

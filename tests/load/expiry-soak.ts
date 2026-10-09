/**
 * Expiry soak (design §4.6, §13): reserve everything, never pay; once the holds run out, the sweeper
 * expires them and the settlement consumer (or the safety net) gives every unit back, so `avail = total`
 * again. Repeated for several rounds on one drop by the same buyers: a leak of a single unit, or of a
 * single buyer's quota (every round needs each buyer's full limit back), fails the next round.
 *
 *   pnpm load:expiry-soak                       100 units, 50 buyers at limit 2, 10 s holds, 3 rounds
 *   pnpm load:expiry-soak -e ROUNDS=10 -e UNITS=500
 *
 * Each round: every buyer reserves its full limit (1 unit per request, its own key per request), in
 * batches of concurrent requests; then one more buyer must be refused SOLD_OUT (everything is held); then
 * the stock must be fully back within the hold plus the sweep. Retryable answers (no answer, 502, 503, 504)
 * are resent with the same key. Strict thresholds: every unit reserved in every round, every probe refused,
 * every round's stock back, nothing unexpected, no 429 (the load profile raises the rate limits, §11).
 */
import { sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import {
  answerOf,
  createTestDrop,
  header,
  mintSessions,
  type ReserveRequest,
  readStock,
  reserve,
  reserveMany,
  type Stock,
} from './lib/api.ts';
import { intEnv } from './lib/config.ts';
import { uuidv7 } from './lib/ids.ts';
import { count, ms, type SummaryData, stat, summaryOutputs } from './lib/summary.ts';
import { isRetryable, retryDelaySeconds } from './lib/verdict.ts';

const UNITS = intEnv('UNITS', 100);
const ROUNDS = intEnv('ROUNDS', 3);
const PER_USER_LIMIT = 2;
/** The shortest hold a drop may have (§3: `hold_seconds BETWEEN 10 AND 900`). */
const HOLD_SECONDS = 10;
/** Reserves in flight at once. */
const BATCH = 50;
/** After a round's last hold runs out: expire-orders (1 s), settlement or the safety net (≤ 15 s), §4.6. */
const RETURN_GRACE_SECONDS = 45;
const MAX_ATTEMPTS = 5;
if (UNITS < PER_USER_LIMIT || UNITS % PER_USER_LIMIT !== 0 || ROUNDS < 1) {
  throw new Error(`UNITS must be a positive multiple of ${PER_USER_LIMIT}, ROUNDS at least 1`);
}
/** Enough buyers to hold everything at the limit, plus the one who probes for SOLD_OUT. */
const BUYERS = UNITS / PER_USER_LIMIT + 1;
const ROUND_SECONDS = HOLD_SECONDS + RETURN_GRACE_SECONDS + 30;

const reserveDuration = new Trend('soak_reserve_duration', true);
const reserved = new Counter('soak_reserved');
const refusedProbe = new Counter('soak_probe_sold_out');
const retried = new Counter('soak_retry');
const rateLimited = new Counter('soak_rate_limited');
const unexpected = new Counter('soak_unexpected');
const returned = new Rate('soak_returned');
const returnSeconds = new Trend('soak_return_seconds');

export const options = {
  setupTimeout: '60s',
  scenarios: {
    soak: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: `${ROUNDS * ROUND_SECONDS + 60}s`,
    },
  },
  // One VU sends whole batches through http.batch; k6 otherwise caps a batch at 6 requests per host.
  batch: BATCH,
  batchPerHost: BATCH,
  thresholds: {
    soak_reserved: [`count==${ROUNDS * UNITS}`],
    soak_probe_sold_out: [`count==${ROUNDS}`],
    soak_returned: ['rate==1'],
    soak_unexpected: ['count==0'],
    soak_rate_limited: ['count==0'],
  },
  summaryTrendStats: ['count', 'med', 'p(95)', 'max'],
};

interface SoakData {
  readonly dropId: string;
  readonly tokens: readonly string[];
}

export function setup(): SoakData {
  const tokens = mintSessions(BUYERS).map((session) => session.token);
  const drop = createTestDrop({
    stock: UNITS,
    perUserLimit: PER_USER_LIMIT,
    holdSeconds: HOLD_SECONDS,
    durationSeconds: ROUNDS * ROUND_SECONDS + 300,
  });
  console.log(`expiry-soak: drop ${drop.dropId}, ${UNITS} units, ${BUYERS} buyers, ${ROUNDS} rounds`);
  return { dropId: drop.dropId, tokens };
}

function report(detail: string): void {
  console.error(`expiry-soak: ${detail}`);
}

/** Sends every request, `BATCH` at a time, resending retryable answers with the same key. */
function reserveAll(dropId: string, requests: readonly ReserveRequest[]): ReturnType<typeof answerOf>[] {
  const answers: ReturnType<typeof answerOf>[] = [];
  let pending = [...requests];
  for (let attempt = 1; pending.length > 0; attempt += 1) {
    const again: ReserveRequest[] = [];
    let delay = 0;
    for (let start = 0; start < pending.length; start += BATCH) {
      const chunk = pending.slice(start, start + BATCH);
      reserveMany(dropId, chunk).forEach((response, index) => {
        reserveDuration.add(response.timings.duration);
        const request = chunk[index];
        if (isRetryable(response.status) && attempt < MAX_ATTEMPTS && request !== undefined) {
          retried.add(1);
          again.push(request);
          delay = Math.max(delay, retryDelaySeconds(header(response, 'Retry-After')));
        } else {
          answers.push(answerOf(response));
        }
      });
    }
    pending = again;
    if (pending.length > 0) sleep(delay);
  }
  return answers;
}

export default function (data: SoakData): void {
  const holders = data.tokens.slice(0, -1);
  const probe = data.tokens[data.tokens.length - 1];
  if (probe === undefined) throw new Error('no buyers');
  for (let round = 1; round <= ROUNDS; round += 1) {
    // Every buyer takes its whole limit, one unit per request and key: everything ends up held.
    const requests = holders.flatMap((token) =>
      Array.from({ length: PER_USER_LIMIT }, () => ({ token, idempotencyKey: uuidv7(), qty: 1 })),
    );
    for (const answer of reserveAll(data.dropId, requests)) {
      if (answer.status === 201 && answer.order?.status === 'RESERVED') reserved.add(1);
      else if (answer.status === 429) rateLimited.add(1);
      else {
        unexpected.add(1);
        report(
          `round ${round}: reserve answered ${answer.status} ${answer.code ?? ''}: a unit or a quota leaked`,
        );
      }
    }
    const lastHoldAt = Date.now();

    const probeAnswer = answerOf(reserve(data.dropId, { token: probe, idempotencyKey: uuidv7(), qty: 1 }));
    if (probeAnswer.status === 409 && probeAnswer.code === 'SOLD_OUT') refusedProbe.add(1);
    else {
      unexpected.add(1);
      report(
        `round ${round}: the probe answered ${probeAnswer.status} ${probeAnswer.code ?? ''}, not SOLD_OUT`,
      );
    }

    // Nobody pays: every hold must expire and come back.
    const expiresAt = lastHoldAt + HOLD_SECONDS * 1_000;
    const deadline = expiresAt + RETURN_GRACE_SECONDS * 1_000;
    let stock: Stock | undefined;
    for (;;) {
      try {
        stock = readStock(data.dropId);
        if (stock.avail === UNITS && stock.held === 0 && stock.sold === 0) {
          returned.add(true);
          returnSeconds.add(Math.max(0, (Date.now() - expiresAt) / 1_000));
          break;
        }
      } catch (error) {
        report(`round ${round}: ${String(error)}`);
      }
      if (Date.now() > deadline) {
        returned.add(false);
        report(`round ${round}: stock did not come back: ${JSON.stringify(stock)}; is the sweeper running?`);
        return;
      }
      sleep(0.5);
    }
  }
}

export function handleSummary(data: SummaryData): Record<string, string> {
  const setup = data.setup_data as Partial<SoakData> | undefined;
  const lines = [
    `expiry-soak: ${ROUNDS} rounds of ${UNITS} units held by ${BUYERS - 1} buyers, never paid, ${HOLD_SECONDS} s holds, drop ${setup?.dropId ?? '(setup failed)'}`,
    `  reserved ${count(data, 'soak_reserved')} of ${ROUNDS * UNITS}, SOLD_OUT probes ${count(data, 'soak_probe_sold_out')} of ${ROUNDS}, retried ${count(data, 'soak_retry')}, 429 ${count(data, 'soak_rate_limited')}, unexpected ${count(data, 'soak_unexpected')}`,
    `  reserve latency p50 ${ms(stat(data, 'soak_reserve_duration', 'med'))}, p95 ${ms(stat(data, 'soak_reserve_duration', 'p(95)'))}`,
    `  stock back after the holds expired: ${count(data, 'soak_return_seconds')} of ${ROUNDS} rounds, slowest ${stat(data, 'soak_return_seconds', 'max').toFixed(1)} s, median ${stat(data, 'soak_return_seconds', 'med').toFixed(1)} s`,
  ];
  return summaryOutputs(
    'expiry-soak',
    data,
    { script: 'expiry-soak', dropId: setup?.dropId, units: UNITS, rounds: ROUNDS, holdSeconds: HOLD_SECONDS },
    lines,
  );
}

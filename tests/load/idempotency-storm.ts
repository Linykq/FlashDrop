/**
 * Idempotency storm (design §4.5, §13), reserve part: 50 identical reserves (one buyer, one
 * Idempotency-Key, one body) fired at the same instant give exactly one hold. Exactly one answer is 201;
 * the other 49 are 200 replays with `Idempotency-Replayed: true`; all 50 name the order id
 * `uuidv5(userId:dropId:key)`. Never a 429: the load profile raises the per-user rate limit, so the result
 * proves that Lua and the primary key serialize same-key requests, not that the limiter dropped them.
 *
 * A retryable answer (no answer, 502, 503, 504: the drop RECONCILING after a nudge, the Postgres breaker, an
 * api restarting behind Caddy) is resent with the same key and body after `Retry-After`, as the storefront
 * does, and only the final answer is judged: it must still be the one 201 or a 200 replay of the same order.
 *
 *   pnpm load:idempotency
 *
 * The checkout part (20 identical checkouts give one order and one charge) joins in M3/M4.
 */
import { sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { answerOf, createTestDrop, header, mintSessions, readStock, reserve, type Stock } from './lib/api.ts';
import { reservationId, uuidv7 } from './lib/ids.ts';
import { count, ms, type SummaryData, stat, summaryOutputs } from './lib/summary.ts';
import { isRetryable, judgeStormAnswer, retryDelaySeconds } from './lib/verdict.ts';

const REQUESTS = 50;
const UNITS = 10;
const QTY = 1;
/** Every VU waits for this moment, so the 50 requests leave together rather than as VUs start. */
const BARRIER_MS = 1_000;
/** Sends of one request before its last retryable answer counts as wrong. */
const MAX_ATTEMPTS = 5;

const duration = new Trend('storm_duration', true);
const created = new Counter('storm_created');
const replayed = new Counter('storm_replayed');
const wrong = new Counter('storm_wrong_answers');
const retried = new Counter('storm_retry');
const oneHold = new Rate('storm_one_hold');

export const options = {
  setupTimeout: '60s',
  scenarios: {
    storm: {
      executor: 'per-vu-iterations',
      vus: REQUESTS,
      iterations: 1,
      maxDuration: '60s',
      gracefulStop: '15s',
    },
  },
  thresholds: {
    storm_created: ['count==1'],
    storm_replayed: [`count==${REQUESTS - 1}`],
    storm_wrong_answers: ['count==0'],
    storm_one_hold: ['rate==1'],
  },
  summaryTrendStats: ['count', 'med', 'p(95)', 'max'],
};

interface StormData {
  readonly dropId: string;
  readonly token: string;
  readonly idempotencyKey: string;
  /** The order every answer must name. */
  readonly rid: string;
  readonly fireAt: number;
}

export function setup(): StormData {
  const [buyer] = mintSessions(1);
  if (buyer === undefined) throw new Error('POST /test/sessions minted no session');
  const drop = createTestDrop({ stock: UNITS, perUserLimit: 2, holdSeconds: 120, durationSeconds: 600 });
  const idempotencyKey = uuidv7();
  return {
    dropId: drop.dropId,
    token: buyer.token,
    idempotencyKey,
    rid: reservationId(buyer.userId, drop.dropId, idempotencyKey),
    fireAt: Date.now() + BARRIER_MS,
  };
}

export default function (data: StormData): void {
  const wait = data.fireAt - Date.now();
  if (wait > 0) sleep(wait / 1_000);
  const request = { token: data.token, idempotencyKey: data.idempotencyKey, qty: QTY };
  for (let attempt = 1; ; attempt += 1) {
    const response = reserve(data.dropId, request);
    duration.add(response.timings.duration);
    if (isRetryable(response.status) && attempt < MAX_ATTEMPTS) {
      retried.add(1);
      sleep(retryDelaySeconds(header(response, 'Retry-After')));
      continue;
    }
    const answer = answerOf(response);
    const verdict = judgeStormAnswer({ rid: data.rid, qty: QTY }, answer);
    if (verdict === 'created') created.add(1);
    else if (verdict === 'replayed') replayed.add(1);
    else {
      wrong.add(1);
      const hint = response.status === 429 ? ' (raise RATE_LIMIT_USER_PER_SEC for the load profile)' : '';
      console.error(
        `attempt ${attempt} answered ${response.status} ${answer.code ?? answer.order?.id ?? ''}${hint}`,
      );
    }
    return;
  }
}

/** Exactly one hold: `held` is one request's qty, and `avail` lost exactly that much. */
export function teardown(data: StormData): void {
  // Always one sample: k6 passes a threshold on a metric that never got one.
  let stock: Stock | string;
  try {
    stock = readStock(data.dropId);
  } catch (error) {
    stock = String(error);
  }
  const ok =
    typeof stock !== 'string' && stock.held === QTY && stock.avail === UNITS - QTY && stock.sold === 0;
  oneHold.add(ok);
  if (!ok) console.error(`expected one hold of ${QTY} on ${UNITS} units, stock is ${JSON.stringify(stock)}`);
}

export function handleSummary(data: SummaryData): Record<string, string> {
  const setup = data.setup_data as Partial<StormData> | undefined;
  const lines = [
    `idempotency-storm: ${REQUESTS} identical reserves on drop ${setup?.dropId ?? '(setup failed)'}`,
    `  created ${count(data, 'storm_created')}, replayed ${count(data, 'storm_replayed')}, wrong ${count(data, 'storm_wrong_answers')}, retried ${count(data, 'storm_retry')}; one hold: ${stat(data, 'storm_one_hold', 'rate') === 1 ? 'yes' : 'NO'}`,
    `  latency p50 ${ms(stat(data, 'storm_duration', 'med'))}, max ${ms(stat(data, 'storm_duration', 'max'))}: the replays wait for the first commit`,
  ];
  return summaryOutputs(
    'idempotency-storm',
    data,
    { script: 'idempotency-storm', dropId: setup?.dropId, rid: setup?.rid, requests: REQUESTS },
    lines,
  );
}

/**
 * Idempotency storm (design §4.5, §13): one buyer, one intent, many identical requests at the same instant.
 *
 * - Reserve: 50 identical reserves (one Idempotency-Key, one body) give exactly one hold. Exactly one answer
 *   is 201; the other 49 are 200 replays with `Idempotency-Replayed: true`; all 50 name the order id
 *   `uuidv5(userId:dropId:key)`.
 * - Checkout: 20 identical submits of that order (one checkout key, one body, `pm_ok`) give exactly one
 *   submission (one 202, 19 replays), then exactly one order, PAID, and exactly one charge in the PSP's book
 *   for it, succeeded and for the order's total, never refunded.
 *
 * Never a 429: the load profile raises the per-user rate limit, so the result proves that Lua, the primary
 * key and the checkout CAS serialize same-key requests, not that the limiter dropped them. A retryable answer
 * (no answer, 502, 503, 504) is resent with the same key and body after `Retry-After`, as the storefront
 * does, and only the final answer is judged.
 *
 *   pnpm load:idempotency
 *
 * The charge is read from payment-mock (`PSP_URL`, on the Compose network); `-e PSP_URL=` skips that check
 * with a warning, for a run from the host without a reachable PSP.
 */
import { sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import {
  answerOf,
  checkout,
  createTestDrop,
  header,
  listOrders,
  mintSessions,
  pspCharges,
  readOrderStatus,
  readStock,
  reserve,
  type Stock,
} from './lib/api.ts';
import { PSP_URL } from './lib/config.ts';
import { reservationId, uuidv7 } from './lib/ids.ts';
import { count, ms, type SummaryData, stat, summaryOutputs } from './lib/summary.ts';
import { isRetryable, judgeStormAnswer, retryDelaySeconds } from './lib/verdict.ts';

const REQUESTS = 50;
const CHECKOUTS = 20;
const UNITS = 10;
const QTY = 1;
/** Every VU waits for this moment, so the requests leave together rather than as VUs start. */
const BARRIER_MS = 1_000;
/** When the checkout storm fires, after setup; the reserve storm is long done by then. */
const CHECKOUT_AT_MS = 10_000;
/** Sends of one request before its last retryable answer counts as wrong. */
const MAX_ATTEMPTS = 5;
/** How long the payment consumer may take to decide the order (it retries a PSP 503 or timeout). */
const PAYMENT_DEADLINE_MS = 60_000;
/** How long the settlement consumer, or the safety net, may take to apply PAID to Redis. */
const SETTLE_DEADLINE_MS = 30_000;
const CHECK_PSP = PSP_URL !== '';

const duration = new Trend('storm_duration', true);
const created = new Counter('storm_created');
const replayed = new Counter('storm_replayed');
const wrong = new Counter('storm_wrong_answers');
const retried = new Counter('storm_retry');
const checkoutDuration = new Trend('storm_checkout_duration', true);
const submitted = new Counter('storm_checkout_submitted');
const checkoutReplayed = new Counter('storm_checkout_replayed');
const checkoutWrong = new Counter('storm_checkout_wrong_answers');
const onePaidOrder = new Rate('storm_one_paid_order');
const oneCharge = new Rate('storm_one_charge');
const stockSold = new Rate('storm_stock_sold_once');

export const options = {
  setupTimeout: '60s',
  teardownTimeout: '120s',
  scenarios: {
    storm: {
      executor: 'per-vu-iterations',
      vus: REQUESTS,
      iterations: 1,
      maxDuration: '60s',
      gracefulStop: '15s',
    },
    checkout: {
      executor: 'per-vu-iterations',
      exec: 'checkoutStorm',
      vus: CHECKOUTS,
      iterations: 1,
      maxDuration: '60s',
      gracefulStop: '15s',
    },
  },
  // The one 201 and 202 are judged within the storm: concurrent copies race, and exactly one wins.
  thresholds: {
    storm_created: ['count==1'],
    storm_replayed: [`count==${REQUESTS - 1}`],
    storm_wrong_answers: ['count==0'],
    storm_checkout_submitted: ['count==1'],
    storm_checkout_replayed: [`count==${CHECKOUTS - 1}`],
    storm_checkout_wrong_answers: ['count==0'],
    storm_one_paid_order: ['rate==1'],
    storm_one_charge: ['rate==1'],
    storm_stock_sold_once: ['rate==1'],
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
  /** The one checkout key all submits share, created once per order as the checkout form does (§8.2). */
  readonly checkoutKey: string;
  readonly checkoutAt: number;
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
    checkoutKey: uuidv7(),
    checkoutAt: Date.now() + CHECKOUT_AT_MS,
  };
}

/** The reserve storm: one identical reserve per VU. */
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
    const verdict = judgeStormAnswer({ rid: data.rid, qty: QTY, changedBy: 201 }, answer);
    if (verdict === 'changed') created.add(1);
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

/**
 * The checkout storm: one identical submit per VU, all at one instant once the storm's order exists. The
 * thresholds require exactly one 202 among them; every other answer must replay it.
 */
export function checkoutStorm(data: StormData): void {
  // The reserve storm is done long before `checkoutAt`; a stack that answered it with 503s for longer
  // makes the submits wait for the order instead of failing with 404.
  waitFor(CHECKOUT_AT_MS, () => readOrderStatus(data.token, data.rid) !== undefined);
  const wait = data.checkoutAt - Date.now();
  if (wait > 0) sleep(wait / 1_000);
  const request = {
    token: data.token,
    orderId: data.rid,
    idempotencyKey: data.checkoutKey,
    paymentMethod: 'pm_ok',
  };
  for (let attempt = 1; ; attempt += 1) {
    const response = checkout(request);
    checkoutDuration.add(response.timings.duration);
    if (isRetryable(response.status) && attempt < MAX_ATTEMPTS) {
      sleep(retryDelaySeconds(header(response, 'Retry-After')));
      continue;
    }
    const verdict = judgeStormAnswer({ rid: data.rid, qty: QTY, changedBy: 202 }, answerOf(response));
    if (verdict === 'changed') submitted.add(1);
    else if (verdict === 'replayed') checkoutReplayed.add(1);
    else {
      checkoutWrong.add(1);
      console.error(
        `checkout attempt ${attempt} answered ${response.status} ${String(response.body).slice(0, 200)}`,
      );
    }
    return;
  }
}

/**
 * After both storms: exactly one order, PAID; exactly one charge for it, succeeded; the stock sold exactly
 * one unit and holds none. Each check waits for the consumers first.
 */
export function teardown(data: StormData): void {
  verdict(onePaidOrder, () => {
    const paid = waitFor(PAYMENT_DEADLINE_MS, () => readOrderStatus(data.token, data.rid) === 'PAID');
    const mine = listOrders(data.token);
    const ok = paid && mine.length === 1 && mine[0]?.id === data.rid && mine[0].status === 'PAID';
    return ok || `expected one PAID order ${data.rid}, the buyer has ${JSON.stringify(mine)}`;
  });
  if (CHECK_PSP) {
    verdict(oneCharge, () => {
      const charges = pspCharges(data.rid);
      const ok = charges.length === 1 && charges[0]?.status === 'succeeded';
      return ok || `expected one succeeded charge for ${data.rid}, the PSP has ${JSON.stringify(charges)}`;
    });
  } else {
    console.warn('PSP_URL is empty: the PSP charge count is NOT checked');
  }
  verdict(stockSold, () => {
    let stock: Stock | undefined;
    const ok = waitFor(SETTLE_DEADLINE_MS, () => {
      try {
        stock = readStock(data.dropId);
      } catch {
        // Keep polling: the api may be busy for a moment.
        return false;
      }
      return stock.sold === QTY && stock.held === 0 && stock.avail === UNITS - QTY;
    });
    return ok || `expected ${QTY} sold of ${UNITS} and none held, stock is ${JSON.stringify(stock)}`;
  });
}

/**
 * Records one teardown check: `check` returns true, or why it failed. A rate without a sample passes its
 * threshold, so a check that throws (the api or the PSP unreachable) is recorded as failed, never skipped.
 */
function verdict(rate: Rate, check: () => true | string): void {
  let outcome: true | string;
  try {
    outcome = check();
  } catch (error) {
    outcome = String(error);
  }
  rate.add(outcome === true);
  if (outcome !== true) console.error(outcome);
}

/** Polls `done` every 250 ms until it holds or `ms` passes. */
function waitFor(ms: number, done: () => boolean): boolean {
  const deadline = Date.now() + ms;
  for (;;) {
    if (done()) return true;
    if (Date.now() > deadline) return false;
    sleep(0.25);
  }
}

export function handleSummary(data: SummaryData): Record<string, string> {
  const setup = data.setup_data as Partial<StormData> | undefined;
  const yes = (metric: string) => (stat(data, metric, 'rate') === 1 ? 'yes' : 'NO');
  const lines = [
    `idempotency-storm: ${REQUESTS} identical reserves, then ${CHECKOUTS} identical checkouts, on drop ${setup?.dropId ?? '(setup failed)'}`,
    `  reserve: created ${count(data, 'storm_created')}, replayed ${count(data, 'storm_replayed')}, wrong ${count(data, 'storm_wrong_answers')}, retried ${count(data, 'storm_retry')}`,
    `  reserve latency p50 ${ms(stat(data, 'storm_duration', 'med'))}, max ${ms(stat(data, 'storm_duration', 'max'))}: the replays wait for the first commit`,
    `  checkout: submitted ${count(data, 'storm_checkout_submitted')}, replayed ${count(data, 'storm_checkout_replayed')}, wrong ${count(data, 'storm_checkout_wrong_answers')}; p50 ${ms(stat(data, 'storm_checkout_duration', 'med'))}, max ${ms(stat(data, 'storm_checkout_duration', 'max'))}`,
    `  one PAID order: ${yes('storm_one_paid_order')}; one charge: ${CHECK_PSP ? yes('storm_one_charge') : 'not checked (PSP_URL empty)'}; stock sold once: ${yes('storm_stock_sold_once')}`,
  ];
  return summaryOutputs(
    'idempotency-storm',
    data,
    {
      script: 'idempotency-storm',
      dropId: setup?.dropId,
      rid: setup?.rid,
      requests: REQUESTS,
      checkouts: CHECKOUTS,
      pspChecked: CHECK_PSP,
    },
    lines,
  );
}

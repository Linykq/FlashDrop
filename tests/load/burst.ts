/**
 * Burst (design §13): a flash sale opening on a fresh drop. Many buyers reserve at once; about 30% of the
 * requests repeat a key with the same body, either later (a network retry) or concurrently (a double click,
 * both copies in flight together). A retryable answer (no answer, 502, 503, 504) is resent with the same key
 * after `Retry-After`, within the same iteration, as the storefront does: that retry is what heals a hold
 * Lua granted and Postgres never recorded (§4.5).
 *
 * Of the winners, 70% check out (90% `pm_ok`, 10% `pm_decline`; `-e DECLINE_SHARE=0.3` for the M4 demo),
 * 20% cancel and 10% walk away. A checkout is one submit with its own key, then a poll of the order until
 * the payment consumer decides it (§5.2, §6.5): that is the submit-to-PAID latency of §1.
 *
 *   pnpm load:burst                          PROFILE=ci: 100 units, 1,000 buyers; an opening spike of 300
 *                                            buyers firing together, then 300 reserves/s for 20 s
 *   pnpm load:burst -e PROFILE=laptop        1,000 units, 10,000 buyers, 2,000 reserves/s for 30 s
 *   pnpm load:burst -e PROFILE=nightly       300 units, 3,000 buyers; the opening spike, then 600/s for 30 s
 *   pnpm demo:burst                          PROFILE=demo, opening 20 s after setup: 2,000 reserves, 500 in
 *                                            flight at a time, from 300 buyers on 100 units; then
 *                                            `verify:invariants`
 *   pnpm load:burst -e PROFILE=demo -e DECLINE_SHARE=0.3 && pnpm verify:invariants
 *                                            the M4 demo: 30% of checkouts declined, and their stock comes back
 *   ... -e MODE=reserve-only                 (M2) reserves only: every hold is abandoned
 *   ... -e OPEN_DELAY_S=20                   the drop opens 20 s after setup (SCHEDULED until then), so its
 *                                            dashboard, whose URL the run prints first, is open before the sale
 *
 * The opening spike is what makes the run contended: an arrival rate alone spaces requests a few ms apart,
 * and at a few ms per reserve that sells the stock almost one request at a time.
 *
 * Correctness thresholds are strict. Both modes: every replay answers with the order it replays, no 429 (the
 * load profile raises the rate limits, §11), nothing unexpected. reserve-only: exactly `units` distinct
 * orders (every request asks for 1 unit; nothing comes back before the holds expire) and then all of the
 * stock back. full: every unit sold at least once, never more PAID orders than units, every submit accepted
 * once, every `pm_ok` order PAID and every `pm_decline` order PAYMENT_FAILED within the deadline, no
 * cancel answered other than CANCELLED or a counted CONFLICT, and at the end nothing held and `avail + sold = units`: declined, cancelled and
 * abandoned stock came back. Postgres, the ledger and the event pipeline are `verify:invariants`' to check.
 * Latency thresholds are loose (ci, laptop) or absent (reported only).
 */
import { sleep } from 'k6';
import exec from 'k6/execution';
import { Counter, Rate, Trend } from 'k6/metrics';
import {
  answerOf,
  cancel,
  checkout,
  createTestDrop,
  header,
  mintSessions,
  readOrderStatus,
  readStock,
  type reserve,
  reserveCopies,
  type Stock,
} from './lib/api.ts';
import { intEnv, ORIGIN } from './lib/config.ts';
import { uuidv7 } from './lib/ids.ts';
import { count, ms, type SummaryData, stat, summaryOutputs } from './lib/summary.ts';
import {
  type BurstPaymentMethod,
  byJudgingOrder,
  byJudgingOrderWithReturns,
  type CheckoutState,
  type IntentState,
  isRetryable,
  judgeCancel,
  judgeCheckout,
  judgePayment,
  judgeReserve,
  pickFate,
  pickPaymentMethod,
  retryDelaySeconds,
  SETTLED_PAYMENT_STATUSES,
} from './lib/verdict.ts';

interface Profile {
  readonly units: number;
  readonly buyers: number;
  readonly perUserLimit: number;
  /**
   * The sale opening: `vus` buyers wait for one shared instant, then each runs `iterations` iterations
   * back to back. The `burst` scenario follows `OPENING_SECONDS` later.
   */
  readonly opening?: { readonly vus: number; readonly iterations: number; readonly p95Ms?: number };
  /**
   * `rate`: reserves per second from the first second, for `seconds`.
   * `count`: exactly `requests` reserves, `vus` in flight at a time, within `seconds` at most; an arrival
   * rate would drop requests whenever the stack is slower than the rate.
   */
  readonly load:
    | { readonly kind: 'rate'; readonly rate: number; readonly seconds: number; readonly maxVUs: number }
    | { readonly kind: 'count'; readonly requests: number; readonly seconds: number };
  /**
   * Longer than the opening plus the burst, so no abandoned hold expires and is sold again while the run
   * sends: in reserve-only mode `units` orders stay exact. Kept short so that teardown sees the stock come
   * back soon.
   */
  readonly holdSeconds: number;
  readonly vus: number;
  /** Loose p95 gate on the `burst` scenario's reserves; undefined: reported only (§1 scale targets). */
  readonly p95Ms?: number;
  /**
   * Loose p95 gate on submit to PAID; undefined: reported only. §1 targets < 5 s in CI and < 2 s on the
   * laptop, but every withheld PSP answer (timeout after success, 1% of charges) holds the payment consumer's
   * whole batch, on the one partition a flash sale lives on, until its 5 s PSP timeout (§6.4 bounded
   * batches), and every order placed meanwhile waits too: measured p95 about 12 s in the ci profile. The gate
   * catches a stall beyond a couple of those.
   */
  readonly paidP95Ms?: number;
  /**
   * How often a buyer polls its order while the payment consumer works: the resolution of submit to PAID.
   * Every checkout polls at once in a big profile, so it polls less often there, to keep the polls from
   * loading the api the reserves are measured on.
   */
  readonly paymentPollSeconds: number;
}

const PROFILES: Readonly<Record<string, Profile>> = {
  ci: {
    units: 100,
    buyers: 1_000,
    perUserLimit: 2,
    // The winners queue on one hot inventory row (§5.2): about 0.5 to 1.3 s at p95 on a 12-thread laptop,
    // so a 4-vCPU runner gets headroom. Correctness is the gate; this catches a pathological stall.
    opening: { vus: 300, iterations: 2, p95Ms: 5_000 },
    load: { kind: 'rate', rate: 300, seconds: 20, maxVUs: 400 },
    holdSeconds: 40,
    vus: 100,
    paymentPollSeconds: 0.2,
    p95Ms: 500,
    paidP95Ms: 20_000,
  },
  nightly: {
    units: 300,
    buyers: 3_000,
    perUserLimit: 2,
    opening: { vus: 300, iterations: 2 },
    load: { kind: 'rate', rate: 600, seconds: 30, maxVUs: 600 },
    holdSeconds: 50,
    vus: 150,
    paymentPollSeconds: 0.5,
  },
  laptop: {
    units: 1_000,
    buyers: 10_000,
    perUserLimit: 2,
    load: { kind: 'rate', rate: 2_000, seconds: 30, maxVUs: 1_000 },
    holdSeconds: 40,
    vus: 300,
    paymentPollSeconds: 0.5,
    p95Ms: 100,
  },
  demo: {
    units: 100,
    buyers: 300,
    perUserLimit: 2,
    load: { kind: 'count', requests: 2_000, seconds: 10 },
    holdSeconds: 15,
    vus: 500,
    paymentPollSeconds: 0.2,
  },
};

const MODES = ['full', 'reserve-only'] as const;
type Mode = (typeof MODES)[number];

const PROFILE = __ENV.PROFILE || 'ci';
const MODE = (__ENV.MODE || 'full') as Mode;
const profile: Profile = (() => {
  const selected = PROFILES[PROFILE];
  if (selected === undefined) {
    throw new Error(`PROFILE=${PROFILE} is unknown; use one of ${Object.keys(PROFILES).join(', ')}`);
  }
  return selected;
})();
if (!MODES.includes(MODE)) throw new Error(`MODE=${MODE} is unknown; use one of ${MODES.join(', ')}`);
const FULL = MODE === 'full';

/** Share of sends that resend a remembered request of the same VU later (a network retry). */
const RESEND_SHARE = 0.2;
/** Share of sends that go out as two concurrent copies (a double click): about 30% repeats in all (§13). */
const DOUBLE_CLICK_SHARE = 0.1;
/** Each VU remembers its last few requests to resend; a resend follows its original within seconds. */
const RECENT_REQUESTS = 32;
const QTY = 1;
/** What a winner does with its hold (§13). */
const FATES = { checkout: 0.7, cancel: 0.2 } as const;
/** Share of checkouts paid with `pm_decline`: 10% (§13); the M4 demo runs 30%. */
const DECLINE_SHARE = Number(__ENV.DECLINE_SHARE || '0.1');
if (!(DECLINE_SHARE >= 0 && DECLINE_SHARE <= 1)) throw new Error('DECLINE_SHARE must be between 0 and 1');
/**
 * How long a submitted order may take to be decided. Generous: a PSP 503 or a withheld success (timeout
 * after success) makes the payment consumer pause the partition and retry with backoff (§6.4).
 */
const PAYMENT_DEADLINE_SECONDS = 60;
/** The drop stays open long enough for a slow setup; it is a fresh, isolated drop either way. */
const DROP_SECONDS = 600;
/**
 * Seconds from setup to the drop's opening (design §9's dashboard, watched live): the run prints where to
 * watch, and nothing reserves before the drop opens.
 */
const OPEN_DELAY_SECONDS = intEnv('OPEN_DELAY_S', 0);
/** Every opening VU waits for this moment after setup, so they fire together rather than as VUs start. */
const BARRIER_MS = 1_000;
/** A VU that fires within this long of the shared instant counts as on time. */
const ON_TIME_MS = 250;
/** Share of opening VUs that must fire on time: proof that the opening was contended, not sequential. */
const ON_TIME_SHARE = 0.9;
/** When the `burst` scenario starts after an opening; it overlaps the opening's tail. */
const OPENING_SECONDS = 5;
/**
 * Iterations still running when a scenario ends get this long to finish their retries, and in full mode
 * their payment, so no decided order goes uncounted.
 */
const GRACEFUL_STOP_SECONDS = FULL ? PAYMENT_DEADLINE_SECONDS + 15 : 15;
/** After the last hold expires: expire-orders (1 s), then settle-safety-net (10 s age, 5 s period), §4.6. */
const RETURN_GRACE_SECONDS = 45;
/** `RETURN_CHECK=0` skips waiting for the stock to come back, e.g. while iterating on the burst itself. */
const RETURN_CHECK = __ENV.RETURN_CHECK !== '0';
/** Unexpected answers logged per VU; the counters carry the rest. */
const MAX_LOGGED = 5;
/** Sends of one request before giving up on retryable answers; its hold, if any, is an orphan then. */
const MAX_ATTEMPTS = 5;

const opening = profile.opening;
/**
 * From the start of the scenarios, which follows setup, to the drop's opening, plus a second, so that no
 * reserve reaches Lua before the drop's `startsAt` (Lua refuses a drop that has not opened yet).
 */
const leadSeconds = OPEN_DELAY_SECONDS > 0 ? OPEN_DELAY_SECONDS + 1 : 0;
const burstStartSeconds = leadSeconds + (opening === undefined ? 0 : OPENING_SECONDS);
/** From the first reserve to the last new one; retries may run `GRACEFUL_STOP_SECONDS` longer. */
const loadSeconds = burstStartSeconds + profile.load.seconds;

const reserveDuration = new Trend('reserve_duration', true);
const winnerDuration = new Trend('reserve_winner_duration', true);
const orders = new Counter('reserve_orders');
const created = new Counter('reserve_created');
const replayed = new Counter('reserve_replayed');
const doubleClicks = new Counter('reserve_double_clicks');
const soldOut = new Counter('reserve_sold_out');
const limitReached = new Counter('reserve_limit_reached');
const expired = new Counter('reserve_expired');
const retried = new Counter('reserve_retry');
const rateLimited = new Counter('reserve_rate_limited');
const transportErrors = new Counter('reserve_transport_errors');
const gaveUp = new Counter('reserve_gave_up');
const unexpected = new Counter('reserve_unexpected');
const replayMismatch = new Counter('reserve_replay_mismatch');
const openingOnTime = new Counter('opening_on_time');
const stockReturned = new Rate('stock_returned');
const stockReturnSeconds = new Trend('stock_return_seconds');
const finalSold = new Trend('final_sold');

const checkoutDuration = new Trend('checkout_duration', true);
const checkoutSubmitted = new Counter('checkout_submitted');
const checkoutReplayed = new Counter('checkout_replayed');
const checkoutRetried = new Counter('checkout_retry');
const checkoutExpired = new Counter('checkout_expired');
const checkoutMismatch = new Counter('checkout_mismatch');
const checkoutUnexpected = new Counter('checkout_unexpected');
const submitToPaid = new Trend('submit_to_paid', true);
const submitToDeclined = new Trend('submit_to_declined', true);
const paymentPaid = new Counter('payment_paid');
const paymentDeclined = new Counter('payment_declined');
const paymentWrong = new Counter('payment_wrong');
const paymentTimeout = new Counter('payment_timeout');
const cancelDuration = new Trend('cancel_duration', true);
const cancelled = new Counter('cancel_cancelled');
const cancelConflict = new Counter('cancel_conflict');
const cancelUnexpected = new Counter('cancel_unexpected');
const abandoned = new Counter('abandoned');

const thresholds: Record<string, string[]> = {
  reserve_replay_mismatch: ['count==0'],
  reserve_unexpected: ['count==0'],
  reserve_rate_limited: ['count==0'],
};
if (FULL) {
  // Returned stock is sold again while the burst runs, so orders exceed the stock; every unit went at
  // least once, and PAID units can never exceed it (INV-1).
  thresholds.reserve_orders = [`count>=${profile.units / QTY}`];
  thresholds.payment_paid = [`count<=${profile.units / QTY}`];
  thresholds.checkout_mismatch = ['count==0'];
  thresholds.checkout_unexpected = ['count==0'];
  // A winner submits right after its reserve, and every profile's hold outlasts its whole load, so a 410
  // means a hold was lost or expired early, never a buyer who took too long.
  thresholds.checkout_expired = ['count==0'];
  thresholds.payment_wrong = ['count==0'];
  thresholds.payment_timeout = ['count==0'];
  thresholds.cancel_unexpected = ['count==0'];
  if (profile.paidP95Ms !== undefined) thresholds.submit_to_paid = [`p(95)<${profile.paidP95Ms}`];
} else {
  // Exactly the stock, with qty 1: no oversell, and no admitted hold lost on the way to Postgres. Distinct
  // orders, not 201s: a winner whose 201 was lost learns its order from the retry's 200 replay.
  thresholds.reserve_orders = [`count==${profile.units / QTY}`];
}
if (RETURN_CHECK) thresholds.stock_returned = ['rate==1'];
if (profile.p95Ms !== undefined) thresholds['reserve_duration{scenario:burst}'] = [`p(95)<${profile.p95Ms}`];
if (opening !== undefined) {
  thresholds.opening_on_time = [`count>=${Math.ceil(opening.vus * ON_TIME_SHARE)}`];
  if (opening.p95Ms !== undefined) {
    thresholds['reserve_duration{scenario:opening}'] = [`p(95)<${opening.p95Ms}`];
  }
}

const gracefulStop = `${GRACEFUL_STOP_SECONDS}s`;

export const options = {
  setupTimeout: '180s',
  teardownTimeout: `${loadSeconds + GRACEFUL_STOP_SECONDS + profile.holdSeconds + RETURN_GRACE_SECONDS + 30}s`,
  scenarios: {
    ...(opening === undefined
      ? {}
      : {
          opening: {
            executor: 'per-vu-iterations',
            exec: 'openingBuyer',
            vus: opening.vus,
            iterations: opening.iterations,
            maxDuration: `${leadSeconds + OPENING_SECONDS + profile.load.seconds}s`,
            gracefulStop,
          },
        }),
    burst:
      profile.load.kind === 'rate'
        ? {
            executor: 'ramping-arrival-rate',
            startTime: `${burstStartSeconds}s`,
            startRate: profile.load.rate,
            timeUnit: '1s',
            preAllocatedVUs: profile.vus,
            maxVUs: profile.load.maxVUs,
            stages: [{ target: profile.load.rate, duration: `${profile.load.seconds}s` }],
            gracefulStop,
          }
        : {
            executor: 'shared-iterations',
            startTime: `${burstStartSeconds}s`,
            vus: profile.vus,
            iterations: profile.load.requests,
            maxDuration: `${profile.load.seconds}s`,
            gracefulStop,
          },
  },
  thresholds,
  summaryTrendStats: ['count', 'avg', 'med', 'p(95)', 'p(99)', 'max'],
};

interface BurstData {
  readonly dropId: string;
  /** Session tokens only: setup data is copied into every VU, so it stays as small as it can be. */
  readonly tokens: readonly string[];
  /** When the first reserve leaves (ms): the opening's shared instant. No hold exists before it. */
  readonly fireAt: number;
}

export function setup(): BurstData {
  const tokens = mintSessions(profile.buyers).map((session) => session.token);
  const opensAt = Date.now() + OPEN_DELAY_SECONDS * 1_000;
  const drop = createTestDrop({
    stock: profile.units,
    perUserLimit: profile.perUserLimit,
    holdSeconds: profile.holdSeconds,
    durationSeconds: DROP_SECONDS,
    ...(OPEN_DELAY_SECONDS > 0 ? { startsAt: new Date(opensAt).toISOString() } : {}),
  });
  const stock = readStock(drop.dropId);
  if (stock.avail !== profile.units || (stock.status !== 'LIVE' && stock.status !== 'SCHEDULED')) {
    throw new Error(`drop ${drop.dropId} is not open after arming: ${JSON.stringify(stock)}`);
  }
  console.log(
    `burst: drop ${drop.dropId}, ${profile.units} units, ${tokens.length} buyers` +
      (OPEN_DELAY_SECONDS > 0 ? `, opening in ${OPEN_DELAY_SECONDS} s` : ''),
  );
  // Test drops are left out of the admin's drop list, so the run names its pages itself.
  console.log(`burst: product page ${ORIGIN}/p/${drop.productSlug}`);
  console.log(`burst: live dashboard ${ORIGIN}/admin/dashboard/${drop.dropId} (signed in as an admin)`);
  const firstReserve = OPEN_DELAY_SECONDS > 0 ? opensAt : Date.now();
  return { dropId: drop.dropId, tokens, fireAt: firstReserve + (opening === undefined ? 0 : BARRIER_MS) };
}

/** One buyer's intent: a session, a key and a body. Every send of it is the same request. */
interface Intent extends IntentState {
  readonly token: string;
  readonly idempotencyKey: string;
  readonly qty: number;
}

type ReserveResponse = ReturnType<typeof reserve>;

const recent: Intent[] = [];
let logged = 0;

/** The next request: a remembered one to resend, or a new intent sent once or as a double click. */
function nextSend(tokens: readonly string[]): { readonly intent: Intent; readonly copies: number } {
  const roll = Math.random();
  if (recent.length > 0 && roll < RESEND_SHARE) {
    return { intent: recent[Math.floor(Math.random() * recent.length)] as Intent, copies: 1 };
  }
  const intent: Intent = {
    token: tokens[Math.floor(Math.random() * tokens.length)] as string,
    idempotencyKey: uuidv7(),
    qty: QTY,
    sent: 0,
    uncertain: false,
  };
  recent.push(intent);
  if (recent.length > RECENT_REQUESTS) recent.shift();
  return { intent, copies: roll < RESEND_SHARE + DOUBLE_CLICK_SHARE ? 2 : 1 };
}

function report(kind: string, key: string, detail: string): void {
  if (logged >= MAX_LOGGED) return;
  logged += 1;
  console.error(`${kind}: key ${key}: ${detail}`);
}

/** The `opening` scenario: the first iteration waits for the shared instant, so every VU fires together. */
export function openingBuyer(data: BurstData): void {
  if (exec.vu.iterationInScenario === 0) {
    const wait = data.fireAt - Date.now();
    if (wait > 0) sleep(wait / 1_000);
    openingOnTime.add(Date.now() - data.fireAt <= ON_TIME_MS ? 1 : 0);
  }
  buy(data);
}

/** The `burst` scenario. */
export default function (data: BurstData): void {
  buy(data);
}

/** One reserve intent; in full mode, a winner then decides what to do with its hold. */
function buy(data: BurstData): void {
  const { intent, copies } = nextSend(data.tokens);
  const orderId = reserveIntent(data.dropId, intent, copies);
  if (orderId === undefined || !FULL) return;
  switch (pickFate(Math.random(), FATES)) {
    case 'checkout':
      checkoutAndPay(intent.token, orderId);
      return;
    case 'cancel':
      cancelHold(intent.token, orderId);
      return;
    case 'abandon':
      // The hold expires; the sweeper and the settlement consumer give the unit back (§4.6).
      abandoned.add(1);
      return;
  }
}

/**
 * Sends the intent (`copies` at once) until every copy has a final answer, and judges them. Returns the
 * order id when this call is the first to learn of the intent's order: a winner, which acts next.
 */
function reserveIntent(dropId: string, intent: Intent, copies: number): string | undefined {
  if (copies > 1) doubleClicks.add(1);
  const known = intent.orderId;
  let pending = copies;
  for (let attempt = 1; ; attempt += 1) {
    const responses = reserveCopies(dropId, intent, pending);
    intent.sent += pending;
    const answers: ReserveResponse[] = [];
    let delay = 0;
    for (const response of responses) {
      reserveDuration.add(response.timings.duration);
      if (!isRetryable(response.status)) {
        answers.push(response);
        continue;
      }
      // Marked before any sibling copy is judged: this send may have committed the order it replays.
      intent.uncertain = true;
      (response.status === 0 ? transportErrors : retried).add(1);
      delay = Math.max(delay, retryDelaySeconds(header(response, 'Retry-After')));
    }
    // Full mode returns stock mid-run, so a refused copy may legitimately precede its twin's creation.
    for (const response of answers.sort(FULL ? byJudgingOrderWithReturns : byJudgingOrder)) {
      record(intent, response);
    }
    pending = responses.length - answers.length;
    if (pending === 0) break;
    if (attempt === MAX_ATTEMPTS) {
      gaveUp.add(pending);
      report(
        'gave up',
        intent.idempotencyKey,
        `${pending} sends still unanswered after ${MAX_ATTEMPTS} attempts`,
      );
      break;
    }
    sleep(delay);
  }
  return known === undefined ? intent.orderId : undefined;
}

/** Counts one final reserve answer by what `judgeReserve` makes of it. */
function record(intent: Intent, response: ReserveResponse): void {
  const verdict = judgeReserve(intent, answerOf(response));
  const detail = () =>
    `after ${intent.sent} sends: ${response.status} ${String(response.body).slice(0, 200)}`;
  switch (verdict.kind) {
    case 'created':
      created.add(1);
      orders.add(1);
      winnerDuration.add(response.timings.duration);
      return;
    case 'replayed':
      replayed.add(1);
      if (verdict.newOrder) orders.add(1);
      return;
    case 'sold-out':
      soldOut.add(1);
      return;
    case 'limit-reached':
      limitReached.add(1);
      return;
    case 'expired':
      expired.add(1);
      return;
    case 'rate-limited':
      rateLimited.add(1);
      report(
        'rate limited',
        intent.idempotencyKey,
        '429: raise RATE_LIMIT_IP_PER_SEC and RATE_LIMIT_USER_PER_SEC',
      );
      return;
    case 'mismatch':
      replayMismatch.add(1);
      report(verdict.reason, intent.idempotencyKey, detail());
      return;
    case 'unexpected':
      unexpected.add(1);
      report(verdict.reason, intent.idempotencyKey, detail());
      return;
  }
}

/**
 * Checkout submit with a fresh key for the order (§8.2: one per order), resent on retryable answers, then a
 * poll of the order until the payment consumer has decided it.
 */
function checkoutAndPay(token: string, orderId: string): void {
  const method = pickPaymentMethod(Math.random(), DECLINE_SHARE);
  const request = { token, orderId, idempotencyKey: uuidv7(), paymentMethod: method };
  const state: CheckoutState = { sent: 0, uncertain: false, submitted: false };
  const submittedAt = Date.now();
  for (let attempt = 1; ; attempt += 1) {
    const response = checkout(request);
    state.sent += 1;
    checkoutDuration.add(response.timings.duration);
    if (isRetryable(response.status) && attempt < MAX_ATTEMPTS) {
      state.uncertain = true;
      checkoutRetried.add(1);
      sleep(retryDelaySeconds(header(response, 'Retry-After')));
      continue;
    }
    const verdict = judgeCheckout(state, orderId, answerOf(response));
    const detail = `${response.status} ${String(response.body).slice(0, 200)}`;
    switch (verdict.kind) {
      case 'submitted':
        checkoutSubmitted.add(1);
        break;
      case 'replayed':
        checkoutReplayed.add(1);
        if (verdict.newSubmission) checkoutSubmitted.add(1);
        break;
      case 'expired':
        checkoutExpired.add(1);
        break;
      case 'mismatch':
        checkoutMismatch.add(1);
        report(`checkout ${verdict.reason}`, request.idempotencyKey, detail);
        break;
      case 'unexpected':
        checkoutUnexpected.add(1);
        report(`checkout ${verdict.reason}`, request.idempotencyKey, detail);
        break;
    }
    break;
  }
  if (state.submitted) awaitPayment(token, orderId, method, submittedAt);
}

/** Polls the order until the payment consumer decided it, and checks that it decided what the PSP said. */
function awaitPayment(token: string, orderId: string, method: BurstPaymentMethod, submittedAt: number): void {
  const deadline = submittedAt + PAYMENT_DEADLINE_SECONDS * 1_000;
  for (;;) {
    const status = readOrderStatus(token, orderId);
    if (status !== undefined && SETTLED_PAYMENT_STATUSES.includes(status)) {
      const elapsed = Date.now() - submittedAt;
      if (judgePayment(method, status) === 'wrong') {
        paymentWrong.add(1);
        report('payment', orderId, `${method} ended ${status}`);
      } else if (status === 'PAID') {
        paymentPaid.add(1);
        submitToPaid.add(elapsed);
      } else {
        paymentDeclined.add(1);
        submitToDeclined.add(elapsed);
      }
      return;
    }
    if (Date.now() > deadline) {
      paymentTimeout.add(1);
      report(
        'payment',
        orderId,
        `${method} still ${status ?? 'unreadable'} after ${PAYMENT_DEADLINE_SECONDS} s`,
      );
      return;
    }
    sleep(profile.paymentPollSeconds);
  }
}

/** Cancels the hold, resending on retryable answers: a repeated cancel answers 200 CANCELLED again. */
function cancelHold(token: string, orderId: string): void {
  for (let attempt = 1; ; attempt += 1) {
    const response = cancel(token, orderId);
    cancelDuration.add(response.timings.duration);
    if (isRetryable(response.status) && attempt < MAX_ATTEMPTS) {
      sleep(retryDelaySeconds(header(response, 'Retry-After')));
      continue;
    }
    const verdict = judgeCancel(orderId, answerOf(response));
    if (verdict === 'cancelled') cancelled.add(1);
    else if (verdict === 'conflict') cancelConflict.add(1);
    else {
      cancelUnexpected.add(1);
      report('cancel', orderId, `${response.status} ${String(response.body).slice(0, 200)}`);
    }
    return;
  }
}

/**
 * Once every hold has expired or been decided, the stock must be back (§4.6): reserve-only gives all of it
 * back; full mode holds nothing and `avail + sold = units`, so declined, cancelled and abandoned units
 * returned. Whether `sold` is exactly the PAID orders is Postgres's truth, which `verify:invariants` checks.
 */
export function teardown(data: BurstData): void {
  // Always one sample: k6 passes a threshold on a metric that never got one, e.g. an opening that never ran.
  openingOnTime.add(0);
  if (!RETURN_CHECK) return;
  const firstExpiry = data.fireAt + profile.holdSeconds * 1_000;
  const deadline = firstExpiry + (loadSeconds + GRACEFUL_STOP_SECONDS + RETURN_GRACE_SECONDS) * 1_000;
  let last: Stock | undefined;
  for (;;) {
    try {
      last = readStock(data.dropId);
      const settled = FULL
        ? last.held === 0 && last.avail + last.sold === profile.units
        : last.avail === profile.units && last.held === 0 && last.sold === 0;
      if (settled) {
        stockReturned.add(true);
        stockReturnSeconds.add(Math.max(0, (Date.now() - firstExpiry) / 1_000));
        finalSold.add(last.sold);
        return;
      }
    } catch (error) {
      console.warn(`teardown: ${String(error)}`);
    }
    if (Date.now() > deadline) {
      stockReturned.add(false);
      console.error(
        `stock did not come back: ${JSON.stringify(last)}; are the worker (sweeper) and consumers running?`,
      );
      return;
    }
    sleep(1);
  }
}

export function handleSummary(data: SummaryData): Record<string, string> {
  const setup = data.setup_data as Partial<BurstData> | undefined;
  const requests = count(data, 'reserve_duration');
  const returned = stat(data, 'stock_returned', 'rate');
  const returnSeconds = stat(data, 'stock_return_seconds', 'max');
  const sold = stat(data, 'final_sold', 'max');
  const counters = (pairs: readonly [string, string][]) =>
    pairs.map(([label, metric]) => `${label} ${count(data, metric)}`).join(', ');
  const load =
    profile.load.kind === 'rate'
      ? `${profile.load.rate} reserves/s for ${profile.load.seconds} s`
      : `${profile.load.requests} reserves, ${profile.vus} in flight`;
  const lines = [
    `burst: profile ${PROFILE}, ${MODE}, ${
      opening === undefined
        ? load
        : `opening of ${opening.vus} buyers x ${opening.iterations} (${count(data, 'opening_on_time')} fired within ${ON_TIME_MS} ms), then ${load}`
    }`,
    `  drop ${setup?.dropId ?? '(setup failed)'}: ${profile.units} units, limit ${profile.perUserLimit}, hold ${profile.holdSeconds} s, ${profile.buyers} buyers`,
    `  ${requests} reserves: ${counters([
      ['orders', 'reserve_orders'],
      ['201', 'reserve_created'],
      ['replayed', 'reserve_replayed'],
      ['double clicks', 'reserve_double_clicks'],
      ['sold out', 'reserve_sold_out'],
      ['limit reached', 'reserve_limit_reached'],
      ['expired', 'reserve_expired'],
      ['5xx retried', 'reserve_retry'],
      ['429', 'reserve_rate_limited'],
      ['no answer', 'reserve_transport_errors'],
      ['gave up', 'reserve_gave_up'],
      ['unexpected', 'reserve_unexpected'],
      ['replay mismatches', 'reserve_replay_mismatch'],
    ])}`,
    `  reserve latency p50 ${ms(stat(data, 'reserve_duration', 'med'))}, p95 ${ms(stat(data, 'reserve_duration', 'p(95)'))}, p99 ${ms(stat(data, 'reserve_duration', 'p(99)'))}; winners p95 ${ms(stat(data, 'reserve_winner_duration', 'p(95)'))}`,
  ];
  if (FULL) {
    lines.push(
      `  winners: ${counters([
        ['checked out', 'checkout_submitted'],
        ['cancelled', 'cancel_cancelled'],
        ['abandoned', 'abandoned'],
      ])} (decline share ${DECLINE_SHARE})`,
      `  checkout: ${counters([
        ['202', 'checkout_submitted'],
        ['replayed', 'checkout_replayed'],
        ['5xx retried', 'checkout_retry'],
        ['expired', 'checkout_expired'],
        ['mismatches', 'checkout_mismatch'],
        ['unexpected', 'checkout_unexpected'],
      ])}; p95 ${ms(stat(data, 'checkout_duration', 'p(95)'))}`,
      `  payment: ${counters([
        ['PAID', 'payment_paid'],
        ['declined', 'payment_declined'],
        ['wrong outcome', 'payment_wrong'],
        ['undecided', 'payment_timeout'],
      ])}; submit to PAID p50 ${ms(stat(data, 'submit_to_paid', 'med'))}, p95 ${ms(stat(data, 'submit_to_paid', 'p(95)'))}, max ${ms(stat(data, 'submit_to_paid', 'max'))} (polled every ${profile.paymentPollSeconds * 1_000} ms)`,
      `  cancel: ${counters([
        ['cancelled', 'cancel_cancelled'],
        ['conflict', 'cancel_conflict'],
        ['unexpected', 'cancel_unexpected'],
      ])}; p95 ${ms(stat(data, 'cancel_duration', 'p(95)'))}`,
    );
  }
  lines.push(
    `  dropped iterations (VUs exhausted): ${count(data, 'dropped_iterations')}`,
    !RETURN_CHECK
      ? '  stock return: not checked (RETURN_CHECK=0)'
      : returned !== 1
        ? '  stock back: NO'
        : FULL
          ? `  stock settled ${returnSeconds.toFixed(1)} s after the first holds expired: sold ${sold}, ${count(data, 'payment_paid')} PAID seen by buyers`
          : `  stock back to ${profile.units}: ${returnSeconds.toFixed(1)} s after the first holds expired`,
  );
  return summaryOutputs(
    `burst-${PROFILE}`,
    data,
    {
      script: 'burst',
      profile: PROFILE,
      mode: MODE,
      dropId: setup?.dropId,
      settings: { ...profile, fates: FATES, declineShare: DECLINE_SHARE },
    },
    lines,
  );
}

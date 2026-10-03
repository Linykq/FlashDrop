/**
 * Reserve burst (design §13): a flash sale opening on a fresh drop. Many buyers reserve at once; about 30%
 * of the requests repeat a key with the same body, either later (a network retry) or concurrently (a
 * double click, both copies in flight together). A retryable answer (no answer, 502, 503, 504) is resent
 * with the same key after `Retry-After`, within the same iteration, as the storefront does: that retry is
 * what heals a hold Lua granted and Postgres never recorded (§4.5).
 *
 *   pnpm load:burst                          PROFILE=ci: 100 units, 1,000 buyers; an opening spike of 300
 *                                            buyers firing together, then 300 reserves/s for 20 s
 *   pnpm load:burst -e PROFILE=laptop        1,000 units, 10,000 buyers, 2,000 reserves/s for 30 s
 *   pnpm load:burst -e PROFILE=nightly       300 units, 3,000 buyers; the opening spike, then 600/s for 30 s
 *   pnpm demo:burst                          PROFILE=demo: 2,000 reserves, 500 in flight at a time, from
 *                                            300 buyers on 100 units; then `verify:invariants`
 *
 * The opening spike is what makes the run contended: an arrival rate alone spaces requests a few ms apart,
 * and at a few ms per reserve that sells the stock almost one request at a time.
 *
 * MODE=reserve-only (M2) never checks out, so every hold is abandoned: teardown() then waits for the
 * sweeper and the safety net to give all of the stock back (§4.6). Checkout and cancel join in M3.
 *
 * Correctness thresholds are strict: exactly `units` distinct orders (every request asks for 1 unit), every
 * replay answers with the order it replays, no 429 (the load profile raises the rate limits, §11), nothing
 * unexpected, all stock back. Latency thresholds are loose (ci, laptop) or absent (reported only).
 */
import { sleep } from 'k6';
import exec from 'k6/execution';
import { Counter, Rate, Trend } from 'k6/metrics';
import {
  answerOf,
  createTestDrop,
  header,
  mintSessions,
  readStock,
  type reserve,
  reserveCopies,
  type Stock,
} from './lib/api.ts';
import { uuidv7 } from './lib/ids.ts';
import { count, ms, type SummaryData, stat, summaryOutputs } from './lib/summary.ts';
import {
  byJudgingOrder,
  type IntentState,
  isRetryable,
  judgeReserve,
  retryDelaySeconds,
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
   * Longer than the opening plus the burst, so no hold expires and is sold again while the run sends:
   * `units` orders stay exact. Kept short so that teardown sees the stock come back soon.
   */
  readonly holdSeconds: number;
  readonly vus: number;
  /** Loose p95 gate on the `burst` scenario's reserves; undefined: reported only (§1 scale targets). */
  readonly p95Ms?: number;
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
    p95Ms: 500,
  },
  nightly: {
    units: 300,
    buyers: 3_000,
    perUserLimit: 2,
    opening: { vus: 300, iterations: 2 },
    load: { kind: 'rate', rate: 600, seconds: 30, maxVUs: 600 },
    holdSeconds: 50,
    vus: 150,
  },
  laptop: {
    units: 1_000,
    buyers: 10_000,
    perUserLimit: 2,
    load: { kind: 'rate', rate: 2_000, seconds: 30, maxVUs: 1_000 },
    holdSeconds: 40,
    vus: 300,
    p95Ms: 100,
  },
  demo: {
    units: 100,
    buyers: 300,
    perUserLimit: 2,
    load: { kind: 'count', requests: 2_000, seconds: 10 },
    holdSeconds: 15,
    vus: 500,
  },
};

const PROFILE = __ENV.PROFILE || 'ci';
const MODE = __ENV.MODE || 'reserve-only';
const profile = PROFILES[PROFILE];
if (profile === undefined) {
  throw new Error(`PROFILE=${PROFILE} is unknown; use one of ${Object.keys(PROFILES).join(', ')}`);
}
if (MODE !== 'reserve-only') {
  throw new Error(`MODE=${MODE} is not available yet: checkout and cancel join the burst in M3`);
}

/** Share of sends that resend a remembered request of the same VU later (a network retry). */
const RESEND_SHARE = 0.2;
/** Share of sends that go out as two concurrent copies (a double click): about 30% repeats in all (§13). */
const DOUBLE_CLICK_SHARE = 0.1;
/** Each VU remembers its last few requests to resend; a resend follows its original within seconds. */
const RECENT_REQUESTS = 32;
const QTY = 1;
/** The drop stays open long enough for a slow setup; it is a fresh, isolated drop either way. */
const DROP_SECONDS = 600;
/** Every opening VU waits for this moment after setup, so they fire together rather than as VUs start. */
const BARRIER_MS = 1_000;
/** A VU that fires within this long of the shared instant counts as on time. */
const ON_TIME_MS = 250;
/** Share of opening VUs that must fire on time: proof that the opening was contended, not sequential. */
const ON_TIME_SHARE = 0.9;
/** When the `burst` scenario starts after an opening; it overlaps the opening's tail. */
const OPENING_SECONDS = 5;
/** Iterations still sending when a scenario ends get this long to finish their retries. */
const GRACEFUL_STOP_SECONDS = 15;
/** After the last hold expires: expire-orders (1 s), then settle-safety-net (10 s age, 5 s period), §4.6. */
const RETURN_GRACE_SECONDS = 45;
/** `RETURN_CHECK=0` skips waiting for the stock to come back, e.g. while iterating on the burst itself. */
const RETURN_CHECK = __ENV.RETURN_CHECK !== '0';
/** Unexpected answers logged per VU; the counters carry the rest. */
const MAX_LOGGED = 5;
/** Sends of one request before giving up on retryable answers; its hold, if any, is an orphan then. */
const MAX_ATTEMPTS = 5;

const opening = profile.opening;
const burstStartSeconds = opening === undefined ? 0 : OPENING_SECONDS;
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

const thresholds: Record<string, string[]> = {
  // Exactly the stock, with qty 1: no oversell, and no admitted hold lost on the way to Postgres. Distinct
  // orders, not 201s: a winner whose 201 was lost learns its order from the retry's 200 replay.
  reserve_orders: [`count==${profile.units / QTY}`],
  reserve_replay_mismatch: ['count==0'],
  reserve_unexpected: ['count==0'],
  reserve_rate_limited: ['count==0'],
};
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
  teardownTimeout: `${loadSeconds + profile.holdSeconds + RETURN_GRACE_SECONDS + 30}s`,
  scenarios: {
    ...(opening === undefined
      ? {}
      : {
          opening: {
            executor: 'per-vu-iterations',
            exec: 'openingBuyer',
            vus: opening.vus,
            iterations: opening.iterations,
            maxDuration: `${OPENING_SECONDS + profile.load.seconds}s`,
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
  const drop = createTestDrop({
    stock: profile.units,
    perUserLimit: profile.perUserLimit,
    holdSeconds: profile.holdSeconds,
    durationSeconds: DROP_SECONDS,
  });
  const stock = readStock(drop.dropId);
  if (stock.avail !== profile.units || (stock.status !== 'LIVE' && stock.status !== 'SCHEDULED')) {
    throw new Error(`drop ${drop.dropId} is not open after arming: ${JSON.stringify(stock)}`);
  }
  console.log(
    `burst: drop ${drop.dropId} (/p/${drop.productSlug}), ${profile.units} units, ${tokens.length} buyers`,
  );
  return { dropId: drop.dropId, tokens, fireAt: Date.now() + (opening === undefined ? 0 : BARRIER_MS) };
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

function report(kind: string, intent: Intent, detail: string): void {
  if (logged >= MAX_LOGGED) return;
  logged += 1;
  console.error(`${kind}: key ${intent.idempotencyKey} after ${intent.sent} sends: ${detail}`);
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

function buy(data: BurstData): void {
  const { intent, copies } = nextSend(data.tokens);
  if (copies > 1) doubleClicks.add(1);
  let pending = copies;
  for (let attempt = 1; ; attempt += 1) {
    const responses = reserveCopies(data.dropId, intent, pending);
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
    for (const response of answers.sort(byJudgingOrder)) record(intent, response);
    pending = responses.length - answers.length;
    if (pending === 0) return;
    if (attempt === MAX_ATTEMPTS) {
      gaveUp.add(pending);
      report('gave up', intent, `${pending} sends still unanswered after ${MAX_ATTEMPTS} attempts`);
      return;
    }
    sleep(delay);
  }
}

/** Counts one final answer by what `judgeReserve` makes of it. */
function record(intent: Intent, response: ReserveResponse): void {
  const verdict = judgeReserve(intent, answerOf(response));
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
      report('rate limited', intent, '429: raise RATE_LIMIT_IP_PER_SEC and RATE_LIMIT_USER_PER_SEC');
      return;
    case 'mismatch':
      replayMismatch.add(1);
      report(verdict.reason, intent, `${response.status} ${String(response.body).slice(0, 200)}`);
      return;
    case 'unexpected':
      unexpected.add(1);
      report(verdict.reason, intent, `${response.status} ${String(response.body).slice(0, 200)}`);
      return;
  }
}

/** Reserve-only: every hold was abandoned, so all of the stock must come back once they expire. */
export function teardown(data: BurstData): void {
  // Always one sample: k6 passes a threshold on a metric that never got one, e.g. an opening that never ran.
  openingOnTime.add(0);
  if (!RETURN_CHECK) return;
  const firstExpiry = data.fireAt + profile.holdSeconds * 1_000;
  const deadline = firstExpiry + (loadSeconds + RETURN_GRACE_SECONDS) * 1_000;
  let last: Stock | undefined;
  for (;;) {
    try {
      last = readStock(data.dropId);
      if (last.avail === profile.units && last.held === 0 && last.sold === 0) {
        stockReturned.add(true);
        stockReturnSeconds.add(Math.max(0, (Date.now() - firstExpiry) / 1_000));
        return;
      }
    } catch (error) {
      console.warn(`teardown: ${String(error)}`);
    }
    if (Date.now() > deadline) {
      stockReturned.add(false);
      console.error(
        `stock did not come back: ${JSON.stringify(last)}; is the worker (sweeper role) running?`,
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
  const counters: [string, string][] = [
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
  ];
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
    `  ${requests} reserves: ${counters.map(([label, metric]) => `${label} ${count(data, metric)}`).join(', ')}`,
    `  latency p50 ${ms(stat(data, 'reserve_duration', 'med'))}, p95 ${ms(stat(data, 'reserve_duration', 'p(95)'))}, p99 ${ms(stat(data, 'reserve_duration', 'p(99)'))}; winners p95 ${ms(stat(data, 'reserve_winner_duration', 'p(95)'))}`,
    `  dropped iterations (VUs exhausted): ${count(data, 'dropped_iterations')}`,
    RETURN_CHECK
      ? `  stock back to ${profile.units}: ${returned === 1 ? `${returnSeconds.toFixed(1)} s after the first holds expired` : 'NO'}`
      : '  stock return: not checked (RETURN_CHECK=0)',
  ];
  return summaryOutputs(
    `burst-${PROFILE}`,
    data,
    { script: 'burst', profile: PROFILE, mode: MODE, dropId: setup?.dropId, settings: profile },
    lines,
  );
}

/**
 * WebSocket fan-out (design §7, §13; targets in §1): `sockets` anonymous viewers watch one fresh drop's stock
 * topic, alternately through `/ws/1` (pinned to api-1) and `/ws/2` (api-2), while a reserve storm churns that
 * drop. Every winner cancels its hold within two seconds, so the level keeps moving for the whole storm (each
 * win and each release is one mutation and one publish) and at the end comes all the way back. It measures
 * what §1 promises a viewer:
 *
 * - propagation: `receive time - ts` of every delta, `ts` being the Redis time of the newest mutation folded
 *   into it (§7). The k6 container shares the host clock with Redis, so this is mutation-to-socket latency,
 *   the 100 ms coalescing tick included;
 * - at most one level frame per socket per 100 ms tick while the drop changes many times faster: that is
 *   coalescing at work. Gated on what k6's receipt times can show (see FRAME_WINDOW_MS): at most 23 frames
 *   in any 2 s and 10.5 a second over the whole storm; the busiest single second is reported;
 * - every socket's final level equals the Redis level, version and counts, once the stock is back.
 *
 *   pnpm load:ws-fanout                      PROFILE=ci: 200 sockets, a 20 s storm
 *   pnpm load:ws-fanout -e PROFILE=nightly   500 sockets, a 30 s storm
 *   pnpm load:ws-fanout -e PROFILE=laptop    2,000 sockets, a 30 s storm
 *                                            the storm: 300 reserves/s on 100 units (see `STORM`)
 *   ... -e WS_URLS=ws://host.docker.internal:4101/ws,ws://host.docker.internal:4102/ws
 *                                            other gateways, round-robined (e.g. native `pnpm dev` instances);
 *                                            the pinning check runs when there are two or more
 *
 * Correctness thresholds are strict: every socket opens, holds a level before the storm and stays open;
 * every frame is well formed, conserves the stock (avail + held + sold = units, INV-9) and is newer than the
 * one before it on its socket (§7 ordering); each URL reaches one instance and no two URLs the same one; at
 * most 23 frames per socket in any 2 s and 10.5 a second over the storm, while in its busiest second each
 * socket's frames carried at least 44 changes; every final level equals Redis; the stock comes back; no 429 and no
 * unexpected answer. Propagation p95 is gated loosely (ci < 600 ms, laptop < 300 ms, §1) or reported only
 * (nightly). A storm request given up after its retries (503 RETRY while the hot row is busy) is counted,
 * not failed: the storm is the load here, and burst.ts judges the reserve path.
 */
import { sleep } from 'k6';
import exec from 'k6/execution';
import { Counter, Rate, Trend } from 'k6/metrics';
import { WebSocket } from 'k6/websockets';
import {
  answerOf,
  cancel,
  createTestDrop,
  header,
  mintSessions,
  type ReserveRequest,
  readStock,
  reserve,
  type Stock,
} from './lib/api.ts';
import { BASE_URL, ORIGIN } from './lib/config.ts';
import {
  changesSince,
  compareVersions,
  createRateMeter,
  type FinalVerdict,
  FRAME_WINDOW_MS,
  isConserved,
  isPinned,
  isSettled,
  judgeFinal,
  type Level,
  parseFrame,
  type RateMeter,
} from './lib/fanout.ts';
import { uuidv7 } from './lib/ids.ts';
import { count, ms, type SummaryData, stat, summaryOutputs } from './lib/summary.ts';
import {
  type IntentState,
  isRetryable,
  judgeCancel,
  judgeReserve,
  retryDelaySeconds,
} from './lib/verdict.ts';

/** The profiles scale the sockets (§1); every profile runs the same storm (see `STORM`). */
interface Profile {
  readonly sockets: number;
  /** How long the storm runs. */
  readonly seconds: number;
  /** How long the sockets get to open and subscribe before the storm starts. */
  readonly connectSeconds: number;
  /** Loose p95 gate on propagation (§1); undefined: reported only. */
  readonly propagationP95Ms?: number;
}

const PROFILES: Readonly<Record<string, Profile>> = {
  ci: { sockets: 200, seconds: 20, connectSeconds: 10, propagationP95Ms: 600 },
  nightly: { sockets: 500, seconds: 30, connectSeconds: 10 },
  laptop: { sockets: 2_000, seconds: 30, connectSeconds: 15, propagationP95Ms: 300 },
};

/**
 * The storm only has to change the level in nearly every 100 ms tick, and 300 reserves/s on 100 units does:
 * about 170 changes/s. It is not the burst's §1 rate (2,000/s on the laptop, burst.ts's own target). Measured
 * on the 12-core dev laptop with 2,000 sockets: at 600/s both api processes sit at 100% CPU and the VM nears
 * its cores; at 2,000/s, beyond this stack there (burst.ts's M2 result), k6 itself starves. Frames then bunch
 * where k6 timestamps them (11, then 12 in a second), and the run would measure the machine, not the gateway.
 */
const STORM = {
  units: 100,
  /** Buyers only need to outnumber the holds the churn keeps open at their limit. */
  buyers: 1_000,
  perUserLimit: 2,
  /** Reserves per second, for the profile's `seconds`. */
  rate: 300,
  /**
   * A winner keeps its VU while it waits to cancel. k6 starts VUs beyond the preallocated ones mid-run, too
   * slowly for a storm's first seconds (it drops iterations meanwhile), so preallocate what the storm keeps busy.
   */
  preAllocatedVUs: 150,
  maxVUs: 400,
} as const;

const PROFILE = __ENV.PROFILE || 'ci';
const profile: Profile = (() => {
  const selected = PROFILES[PROFILE];
  if (selected === undefined) {
    throw new Error(`PROFILE=${PROFILE} is unknown; use one of ${Object.keys(PROFILES).join(', ')}`);
  }
  return selected;
})();

/** Caddy pins `/ws/1` to api-1 and `/ws/2` to api-2 (§7); sockets alternate between the URLs. */
const WS_URLS = (
  __ENV.WS_URLS || `${BASE_URL.replace(/^http/, 'ws')}/ws/1,${BASE_URL.replace(/^http/, 'ws')}/ws/2`
)
  .split(',')
  .map((url) => url.trim())
  .filter((url) => url !== '');
if (WS_URLS.length === 0) throw new Error('WS_URLS names no gateway');

/**
 * Sockets per VU: one VU's event loop serves all of its sockets, so 2,000 sockets cost 100 JS runtimes rather
 * than 2,000. Each handles about 10 frames per socket per second, a light load for one loop.
 */
const SOCKETS_PER_VU = 20;
const WATCHER_VUS = Math.ceil(profile.sockets / SOCKETS_PER_VU);
/** Between two sockets of one VU opening, so 2,000 upgrades spread over half a second. */
const OPEN_SPACING_MS = 25;
/**
 * A winner cancels after up to this long, uniformly: spread out, the cancels and the releases the settlement
 * consumer makes of them (§6.5) keep the stock turning over all storm long. Cancelled all at once, a batch of
 * releases is re-won in the same few milliseconds, and those reserves and their cancels queue on the drop's
 * hot inventory row past the api's 2 s statement timeout (503 RETRY).
 */
const CANCEL_AFTER_MAX_SECONDS = 2;
/**
 * Far longer than a winner keeps its hold, so a cancel never loses to expiry; a hold whose cancel never got
 * through (an interrupted iteration) expires after it and comes back too.
 */
const HOLD_SECONDS = 30;
/** The drop stays open long past the run. */
const DROP_SECONDS = 900;
/** Storm iterations still running at its end get this long to finish their retries and their cancel. */
const GRACEFUL_STOP_SECONDS = 15;
/** After the last hold could expire: expire-orders (1 s), then settlement or the safety net (≤ 15 s), §4.6. */
const RETURN_GRACE_SECONDS = 45;
/** Once every socket shows the stock back: a frame still on its way lands within one tick or two. */
const QUIET_MS = 1_000;
/** Reads of the Redis level, a second apart, before a socket that is behind it counts as stuck there. */
const FINAL_READS = 5;
const POLL_MS = 100;
const MAX_ATTEMPTS = 5;
/** Unexpected events logged per VU; the counters carry the rest. */
const MAX_LOGGED = 5;
/**
 * The frame cap per socket (§1: one frame per 100 ms tick), as gated. Any FRAME_WINDOW_MS holds its 20 ticks,
 * one more that crossed into it late, and the two that a VU stalled for 200 ms reads at once. Over the whole
 * storm, where bunching evens out, the tick rate itself, with room for a frame or two at the storm's edges.
 * And how fast the level must change in a socket's busiest second for the cap to prove coalescing rather
 * than a quiet drop: over 4 times the tick rate.
 */
const MAX_FRAMES_PER_WINDOW = FRAME_WINDOW_MS / 100 + 3;
const MAX_STORM_FRAMES_PER_SECOND = 10.5;
const MIN_PEAK_CHANGES_PER_SECOND = 44;

const stormStartSeconds = profile.connectSeconds;
const stormEndSeconds = stormStartSeconds + profile.seconds;
const settleSeconds = GRACEFUL_STOP_SECONDS + HOLD_SECONDS + RETURN_GRACE_SECONDS;

/*
 * Per-socket gates are counters that must reach `sockets`, not rates: a VU that dies before judging its
 * sockets then fails the run instead of leaving a rate without samples, which k6 passes.
 */
const opened = new Counter('ws_opened');
const connectErrors = new Counter('ws_connect_errors');
const closedEarly = new Counter('ws_closed_early');
const readyInTime = new Counter('ws_ready_before_storm');
const snapshots = new Counter('ws_snapshots');
const deltas = new Counter('ws_deltas');
const propagation = new Trend('ws_propagation', true);
const badFrames = new Counter('ws_bad_frames');
const outOfOrder = new Counter('ws_out_of_order');
const unconserved = new Counter('ws_unconserved');
const topicErrors = new Counter('ws_topic_errors');
const peakFramesPerSecond = new Trend('ws_peak_frames_per_second');
const peakFramesPerWindow = new Trend('ws_peak_frames_per_window');
const peakChangesPerSecond = new Trend('ws_peak_changes_per_second');
const stormFramesPerSecond = new Trend('ws_storm_frames_per_second');
const stormChangesPerSecond = new Trend('ws_storm_changes_per_second');
const finalMatched = new Counter('ws_final_level_matched');
/**
 * k6 2.3's `k6/websockets` now and then drops the frame that arrives together with the upgrade response:
 * about 1 socket in 1,000 never sees its `hello` (the gateway's first frame) yet gets every frame after it.
 * Measured: a Node `ws` client got `hello` first on 4,000 of 4,000 sockets, direct and through Caddy, where
 * k6 missed 2 of 2,000. So the hello rate is gated just short of 1, which still fails a gateway that stops
 * sending it, and pinning is judged on the sockets that kept theirs.
 */
const helloReceived = new Rate('ws_hello_received');
const pinned = new Rate('ws_pinned');

const reserveDuration = new Trend('storm_reserve_duration', true);
const won = new Counter('storm_won');
const soldOut = new Counter('storm_sold_out');
const limitReached = new Counter('storm_limit_reached');
const retried = new Counter('storm_retry');
const gaveUp = new Counter('storm_gave_up');
const rateLimited = new Counter('storm_rate_limited');
const cancelled = new Counter('storm_cancelled');
const cancelConflict = new Counter('storm_cancel_conflict');
const unexpected = new Counter('storm_unexpected');
const stockReturned = new Rate('stock_returned');

const thresholds: Record<string, string[]> = {
  ws_opened: [`count==${profile.sockets}`],
  ws_connect_errors: ['count==0'],
  ws_closed_early: ['count==0'],
  ws_ready_before_storm: [`count==${profile.sockets}`],
  ws_hello_received: ['rate>=0.99'],
  ws_bad_frames: ['count==0'],
  ws_out_of_order: ['count==0'],
  ws_unconserved: ['count==0'],
  ws_topic_errors: ['count==0'],
  ws_peak_frames_per_window: [`max<=${MAX_FRAMES_PER_WINDOW}`],
  ws_storm_frames_per_second: [`max<=${MAX_STORM_FRAMES_PER_SECOND}`],
  ws_peak_changes_per_second: [`min>=${MIN_PEAK_CHANGES_PER_SECOND}`],
  ws_final_level_matched: [`count==${profile.sockets}`],
  storm_won: [`count>=${STORM.units}`],
  storm_rate_limited: ['count==0'],
  storm_unexpected: ['count==0'],
  stock_returned: ['rate==1'],
};
if (WS_URLS.length > 1) thresholds.ws_pinned = ['rate==1'];
if (profile.propagationP95Ms !== undefined) thresholds.ws_propagation = [`p(95)<${profile.propagationP95Ms}`];

export const options = {
  setupTimeout: '120s',
  teardownTimeout: '60s',
  scenarios: {
    watchers: {
      executor: 'per-vu-iterations',
      exec: 'watch',
      vus: WATCHER_VUS,
      iterations: 1,
      maxDuration: `${stormEndSeconds + settleSeconds + FINAL_READS + 30}s`,
    },
    storm: {
      executor: 'constant-arrival-rate',
      exec: 'storm',
      startTime: `${stormStartSeconds}s`,
      rate: STORM.rate,
      timeUnit: '1s',
      duration: `${profile.seconds}s`,
      preAllocatedVUs: STORM.preAllocatedVUs,
      maxVUs: STORM.maxVUs,
      gracefulStop: `${GRACEFUL_STOP_SECONDS}s`,
    },
  },
  thresholds,
  summaryTrendStats: ['count', 'min', 'avg', 'med', 'p(95)', 'p(99)', 'max'],
};

interface FanoutData {
  readonly dropId: string;
  /** Session tokens only: setup data is copied into every VU, so it stays as small as it can be. */
  readonly tokens: readonly string[];
}

export function setup(): FanoutData {
  const tokens = mintSessions(STORM.buyers).map((session) => session.token);
  const drop = createTestDrop({
    stock: STORM.units,
    perUserLimit: STORM.perUserLimit,
    holdSeconds: HOLD_SECONDS,
    durationSeconds: DROP_SECONDS,
  });
  // Armed SCHEDULED from now: the drop scheduler opens it within a second, long before the storm.
  const stock = readStock(drop.dropId);
  if (stock.avail !== STORM.units || (stock.status !== 'LIVE' && stock.status !== 'SCHEDULED')) {
    throw new Error(`drop ${drop.dropId} is not open after arming: ${JSON.stringify(stock)}`);
  }
  console.log(
    `ws-fanout: drop ${drop.dropId}, ${STORM.units} units; ${profile.sockets} sockets over ${WS_URLS.join(', ')}`,
  );
  return { dropId: drop.dropId, tokens };
}

let logged = 0;

function report(kind: string, detail: string): void {
  if (logged >= MAX_LOGGED) return;
  logged += 1;
  console.error(`${kind}: ${detail}`);
}

function delay(waitMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, waitMs)));
}

/** Polls `done` until it holds or `deadline` (epoch ms) passes; the VU's sockets keep receiving meanwhile. */
async function waitUntil(done: () => boolean, deadline: number): Promise<boolean> {
  while (!done()) {
    if (Date.now() >= deadline) return false;
    await delay(POLL_MS);
  }
  return true;
}

// ---------------------------------------------------------------------------------------------------------
// Watchers

/** The parts of a k6 `MessageEvent` used here; `timestamp` is when k6 read the frame off the socket. */
interface FrameEvent {
  readonly data: unknown;
  readonly timestamp?: number;
}

interface CloseEvent {
  readonly code?: number;
  readonly reason?: string;
}

/** The storm's window in epoch ms, as the watchers scenario sees it. */
interface Window {
  readonly start: number;
  readonly end: number;
}

interface Watcher {
  readonly url: string;
  readonly socket: WebSocket;
  readonly meter: RateMeter;
  instanceId?: string;
  /** The newest level applied: frames are applied only if strictly newer, as the storefront does (§8.2). */
  level?: Level;
  /** Level frames received during the storm, and the changes they carried. */
  stormFrames: number;
  stormChanges: number;
  opened: boolean;
  closed: boolean;
  /** Set before the script closes the socket itself, so that close is not counted as early. */
  closing: boolean;
}

function onFrame(watcher: Watcher, event: FrameEvent, topic: string, storm: Window): void {
  const at = typeof event.timestamp === 'number' ? event.timestamp : Date.now();
  const frame = parseFrame(String(event.data), topic);
  switch (frame.kind) {
    case 'hello':
      if (watcher.instanceId !== undefined) {
        badFrames.add(1);
        report('second hello', watcher.url);
      }
      watcher.instanceId = frame.instanceId;
      return;
    case 'topic-error':
      topicErrors.add(1);
      report('topic refused', `${frame.code} on ${watcher.url}`);
      return;
    case 'malformed':
      badFrames.add(1);
      report('bad frame', `${frame.reason} on ${watcher.url}`);
      return;
    case 'snapshot':
    case 'delta': {
      // §7 ordering: the gateway never writes a socket a level older than or equal to one it wrote before.
      const newer = watcher.level === undefined || compareVersions(frame.level, watcher.level) > 0;
      const changes = newer ? changesSince(watcher.level, frame.level) : 0;
      watcher.meter.record(at, changes);
      if (at >= storm.start && at <= storm.end) {
        watcher.stormFrames += 1;
        watcher.stormChanges += changes;
      }
      if (!newer) {
        outOfOrder.add(1);
        report('out of order', `${JSON.stringify(frame.level)} after ${JSON.stringify(watcher.level)}`);
        return;
      }
      if (!isConserved(frame.level, STORM.units)) {
        unconserved.add(1);
        report('unconserved level', JSON.stringify(frame.level));
      }
      if (frame.kind === 'snapshot') {
        snapshots.add(1);
      } else {
        deltas.add(1);
        propagation.add(at - frame.ts);
      }
      watcher.level = frame.level;
      return;
    }
  }
}

function openWatcher(url: string, topic: string, storm: Window): Watcher {
  const socket = new WebSocket(url, null, { headers: { Origin: ORIGIN } });
  const watcher: Watcher = {
    url,
    socket,
    meter: createRateMeter(),
    stormFrames: 0,
    stormChanges: 0,
    opened: false,
    closed: false,
    closing: false,
  };
  socket.onopen = () => {
    watcher.opened = true;
    opened.add(1);
    socket.send(JSON.stringify({ type: 'sub', topics: [topic] }));
  };
  socket.onmessage = (event?: FrameEvent) => {
    if (event !== undefined) onFrame(watcher, event, topic, storm);
  };
  socket.onerror = (event?: { readonly error?: unknown }) => {
    // k6 also reports the end of a socket the script is closing ("close sent"): not an error of the run.
    if (watcher.closing) return;
    if (!watcher.opened) connectErrors.add(1);
    report('socket error', `${url}: ${String(event?.error)}`);
  };
  socket.onclose = (event?: CloseEvent) => {
    watcher.closed = true;
    // A failed handshake also ends in a close; it is already counted as a connect error.
    if (watcher.opened && !watcher.closing) {
      closedEarly.add(1);
      report('closed early', `${url}: ${event?.code ?? 'no code'} ${event?.reason ?? ''}`);
    }
  };
  return watcher;
}

/**
 * Judges every socket's final level against Redis's: a socket that is behind gets a second for its frame to
 * land and is judged against a fresh read, up to `FINAL_READS` reads; one still behind then missed the
 * newest level, which coalescing must always deliver.
 */
async function judgeFinalLevels(watchers: readonly Watcher[], dropId: string): Promise<void> {
  const verdicts = new Map<Watcher, FinalVerdict>(watchers.map((watcher) => [watcher, 'behind']));
  let redis: Stock | undefined;
  for (let read = 1; ; read += 1) {
    try {
      redis = readStock(dropId);
    } catch (error) {
      report('stock read', String(error));
    }
    for (const watcher of watchers) {
      const verdict = verdicts.get(watcher);
      if (redis === undefined || verdict === 'match' || verdict === 'differs') continue;
      verdicts.set(watcher, watcher.closed ? 'behind' : judgeFinal(watcher.level, redis));
    }
    const open = [...verdicts.values()].some((verdict) => verdict === 'behind' || verdict === 'ahead');
    if (!open || read === FINAL_READS) break;
    await delay(1_000);
  }
  for (const [watcher, verdict] of verdicts) {
    if (verdict === 'match') {
      finalMatched.add(1);
    } else {
      report(
        `final level ${verdict}`,
        `${watcher.url}: socket ${JSON.stringify(watcher.level)}, Redis ${JSON.stringify(redis)}`,
      );
    }
  }
}

/** The `watchers` scenario: one VU's share of the sockets, from before the storm until the level settles. */
export async function watch(data: FanoutData): Promise<void> {
  const begin = exec.scenario.startTime;
  const storm: Window = {
    start: begin + stormStartSeconds * 1_000,
    end: begin + stormEndSeconds * 1_000,
  };
  const first = exec.scenario.iterationInTest * SOCKETS_PER_VU;
  const share = Math.min(SOCKETS_PER_VU, profile.sockets - first);
  const topic = `stock:${data.dropId}`;
  const watchers: Watcher[] = [];
  for (let i = 0; i < share; i += 1) {
    watchers.push(openWatcher(WS_URLS[(first + i) % WS_URLS.length] as string, topic, storm));
    await delay(OPEN_SPACING_MS);
  }

  await delay(storm.start - Date.now());
  for (const watcher of watchers) readyInTime.add(watcher.level !== undefined && !watcher.closed ? 1 : 0);

  // Every winner cancels, so once the last release lands the stock is all back and nothing moves the level
  // any more: wait for that on every open socket, then for a frame still on its way.
  await delay(storm.end - Date.now());
  await waitUntil(
    () => watchers.every((w) => w.closed || (w.level !== undefined && isSettled(w.level, STORM.units))),
    storm.end + settleSeconds * 1_000,
  );
  await delay(QUIET_MS);
  await judgeFinalLevels(watchers, data.dropId);

  for (const watcher of watchers) {
    watcher.closing = true;
    if (!watcher.closed) watcher.socket.close();
  }
  await waitUntil(() => watchers.every((w) => w.closed), Date.now() + 5_000);
  for (const watcher of watchers) {
    if (!watcher.opened) continue;
    helloReceived.add(watcher.instanceId !== undefined);
    peakFramesPerSecond.add(watcher.meter.peakFrames());
    peakFramesPerWindow.add(watcher.meter.peakWindowFrames());
    peakChangesPerSecond.add(watcher.meter.peakChanges());
    stormFramesPerSecond.add(watcher.stormFrames / profile.seconds);
    stormChangesPerSecond.add(watcher.stormChanges / profile.seconds);
  }
  const urls = new Set(watchers.map((w) => w.url));
  if (urls.size > 1) {
    const hellos = watchers.flatMap((w) =>
      w.instanceId === undefined ? [] : [{ url: w.url, instanceId: w.instanceId }],
    );
    // Over the sockets that kept their hello (see `helloReceived`), as long as every URL has one.
    const ok = new Set(hellos.map((hello) => hello.url)).size === urls.size && isPinned(hellos);
    pinned.add(ok);
    if (!ok) report('not pinned', JSON.stringify(hellos));
  }
}

// ---------------------------------------------------------------------------------------------------------
// The storm

/**
 * Sends one reserve until it has a final answer, resending retryable ones with the same key (§4.5); returns
 * the order id of a win. One still unanswered after `MAX_ATTEMPTS` is given up: a hold Lua granted for it
 * becomes an orphan the sweeper returns (§4.6), and the watchers wait for that like for any other release.
 */
function reserveOnce(dropId: string, request: ReserveRequest): string | undefined {
  const intent: IntentState = { sent: 0, uncertain: false };
  for (let attempt = 1; ; attempt += 1) {
    const response = reserve(dropId, request);
    intent.sent += 1;
    reserveDuration.add(response.timings.duration);
    if (isRetryable(response.status)) {
      // This send may have committed: a later 200 replay then names the order.
      intent.uncertain = true;
      if (attempt === MAX_ATTEMPTS) {
        gaveUp.add(1);
        report('gave up', `${request.idempotencyKey}: ${response.status} after ${attempt} sends`);
        return undefined;
      }
      retried.add(1);
      sleep(retryDelaySeconds(header(response, 'Retry-After')));
      continue;
    }
    const verdict = judgeReserve(intent, answerOf(response));
    switch (verdict.kind) {
      case 'created':
      case 'replayed':
        won.add(1);
        return intent.orderId;
      case 'sold-out':
        soldOut.add(1);
        return undefined;
      case 'limit-reached':
        limitReached.add(1);
        return undefined;
      case 'rate-limited':
        rateLimited.add(1);
        report('rate limited', '429: raise RATE_LIMIT_IP_PER_SEC and RATE_LIMIT_USER_PER_SEC');
        return undefined;
      case 'expired':
      case 'mismatch':
      case 'unexpected':
        unexpected.add(1);
        report(`reserve ${verdict.kind}`, `${response.status} ${String(response.body).slice(0, 200)}`);
        return undefined;
    }
  }
}

/**
 * Cancels the hold, resending retryable answers; the settlement consumer then releases it in Redis (§6.5).
 * A cancel given up on leaves the hold to expire.
 */
function cancelHold(token: string, orderId: string): void {
  for (let attempt = 1; ; attempt += 1) {
    const response = cancel(token, orderId);
    if (isRetryable(response.status)) {
      if (attempt === MAX_ATTEMPTS) {
        gaveUp.add(1);
        report('gave up', `cancel of ${orderId}: ${response.status} after ${attempt} sends`);
        return;
      }
      retried.add(1);
      sleep(retryDelaySeconds(header(response, 'Retry-After')));
      continue;
    }
    const verdict = judgeCancel(orderId, answerOf(response));
    if (verdict === 'cancelled') cancelled.add(1);
    else if (verdict === 'conflict') cancelConflict.add(1);
    else {
      unexpected.add(1);
      report('cancel', `${orderId}: ${response.status} ${String(response.body).slice(0, 200)}`);
    }
    return;
  }
}

/** The `storm` scenario: one buyer's reserve; a winner keeps its hold briefly, then cancels it. */
export function storm(data: FanoutData): void {
  const token = data.tokens[Math.floor(Math.random() * data.tokens.length)] as string;
  const orderId = reserveOnce(data.dropId, { token, idempotencyKey: uuidv7(), qty: 1 });
  if (orderId === undefined) return;
  sleep(Math.random() * CANCEL_AFTER_MAX_SECONDS);
  cancelHold(token, orderId);
}

/** The level the watchers judged against, once more through the api: all the stock is back. */
export function teardown(data: FanoutData): void {
  const deadline = Date.now() + 15_000;
  let last: Stock | undefined;
  for (;;) {
    try {
      last = readStock(data.dropId);
      if (isSettled(last, STORM.units) && last.sold === 0) {
        stockReturned.add(true);
        return;
      }
    } catch (error) {
      console.warn(`teardown: ${String(error)}`);
    }
    if (Date.now() > deadline) {
      stockReturned.add(false);
      console.error(
        `stock did not come back: ${JSON.stringify(last)}; are the relay (worker) and the settlement consumer running?`,
      );
      return;
    }
    sleep(1);
  }
}

export function handleSummary(data: SummaryData): Record<string, string> {
  const setup = data.setup_data as Partial<FanoutData> | undefined;
  const counters = (pairs: readonly [string, string][]) =>
    pairs.map(([label, metric]) => `${label} ${count(data, metric)}`).join(', ');
  const rate = (metric: string) => {
    const value = stat(data, metric, 'rate');
    return Number.isNaN(value) ? 'n/a' : `${(value * 100).toFixed(1)}%`;
  };
  const perSecond = (metric: string, name: string) => {
    const value = stat(data, metric, name);
    return Number.isNaN(value) ? 'n/a' : value.toFixed(1);
  };
  const lines = [
    `ws-fanout: profile ${PROFILE}, ${profile.sockets} sockets over ${WS_URLS.join(', ')} (${WATCHER_VUS} VUs); storm of ${STORM.rate} reserves/s for ${profile.seconds} s`,
    `  drop ${setup?.dropId ?? '(setup failed)'}: ${STORM.units} units, limit ${STORM.perUserLimit}, ${STORM.buyers} buyers; winners cancel within ${CANCEL_AFTER_MAX_SECONDS} s`,
    `  sockets: ${counters([
      ['opened', 'ws_opened'],
      ['connect errors', 'ws_connect_errors'],
      ['closed early', 'ws_closed_early'],
    ])}; holding a level before the storm ${count(data, 'ws_ready_before_storm')}; hello seen ${rate('ws_hello_received')}; VUs pinned per URL ${rate('ws_pinned')}`,
    `  frames: ${counters([
      ['snapshots', 'ws_snapshots'],
      ['deltas', 'ws_deltas'],
      ['bad', 'ws_bad_frames'],
      ['out of order', 'ws_out_of_order'],
      ['unconserved', 'ws_unconserved'],
      ['topics refused', 'ws_topic_errors'],
    ])}`,
    `  coalescing: during the storm each socket saw ${perSecond('ws_storm_changes_per_second', 'avg')} changes/s in ${perSecond('ws_storm_frames_per_second', 'avg')} frames/s (cap ${MAX_STORM_FRAMES_PER_SECOND} on every socket); at most ${perSecond('ws_peak_frames_per_window', 'max')} frames in any ${FRAME_WINDOW_MS / 1_000} s (cap ${MAX_FRAMES_PER_WINDOW}) and ${perSecond('ws_peak_frames_per_second', 'max')} in any second (reported), while the busiest second carried at least ${perSecond('ws_peak_changes_per_second', 'min')} changes on every socket (gate ${MIN_PEAK_CHANGES_PER_SECOND})`,
    `  propagation (Redis mutation to frame received): p50 ${ms(stat(data, 'ws_propagation', 'med'))}, p95 ${ms(stat(data, 'ws_propagation', 'p(95)'))}, p99 ${ms(stat(data, 'ws_propagation', 'p(99)'))}, max ${ms(stat(data, 'ws_propagation', 'max'))}`,
    `  final level equal to Redis on ${count(data, 'ws_final_level_matched')} of ${profile.sockets} sockets; stock back: ${rate('stock_returned')}`,
    `  storm: ${count(data, 'storm_reserve_duration')} reserves: ${counters([
      ['won', 'storm_won'],
      ['sold out', 'storm_sold_out'],
      ['limit reached', 'storm_limit_reached'],
      ['5xx retried', 'storm_retry'],
      ['gave up', 'storm_gave_up'],
      ['429', 'storm_rate_limited'],
      ['unexpected', 'storm_unexpected'],
    ])}; ${counters([
      ['cancelled', 'storm_cancelled'],
      ['cancel conflicts', 'storm_cancel_conflict'],
    ])}; reserve p95 ${ms(stat(data, 'storm_reserve_duration', 'p(95)'))}`,
    `  dropped iterations (VUs exhausted): ${count(data, 'dropped_iterations')}`,
  ];
  return summaryOutputs(
    `ws-fanout-${PROFILE}`,
    data,
    {
      script: 'ws-fanout',
      profile: PROFILE,
      dropId: setup?.dropId,
      settings: {
        ...profile,
        storm: STORM,
        wsUrls: WS_URLS,
        socketsPerVu: SOCKETS_PER_VU,
        holdSeconds: HOLD_SECONDS,
      },
    },
    lines,
  );
}

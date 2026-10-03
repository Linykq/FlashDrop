import type { IDEMPOTENCY_KEY_HEADER, ReserveBody, ReserveErrorCode } from '@flashdrop/contracts';

/*
 * The Buy button's reserve request, `POST /api/v1/drops/:dropId/reservations` (SD §5.1, §8.2), called
 * same-origin from the browser with the key from `reserve-key.ts`. Its safety rests on that Idempotency-Key:
 * api derives the reservation id from (user, drop, key), so every retry of one intent lands on the same hold
 * and the same order, and a retry can never reserve twice.
 *
 * Responses are read with small type guards rather than the Zod contracts: Zod would weigh on the product
 * page's first load (design-system §14), and only the order id and the problem `code` are used here. api
 * validates the request, and the checkout page re-reads the order through the contract on the server. The
 * module itself loads after the page, before the first press (`use-reserve.ts`).
 */

const KEY_HEADER: typeof IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/** 503s and 429s are retried with the same key for this long in total, then the button gives up (§9.13). */
export const RESERVE_BUDGET_MS = 10_000;
const FIRST_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 2_000;
/** A single attempt never waits longer than the budget left, but always gets this long to answer. */
const MIN_ATTEMPT_MS = 3_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The final refusals: the request was understood and answered; retrying the same key gives the same answer. */
export type RefusalCode = Extract<
  ReserveErrorCode,
  'SOLD_OUT' | 'LIMIT_REACHED' | 'DROP_NOT_LIVE' | 'RESERVATION_EXPIRED' | 'IDEMPOTENCY_KEY_REUSED'
>;

const REFUSALS: readonly string[] = [
  'SOLD_OUT',
  'LIMIT_REACHED',
  'DROP_NOT_LIVE',
  'RESERVATION_EXPIRED',
  'IDEMPOTENCY_KEY_REUSED',
] satisfies readonly RefusalCode[];

function isRefusal(code: unknown): code is RefusalCode {
  return typeof code === 'string' && REFUSALS.includes(code);
}

/** Why a request was retried: the drop is being rebuilt or api is busy, the rate limit, or no network. */
export type RetryCause = 'busy' | 'rate-limited' | 'offline';

export type ReserveOutcome =
  /** 201 (new) or 200 (a replay of this key): the hold exists; checkout shows it. */
  | { kind: 'reserved'; orderId: string }
  | { kind: 'refused'; code: RefusalCode }
  /** 401: the session ended; signing in again keeps the key, so the retry replays. */
  | { kind: 'signed-out' }
  /** Still retryable when the budget ran out. The key is kept: pressing Buy again continues the same intent. */
  | { kind: 'unavailable'; cause: RetryCause }
  /** An answer this flow never expects (400, 403, 404, 500): a bug or a misconfiguration, logged by api. */
  | { kind: 'failed'; status: number };

type Attempt = ReserveOutcome | { kind: 'retry'; cause: RetryCause; afterMs: number | null };

export type ReserveRequest = { dropId: string; qty: number; key: string };

/** What the request needs from the browser, injectable for tests. */
export type ReserveEnvironment = {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** A monotonic clock in milliseconds. */
  now: () => number;
  random: () => number;
  online: () => boolean;
};

const browserEnvironment: ReserveEnvironment = {
  fetch: (url, init) => fetch(url, init),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    }),
  now: () => performance.now(),
  random: Math.random,
  online: () => navigator.onLine,
};

/**
 * Reserves with retries (§9.13): a 503 (the drop is being rebuilt, SD §4.7) or a 429 is sent again with the
 * same key after api's `Retry-After`, or after a backoff, until about 10 s have passed. A network failure is
 * retried the same way, because the request may have reached api: the same key turns a hold it did create
 * into a replay. Rejects only when `signal` aborts (the page went away).
 */
export async function reserve(
  request: ReserveRequest,
  signal: AbortSignal,
  env: ReserveEnvironment = browserEnvironment,
): Promise<ReserveOutcome> {
  const started = env.now();
  for (let attempt = 0; ; attempt++) {
    const remaining = RESERVE_BUDGET_MS - (env.now() - started);
    const result = await send(request, signal, env, Math.max(remaining, MIN_ATTEMPT_MS));
    if (result.kind !== 'retry') return result;
    // Offline, a retry fails at once: say so now rather than after the whole budget.
    if (result.cause === 'offline') return { kind: 'unavailable', cause: 'offline' };
    const wait = retryDelay(result.afterMs, attempt, env.random);
    if (env.now() - started + wait > RESERVE_BUDGET_MS) return { kind: 'unavailable', cause: result.cause };
    await env.sleep(wait, signal);
  }
}

/**
 * api's `Retry-After` when it sent one (1 s while a drop is rebuilt), otherwise exponential backoff from
 * 250 ms, capped at 2 s; either way plus up to 50% jitter, so buyers refused together don't return together.
 */
export function retryDelay(afterMs: number | null, attempt: number, random: () => number): number {
  const base = afterMs ?? Math.min(MAX_BACKOFF_MS, FIRST_BACKOFF_MS * 2 ** attempt);
  return Math.round(base * (1 + random() / 2));
}

async function send(
  { dropId, qty, key }: ReserveRequest,
  signal: AbortSignal,
  env: ReserveEnvironment,
  timeoutMs: number,
): Promise<Attempt> {
  const body: ReserveBody = { qty };
  let response: Response;
  try {
    response = await env.fetch(`/api/v1/drops/${encodeURIComponent(dropId)}/reservations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [KEY_HEADER]: key },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    // No answer: offline, a dropped connection, or this attempt's own timeout.
    return { kind: 'retry', cause: env.online() ? 'busy' : 'offline', afterMs: null };
  }
  return classify(response);
}

async function classify(response: Response): Promise<Attempt> {
  const { status } = response;
  const body: unknown = await response.json().catch(() => undefined);
  switch (status) {
    case 200:
    case 201: {
      const orderId = orderIdOf(body);
      return orderId === null ? { kind: 'failed', status } : { kind: 'reserved', orderId };
    }
    case 401:
      return { kind: 'signed-out' };
    case 409:
    case 410:
    case 422: {
      const code = codeOf(body);
      return isRefusal(code) ? { kind: 'refused', code } : { kind: 'failed', status };
    }
    case 429:
      return { kind: 'retry', cause: 'rate-limited', afterMs: retryAfterMs(response.headers) };
    // 503 is api's RETRY; 502 and 504 come from Caddy while an api instance restarts.
    case 502:
    case 503:
    case 504:
      return { kind: 'retry', cause: 'busy', afterMs: retryAfterMs(response.headers) };
    default:
      return { kind: 'failed', status };
  }
}

function orderIdOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || !('order' in body)) return null;
  const { order } = body;
  if (typeof order !== 'object' || order === null || !('id' in order)) return null;
  return typeof order.id === 'string' && UUID.test(order.id) ? order.id : null;
}

function codeOf(body: unknown): unknown {
  return typeof body === 'object' && body !== null && 'code' in body ? body.code : undefined;
}

/** `Retry-After` in whole seconds, as api sends it; anything else is left to the backoff. */
function retryAfterMs(headers: Headers): number | null {
  const value = headers.get('retry-after');
  if (value === null || !/^\d{1,2}$/.test(value.trim())) return null;
  return Number(value) * 1000;
}

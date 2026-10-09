import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { type CheckoutBody, OrderResponse, type PaymentMethod, ProblemDetails } from '@flashdrop/contracts';
import { type Buyer, SHIPPING } from '../../tools/system/support';

/*
 * The scripted burst a chaos run breaks the stack under (design §13): buyers reserve one unit each through
 * Caddy, and each winner then does what k6 burst.ts's winners do, in about the same mix: check out and pay
 * (`pm_ok`), check out and be declined (`pm_decline`), cancel the hold, or walk away from it. Scripted
 * rather than k6 because a chaos run needs to know, per order, which end it must reach, and to inject its
 * fault at a known point of the burst.
 *
 * Retries behave like the storefront's: a 502, 503 or 504, or no answer at all, is resent with the same
 * Idempotency-Key after `Retry-After`. That is what keeps a burst going through a fault that fails requests
 * closed (Redis down: reserves answer 503 `RETRY`), and what heals a hold Lua granted whose answer was lost
 * (§4.5). Any other answer outside the contract stops the burst: it is a finding, not noise.
 */

/** What a winner does with its hold, and the order status that must result once the stack is quiescent. */
export type Fate = 'pay' | 'decline' | 'cancel' | 'abandon';

export const FINAL_STATUS: Readonly<Record<Fate, string>> = {
  pay: 'PAID',
  decline: 'PAYMENT_FAILED',
  cancel: 'CANCELLED',
  abandon: 'EXPIRED',
};

/**
 * 60% pay, 10% declined, 20% cancel, 10% walk away (k6: 63/7/20/10), interleaved so that every stretch of
 * the burst, and so every fault window, sees the whole mix.
 */
const FATE_CYCLE: readonly Fate[] = [
  'pay',
  'pay',
  'cancel',
  'pay',
  'pay',
  'abandon',
  'pay',
  'cancel',
  'pay',
  'decline',
];

export function fateOf(winner: number): Fate {
  return FATE_CYCLE[winner % FATE_CYCLE.length] ?? 'pay';
}

const PAYMENT_METHOD: Readonly<Record<'pay' | 'decline', PaymentMethod>> = {
  pay: 'pm_ok',
  decline: 'pm_decline',
};

export interface BurstOptions {
  readonly baseUrl: string;
  readonly dropId: string;
  readonly buyers: readonly Buyer[];
  /** Buyers in flight at once. */
  readonly concurrency: number;
  /** Each lane's pause after a buyer: with `concurrency`, it sets the pace and so the length of the burst. */
  readonly paceMs: number;
}

export interface BurstProgress {
  /** Buyers whose reserve was answered. */
  readonly handled: number;
  readonly won: number;
  readonly soldOut: number;
  readonly checkedOut: number;
  readonly cancelled: number;
  readonly abandoned: number;
  /** Resends by cause: an HTTP status, or `no answer`. */
  readonly retries: Readonly<Record<string, number>>;
  /** When the first and the last resend went out (ms since the epoch), or null: the window the fault was felt. */
  readonly retryWindow: { readonly first: number; readonly last: number } | null;
}

export interface BurstResult extends BurstProgress {
  /** Every order the burst won, with what its buyer did. */
  readonly orders: ReadonlyMap<string, Fate>;
  readonly elapsedMs: number;
}

export interface Burst {
  progress(): BurstProgress;
  /** No buyer starts after this; those under way finish. */
  stop(): void;
  /** Settles when every buyer is through; rejects on the first answer outside the contract. */
  readonly finished: Promise<BurstResult>;
}

/** How long one request may keep being resent: longer than any fault a scenario injects. */
const RETRY_BUDGET_MS = 180_000;
const REQUEST_TIMEOUT_MS = 15_000;
const RETRYABLE = new Set([0, 502, 503, 504]);

interface Answer {
  /** 0: no answer (connection refused or reset, or the request timed out). */
  readonly status: number;
  readonly json: unknown;
  readonly retryAfterMs: number;
}

export function startBurst(options: BurstOptions): Burst {
  const startedAt = Date.now();
  const queue = [...options.buyers];
  const orders = new Map<string, Fate>();
  const retries: Record<string, number> = {};
  let retryWindow: { first: number; last: number } | null = null;
  let handled = 0;
  let soldOut = 0;
  let checkedOut = 0;
  let cancelled = 0;
  let abandoned = 0;
  let stopped = false;

  async function send(
    method: string,
    path: string,
    buyer: Buyer,
    key?: string,
    body?: unknown,
  ): Promise<Answer> {
    const headers: Record<string, string> = {
      origin: options.baseUrl,
      cookie: `fd_session=${buyer.token}`,
    };
    if (key !== undefined) headers['idempotency-key'] = key;
    if (body !== undefined) headers['content-type'] = 'application/json';
    try {
      const response = await fetch(`${options.baseUrl}/api/v1${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await response.text();
      const retryAfter = Number(response.headers.get('retry-after'));
      // The api answers JSON; Caddy's own 502 while an upstream is down is plain text.
      const json = response.headers.get('content-type')?.includes('json')
        ? (JSON.parse(text) as unknown)
        : text;
      return {
        status: response.status,
        json,
        retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000,
      };
    } catch (error) {
      // fetch rejects only without an answer: refused, reset, or our timeout. The request may still have been
      // applied, which the same-key resend sorts out.
      if (error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError')) {
        return { status: 0, json: undefined, retryAfterMs: 1000 };
      }
      throw error;
    }
  }

  /** `send`, resent with the same key while the answer is retryable. */
  async function sendRetrying(what: string, attempt: () => Promise<Answer>): Promise<Answer> {
    const deadline = Date.now() + RETRY_BUDGET_MS;
    for (;;) {
      const answer = await attempt();
      if (!RETRYABLE.has(answer.status)) return answer;
      const cause = answer.status === 0 ? 'no answer' : String(answer.status);
      retries[cause] = (retries[cause] ?? 0) + 1;
      const now = Date.now();
      retryWindow =
        retryWindow === null ? { first: now, last: now } : { first: retryWindow.first, last: now };
      if (now > deadline)
        throw new Error(`${what}: still ${cause} after ${RETRY_BUDGET_MS / 1000} s of resends`);
      // Up to half a second of jitter, so lanes held up together don't come back in lockstep.
      await sleep(answer.retryAfterMs + Math.random() * 500);
    }
  }

  const unexpected = (what: string, answer: Answer) =>
    new Error(`${what}: unexpected ${answer.status} ${JSON.stringify(answer.json)}`);

  async function buy(buyer: Buyer): Promise<void> {
    const reserveKey = `chaos_${randomUUID()}`;
    const reserved = await sendRetrying('reserve', () =>
      send('POST', `/drops/${options.dropId}/reservations`, buyer, reserveKey, { qty: 1 }),
    );
    handled++;
    if (reserved.status === 409 && ProblemDetails.safeParse(reserved.json).data?.code === 'SOLD_OUT') {
      soldOut++;
      return;
    }
    if (reserved.status !== 201 && reserved.status !== 200) throw unexpected('reserve', reserved);
    const orderId = OrderResponse.parse(reserved.json).order.id;
    const fate = fateOf(orders.size);
    orders.set(orderId, fate);

    if (fate === 'abandon') {
      abandoned++;
      return;
    }
    if (fate === 'cancel') {
      let attempts = 0;
      const answer = await sendRetrying('cancel', () => {
        attempts++;
        return send('POST', `/orders/${orderId}/cancel`, buyer);
      });
      // Cancel carries no key: after a lost answer, the resend finds the order already cancelled (409). The
      // final status check confirms it either way.
      if (answer.status !== 200 && !(answer.status === 409 && attempts > 1))
        throw unexpected('cancel', answer);
      cancelled++;
      return;
    }
    const checkoutKey = `chaos_${randomUUID()}`;
    const body: CheckoutBody = { shipping: SHIPPING, paymentMethod: PAYMENT_METHOD[fate] };
    const answer = await sendRetrying('checkout', () =>
      send('POST', `/orders/${orderId}/checkout`, buyer, checkoutKey, body),
    );
    // 202 a new submit; 200 the replay of one whose answer was lost.
    if (answer.status !== 202 && answer.status !== 200) throw unexpected('checkout', answer);
    checkedOut++;
  }

  async function lane(): Promise<void> {
    for (let buyer = queue.shift(); buyer !== undefined && !stopped; buyer = queue.shift()) {
      await buy(buyer);
      if (options.paceMs > 0) await sleep(options.paceMs);
    }
  }

  const progress = (): BurstProgress => ({
    handled,
    won: orders.size,
    soldOut,
    checkedOut,
    cancelled,
    abandoned,
    retries: { ...retries },
    retryWindow,
  });

  const finished = Promise.all(
    Array.from({ length: options.concurrency }, () =>
      lane().catch((error: unknown) => {
        // One broken lane ends the burst: the others start no new buyer.
        stopped = true;
        throw error;
      }),
    ),
  ).then(() => ({ ...progress(), orders, elapsedMs: Date.now() - startedAt }));
  // The harness awaits `finished` after the fault; until then this keeps a failure from counting as unhandled.
  finished.catch(() => undefined);

  return {
    progress,
    stop: () => {
      stopped = true;
    },
    finished,
  };
}

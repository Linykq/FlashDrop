/*
 * How the load scripts judge reserve answers (design §4.5, §5.2). Plain TypeScript without k6 imports, so
 * the Vitest unit project tests the same logic that k6 runs (verdict.test.ts).
 */

/**
 * No answer (0), RETRY (503: the drop is RECONCILING, or Postgres is out of reach), or the edge without a
 * healthy api (502, 504, e.g. while an instance restarts). The request may have committed before its
 * answer was lost, so the client resends it with the same key and body, as the storefront does (§4.5).
 */
export function isRetryable(status: number): boolean {
  return status === 0 || status === 502 || status === 503 || status === 504;
}

/** `Retry-After` in seconds (§5.2 sends `Retry-After: 1`); 1 s when it is missing or not a delay. */
export function retryDelaySeconds(retryAfter: string | undefined): number {
  const seconds = Number(retryAfter);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 10) : 1;
}

/** What the scripts know about one intent (one session, one key, one body) across all of its sends. */
export interface IntentState {
  /** Sends so far, concurrent copies included. */
  sent: number;
  /**
   * An earlier send was retried (see `isRetryable`): it may have committed, so a 200 replay may be the
   * first answer that names the order. Without one, a replay of an order no answer created is a bug.
   */
  uncertain: boolean;
  /** The order a 201 or 200 named; every later answer for this key must name the same one. */
  orderId?: string;
}

/** The parts of a reserve answer that the verdict depends on. */
export interface ReserveAnswer {
  readonly status: number;
  /** The order of a 201/200 `OrderResponse`. */
  readonly order?: { readonly id: string; readonly status: string; readonly qty: number };
  /** `Idempotency-Replayed: true`. */
  readonly replayed: boolean;
  /** The problem-details `code` (`SOLD_OUT`, ...). */
  readonly code?: string;
}

export type Verdict =
  /** This answer created the order. */
  | { readonly kind: 'created' }
  /** A replay; `newOrder` when no earlier answer named the order, because the 201 was lost on the way. */
  | { readonly kind: 'replayed'; readonly newOrder: boolean }
  | { readonly kind: 'sold-out' }
  | { readonly kind: 'limit-reached' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'rate-limited' }
  /** The answer contradicts what earlier answers for the same key said: an idempotency bug. */
  | { readonly kind: 'mismatch'; readonly reason: string }
  /** An answer the reserve route never gives under this load. */
  | { readonly kind: 'unexpected'; readonly reason: string };

/**
 * Judges one final (not retryable) answer against everything earlier answers for the same intent said,
 * and records the order it names on `intent`. Concurrent copies of one intent are judged in
 * `byJudgingOrder`, so the 201 names the order before its twin's 200 replays it.
 *
 * `newOrder` and `created` together count every order a client learned of exactly once, which is what the
 * burst gates on: counting 201s alone would miss an order whose 201 was lost and whose retry replayed it.
 */
export function judgeReserve(intent: IntentState, answer: ReserveAnswer): Verdict {
  switch (answer.status) {
    case 201:
      // A key creates its order once; a second 201 for it would be a second reservation.
      if (answer.order === undefined || answer.order.status !== 'RESERVED') {
        return { kind: 'mismatch', reason: 'a 201 without a RESERVED order' };
      }
      if (intent.orderId !== undefined) return { kind: 'mismatch', reason: 'second creation' };
      intent.orderId = answer.order.id;
      return { kind: 'created' };
    case 200: {
      if (answer.order === undefined || !answer.replayed || intent.sent < 2) {
        return { kind: 'mismatch', reason: 'a replay without an earlier send, an order or the header' };
      }
      if (intent.orderId === undefined) {
        if (!intent.uncertain) return { kind: 'mismatch', reason: 'a replay of an order no answer created' };
        intent.orderId = answer.order.id;
        return { kind: 'replayed', newOrder: true };
      }
      if (intent.orderId !== answer.order.id)
        return { kind: 'mismatch', reason: 'a replay of another order' };
      return { kind: 'replayed', newOrder: false };
    }
    case 409:
      // An order that exists can be replayed, expired or paid, never refused.
      if (intent.orderId !== undefined) return { kind: 'mismatch', reason: 'a created order refused' };
      if (answer.code === 'SOLD_OUT') return { kind: 'sold-out' };
      if (answer.code === 'LIMIT_REACHED') return { kind: 'limit-reached' };
      return { kind: 'unexpected', reason: `refused with ${String(answer.code)}` };
    case 410:
      return intent.orderId === undefined
        ? { kind: 'unexpected', reason: 'expired before it existed' }
        : { kind: 'expired' };
    case 429:
      return { kind: 'rate-limited' };
    default:
      return { kind: 'unexpected', reason: `status ${answer.status}` };
  }
}

/** Creation first, then replays, then the rest: the order in which concurrent copies' answers are judged. */
export function byJudgingOrder(a: { readonly status: number }, b: { readonly status: number }): number {
  const rank = (status: number) => (status === 201 ? 0 : status === 200 ? 1 : 2);
  return rank(a.status) - rank(b.status);
}

/**
 * The idempotency storm's verdict: every final answer names the storm's one order (`rid`, `qty`), either as
 * its creation (201) or as a replay (200 with the header).
 */
export function judgeStormAnswer(
  expected: { readonly rid: string; readonly qty: number },
  answer: ReserveAnswer,
): 'created' | 'replayed' | 'wrong' {
  if (answer.order?.id !== expected.rid || answer.order.qty !== expected.qty) return 'wrong';
  if (answer.status === 201) return 'created';
  return answer.status === 200 && answer.replayed ? 'replayed' : 'wrong';
}

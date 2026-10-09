/*
 * How the load scripts judge answers (design §4.5, §5.1, §5.2, §6.5): reserve, checkout submit, cancel and
 * the payment outcome, and how a burst's winner picks what to do next. Plain TypeScript without k6 imports,
 * so the Vitest unit project tests the same logic that k6 runs (verdict.test.ts).
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

/** The parts of an order answer (reserve, checkout, cancel) that a verdict depends on. */
export interface OrderAnswer {
  readonly status: number;
  /** The order of a 2xx `OrderResponse`. */
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
export function judgeReserve(intent: IntentState, answer: OrderAnswer): Verdict {
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

/**
 * Creation first, then replays, then the rest: the order in which concurrent copies' answers are judged.
 * Checkout's 202 ranks with reserve's 201: both are the one answer that made the change.
 */
export function byJudgingOrder(a: { readonly status: number }, b: { readonly status: number }): number {
  const rank = (status: number) => (status === 201 || status === 202 ? 0 : status === 200 ? 1 : 2);
  return rank(a.status) - rank(b.status);
}

/**
 * The judging order of concurrent reserve copies when stock comes back during the run (cancels, declines):
 * refusals first, then the creation, then replays. Lua records nothing for a refusal (losers get a read-only
 * answer, §4.2), and a copy whose call ran after its twin's creation gets EXISTING, never SOLD_OUT or LIMIT.
 * So a refused copy ran first, and a unit or quota returned in between explains the pair. With nothing
 * returned mid-run (reserve-only), `byJudgingOrder` flags such a pair instead.
 */
export function byJudgingOrderWithReturns(
  a: { readonly status: number },
  b: { readonly status: number },
): number {
  const rank = (status: number) => (status === 409 ? 0 : status === 201 ? 1 : status === 200 ? 2 : 3);
  return rank(a.status) - rank(b.status);
}

/**
 * The idempotency storm's verdict: every final answer names the storm's one order (`rid`, `qty`), either as
 * the one answer that made the change (`changedBy`: 201 for the reserve storm, 202 for the checkout storm)
 * or as a replay (200 with the header). Thresholds then require exactly one change.
 */
export function judgeStormAnswer(
  expected: { readonly rid: string; readonly qty: number; readonly changedBy: 201 | 202 },
  answer: OrderAnswer,
): 'changed' | 'replayed' | 'wrong' {
  if (answer.order?.id !== expected.rid || answer.order.qty !== expected.qty) return 'wrong';
  if (answer.status === expected.changedBy) return 'changed';
  return answer.status === 200 && answer.replayed ? 'replayed' : 'wrong';
}

/** What the scripts know about one checkout submit (one order, one checkout key, one body). */
export interface CheckoutState {
  /** Sends so far, concurrent copies included. */
  sent: number;
  /** An earlier send got no final answer and may have committed (see `IntentState.uncertain`). */
  uncertain: boolean;
  /** A 202 or a first replay said the order was submitted. */
  submitted: boolean;
}

export type CheckoutVerdict =
  /** This answer submitted the order: 202, PENDING_PAYMENT. */
  | { readonly kind: 'submitted' }
  /** A 200 replay of the submission; `newSubmission` when the 202 was lost on the way. */
  | { readonly kind: 'replayed'; readonly newSubmission: boolean }
  /** 410: the hold ran out before the submit (the client was slower than the hold). */
  | { readonly kind: 'expired' }
  /** The answer contradicts earlier answers for the same key: an idempotency bug. */
  | { readonly kind: 'mismatch'; readonly reason: string }
  | { readonly kind: 'unexpected'; readonly reason: string };

/**
 * Judges a final checkout answer (§5.2): the CAS on RESERVED submits once, and every other send with the
 * same key and body replays it with 200 and the order as it is now, whatever the payment did meanwhile.
 * The scripts use one key per order, so 409 ALREADY_SUBMITTED (another key won) is a bug here.
 */
export function judgeCheckout(state: CheckoutState, orderId: string, answer: OrderAnswer): CheckoutVerdict {
  switch (answer.status) {
    case 202:
      if (answer.order?.id !== orderId || answer.order.status !== 'PENDING_PAYMENT') {
        return { kind: 'mismatch', reason: 'a 202 without the order in PENDING_PAYMENT' };
      }
      if (state.submitted) return { kind: 'mismatch', reason: 'second submission' };
      state.submitted = true;
      return { kind: 'submitted' };
    case 200:
      if (answer.order?.id !== orderId || !answer.replayed || state.sent < 2) {
        return { kind: 'mismatch', reason: 'a replay without an earlier send, the order or the header' };
      }
      if (state.submitted) return { kind: 'replayed', newSubmission: false };
      if (!state.uncertain) return { kind: 'mismatch', reason: 'a replay of a submission no answer made' };
      state.submitted = true;
      return { kind: 'replayed', newSubmission: true };
    case 409:
      return answer.code === 'ALREADY_SUBMITTED'
        ? { kind: 'mismatch', reason: 'submitted under another key' }
        : { kind: 'unexpected', reason: `refused with ${String(answer.code)}` };
    case 410:
      return state.submitted
        ? { kind: 'mismatch', reason: 'a submitted order answered as expired' }
        : { kind: 'expired' };
    default:
      return { kind: 'unexpected', reason: `status ${answer.status}` };
  }
}

/**
 * A cancel of a RESERVED hold (§5.1): 200 with the order CANCELLED, also on a repeat. 409 CONFLICT means
 * the order ended otherwise first; for a hold cancelled at once that is the sweeper only after its hold ran
 * out, so it is counted, not failed.
 */
export function judgeCancel(orderId: string, answer: OrderAnswer): 'cancelled' | 'conflict' | 'unexpected' {
  if (answer.status === 200 && answer.order?.id === orderId && answer.order.status === 'CANCELLED') {
    return 'cancelled';
  }
  return answer.status === 409 && answer.code === 'CONFLICT' ? 'conflict' : 'unexpected';
}

/** Statuses after which a submitted order's payment changes nothing more (§4.4). */
export const SETTLED_PAYMENT_STATUSES: readonly string[] = ['PAID', 'PAYMENT_FAILED', 'EXPIRED', 'CANCELLED'];

/** The test payment methods the burst uses and how the PSP answers each (`apps/payment-mock`). */
export const PAYMENT_OUTCOMES = { pm_ok: 'PAID', pm_decline: 'PAYMENT_FAILED' } as const;
export type BurstPaymentMethod = keyof typeof PAYMENT_OUTCOMES;

/** Whether a submitted order ended as its payment method says it must: pm_ok PAID, pm_decline failed. */
export function judgePayment(method: BurstPaymentMethod, finalStatus: string): 'as-expected' | 'wrong' {
  return finalStatus === PAYMENT_OUTCOMES[method] ? 'as-expected' : 'wrong';
}

/** What a burst's winner does with its hold (§13): check out, cancel, or walk away and let it expire. */
export type Fate = 'checkout' | 'cancel' | 'abandon';

export interface FateShares {
  readonly checkout: number;
  readonly cancel: number;
}

/** Picks a fate from a uniform roll in [0, 1): `checkout` share first, then `cancel`, the rest abandon. */
export function pickFate(roll: number, shares: FateShares): Fate {
  if (roll < shares.checkout) return 'checkout';
  return roll < shares.checkout + shares.cancel ? 'cancel' : 'abandon';
}

/** Picks the checkout's payment method from a uniform roll: `pm_decline` with `declineShare`. */
export function pickPaymentMethod(roll: number, declineShare: number): BurstPaymentMethod {
  return roll < declineShare ? 'pm_decline' : 'pm_ok';
}

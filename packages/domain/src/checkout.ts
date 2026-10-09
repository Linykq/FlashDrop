import { sameBytes } from './bytes';
import { BugError, type ErrorCode } from './errors';
import type { OrderStatus } from './statuses';

/*
 * Checkout submit, cancel and the hold extension (design §4.4, §5.1, §5.2): how a request is answered when
 * its compare-and-set changed nothing. Pure and browser-safe; `packages/db` classifies inside the
 * transaction that ran the CAS, and `api` maps the codes to HTTP statuses (`ERROR_STATUS`).
 */

/** The one hold extension (WCAG 2.2.1, §8.3): +60 s, once, while the order is RESERVED and still held. */
export const HOLD_EXTENSION_SECONDS = 60;

/** The fields of a stored order that decide how a checkout submit the CAS refused is answered. */
export interface CheckoutReplayable {
  readonly status: OrderStatus;
  /** The Idempotency-Key of the submit that moved the order to PENDING_PAYMENT; null before checkout. */
  readonly checkoutKey: string | null;
  /** `checkoutFingerprint({orderId, shipping, paymentMethod})` of that submit. */
  readonly checkoutHash: Uint8Array | null;
}

export const CHECKOUT_REFUSALS = [
  'IDEMPOTENCY_KEY_REUSED',
  'ALREADY_SUBMITTED',
  'RESERVATION_EXPIRED',
  'CONFLICT',
] as const satisfies readonly ErrorCode[];
export type CheckoutRefusal = (typeof CHECKOUT_REFUSALS)[number];

export type CheckoutReplay =
  | { readonly kind: 'order' }
  | { readonly kind: 'refused'; readonly code: CheckoutRefusal };

/**
 * How a checkout submit is answered when the submit CAS (`status = 'RESERVED' AND expires_at > now()`, for
 * the caller's own order) updated nothing (§5.2):
 *
 * - submitted under this key: the same body replays (200 with the order as it is now, paid, failed or
 *   expired included, since that submit did happen); another body is 422 `IDEMPOTENCY_KEY_REUSED`;
 * - submitted under another key: 409 `ALREADY_SUBMITTED` (another tab placed it; the UI opens the order);
 * - never submitted and RESERVED or EXPIRED: 410 `RESERVATION_EXPIRED`. A RESERVED order the CAS refused had
 *   passed its deadline by the CAS's `now()`; the sweeper simply has not expired it yet;
 * - never submitted and CANCELLED or REJECTED: 409 `CONFLICT`, the order is closed.
 *
 * Only valid for an order the CAS refused: a live, unexpired RESERVED order would read as expired.
 */
export function checkoutReplay(
  order: CheckoutReplayable,
  checkoutKey: string,
  fingerprint: Uint8Array,
): CheckoutReplay {
  if (order.checkoutKey === checkoutKey) {
    if (order.checkoutHash === null) throw new BugError('a submitted order without a checkout_hash');
    return sameBytes(order.checkoutHash, fingerprint)
      ? { kind: 'order' }
      : { kind: 'refused', code: 'IDEMPOTENCY_KEY_REUSED' };
  }
  if (order.checkoutKey !== null) return { kind: 'refused', code: 'ALREADY_SUBMITTED' };
  switch (order.status) {
    case 'RESERVED':
    case 'EXPIRED':
      return { kind: 'refused', code: 'RESERVATION_EXPIRED' };
    case 'CANCELLED':
    case 'REJECTED':
      return { kind: 'refused', code: 'CONFLICT' };
    default:
      // PENDING_PAYMENT and everything after it is reached only through a submit, which sets the key.
      throw new BugError(`a ${order.status} order without a checkout key`);
  }
}

export type CancelReplay =
  | { readonly kind: 'order' }
  | { readonly kind: 'refused'; readonly code: 'CONFLICT' };

/**
 * How a cancel is answered when its CAS (RESERVED or PENDING_PAYMENT to CANCELLED, for the caller's own
 * order) updated nothing (§5.1). Only the owner cancels, so a CANCELLED order is the same intent repeated (a
 * double click, a retried request) and is answered like the first time. Any other status means the order
 * moved on first, paid, failed or expired, and the cancel lost: 409.
 */
export function cancelReplay(status: OrderStatus): CancelReplay {
  return status === 'CANCELLED' ? { kind: 'order' } : { kind: 'refused', code: 'CONFLICT' };
}

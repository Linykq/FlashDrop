import { BugError, type ErrorCode } from './errors';
import type { CloseReason, OrderStatus } from './statuses';

/*
 * The vocabulary of a reservation's admission (design §4.2, §4.5, §5.2): what Lua answers, why Redis or
 * Postgres refuses, how both map to API error codes, and what a replayed request gets. Pure and
 * browser-safe; `api` turns these outcomes into HTTP answers.
 */

/** `orders.qty` CHECK, the Lua `BAD_QTY` guard and `ReserveBody` share this range. */
export const MIN_ORDER_QTY = 1;
export const MAX_ORDER_QTY = 10;

/** First element of every `fd_reserve` reply (§4.2). */
export const RESERVE_REPLY_CODES = [
  'RESERVED',
  'EXISTING',
  'RETRY',
  'NO_DROP',
  'NOT_LIVE',
  'LIMIT',
  'SOLD_OUT',
  'FP_MISMATCH',
  'BAD_QTY',
] as const;
export type ReserveReplyCode = (typeof RESERVE_REPLY_CODES)[number];

/**
 * Why an admission is refused. Lua answers these before any write; Postgres answers the same three when it
 * refuses what Redis admitted, and the REJECTED tombstone then carries the reason as its `close_reason`.
 */
export const ADMISSION_REFUSALS = ['SOLD_OUT', 'LIMIT', 'NOT_LIVE'] as const satisfies readonly CloseReason[];
export type AdmissionRefusal = (typeof ADMISSION_REFUSALS)[number];

/**
 * What the reserve transaction can roll back with (§5.2): a refusal, or `STALE_GEN` when a rebuild fenced
 * the generation Lua admitted under (§4.7). `STALE_GEN` writes no tombstone: the rebuild already dropped the
 * hold, so the client simply retries with the same key.
 */
export type PostgresRefusal = AdmissionRefusal | 'STALE_GEN';

/** The `close_reason` of a REJECTED order: a Postgres refusal, or `ORPHANED` from the orphan scan (§4.6). */
export const REJECT_REASONS = [...ADMISSION_REFUSALS, 'ORPHANED'] as const satisfies readonly CloseReason[];
export type RejectReason = (typeof REJECT_REASONS)[number];

/** §5.2: Lua refusals and Postgres refusals map to the same 409 codes. */
export const LUA_TO_API = {
  NOT_LIVE: 'DROP_NOT_LIVE',
  LIMIT: 'LIMIT_REACHED',
  SOLD_OUT: 'SOLD_OUT',
} as const satisfies Readonly<Record<AdmissionRefusal, ErrorCode>>;

/** The API code for a refused reserve transaction: a refusal is a 409, a fenced generation a 503 `RETRY`. */
export function refusalErrorCode(reason: PostgresRefusal): ErrorCode {
  return reason === 'STALE_GEN' ? 'RETRY' : LUA_TO_API[reason];
}

/** The API code a replay of a REJECTED order answers with. */
export function rejectionErrorCode(reason: RejectReason): ErrorCode {
  // An orphan is a hold that lapsed before Postgres recorded it: to the buyer, an expired reservation.
  return reason === 'ORPHANED' ? 'RESERVATION_EXPIRED' : LUA_TO_API[reason];
}

/** The fields of a stored order that decide how a replay of its reserve request is answered. */
export interface ReplayableOrder {
  readonly status: OrderStatus;
  readonly closeReason: CloseReason | null;
  /** `orders.request_hash`, the reserve fingerprint the order was created with. */
  readonly requestHash: Uint8Array;
}

export type ReserveReplay =
  | { readonly kind: 'order' }
  | { readonly kind: 'refused'; readonly code: ErrorCode };

/**
 * How a reserve request whose rid already has an order is answered (§4.5): another body under the same key
 * is 422 `IDEMPOTENCY_KEY_REUSED`; a tombstone replays its refusal (409, or 410 for an orphan); an expired
 * hold is 410 `RESERVATION_EXPIRED`; anything else is a 200 with the order's current representation.
 */
export function reserveReplay(order: ReplayableOrder, fingerprint: Uint8Array): ReserveReplay {
  if (!sameBytes(order.requestHash, fingerprint)) return { kind: 'refused', code: 'IDEMPOTENCY_KEY_REUSED' };
  if (order.status === 'EXPIRED') return { kind: 'refused', code: 'RESERVATION_EXPIRED' };
  if (order.status === 'REJECTED') {
    const reason = order.closeReason;
    if (!isRejectReason(reason)) throw new BugError(`REJECTED order with close_reason ${String(reason)}`);
    return { kind: 'refused', code: rejectionErrorCode(reason) };
  }
  return { kind: 'order' };
}

function isRejectReason(reason: CloseReason | null): reason is RejectReason {
  return (REJECT_REASONS as readonly (CloseReason | null)[]).includes(reason);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** States of a Redis `rsv` entry (§4.1). */
export const RSV_STATES = ['HELD', 'COMMITTED', 'RELEASED'] as const;
export type RsvState = (typeof RSV_STATES)[number];

/**
 * The `rsv` state a rebuild writes for an order (§4.7 step 4): live orders still hold stock, PAID ones
 * committed it, every other terminal order is kept as a released idempotency record.
 */
export function rsvStateOf(status: OrderStatus): RsvState {
  if (status === 'RESERVED' || status === 'PENDING_PAYMENT') return 'HELD';
  if (status === 'PAID') return 'COMMITTED';
  return 'RELEASED';
}

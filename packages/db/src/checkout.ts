import type { PaymentMethod, ShippingAddress } from '@flashdrop/contracts';
import {
  type CheckoutRefusal,
  cancelReplay,
  checkoutReplay,
  HOLD_EXTENSION_SECONDS,
  LIVE_ORDER_STATUSES,
} from '@flashdrop/domain';
import { checkoutFingerprint, uuidv7 } from '@flashdrop/domain/identity';
import { sql } from 'drizzle-orm';
import type { Db } from './client';
import {
  getOrderForUser,
  ORDER_PRODUCT_COLUMNS,
  type OrderWithProduct,
  parseOrderWithProductRows,
} from './orders';
import { insertOutboxEvents, notifyOutbox, orderEvent } from './outbox';
import { transaction } from './transaction';

/*
 * The buyer's transitions after reserve (design §4.4, §5.1, §5.2): checkout submit, cancel and the one-time
 * hold extension. Each is one compare-and-set on the caller's own order (`user_id` is in every WHERE, so
 * another user's order is "not found", never "forbidden", §11). The orders row lock is the single
 * linearization point of every race on one order (submit vs cancel vs expiry vs payment): whoever's CAS
 * commits first wins, and the loser re-reads the committed outcome and classifies it.
 *
 * Use the api pool profile (`statement_timeout=2s`, `transaction_timeout=5s`). None of these touch Redis or
 * the PSP: the settlement consumer (or the safety net) gives stock back to Redis after Postgres commits.
 */

export interface CheckoutSubmission {
  readonly orderId: string;
  readonly userId: string;
  /** The submit's `Idempotency-Key`, created once per order by the checkout form (§8.2). */
  readonly checkoutKey: string;
  /** Parsed by `CheckoutBody`: the fingerprint hashes this normalized value. */
  readonly shipping: ShippingAddress;
  readonly paymentMethod: PaymentMethod;
  readonly traceId?: string;
}

export type CheckoutOutcome =
  /** 202: now PENDING_PAYMENT, `expiresAt` = the payment deadline. */
  | ({ readonly kind: 'submitted' } & OrderWithProduct)
  /** 200 with `Idempotency-Replayed: true`: submitted before with this key and body; the order as it is now. */
  | ({ readonly kind: 'replay' } & OrderWithProduct)
  /** 409 `ALREADY_SUBMITTED` or `CONFLICT`, 410 `RESERVATION_EXPIRED`, 422 `IDEMPOTENCY_KEY_REUSED`. */
  | { readonly kind: 'refused'; readonly code: CheckoutRefusal }
  /** 404: no such order, or another user's. */
  | { readonly kind: 'not_found' };

/**
 * Checkout submit (§5.2): one CAS, RESERVED and unexpired to PENDING_PAYMENT, that stores the checkout key,
 * its fingerprint, shipping and the payment method and moves `expires_at` to `now() + payment_seconds`;
 * then the `order.placed` outbox row and a NOTIFY to the relay (a low-rate path, §5.4), in the same
 * transaction. No counter changes: the units stay reserved and claimed until the order is paid or ends.
 *
 * When the CAS updates nothing, the order is re-read and classified (`checkoutReplay`): a same-key retry
 * replays, a concurrent submit from another tab is ALREADY_SUBMITTED. Two concurrent submits serialize on the
 * row lock, and the second sees the first one's committed key.
 */
export async function submitCheckout(db: Db, submission: CheckoutSubmission): Promise<CheckoutOutcome> {
  const { orderId, userId, checkoutKey, shipping, paymentMethod } = submission;
  const fingerprint = checkoutFingerprint({ orderId, shipping, paymentMethod });
  return transaction(db, async (tx): Promise<CheckoutOutcome> => {
    // The join reads the drop's payment window through MVCC and locks nothing there (§3: never lock drops).
    const { rows } = await tx.execute(sql`
      WITH placed AS (
        UPDATE orders o
        SET status = 'PENDING_PAYMENT', checkout_key = ${checkoutKey}::text, checkout_hash = ${fingerprint}::bytea,
            shipping = ${JSON.stringify(shipping)}::jsonb, payment_method = ${paymentMethod}::text,
            expires_at = now() + make_interval(secs => d.payment_seconds),
            version = o.version + 1, updated_at = now()
        FROM drops d
        WHERE o.id = ${orderId}::uuid AND o.user_id = ${userId}::uuid
          AND o.status = 'RESERVED' AND o.expires_at > now() AND d.id = o.drop_id
        RETURNING o.*)
      SELECT placed.*, ${ORDER_PRODUCT_COLUMNS} FROM placed JOIN products p ON p.id = placed.product_id`);
    const [placed] = parseOrderWithProductRows(rows, 'submitCheckout');
    if (placed === undefined) {
      const found = await getOrderForUser(tx, orderId, userId);
      if (found === undefined) return { kind: 'not_found' };
      const replay = checkoutReplay(found.order, checkoutKey, fingerprint);
      return replay.kind === 'order' ? { kind: 'replay', ...found } : replay;
    }

    const { order } = placed;
    await insertOutboxEvents(tx, [
      orderEvent(
        'order.placed',
        order,
        {
          qty: order.qty,
          totalCents: order.qty * order.unitPriceCents,
          currency: order.currency,
          paymentMethod,
          expiresAt: order.expiresAt.toISOString(),
        },
        { occurredAt: order.updatedAt, traceId: submission.traceId },
      ),
    ]);
    await notifyOutbox(tx);
    return { kind: 'submitted', ...placed };
  });
}

export interface OrderRequest {
  readonly orderId: string;
  readonly userId: string;
  readonly traceId?: string;
}

export interface CancelRequest extends OrderRequest {
  /** Cancel only an order still in this status (`CancelQuery`); any live status when absent. */
  readonly from?: (typeof LIVE_ORDER_STATUSES)[number];
}

export type CancelOutcome =
  | ({ readonly kind: 'cancelled' } & OrderWithProduct)
  /** Already CANCELLED: a repeated cancel, answered 200 like the first. */
  | ({ readonly kind: 'replay' } & OrderWithProduct)
  /** 409: paid, failed or expired first, or no longer in the requested `from` status. */
  | { readonly kind: 'refused'; readonly code: 'CONFLICT' }
  | { readonly kind: 'not_found' };

/**
 * Cancel (§4.4): RESERVED or PENDING_PAYMENT to CANCELLED (`close_reason` USER), with quota −q, the
 * `order.cancelled` outbox row and inventory `reserved` −q last, in the global lock order: orders, quota,
 * inventory. No NOTIFY: cancels come in bursts too, and a notifying commit queues behind every other one
 * with the hot row locked (§5.4); the event waits for the relay's poll.
 *
 * One call of `fd_cancel_order` (migration 0009), outside any explicit transaction: it commits in the round
 * trip that runs it, so the drop's hot inventory row is never held while the api, saturated by a burst, gets
 * round to reading the answer and sending a COMMIT (the M2 bottleneck the reserve function removed, §5.2).
 * It locks the order first and reports as `fromStatus` the status of the very version its UPDATE replaces:
 * a payment or expiry that commits first leaves nothing to cancel, and the cancel loses. Cancelling a
 * PENDING_PAYMENT order may race a charge; the payment consumer's PAID CAS then loses, and the
 * `order.cancelled` event makes it close the PSP reference, which refunds the charge (§6.5).
 *
 * With `from`, the cancel also requires that status: a buyer's Leave in a stale checkout tab
 * (`from=RESERVED`) then loses to the submit another tab made, instead of cancelling an order being paid.
 *
 * When nothing was cancelled, the order is re-read and classified: a repeated cancel replays, anything else
 * that moved first is CONFLICT.
 */
export async function cancelOrder(db: Db, request: CancelRequest): Promise<CancelOutcome> {
  const { orderId, userId } = request;
  const cancellable = request.from === undefined ? LIVE_ORDER_STATUSES : [request.from];
  const { rows } = await db.execute(sql`
    SELECT (r.cancelled_order).*, r.from_status, ${ORDER_PRODUCT_COLUMNS}
    FROM fd_cancel_order(${orderId}::uuid, ${userId}::uuid, ${sql.param(cancellable)}::order_status[],
                         ${uuidv7()}::uuid, ${request.traceId ?? null}::text) r
    JOIN products p ON p.id = (r.cancelled_order).product_id`);
  const [cancelled] = parseOrderWithProductRows(rows, 'fd_cancel_order');
  if (cancelled !== undefined) return { kind: 'cancelled', ...cancelled };
  const found = await getOrderForUser(db, orderId, userId);
  if (found === undefined) return { kind: 'not_found' };
  const replay = cancelReplay(found.order.status);
  return replay.kind === 'order' ? { kind: 'replay', ...found } : replay;
}

export type ExtendOutcome =
  | ({ readonly kind: 'extended' } & OrderWithProduct)
  /** 409: no longer RESERVED, already past its deadline, or extended once already. */
  | { readonly kind: 'refused'; readonly code: 'CONFLICT' }
  | { readonly kind: 'not_found' };

/**
 * The one-time hold extension (WCAG 2.2.1, §5.1, §8.3): `expires_at` +60 s, once, while the order is
 * RESERVED and its hold has not run out by Postgres time. A single CAS with no event and no counter change.
 * The orphan scan's Redis `exp` entry still carries the old deadline; the scan finds the order live in
 * Postgres and moves the entry to the new one (§4.6), so Redis never needs to hear about it.
 */
export async function extendHold(db: Db, request: OrderRequest): Promise<ExtendOutcome> {
  const { orderId, userId } = request;
  return transaction(db, async (tx): Promise<ExtendOutcome> => {
    const { rows } = await tx.execute(sql`
      WITH extended AS (
        UPDATE orders SET expires_at = expires_at + make_interval(secs => ${HOLD_EXTENSION_SECONDS}),
                          extensions = extensions + 1, version = version + 1, updated_at = now()
        WHERE id = ${orderId}::uuid AND user_id = ${userId}::uuid
          AND status = 'RESERVED' AND extensions = 0 AND expires_at > now()
        RETURNING *)
      SELECT extended.*, ${ORDER_PRODUCT_COLUMNS} FROM extended JOIN products p ON p.id = extended.product_id`);
    const [extended] = parseOrderWithProductRows(rows, 'extendHold');
    if (extended !== undefined) return { kind: 'extended', ...extended };
    const found = await getOrderForUser(tx, orderId, userId);
    return found === undefined ? { kind: 'not_found' } : { kind: 'refused', code: 'CONFLICT' };
  });
}

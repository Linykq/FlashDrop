import {
  BugError,
  InvariantViolation,
  isTerminalUnpaidOrderStatus,
  ORDER_STATUSES,
  PSP_CLOSE_ORDER_STATUSES,
  TERMINAL_UNPAID_ORDER_STATUSES,
} from '@flashdrop/domain';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Executor, Tx } from './client';
import { releaseQuota, releaseStock, sellStock } from './counters';
import { getOrder, type OrderRecord, parseOrderRows } from './orders';
import { insertOutboxEvents, orderEvent } from './outbox';
import { PgTimestamp, PgUuid, parseRows } from './rows';
import { pspClosures } from './schema';
import { literalList } from './schema/columns';
import { testHook } from './test-hooks';
import { transaction } from './transaction';

/*
 * The payment consumer's transitions (design §4.4, §6.5). Each is a CAS on PENDING_PAYMENT plus its
 * `payments` row, counters and outbox row in one transaction, in the global lock order: the orders row (and
 * its own `payments` row, keyed by the order), then the quota row, then `drop_inventory` last. The orders row
 * lock linearizes payment against expiry and cancel: whichever CAS commits first decides the order, and a
 * charge that loses is refunded by closing its PSP reference.
 *
 * No NOTIFY: payment events are as frequent as orders in a burst, so they wait for the relay's 250 ms poll
 * (§5.4).
 */

const TERMINAL_UNPAID = literalList(TERMINAL_UNPAID_ORDER_STATUSES);
const CLOSE_OWED = literalList(PSP_CLOSE_ORDER_STATUSES);

export type PaymentCas =
  /** This call decided the order. */
  | { readonly kind: 'won'; readonly order: OrderRecord }
  /**
   * The order had left PENDING_PAYMENT (a duplicate delivery, an expiry or a cancel committed first): nothing
   * changed. `order` is the committed state the CAS lost to; if it ended unpaid after a successful charge,
   * the caller closes the PSP reference to refund it (§6.5).
   */
  | { readonly kind: 'lost'; readonly order: OrderRecord };

export interface PaidCharge {
  readonly orderId: string;
  /** The PSP's id of the succeeded charge. */
  readonly pspChargeId: string;
  readonly traceId?: string;
}

/**
 * PENDING_PAYMENT to PAID (§4.4): `paid_at`, a SUCCEEDED `payments` row for the order's total, the
 * `order.paid` outbox row, and inventory `reserved` −q / `sold` +q last. The quota is unchanged: bought
 * units still count toward the user's limit (INV-3).
 *
 * The CAS checks the status only, not `expires_at`: a charge that succeeded before the sweeper expired the
 * order wins, because the units were still reserved for it (no oversell), and the sweeper skips the locked
 * row. Once the sweeper has committed EXPIRED, this CAS loses and the charge is refunded.
 */
export async function markPaid(db: Db, charge: PaidCharge): Promise<PaymentCas> {
  return transaction(db, async (tx): Promise<PaymentCas> => {
    const { rows } = await tx.execute(sql`
      UPDATE orders SET status = 'PAID', paid_at = now(), version = version + 1, updated_at = now()
      WHERE id = ${charge.orderId}::uuid AND status = 'PENDING_PAYMENT'
      RETURNING *`);
    const [order] = parseOrderRows(rows, 'markPaid');
    if (order === undefined) return lost(tx, charge.orderId);
    await testHook(tx, 'paid.locked');

    const totalCents = order.qty * order.unitPriceCents;
    // A plain INSERT: no payments row can exist for an order that was still PENDING_PAYMENT, so a conflict
    // here is a bug and must fail the transaction, not be skipped.
    await tx.execute(sql`
      INSERT INTO payments (order_id, psp_charge_id, amount_cents, status)
      VALUES (${order.id}::uuid, ${charge.pspChargeId}::text, ${totalCents}::int, 'SUCCEEDED')`);
    await insertOutboxEvents(tx, [
      orderEvent(
        'order.paid',
        order,
        { qty: order.qty, totalCents, pspChargeId: charge.pspChargeId },
        { occurredAt: order.updatedAt, traceId: charge.traceId },
      ),
    ]);
    await sellStock(tx, order);
    return { kind: 'won', order };
  });
}

export interface FailedCharge {
  readonly orderId: string;
  /** The PSP's decline code; `reference_closed` when the PSP refused because the reference was closed. */
  readonly declineCode: string;
  /** The declined charge's id; absent for `reference_closed`, which the PSP refused without a charge. */
  readonly pspChargeId?: string;
  readonly traceId?: string;
}

/**
 * PENDING_PAYMENT to PAYMENT_FAILED (§4.4; `close_reason` DECLINED): a FAILED `payments` row with the decline
 * code, quota −q, the `order.payment_failed` outbox row, and inventory `reserved` −q last. A no-op (`lost`)
 * when the order already expired or was cancelled, which is always the case for `reference_closed`.
 */
export async function markPaymentFailed(db: Db, failure: FailedCharge): Promise<PaymentCas> {
  return transaction(db, async (tx): Promise<PaymentCas> => {
    const { rows } = await tx.execute(sql`
      UPDATE orders SET status = 'PAYMENT_FAILED', close_reason = 'DECLINED', closed_at = now(),
                        version = version + 1, updated_at = now()
      WHERE id = ${failure.orderId}::uuid AND status = 'PENDING_PAYMENT'
      RETURNING *`);
    const [order] = parseOrderRows(rows, 'markPaymentFailed');
    if (order === undefined) return lost(tx, failure.orderId);

    await tx.execute(sql`
      INSERT INTO payments (order_id, psp_charge_id, amount_cents, status, decline_code)
      VALUES (${order.id}::uuid, ${failure.pspChargeId ?? null}::text, ${order.qty * order.unitPriceCents}::int,
              'FAILED', ${failure.declineCode}::text)`);
    await releaseQuota(tx, order);
    await insertOutboxEvents(tx, [
      orderEvent(
        'order.payment_failed',
        order,
        { qty: order.qty, declineCode: failure.declineCode },
        { occurredAt: order.updatedAt, traceId: failure.traceId },
      ),
    ]);
    await releaseStock(tx, order);
    return { kind: 'won', order };
  });
}

/** The committed state a payment CAS lost to. Every event names an order that exists, so none is a bug. */
async function lost(tx: Tx, orderId: string): Promise<PaymentCas> {
  const order = await getOrder(tx, orderId);
  if (order === undefined) throw new BugError(`payment for unknown order ${orderId}`);
  return { kind: 'lost', order };
}

export interface Refund {
  readonly orderId: string;
  /** The refunded charge, from the PSP's close-by-reference answer. */
  readonly pspChargeId: string;
  readonly amountCents: number;
}

const ClosureRow = z.object({ status: z.enum(ORDER_STATUSES), refunded: z.boolean() });

/**
 * Records a close of the order's PSP reference (§6.5) in one statement: the `psp_closures` row, and the
 * refund the close made, if any, as the order's REFUNDED `payments` row. Both inserts are `ON CONFLICT DO
 * NOTHING`, so a repeated close (a redelivery, the consumer and the close-unpaid loop at once) records
 * nothing new. True when this call recorded the refund.
 *
 * Only an order that ended unpaid (PAYMENT_FAILED, EXPIRED, CANCELLED) can have its reference closed: its
 * status is final, so the check cannot go stale. A close of a PAID order, or of one still live, would refund
 * (or fence) a charge the order needs: an INV-4 breach, thrown as an `InvariantViolation` (dead-letter and
 * alert), never recorded.
 */
async function recordClose(
  db: Executor,
  orderId: string,
  refund: Omit<Refund, 'orderId'> | undefined,
): Promise<boolean> {
  const { rows } = await db.execute(sql`
    WITH o AS (SELECT id, status FROM orders WHERE id = ${orderId}::uuid AND status IN (${TERMINAL_UNPAID})),
    refund AS (
      INSERT INTO payments (order_id, psp_charge_id, amount_cents, status)
      SELECT o.id, ${refund?.pspChargeId ?? null}::text, ${refund?.amountCents ?? null}::int, 'REFUNDED' FROM o
      WHERE ${refund !== undefined}::boolean
      ON CONFLICT (order_id) DO NOTHING
      RETURNING order_id),
    closure AS (
      INSERT INTO psp_closures (order_id) SELECT o.id FROM o
      ON CONFLICT (order_id) DO NOTHING)
    SELECT status, EXISTS (SELECT 1 FROM refund) AS refunded FROM orders WHERE id = ${orderId}::uuid`);
  const [row] = parseRows(ClosureRow, rows, 'recordClose');
  if (row === undefined) throw new BugError(`PSP close of unknown order ${orderId}`);
  if (!isTerminalUnpaidOrderStatus(row.status)) {
    const what = refund === undefined ? 'closed the PSP reference' : `refund of charge ${refund.pspChargeId}`;
    throw new InvariantViolation('INV-4', `${what} for a ${row.status} order`);
  }
  return row.refunded;
}

/** A close that refunded `refund.pspChargeId` (`recordClose`). True when this call recorded the refund. */
export function recordRefund(db: Executor, refund: Refund): Promise<boolean> {
  return recordClose(db, refund.orderId, refund);
}

/** A close that found nothing captured (`recordClose`). */
export async function recordPspClosure(db: Executor, orderId: string): Promise<void> {
  await recordClose(db, orderId, undefined);
}

/**
 * Whether a close of the order's PSP reference is recorded (`recordClose`). A recorded closure is final: the
 * PSP refuses every later charge on the reference, and the refund the close made, if any, was recorded in the
 * same statement. So the payment consumer skips a redelivered close (§6.5): a repeat could change nothing and
 * would only cost the PSP a call.
 */
export async function hasPspClosure(db: Executor, orderId: string): Promise<boolean> {
  const rows = await db
    .select({ orderId: pspClosures.orderId })
    .from(pspClosures)
    .where(eq(pspClosures.orderId, orderId))
    .limit(1);
  return rows.length > 0;
}

export interface UnclosedOrder {
  readonly id: string;
  readonly status: (typeof PSP_CLOSE_ORDER_STATUSES)[number];
  readonly closedAt: Date;
}

const UnclosedRow = z
  .object({ id: PgUuid, status: z.enum(PSP_CLOSE_ORDER_STATUSES), closed_at: PgTimestamp })
  .transform((row): UnclosedOrder => ({ id: row.id, status: row.status, closedAt: row.closed_at }));

/** One page of `listUnclosedOrders`. */
export const UNCLOSED_PAGE = 200;

/**
 * The close-unpaid candidates (§6.5): orders that expired or were cancelled after checkout (a charge may have
 * raced their end) more than `olderThanSeconds` ago (60 s, so the payment consumer gets the first go), with
 * no closure recorded and not quarantined by the loop, oldest first.
 *
 * The scan walks `orders_close_owed` over the last `lookbackDays` (30, the DLQ's retention) and probes
 * `psp_closures` per order, so its cost grows with the closed orders of that window, not of all time.
 */
export async function listUnclosedOrders(
  db: Executor,
  options: {
    readonly olderThanSeconds?: number;
    readonly lookbackDays?: number;
    readonly limit?: number;
  } = {},
): Promise<UnclosedOrder[]> {
  const { rows } = await db.execute(sql`
    SELECT o.id, o.status, o.closed_at FROM orders o
    WHERE o.checkout_key IS NOT NULL AND o.status IN (${CLOSE_OWED})
      AND o.closed_at < now() - make_interval(secs => ${options.olderThanSeconds ?? 60})
      AND o.closed_at > now() - make_interval(days => ${options.lookbackDays ?? 30})
      AND NOT EXISTS (SELECT 1 FROM psp_closures c WHERE c.order_id = o.id)
      AND NOT EXISTS (SELECT 1 FROM sweeper_quarantine q WHERE q.loop = 'close-unpaid' AND q.order_id = o.id)
    ORDER BY o.closed_at LIMIT ${options.limit ?? UNCLOSED_PAGE}`);
  return parseRows(UnclosedRow, rows, 'listUnclosedOrders');
}

import type { Logger } from '@flashdrop/config';
import type { OrderEventOf, OrderStatusMessage } from '@flashdrop/contracts';
import {
  type Db,
  getOrder,
  hasPspClosure,
  markPaid,
  markPaymentFailed,
  type OrderRecord,
  recordPspClosure,
  recordRefund,
} from '@flashdrop/db';
import {
  BugError,
  InvariantViolation,
  isPaymentMethod,
  isTerminalUnpaidOrderStatus,
  pspChargeKey,
  pspCloseKey,
} from '@flashdrop/domain';
import { type FlashdropRedis, REDIS_DEADLINE_MS, userChannel, withDeadline } from '@flashdrop/inventory';
import type { HandlerContext, OrderEventHandlers } from '@flashdrop/messaging';
import type { PspClient } from './psp-client';

/*
 * The `payment` group (design §6.3, §6.5): charges a placed order, then decides it with a CAS to PAID or
 * PAYMENT_FAILED; closes the PSP reference of an order that ended unpaid, which refunds a charge that raced
 * its end and refuses any later one.
 *
 * Why no charge is ever doubled or kept for an unpaid order (INV-4):
 * - one charge per order, ever: every attempt uses `charge:<orderId>`, so a retry after an unknown outcome
 *   (timeout, 5xx) gets the recorded charge back instead of making a second one;
 * - the orders row lock linearizes payment against expiry and cancel. If the PAID CAS loses, the order
 *   ended unpaid first, and closing its reference refunds the charge;
 * - the PSP serializes a charge and a close of one reference, so a charge still in flight when the order
 *   ended is either refunded by the close or refused after it (`reference_closed`);
 * - a REFUNDED row is recorded only for an order that ended unpaid (`recordRefund` throws INV-4 otherwise);
 * - every close is recorded in `psp_closures`, and the `close-unpaid` loop closes, from Postgres, every
 *   order that expired or was cancelled after checkout without one: an event this group dead-lettered (or
 *   never got) cannot leave a charge captured on an unpaid order.
 *
 * Retries: the runner retries a transient failure (PSP unknown outcome, Postgres or Redis away) forever and
 * runs one order's events one after another (grouped by orderId, `p-limit(32)` across orders), so two
 * copies of one event never race inside a member. Copies in two members (a rebalance) still race safely on
 * the CAS and the PSP keys.
 */

export interface PaymentDeps {
  readonly db: Db;
  /** For the best-effort order status push on the owner's channel. */
  readonly redis: FlashdropRedis;
  readonly psp: PspClient;
}

export function paymentHandlers(deps: PaymentDeps): OrderEventHandlers {
  return {
    'order.placed': (event, context) => onOrderPlaced(deps, event, context),
    'order.expired': (event, context) => onOrderEndedUnpaid(deps, event, context),
    'order.cancelled': (event, context) => onOrderEndedUnpaid(deps, event, context),
  };
}

async function onOrderPlaced(
  deps: PaymentDeps,
  event: OrderEventOf<'order.placed'>,
  { logger }: HandlerContext,
): Promise<void> {
  const order = await getOrder(deps.db, event.orderId);
  if (order === undefined) throw new BugError(`order.placed for unknown order ${event.orderId}`);
  if (order.status === 'PAID') {
    logger.debug('already paid'); // a redelivery
    return;
  }
  if (order.status === 'PAYMENT_FAILED') {
    // A redelivery. Only this handler fails an order, and only on `declined` (the PSP recorded a declined
    // charge under the order's one key, which replays as declined forever) or `reference_closed` (refused,
    // with any earlier capture refunded by that close): nothing is captured, and nothing ever can be.
    logger.debug('already failed');
    return;
  }
  if (isTerminalUnpaidOrderStatus(order.status)) {
    // Redelivered after the order expired or was cancelled: refund a charge an earlier attempt may have
    // made, unless the reference's close is already recorded (`closeIfOpen`).
    await closeIfOpen(deps, order.id, logger);
    return;
  }
  if (order.status !== 'PENDING_PAYMENT') {
    // RESERVED or REJECTED: `order.placed` is written by the very CAS that leaves RESERVED, so the event
    // log and Postgres disagree. Dead-letter and alert rather than charge.
    throw new InvariantViolation('INV-5', `order.placed for a ${order.status} order`);
  }
  const paymentMethod = order.paymentMethod;
  if (!isPaymentMethod(paymentMethod)) {
    throw new BugError(`placed order ${order.id} has payment method ${String(paymentMethod)}`);
  }

  // Unknown outcomes (timeout, 5xx) throw a transient error here: the retry repeats this whole handler,
  // reads the order again, and charges again under the same key, which replays the recorded outcome.
  const charge = await deps.psp.charge(
    { reference: order.id, amountCents: order.qty * order.unitPriceCents, paymentMethod },
    pspChargeKey(order.id),
  );

  let decided: OrderRecord;
  if (charge.status === 'succeeded') {
    const cas = await markPaid(deps.db, {
      orderId: order.id,
      pspChargeId: charge.id,
      traceId: event.traceId,
    });
    decided = cas.order;
    if (cas.kind === 'won') {
      logger.info({ pspChargeId: charge.id }, 'order paid');
    } else if (isTerminalUnpaidOrderStatus(cas.order.status)) {
      // Lost to expiry or cancel while the charge was in flight: the money must go back.
      logger.warn(
        { pspChargeId: charge.id, status: cas.order.status },
        'charge raced the order ending; refunding',
      );
      await closeAndRecord(deps, order.id, logger);
    }
    // Lost to PAID: a copy in another member paid it with this same charge (one key per order).
  } else {
    // `declined` fails the order. `reference_closed` means it ended unpaid and its reference was closed
    // before this charge arrived (a replay from the DLQ, a copy in another member): the CAS loses and
    // changes nothing.
    const cas = await markPaymentFailed(deps.db, {
      orderId: order.id,
      declineCode: charge.declineCode,
      pspChargeId: charge.status === 'declined' ? charge.id : undefined,
      traceId: event.traceId,
    });
    decided = cas.order;
    if (cas.kind === 'won') logger.info({ declineCode: charge.declineCode }, 'payment failed');
  }
  await publishStatus(deps.redis, decided, logger);
}

async function onOrderEndedUnpaid(
  deps: PaymentDeps,
  event: OrderEventOf<'order.expired' | 'order.cancelled'>,
  { logger }: HandlerContext,
): Promise<void> {
  // An order that ended while RESERVED never reached checkout: there is no `order.placed` for it, and the
  // checkout CAS needs RESERVED, which it can never be again. So no charge exists or can ever be made, and
  // closing its reference would only cost the PSP a call per abandoned hold (most holds of a sale end so).
  // `close-unpaid` skips the same orders: they have no checkout key.
  if (event.data.fromStatus === 'RESERVED') return;
  await closeIfOpen(deps, event.orderId, logger);
}

/**
 * `closeAndRecord`, unless a close of the reference is already recorded (a redelivery, the close-unpaid loop
 * got there first): a recorded closure fences every later charge and recorded its refund in the same
 * statement, so closing again could change nothing. That matters because a transient failure seeks the
 * partition back and re-runs every finished message after it, and each repeat close would take a PSP call
 * (and a slot of the batch's 32) from the charges waiting behind it.
 *
 * A close recorded between the check and the call (another member, or the loop, at the same moment) is only
 * repeated, and a repeat is idempotent at the PSP (`close:<orderId>`) and in Postgres.
 */
async function closeIfOpen(deps: PaymentDeps, orderId: string, logger: Logger): Promise<void> {
  if (await hasPspClosure(deps.db, orderId)) {
    logger.debug('reference already closed');
    return;
  }
  await closeAndRecord(deps, orderId, logger);
}

/**
 * Closes the order's PSP reference (`close:<orderId>`, idempotent): the PSP refunds a captured charge and
 * refuses every later one. The close is recorded in `psp_closures`, and a refund as the order's REFUNDED
 * payments row, in one statement; a repeat records nothing new. Also run by the `close-unpaid` loop.
 */
export async function closeAndRecord(
  deps: Pick<PaymentDeps, 'db' | 'psp'>,
  orderId: string,
  logger: Logger,
): Promise<void> {
  const closed = await deps.psp.closeReference(orderId, pspCloseKey(orderId));
  if (closed.refundedChargeId === undefined || closed.amountCents === undefined) {
    await recordPspClosure(deps.db, orderId);
    logger.debug('reference closed; nothing was captured');
    return;
  }
  const recorded = await recordRefund(deps.db, {
    orderId,
    pspChargeId: closed.refundedChargeId,
    amountCents: closed.amountCents,
  });
  logger.info(
    { pspChargeId: closed.refundedChargeId, amountCents: closed.amountCents, recorded },
    'charge refunded',
  );
}

/**
 * Pushes the order's status to its owner's channel (§7, `OrderStatusMessage`). Best effort: the order page
 * also polls, so a failed push is logged, never retried, and never fails the event.
 */
async function publishStatus(redis: FlashdropRedis, order: OrderRecord, logger: Logger): Promise<void> {
  const message: OrderStatusMessage = {
    type: 'order',
    orderId: order.id,
    status: order.status,
    version: order.version,
  };
  try {
    await withDeadline('order status publish', REDIS_DEADLINE_MS, () =>
      redis.publish(userChannel(order.userId), JSON.stringify(message)),
    );
  } catch (err) {
    logger.warn({ err }, 'order status push failed; the order page polls');
  }
}

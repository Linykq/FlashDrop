import type { OrderEvent } from '@flashdrop/contracts';
import { alert, BugError, InvariantViolation, TransientError } from '@flashdrop/domain';
import { type SettleDeps, settleRedis } from '@flashdrop/inventory';
import type { HandlerContext, OrderEventHandlers } from '@flashdrop/messaging';

/*
 * The `inventory-settlement` group (design §6.3, §6.5): the fast path that gives Redis an order's terminal
 * outcome, `fd_confirm` for PAID and `fd_release` for every other terminal status, then records it in
 * `redis_settled_at`. The sweeper's settle-safety-net covers any order this path misses (a lost, slow or
 * dead-lettered event) 10 s later, through the same `settleRedis`.
 *
 * Idempotent by construction, so duplicates, redeliveries and a racing safety net are harmless:
 * - the event is only a trigger. `settleRedis` re-reads the order from Postgres and applies the committed
 *   outcome there, never the event's view, so Redis frees stock only after Postgres committed (§4.3);
 * - an order already settled is skipped, and the Lua state machine answers NOOP to a repeat that raced it;
 * - `fd_confirm` and `fd_release` are mutually exclusive per reservation, so stock moves at most once.
 */

export function settlementHandlers(deps: SettleDeps): OrderEventHandlers {
  const settle = async (event: OrderEvent, { logger }: HandlerContext): Promise<void> => {
    const outcome = await settleRedis(deps, event.orderId);
    switch (outcome.kind) {
      case 'SETTLED':
        logger.info({ via: outcome.via }, 'redis settled');
        return;
      case 'SKIPPED':
        // Every handled event is written in the transaction that made its order terminal, and the relay
        // publishes only committed rows: a live order here means the event log and Postgres disagree.
        if (outcome.reason === 'NOT_TERMINAL') {
          throw new BugError(`${event.type} for order ${event.orderId}, which is not terminal`);
        }
        logger.debug('already settled');
        return;
      case 'RETRY':
        // The drop is RECONCILING, or not in Redis yet (`settleRedis` nudged a rebuild): pause and retry.
        throw new TransientError(`drop ${event.dropId} cannot be settled yet (${outcome.reason})`);
      case 'CONFLICT':
        alert(
          logger,
          'redis_conflict',
          { status: outcome.status },
          'redis holds the opposite outcome (INV-8)',
        );
        throw new InvariantViolation(
          'INV-8',
          `redis holds the opposite outcome of a ${outcome.status} order`,
        );
      case 'UNKNOWN_ORDER':
        // Orders are never deleted: the event names an order this database never had.
        throw new BugError(`${event.type} for unknown order ${event.orderId}`);
    }
  };
  return {
    'order.paid': settle,
    'order.payment_failed': settle,
    'order.expired': settle,
    'order.cancelled': settle,
    'order.rejected': settle,
  };
}

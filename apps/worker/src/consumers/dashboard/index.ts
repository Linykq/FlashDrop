import type { DashboardTotalsMessage, OrderEvent } from '@flashdrop/contracts';
import { projectSalesEvents } from '@flashdrop/db';
import { dashboardChannel, REDIS_DEADLINE_MS, withDeadline } from '@flashdrop/inventory';
import type { OrderEventHandlers } from '@flashdrop/messaging';
import type { WorkerDeps } from '../../deps';
import { isTransientError } from '../../loop';
import { createSalesProjector } from './projector';

/*
 * The `sales-dashboard` group (design §6.3, §9): every event type, folded into the Postgres projection and
 * then published as the drop's totals on `fd:ch:dash:<dropId>`.
 */

export type DashboardDeps = Pick<WorkerDeps, 'db' | 'redis' | 'logger'>;

/** One projector per call: the runner, or `dlq:replay`, owns it for its lifetime. */
export function dashboardHandlers(deps: DashboardDeps): OrderEventHandlers {
  const { db, redis, logger } = deps;
  const projector = createSalesProjector({
    project: (events) => projectSalesEvents(db, events),
    async publish(dropId: string, message: DashboardTotalsMessage) {
      try {
        await withDeadline('dashboard publish', REDIS_DEADLINE_MS, () =>
          redis.publish(dashboardChannel(dropId), JSON.stringify(message)),
        );
      } catch (err) {
        // Totals, not deltas: the next publish of this drop carries everything this one would have.
        logger.warn({ err, dropId, version: message.version }, 'dashboard totals publish failed');
      }
    },
    isTransient: isTransientError,
    logger,
  });
  const apply = (event: OrderEvent) => projector.apply(event);
  return {
    'order.reserved': apply,
    'order.placed': apply,
    'order.paid': apply,
    'order.payment_failed': apply,
    'order.expired': apply,
    'order.cancelled': apply,
    'order.rejected': apply,
  } satisfies Required<OrderEventHandlers>;
}

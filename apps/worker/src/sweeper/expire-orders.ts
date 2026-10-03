import { EXPIRE_BATCH, expireDueOrders } from '@flashdrop/db';
import { alert } from '@flashdrop/domain';
import type { WorkerDeps } from '../deps';

/** A tick stops draining after this long; the loop runs every second. */
const TICK_BUDGET_MS = 800;

/**
 * `expire-orders` (design §4.6, every second): live orders past `expires_at`, by Postgres time, become
 * EXPIRED with their quota, inventory and `order.expired` event in one transaction per batch of 200
 * (`expireDueOrders`, which takes the loop lock itself). A full batch means more may be due, so the tick
 * runs the next one at once, within its budget: a burst of abandoned holds expires on time instead of at
 * 200 a second. Redis gets the stock back afterwards, from the settlement consumer or the safety net: Redis
 * frees stock only after Postgres committed the outcome (§4.3).
 *
 * If a batch failed on a bad row, its orders went one transaction each and every order that still failed
 * is quarantined: later ticks skip it, so one bad row never stops expiry platform-wide. The tick ends
 * there; the next one carries on.
 */
export async function expireOrders(
  deps: Pick<WorkerDeps, 'db' | 'logger'>,
  signal: AbortSignal = new AbortController().signal,
): Promise<void> {
  const started = Date.now();
  for (;;) {
    const tick = await expireDueOrders(deps.db);
    if (tick.kind === 'busy') return;
    if (tick.expired.length > 0) {
      deps.logger.info(
        { expired: tick.expired.length, orderIds: tick.expired.map((order) => order.id) },
        'orders expired',
      );
    }
    if (tick.kind === 'fallback') {
      deps.logger.error({ err: tick.batchError }, 'expiry batch failed; expired the due orders one by one');
      for (const { orderId, error } of tick.quarantined) {
        alert(
          deps.logger,
          'sweeper_quarantine',
          { loop: 'expire-orders', orderId, error },
          'order quarantined',
        );
      }
      return;
    }
    if (tick.expired.length < EXPIRE_BATCH || signal.aborted || Date.now() - started >= TICK_BUDGET_MS)
      return;
  }
}

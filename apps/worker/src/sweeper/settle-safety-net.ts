import { listUnsettledTerminalOrders, markRedisSettledMany, UNSETTLED_PAGE } from '@flashdrop/db';
import { applySettlement } from '@flashdrop/inventory';
import { settleWithLimit } from '../concurrency';
import type { WorkerDeps } from '../deps';
import { isTransientError } from '../loop';
import { withLoopLock } from '../postgres';
import { quarantine, recordConflict } from './settle';

export interface SafetyNetOptions {
  /** How long an order must sit unsettled first, so the settlement consumer gets the first go (10 s). */
  readonly olderThanSeconds?: number;
}

/** Function calls in flight at once; node-redis pipelines them on the one command connection. */
const CONCURRENCY = 16;
/** A tick stops paging after this long; the next one starts within a second of it ending (every 5 s). */
const TICK_BUDGET_MS = 4_000;

/**
 * `settle-safety-net` (design §4.6, every 5 s): terminal orders whose outcome Redis has not applied, and
 * that changed more than 10 s ago, are settled directly. It covers a lost, slow or dead-lettered
 * settlement event, and until the settlement consumer exists (M3) it is how stock comes back after expiry:
 * expire-orders (≤ 1 s) + 10 s + this loop (≤ 5 s), about 15 s in all.
 *
 * It drains rather than taking one page per tick, so a burst of abandoned holds comes back within that
 * bound too: pages of 200, each settled with up to 16 Function calls in flight and recorded in one
 * statement, until a page comes back short or the tick's budget is spent. The list is read from Postgres
 * and terminal statuses never change, so each call applies an outcome Postgres has committed (§4.3).
 *
 * Per order: an outcome Redis now reflects is recorded in `redis_settled_at`; RETRY (the drop is rebuilding,
 * or not in Redis yet) leaves the order for the next tick and the rest of that drop out of this one, so a
 * drop stuck RECONCILING cannot hold the head of the list for every other drop; CONFLICT (an INV-8 breach)
 * and any other failure quarantine the order with an alert. A transient failure ends the tick after what
 * succeeded has been recorded.
 */
export async function settleSafetyNet(
  deps: WorkerDeps,
  signal: AbortSignal,
  options: SafetyNetOptions = {},
): Promise<void> {
  await withLoopLock(deps.db, 'settle-safety-net', async () => {
    const started = Date.now();
    const retrying = new Set<string>();
    while (!signal.aborted && Date.now() - started < TICK_BUDGET_MS) {
      const page = await listUnsettledTerminalOrders(deps.db, {
        olderThanSeconds: options.olderThanSeconds,
        excludeDropIds: [...retrying],
      });
      if (page.length === 0) return;

      const outcomes = await settleWithLimit(page, CONCURRENCY, (order) => applySettlement(deps, order));
      const applied: string[] = [];
      let outage: unknown;
      for (const [i, outcome] of outcomes.entries()) {
        const order = page[i];
        if (order === undefined) continue;
        if (outcome.status === 'rejected') {
          if (isTransientError(outcome.reason)) outage ??= outcome.reason;
          else await quarantine(deps, 'settle-safety-net', order.id, outcome.reason);
          continue;
        }
        const result = outcome.value;
        if (result.kind === 'APPLIED') applied.push(order.id);
        else if (result.kind === 'RETRY') retrying.add(order.dropId);
        else {
          const log = deps.logger.child({ orderId: order.id, dropId: order.dropId });
          await recordConflict(deps, 'settle-safety-net', order.id, result.status, log);
        }
      }
      const marked = await markRedisSettledMany(deps.db, applied);
      if (marked.length > 0) deps.logger.info({ settled: marked.length }, 'redis settled');
      if (outage !== undefined) throw outage;
      if (page.length < UNSETTLED_PAGE) return;
    }
  });
}

import type { Logger } from '@flashdrop/config';
import { quarantineOrder, type SweeperLoop } from '@flashdrop/db';
import { alert, BugError, type OrderStatus } from '@flashdrop/domain';
import type { SettleOutcome } from '@flashdrop/inventory';
import type { WorkerDeps } from '../deps';
import { isTransientError } from '../loop';

/*
 * What the settle-safety-net and orphan-scan loops do with each order they settle (design §4.6): each order
 * is handled on its own, so one failure costs one order, never the tick. A transient failure (Postgres or
 * Redis away) ends the tick instead, for the next one to retry; it is never quarantined.
 */

/** Parks an order this loop cannot process: later ticks skip it, and every quarantine is an alert. */
export async function quarantine(
  deps: Pick<WorkerDeps, 'db' | 'logger'>,
  loop: SweeperLoop,
  orderId: string,
  reason: unknown,
): Promise<void> {
  const fresh = await quarantineOrder(deps.db, loop, orderId, reason);
  if (fresh) alert(deps.logger, 'sweeper_quarantine', { loop, orderId, err: reason }, 'order quarantined');
}

/** Logs a settle outcome; CONFLICT (an INV-8 breach) quarantines the order. */
export async function recordSettle(
  deps: Pick<WorkerDeps, 'db' | 'logger'>,
  loop: SweeperLoop,
  orderId: string,
  outcome: SettleOutcome,
  log: Pick<Logger, 'info' | 'error'>,
): Promise<void> {
  switch (outcome.kind) {
    case 'SETTLED':
      log.info({ via: outcome.via }, 'redis settled');
      return;
    // Raced with the settlement consumer, or the order was never terminal: nothing to do.
    case 'SKIPPED':
    // The drop is RECONCILING or not rebuilt yet (a rebuild was nudged): the next tick retries.
    case 'RETRY':
      return;
    case 'CONFLICT':
      await recordConflict(deps, loop, orderId, outcome.status, log);
      return;
    case 'UNKNOWN_ORDER':
      // Orders are never deleted, and both loops only settle orders they have just read.
      throw new BugError(`${loop}: order ${orderId} vanished`);
  }
}

/** Redis holds the opposite terminal state of the order (an INV-8 breach): alert and quarantine it. */
export async function recordConflict(
  deps: Pick<WorkerDeps, 'db' | 'logger'>,
  loop: SweeperLoop,
  orderId: string,
  status: OrderStatus,
  log: Pick<Logger, 'error'>,
): Promise<void> {
  alert(log, 'redis_conflict', { status }, 'redis holds the opposite outcome (INV-8)');
  await quarantine(deps, loop, orderId, `INV-8: redis CONFLICT for a ${status} order`);
}

/**
 * Runs `work` for one order. A transient failure is rethrown, which ends the tick; anything else
 * quarantines the order and the tick moves on.
 */
export async function oneOrder(
  deps: Pick<WorkerDeps, 'db' | 'logger'>,
  loop: SweeperLoop,
  orderId: string,
  work: () => Promise<void>,
): Promise<void> {
  try {
    await work();
  } catch (error) {
    if (isTransientError(error)) throw error;
    await quarantine(deps, loop, orderId, error);
  }
}

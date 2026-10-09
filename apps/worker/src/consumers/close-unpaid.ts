import type { Logger } from '@flashdrop/config';
import { listUnclosedOrders } from '@flashdrop/db';
import { settleWithLimit } from '../concurrency';
import { isTransientError, type LoopSpec } from '../loop';
import { withLoopLock } from '../postgres';
import { quarantine } from '../sweeper/settle';
import { closeAndRecord, type PaymentDeps } from './payment';

/*
 * `close-unpaid` (design §6.5): the money counterpart of settle-safety-net. The payment consumer closes the
 * PSP reference of every order that expires or is cancelled after checkout, from its `order.expired` and
 * `order.cancelled` events; that close is the only thing that refunds a charge that raced the order's end.
 * An event the group dead-lettered (a PSP refusing the close, a bug, a failure it could not classify)
 * would leave such a charge captured on an unpaid order for good (INV-4). So every 30 s this loop closes,
 * from Postgres, each such order that ended more than 60 s ago and has no recorded closure
 * (`listUnclosedOrders`), exactly as the consumer would (`closeAndRecord`, key `close:<orderId>`, so a close
 * the consumer also makes is a replay at the PSP and a no-op in Postgres).
 *
 * It runs in the payment role, which has the PSP client, under its own loop lock, so one of the replicas
 * does the work. A PSP or Postgres outage ends the tick for the next one to retry: once one close fails
 * transiently, no new close starts, so a tick against a PSP that hangs costs at most one round of
 * `CLOSE_UNPAID_CONCURRENCY` calls, each bounded by the client's timeout. Any other failure quarantines the
 * order with an alert (`sweeper_quarantine`): a human looks at a close that keeps failing.
 *
 * The tick also has a time budget. The loop lock lives in a transaction that Postgres ends after 60 s
 * (`WORKER_POOL_PROFILE.transaction_timeout`); a tick that outlived it would lose the lock mid-tick, let the
 * other replica start a second round of closes against the same PSP, and fail at COMMIT. So no close starts
 * after `CLOSE_UNPAID_BUDGET_MS` (30 s): a close in flight then ends within the PSP timeout (5 s) and one
 * recording statement (10 s), well inside the transaction's limit, and the orders left over go next tick.
 */

export interface CloseUnpaidDeps extends Pick<PaymentDeps, 'db' | 'psp'> {
  readonly logger: Logger;
}

export interface CloseUnpaidOptions {
  /** How long an order must have been ended first, so the payment consumer gets the first go (60 s). */
  readonly olderThanSeconds?: number;
  /** After this long, counted from the tick's start, no new close starts (`CLOSE_UNPAID_BUDGET_MS`). */
  readonly budgetMs?: number;
}

/** Closes in flight at once: the PSP serializes per reference, not across references. */
export const CLOSE_UNPAID_CONCURRENCY = 8;

/** Half the loop lock transaction's 60 s limit (see the header). */
export const CLOSE_UNPAID_BUDGET_MS = 30_000;

export const CLOSE_UNPAID_EVERY_MS = 30_000;

export async function closeUnpaid(
  deps: CloseUnpaidDeps,
  signal: AbortSignal,
  options: CloseUnpaidOptions = {},
): Promise<void> {
  // Shutdown, or the budget spent: either way, start no new close.
  const stop = AbortSignal.any([signal, AbortSignal.timeout(options.budgetMs ?? CLOSE_UNPAID_BUDGET_MS)]);
  await withLoopLock(deps.db, 'close-unpaid', async () => {
    const owed = await listUnclosedOrders(deps.db, { olderThanSeconds: options.olderThanSeconds });
    if (owed.length === 0 || stop.aborted) return;
    deps.logger.warn(
      { count: owed.length, orderIds: owed.map((order) => order.id) },
      'closing PSP references the payment consumer did not close',
    );
    // The first transient failure, which also stops the closes not yet started: the PSP (or Postgres) is
    // away, and calling it for every remaining order would only stretch the tick.
    let outage: unknown;
    const outcomes = await settleWithLimit(owed, CLOSE_UNPAID_CONCURRENCY, async (order) => {
      if (outage !== undefined || stop.aborted) return 'skipped';
      try {
        await closeAndRecord(deps, order.id, deps.logger.child({ orderId: order.id }));
        return 'closed';
      } catch (error) {
        if (isTransientError(error)) outage ??= error;
        throw error;
      }
    });
    let closed = 0;
    let skipped = 0;
    for (const [i, outcome] of outcomes.entries()) {
      const order = owed[i];
      if (order === undefined) continue;
      if (outcome.status === 'fulfilled') {
        if (outcome.value === 'closed') closed++;
        else skipped++;
      } else if (!isTransientError(outcome.reason)) {
        await quarantine(deps, 'close-unpaid', order.id, outcome.reason);
      }
    }
    if (closed > 0) deps.logger.info({ closed }, 'PSP references closed');
    if (outage !== undefined) throw outage;
    if (skipped > 0) deps.logger.info({ skipped }, 'tick stopped early; the rest close next tick');
  });
}

export function closeUnpaidLoop(deps: CloseUnpaidDeps): LoopSpec {
  return {
    name: 'close-unpaid',
    everyMs: CLOSE_UNPAID_EVERY_MS,
    tick: (signal) => closeUnpaid(deps, signal),
  };
}

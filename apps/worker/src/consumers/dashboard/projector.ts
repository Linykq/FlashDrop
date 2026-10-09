import type { Logger } from '@flashdrop/config';
import type { DashboardTotalsMessage, OrderEvent } from '@flashdrop/contracts';
import type { ProjectedSales } from '@flashdrop/db';

/*
 * Group commit for the sales-dashboard group (design §6.3: "whole batch in one transaction", §9).
 *
 * The consumer runner dispatches a batch one message at a time: it groups the messages by order, runs an
 * order's messages one after another and up to `concurrency` orders at once, and a message is finished (its
 * offset may be committed) when its handler resolves. So the handler cannot resolve before the event's
 * effect has committed, and the projector instead gathers every event applied while the batch starts its
 * orders and folds them in one transaction: each `apply` waits for a turn of the event loop, the runner has
 * by then started every order of the batch (it starts them through microtasks, with no I/O in between), and
 * all their first events commit together; then all the second ones, and so on. A batch therefore costs as
 * many transactions as its busiest order has events in it (usually up to three: reserved, placed, paid), not
 * one per event, and only one projection transaction runs at a time per process, on one connection.
 *
 * A group that fails transiently (Postgres away) fails as a whole: every event of it is retried by the
 * runner's pause, seek and backoff. Any other failure is re-run one event per transaction, so that only an
 * event that fails on its own fails, and the runner dead-letters that one rather than everything that
 * happened to share its transaction.
 *
 * After each commit the committed totals of every drop of the group are published, best effort and without
 * holding up the next group. A lost publish costs a dashboard one update: the next one carries the totals,
 * and a redelivered batch republishes them.
 */

export interface SalesProjector {
  /** Resolves once the event's effect, or the record that it had been applied before, has committed. */
  apply(event: OrderEvent): Promise<void>;
}

export interface SalesProjectorDeps {
  /** One projection transaction (`projectSalesEvents`). */
  readonly project: (events: readonly OrderEvent[]) => Promise<ProjectedSales>;
  /** Publishes a drop's totals on its dashboard channel; must not throw. */
  readonly publish: (dropId: string, message: DashboardTotalsMessage) => Promise<void>;
  readonly isTransient: (error: unknown) => boolean;
  readonly logger: Logger;
}

interface Waiting {
  readonly event: OrderEvent;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

/** Resolves after the microtasks queued so far have run: the rest of the wave has been applied by then. */
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

export function createSalesProjector(deps: SalesProjectorDeps): SalesProjector {
  const { project, publish, isTransient, logger } = deps;
  let queue: Waiting[] = [];
  let draining = false;

  async function commit(group: readonly Waiting[]): Promise<void> {
    let result: ProjectedSales;
    try {
      result = await project(group.map((waiting) => waiting.event));
    } catch (error) {
      if (group.length === 1 || isTransient(error)) {
        for (const waiting of group) waiting.reject(error);
        return;
      }
      logger.warn(
        { err: error, events: group.length },
        'dashboard projection of a group failed; projecting its events one by one',
      );
      for (const waiting of group) await commit([waiting]);
      return;
    }
    for (const waiting of group) waiting.resolve();
    logger.debug(
      {
        events: group.length,
        applied: result.applied,
        duplicates: result.duplicates,
        drops: result.totals.size,
      },
      'dashboard projection committed',
    );
    for (const [dropId, message] of result.totals) void publish(dropId, message);
  }

  async function drain(): Promise<void> {
    try {
      for (;;) {
        await nextTurn();
        if (queue.length === 0) return;
        const group = queue;
        queue = [];
        await commit(group);
      }
    } finally {
      draining = false;
    }
  }

  return {
    apply(event) {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      queue.push({ event, resolve, reject });
      if (!draining) {
        draining = true;
        void drain();
      }
      return promise;
    },
  };
}

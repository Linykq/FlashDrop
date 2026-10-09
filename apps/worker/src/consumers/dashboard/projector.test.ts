import { randomUUID } from 'node:crypto';
import { createLogger } from '@flashdrop/config';
import type { DashboardTotalsMessage, OrderEvent } from '@flashdrop/contracts';
import type { ProjectedSales } from '@flashdrop/db';
import { TransientError } from '@flashdrop/domain';
import { describe, expect, it } from 'vitest';
import { createSalesProjector } from './projector';

const DROP = '0192a3b4-0000-4000-8000-00000000d001';
const logger = createLogger({ name: 'projector-test', level: 'silent' });

function reserved(dropId = DROP): OrderEvent {
  return {
    eventId: randomUUID(),
    schemaVersion: 1,
    occurredAt: '2026-10-09T18:00:00.000Z',
    orderId: randomUUID(),
    orderVersion: 1,
    productId: randomUUID(),
    dropId,
    userId: randomUUID(),
    type: 'order.reserved',
    data: { qty: 1, unitPriceCents: 1_999, expiresAt: '2026-10-09T18:02:00.000Z' },
  };
}

const totals = (version: number): DashboardTotalsMessage => ({
  version,
  totals: {
    reserved: version,
    placed: 0,
    paid: 0,
    failed: 0,
    expired: 0,
    cancelled: 0,
    rejected: 0,
    unitsSold: 0,
    revenueCents: 0,
    lastEventAt: null,
  },
});

/** A projector over a recording fake transaction; `fail` decides per group whether it throws. */
function harness(fail: (events: readonly OrderEvent[]) => Error | undefined = () => undefined) {
  const groups: OrderEvent[][] = [];
  const published: [string, number][] = [];
  let version = 0;
  const projector = createSalesProjector({
    async project(events): Promise<ProjectedSales> {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const error = fail(events);
      if (error !== undefined) throw error;
      groups.push([...events]);
      version += 1;
      return { applied: events.length, duplicates: 0, totals: new Map([[DROP, totals(version)]]) };
    },
    async publish(dropId, message) {
      published.push([dropId, message.version]);
    },
    isTransient: (error) => error instanceof TransientError,
    logger,
  });
  return { projector, groups, published };
}

describe('sales projector group commit', () => {
  it('folds the events applied together in one transaction, then publishes the committed totals', async () => {
    const { projector, groups, published } = harness();
    const events = Array.from({ length: 50 }, () => reserved());

    await Promise.all(events.map((event) => projector.apply(event)));

    expect(groups).toEqual([events]);
    expect(published).toEqual([[DROP, 1]]);
  });

  it('runs one transaction at a time and folds what arrived meanwhile into the next', async () => {
    const sizes: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const started = Promise.withResolvers<void>();
    const commit = Promise.withResolvers<void>();
    const projector = createSalesProjector({
      async project(events) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        sizes.push(events.length);
        started.resolve();
        await commit.promise;
        inFlight -= 1;
        return { applied: events.length, duplicates: 0, totals: new Map() };
      },
      publish: async () => undefined,
      isTransient: () => false,
      logger,
    });
    const first = projector.apply(reserved());
    await started.promise;
    const later = Array.from({ length: 3 }, () => projector.apply(reserved()));
    commit.resolve();

    await Promise.all([first, ...later]);

    expect(sizes).toEqual([1, 3]);
    expect(maxInFlight).toBe(1);
  });

  it('settles an event only once its transaction committed', async () => {
    const { projector, groups } = harness();
    const event = reserved();
    let settled = false;
    const applied = projector.apply(event).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    await applied;

    expect(groups).toEqual([[event]]);
  });

  it('fails a whole group on a transient error, without splitting it', async () => {
    const { projector, groups } = harness(() => new TransientError('postgres away'));
    const outcomes = await Promise.allSettled([projector.apply(reserved()), projector.apply(reserved())]);

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected']);
    expect(groups).toEqual([]);
  });

  it('re-runs a group that failed otherwise one event at a time, so only the bad event fails', async () => {
    const bad = reserved();
    const { projector, groups } = harness((events) =>
      events.includes(bad) ? new Error('value out of range') : undefined,
    );
    const good = [reserved(), reserved()];

    const outcomes = await Promise.allSettled([...good, bad].map((event) => projector.apply(event)));

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled', 'rejected']);
    expect(groups).toEqual([[good[0]], [good[1]]]);
  });

  it('keeps projecting after a failed group', async () => {
    let failOnce = true;
    const { projector, groups } = harness(() => {
      if (!failOnce) return undefined;
      failOnce = false;
      return new TransientError('postgres away');
    });
    await expect(projector.apply(reserved())).rejects.toThrow('postgres away');

    const event = reserved();
    await projector.apply(event);

    expect(groups).toEqual([[event]]);
  });
});

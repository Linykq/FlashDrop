import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  compose,
  connectStores,
  createBuyers,
  createTestDrop,
  killService,
  logEnds,
  outboxInFlight,
  outboxOf,
  partitionOf,
  problemsIn,
  purchaseAll,
  readPartition,
  type Stores,
  startServices,
  until,
  verifyDrops,
} from './support';

/*
 * M3 demo and the nightly `relay-kill` chaos case (design §5.4, §13): SIGKILL the worker while a relay batch
 * is in flight, under a purchase load, and nothing is lost. The batch is caught in flight deterministically:
 * with the broker paused, the relay's send waits for acknowledgements (up to message.timeout.ms, 10 s) while
 * its transaction holds the batch's rows and the relay fence. The first such batch times out and rolls back
 * while the load keeps checking out, so the relay's next batch takes the whole backlog, and the worker is
 * killed with that batch in flight. Postgres ends the dead session, the rows become unpublished-and-free
 * again, and the restarted relay publishes them. Whatever the dead producer had already handed to the broker
 * may arrive twice ("crash after send, before mark"); consumers dedupe, so every order ends exactly as
 * without the crash.
 */

/** In-flight rows that make the killed batch the backlog, not the one or two rows of a poll. */
const BACKLOG_BATCH = 50;

let stores: Stores;

beforeAll(async () => {
  stores = await connectStores();
});

afterAll(async () => {
  // Never leave the stack broken for the next file, even after a failed assertion.
  await compose(['unpause', 'kafka']).catch(() => undefined);
  await startServices('worker');
  await stores?.close();
});

describe('relay killed mid-batch', () => {
  it('loses no event: every outbox row reaches orders.v1, every order is PAID once, INV-5 holds', async () => {
    const buyers = await createBuyers(800);
    const drop = await createTestDrop({ stock: buyers.length, perUserLimit: 1 });
    const partition = partitionOf(drop.productId);
    const from = (await logEnds(stores.admin)).get(partition) ?? '0';

    // About 20 checkouts a second, running until the worker is dead and back.
    const load = purchaseAll(buyers, drop.dropId, { concurrency: 4, paceMs: 150 });
    await until(
      'the load under way',
      async () => load.placed(),
      (placed) => placed >= 20,
      60_000,
    );

    await compose(['pause', 'kafka']);
    let caught: { pending: number; locked: number };
    try {
      // A batch locks its rows and waits for acknowledgements that cannot come; it fails after 10 s, and the
      // relay's next batch, after its backoff, takes the backlog the load piled up meanwhile.
      caught = await until(
        'a relay batch of the backlog in flight',
        () => outboxInFlight(stores.pool),
        (o) => o.locked >= BACKLOG_BATCH,
        45_000,
      );
      await killService('worker');
      // Postgres ends the dead relay's session: its transaction rolls back, freeing the rows and the fence.
      await until(
        'the dead batch released',
        () => outboxInFlight(stores.pool),
        (o) => o.locked === 0,
        30_000,
      );
    } finally {
      await compose(['unpause', 'kafka']);
    }

    // Checkout never needed the relay: the load runs on while the worker is dead.
    const placedWhileDead = load.placed();
    await startServices('worker');
    load.stop();
    const orders = await load.finished;
    expect(orders.length).toBeGreaterThan(placedWhileDead);

    // Quiescence first (outbox drained, payment and settlement at lag 0), then INV-1 to INV-9.
    const report = await verifyDrops(stores, [drop.dropId], 180_000);
    expect(problemsIn(report)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.drops[0]?.postgres.orders).toEqual({ PAID: orders.length });

    const outbox = await outboxOf(stores.pool, orders);
    expect(outbox.every((row) => row.published)).toBe(true);
    // reserved, placed and paid for each order.
    expect(outbox).toHaveLength(orders.length * 3);

    const records = (await readPartition(stores, partition, from)).filter((r) =>
      orders.includes(r.event.orderId),
    );
    const delivered = new Map<string, number>();
    for (const record of records) {
      delivered.set(record.event.eventId, (delivered.get(record.event.eventId) ?? 0) + 1);
    }
    // Nothing lost, nothing invented: exactly the outbox's events, each at least once.
    expect([...delivered.keys()].sort()).toEqual(outbox.map((row) => row.event_id).sort());
    // Each order's events in the order they happened (first deliveries).
    const seen = new Set<string>();
    const firstTypes = new Map<string, string[]>();
    for (const { event } of records) {
      if (seen.has(event.eventId)) continue;
      seen.add(event.eventId);
      firstTypes.set(event.orderId, [...(firstTypes.get(event.orderId) ?? []), event.type]);
    }
    for (const orderId of orders) {
      expect(firstTypes.get(orderId)).toEqual(['order.reserved', 'order.placed', 'order.paid']);
    }
    const duplicates = records.length - delivered.size;
    console.info(
      `relay-kill: SIGKILL with a batch of ${caught.locked} rows in flight (${caught.pending} unpublished); ` +
        `${orders.length} orders, ${outbox.length} outbox events, ${records.length} records on partition ` +
        `${partition} (${duplicates} redelivered); all PAID; invariants ${report.ok ? 'pass' : 'FAIL'} after ` +
        `${report.quiescence.waitedMs} ms`,
    );
  });
});

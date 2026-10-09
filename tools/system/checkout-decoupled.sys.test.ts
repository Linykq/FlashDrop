import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Buyer,
  checkout,
  connectStores,
  containerStarts,
  createBuyers,
  createTestDrop,
  orderOf,
  outboxOf,
  problemsIn,
  pspCharges,
  reserve,
  type Stores,
  startServices,
  stopServices,
  until,
  verifyDrops,
} from './support';

/*
 * `checkout-decoupled` (design §5.4 "Kafka down", §13): checkout submit is one CAS plus an outbox row in
 * Postgres, and the request ends there. With the broker and the PSP both stopped it still answers 202 at
 * once, and the outbox grows; once they are back, the relay publishes the backlog, the payment consumer
 * charges each order exactly once, and INV-5 holds (outbox drained, every group at lag 0). The consumers ride
 * out the broker restart in place: nothing restarts them.
 */

let stores: Stores;

beforeAll(async () => {
  stores = await connectStores();
});

afterAll(async () => {
  await startServices('kafka', 'payment-mock', 'consumers');
  await stores?.close();
});

describe('checkout decoupled from Kafka and the PSP', () => {
  it('answers 202 with both stopped, the outbox grows, and after a restart every order is PAID', async () => {
    const buyers = (await createBuyers(3)) as [Buyer, Buyer, Buyer];
    const drop = await createTestDrop({ stock: 5, perUserLimit: 1, paymentSeconds: 300 });
    const orders = await Promise.all(buyers.map((buyer) => reserve(buyer, drop.dropId)));
    // Every order.reserved is out first, so what piles up below is the checkouts' own events.
    await until(
      'the reservations published',
      () => outboxOf(stores.pool, orders),
      (rows) => rows.length === orders.length && rows.every((row) => row.published),
      30_000,
    );

    const consumers = await containerStarts('consumers');
    await stopServices('kafka', 'payment-mock');
    const submitted = Date.now();
    const statuses = await Promise.all(buyers.map((buyer, i) => checkout(buyer, orders[i] ?? '')));
    const submitMs = Date.now() - submitted;
    expect(statuses).toEqual([202, 202, 202]);
    for (const [i, buyer] of buyers.entries()) {
      expect((await orderOf(buyer, orders[i] ?? '')).status).toBe('PENDING_PAYMENT');
    }
    // The relay retries a broker that is gone; the order.placed rows wait in the outbox.
    const waiting = await until(
      'the order.placed rows held back',
      () => outboxOf(stores.pool, orders),
      (rows) => rows.filter((row) => row.event_type === 'order.placed' && !row.published).length === 3,
      10_000,
    );
    expect(waiting.filter((row) => !row.published).map((row) => row.event_type)).toEqual([
      'order.placed',
      'order.placed',
      'order.placed',
    ]);

    await startServices('kafka', 'payment-mock');
    const restarted = Date.now();
    for (const [i, buyer] of buyers.entries()) {
      await until(
        `order ${orders[i]} PAID`,
        () => orderOf(buyer, orders[i] ?? ''),
        (order) => order.status === 'PAID',
        120_000,
      );
    }
    const paidMs = Date.now() - restarted;
    // The same consumer processes, still running: a broker restart must not take them down.
    expect(await containerStarts('consumers')).toEqual(consumers);
    const report = await verifyDrops(stores, [drop.dropId]);
    expect(problemsIn(report)).toEqual([]);
    expect(report.ok).toBe(true);
    const charges = await pspCharges(stores.pool, orders);
    expect(charges.map((charge) => charge.reference).sort()).toEqual([...orders].sort());
    expect(charges.every((charge) => charge.status === 'succeeded')).toBe(true);
    console.info(
      `checkout-decoupled: 3 submits answered 202 in ${submitMs} ms with Kafka and payment-mock stopped; ` +
        `3 order.placed rows waited in the outbox; all PAID ${paidMs} ms after the restart, one charge each; ` +
        `invariants pass (outbox ${JSON.stringify(report.events?.outbox)})`,
    );
  });
});

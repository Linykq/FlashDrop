import { ORDERS_PARTITIONS } from '@flashdrop/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Buyer,
  cancel,
  checkout,
  connectStores,
  createBuyers,
  createTestDrop,
  logEnds,
  orderOf,
  outboxOf,
  partitionOf,
  readPartition,
  reserve,
  type Stores,
  until,
} from './support';

/*
 * M3 demo (design §6.1, §16): the whole order lifecycle reaches `orders.v1`, every record keyed by its
 * productId, on partition murmur2(productId) % 6, with the outbox's event id and type as headers, and each
 * order's events in the order they happened.
 */

let stores: Stores;

beforeAll(async () => {
  stores = await connectStores();
});

afterAll(async () => {
  await stores?.close();
});

describe('orders.v1 on the running stack', () => {
  it('carries order.* events keyed by productId, on murmur2(productId) % 6, in each order’s order', async () => {
    const drop = await createTestDrop({ stock: 5, paymentSeconds: 60 });
    const partition = partitionOf(drop.productId);
    const from = (await logEnds(stores.admin)).get(partition) ?? '0';
    const [paid, cancelled, declined] = (await createBuyers(3)) as [Buyer, Buyer, Buyer];

    const paidOrder = await reserve(paid, drop.dropId);
    expect(await checkout(paid, paidOrder)).toBe(202);
    const cancelledOrder = await reserve(cancelled, drop.dropId);
    expect(await cancel(cancelled, cancelledOrder)).toBe(200);
    const declinedOrder = await reserve(declined, drop.dropId);
    expect(await checkout(declined, declinedOrder, 'pm_decline')).toBe(202);

    await until(
      'the paid order',
      () => orderOf(paid, paidOrder),
      (o) => o.status === 'PAID',
      60_000,
    );
    await until(
      'the declined order',
      () => orderOf(declined, declinedOrder),
      (o) => o.status === 'PAYMENT_FAILED',
      60_000,
    );
    const orders = [paidOrder, cancelledOrder, declinedOrder];
    await until(
      'the outbox of the three orders',
      () => outboxOf(stores.pool, orders),
      (rows) => rows.length === 8 && rows.every((row) => row.published),
      30_000,
    );

    const records = (await readPartition(stores, partition, from)).filter((r) =>
      orders.includes(r.event.orderId),
    );
    const typesOf = (orderId: string) =>
      records.filter((r) => r.event.orderId === orderId).map((r) => r.event.type);
    expect(typesOf(paidOrder)).toEqual(['order.reserved', 'order.placed', 'order.paid']);
    expect(typesOf(cancelledOrder)).toEqual(['order.reserved', 'order.cancelled']);
    expect(typesOf(declinedOrder)).toEqual(['order.reserved', 'order.placed', 'order.payment_failed']);
    for (const record of records) {
      expect(record.key).toBe(drop.productId);
      expect(record.partition).toBe(partition);
      expect(record.headers['event-id']).toBe(record.event.eventId);
      expect(record.headers['event-type']).toBe(record.event.type);
    }
    // Exactly the outbox's events, none lost, none invented.
    const outboxIds = (await outboxOf(stores.pool, orders)).map((row) => row.event_id).sort();
    expect([...new Set(records.map((r) => r.event.eventId))].sort()).toEqual(outboxIds);
    expect(partition).toBeLessThan(ORDERS_PARTITIONS);
    console.info(
      `orders.v1 partition ${partition} (murmur2(${drop.productId}) % ${ORDERS_PARTITIONS}), from offset ${from}:\n` +
        records
          .map((r) => `  ${r.offset}  key=${r.key}  ${r.event.type}  order ${r.event.orderId}`)
          .join('\n'),
    );
  });
});

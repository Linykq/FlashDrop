import { CONSUMER_GROUPS } from '@flashdrop/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Buyer,
  cancel,
  checkout,
  connectStores,
  createBuyers,
  createTestDrop,
  groupLagOn,
  orderOf,
  partitionOf,
  paymentRows,
  problemsIn,
  pspCharges,
  reserve,
  type Stores,
  settledInRedis,
  startServices,
  stockOf,
  stopServices,
  until,
  verifyDrops,
} from './support';

/*
 * M3 demo (design §4.6, §6.4 "a DLQ'd event never leaks stock"): with every consumer stopped, stock still
 * comes back. Postgres decides every outcome without Kafka (cancel at once, the sweeper's expiry at the
 * deadline) and gives the units back in the same transactions; the sweeper's settle-safety-net then applies
 * each outcome to Redis once it is 10 s old, so a lost, slow or absent settlement consumer only delays the
 * return by seconds. Restarted, the consumers catch up from their committed offsets: the payment group closes
 * the reference of the order that expired unpaid, and INV-5 holds.
 */

let stores: Stores;

beforeAll(async () => {
  stores = await connectStores();
});

afterAll(async () => {
  await startServices('consumers');
  await stores?.close();
});

describe('consumers stopped', () => {
  it('stock still returns to Redis through the safety net, and the consumers catch up afterwards', async () => {
    const drop = await createTestDrop({ stock: 4, perUserLimit: 1, holdSeconds: 10, paymentSeconds: 10 });
    const partition = partitionOf(drop.productId);
    const [cancelling, paying, abandoning, idle] = (await createBuyers(4)) as [Buyer, Buyer, Buyer, Buyer];

    await stopServices('consumers');
    const started = Date.now();
    const orders = await Promise.all(
      [cancelling, paying, abandoning, idle].map((buyer) => reserve(buyer, drop.dropId)),
    );
    const [cancelled = '', placed = '', abandoned = '', untouched = ''] = orders;
    expect(await stockOf(drop.dropId)).toMatchObject({ avail: 0, held: 4 });
    expect(await cancel(cancelling, cancelled)).toBe(200);
    // Placed, and nobody will charge it: the payment group is down too.
    expect(await checkout(paying, placed)).toBe(202);

    const stock = await until(
      'all four units back in Redis',
      () => stockOf(drop.dropId),
      (s) => s.avail === 4 && s.held === 0 && s.sold === 0,
      60_000,
    );
    const returnedMs = Date.now() - started;
    expect((await orderOf(cancelling, cancelled)).status).toBe('CANCELLED');
    expect((await orderOf(paying, placed)).status).toBe('EXPIRED');
    expect((await orderOf(abandoning, abandoned)).status).toBe('EXPIRED');
    expect((await orderOf(idle, untouched)).status).toBe('EXPIRED');
    // The sweeper settled them: the settlement group has not consumed a single one of these events.
    expect(await settledInRedis(stores.pool, orders)).toBe(4);
    const lag = await groupLagOn(stores, CONSUMER_GROUPS.settlement, partition);
    expect(lag).toBeGreaterThanOrEqual(orders.length * 2);

    await startServices('consumers');
    const report = await verifyDrops(stores, [drop.dropId]);
    expect(problemsIn(report)).toEqual([]);
    expect(report.ok).toBe(true);
    // The payment group, back, closed the reference of the order that expired unpaid: no charge ever ran.
    expect(await pspCharges(stores.pool, [placed])).toEqual([]);
    expect(await paymentRows(stores.pool, orders)).toEqual([]);
    console.info(
      `safety net: consumers stopped; 4 holds (1 cancelled, 1 placed, 2 abandoned) back in Redis ` +
        `${returnedMs} ms after the reserves (${JSON.stringify(stock)}), settlement lag ${lag} on partition ` +
        `${partition}; invariants pass ${report.quiescence.waitedMs} ms after the restart`,
    );
  });
});

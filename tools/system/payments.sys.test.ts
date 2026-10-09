import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Buyer,
  checkout,
  connectStores,
  createBuyers,
  createTestDrop,
  killService,
  orderOf,
  paymentRows,
  problemsIn,
  pspCharges,
  recreatePaymentMock,
  reserve,
  type Stores,
  serviceLogs,
  until,
  verifyDrops,
  WITHHOLD_EVERY_ANSWER,
} from './support';

/*
 * M4 demos on the running stack (design §6.5): the payment consumer turns unknown PSP outcomes into exactly
 * one charge, and money taken for an order that ended unpaid is given back. Each case runs payment-mock with
 * its own failure settings; afterAll restores the stack's.
 */

const PRICE_CENTS = 2_500;

let stores: Stores;

beforeAll(async () => {
  stores = await connectStores();
});

afterAll(async () => {
  await recreatePaymentMock();
  await stores?.close();
});

describe('payments on the running stack', () => {
  it('timeout after success on every charge: each order is charged exactly once and PAID', async () => {
    await recreatePaymentMock(WITHHOLD_EVERY_ANSWER);
    const buyers = await createBuyers(6);
    const drop = await createTestDrop({ stock: buyers.length, perUserLimit: 1, priceCents: PRICE_CENTS });
    const orders = await Promise.all(buyers.map((buyer) => reserve(buyer, drop.dropId)));
    for (const [i, buyer] of buyers.entries()) expect(await checkout(buyer, orders[i] ?? '')).toBe(202);

    for (const [i, buyer] of buyers.entries()) {
      await until(
        `order ${orders[i]} PAID`,
        () => orderOf(buyer, orders[i] ?? ''),
        (order) => order.status === 'PAID',
        90_000,
      );
    }
    // Every first answer was withheld: the consumer timed out and retried each charge under the same key.
    // payment-mock logs each one at info, which WITHHOLD_EVERY_ANSWER sets whatever the stack's LOG_LEVEL.
    const withheld = (await serviceLogs('payment-mock'))
      .split('\n')
      .filter((line) => line.includes('answer withheld'));
    expect(withheld.length).toBeGreaterThanOrEqual(orders.length);
    const charges = await pspCharges(stores.pool, orders);
    expect(charges).toHaveLength(orders.length);
    expect(new Set(charges.map((charge) => charge.reference)).size).toBe(orders.length);
    expect(charges.every((c) => c.status === 'succeeded' && c.amount_cents === PRICE_CENTS)).toBe(true);
    expect((await paymentRows(stores.pool, orders)).map((row) => row.status)).toEqual(
      orders.map(() => 'SUCCEEDED'),
    );
    const report = await verifyDrops(stores, [drop.dropId]);
    expect(problemsIn(report)).toEqual([]);
    console.info(
      `timeout-after-success: ${orders.length} orders, ${withheld.length} withheld answers, ` +
        `${charges.length} charges (one per reference), all PAID; invariants pass`,
    );
  });

  it('a payment that lands after the order expired is refunded: a REFUNDED row and PSP net 0', async () => {
    await recreatePaymentMock(WITHHOLD_EVERY_ANSWER);
    const [buyer] = (await createBuyers(1)) as [Buyer];
    const drop = await createTestDrop({
      stock: 1,
      perUserLimit: 1,
      paymentSeconds: 10,
      priceCents: PRICE_CENTS,
    });
    const orderId = await reserve(buyer, drop.dropId);
    expect(await checkout(buyer, orderId)).toBe(202);

    // The PSP takes the money and withholds its answer. Killed before the consumer's retry could learn the
    // outcome, it leaves the consumer retrying an unknown outcome while the 10 s payment window runs out.
    await until(
      'the charge',
      () => pspCharges(stores.pool, [orderId]),
      (rows) => rows.length === 1,
      10_000,
    );
    await killService('payment-mock');
    await until(
      'the expiry',
      () => orderOf(buyer, orderId),
      (order) => order.status === 'EXPIRED',
      30_000,
    );

    await recreatePaymentMock();
    // The retry finds the order EXPIRED and closes its reference: the PSP refunds the late charge.
    const [refund] = await until(
      'the refund recorded',
      () => paymentRows(stores.pool, [orderId]),
      (rows) => rows[0]?.status === 'REFUNDED',
      90_000,
    );
    expect(refund).toMatchObject({ status: 'REFUNDED', amount_cents: PRICE_CENTS });
    expect(await pspCharges(stores.pool, [orderId])).toEqual([
      expect.objectContaining({ status: 'refunded', amount_cents: PRICE_CENTS }),
    ]);
    expect(await orderOf(buyer, orderId)).toMatchObject({ status: 'EXPIRED' });
    const report = await verifyDrops(stores, [drop.dropId]);
    expect(problemsIn(report)).toEqual([]);
    expect(report.drops[0]?.ledger).toMatchObject({ capturedCents: 0, refundedCents: PRICE_CENTS });
    console.info(
      `late payment: charged at the PSP, order EXPIRED before the consumer learned it, then refunded ` +
        `(payments REFUNDED ${PRICE_CENTS}, PSP captured 0); invariants pass`,
    );
  });
});

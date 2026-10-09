import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Buyer,
  checkout,
  connectStores,
  createBuyers,
  deadLetter,
  killService,
  logEnds,
  orderOf,
  outboxOf,
  partitionOf,
  paymentRows,
  postTestDrop,
  problemsIn,
  pspCharges,
  readPartition,
  recreatePaymentMock,
  replayDeadLetters,
  reserve,
  type Stores,
  startServices,
  until,
  verifyDrops,
  WITHHOLD_EVERY_ANSWER,
} from './support';

/*
 * M3 "direct-handler dlq:replay" against the stack (design §6.4): a dead-lettered payment event is replayed
 * the way an operator replays one, as a one-off of the consumers service, inside the Compose network where
 * payment-mock resolves, and its handler gives the money back.
 *
 * The letter carries the order.expired of an order whose charge the PSP took while both payment consumers
 * were dead, so nothing else can refund it before they return: the REFUNDED row and the PSP's refund,
 * checked while they are still down, can only come from the replay. The letter is written as the runner
 * writes one, from the record the relay published. It stays in the DLQ, which CI's system job counts on
 * (`verify:invariants --max-dead-letters 1`).
 */

const PRICE_CENTS = 3_100;

let stores: Stores;

beforeAll(async () => {
  stores = await connectStores();
});

afterAll(async () => {
  await recreatePaymentMock();
  await startServices('consumers');
  await stores?.close();
});

describe('dlq:replay on the running stack', () => {
  it('replays a dead-lettered payment event inside the network: the late charge is refunded', async () => {
    await recreatePaymentMock(WITHHOLD_EVERY_ANSWER);
    const [buyer] = (await createBuyers(1)) as [Buyer];
    const drop = await postTestDrop({
      stock: 1,
      perUserLimit: 1,
      paymentSeconds: 10,
      priceCents: PRICE_CENTS,
    });
    const partition = partitionOf(drop.productId);
    const from = (await logEnds(stores.admin)).get(partition) ?? '0';
    const orderId = await reserve(buyer, drop.dropId);
    expect(await checkout(buyer, orderId)).toBe(202);

    // The PSP takes the money and withholds its answer. SIGKILLed before their 5 s timeout and retry could
    // learn the outcome, the consumers leave the charge captured for an order nobody will pay.
    await until(
      'the charge',
      () => pspCharges(stores.pool, [orderId]),
      (rows) => rows.length === 1,
      10_000,
    );
    await killService('consumers');
    expect((await orderOf(buyer, orderId)).status).toBe('PENDING_PAYMENT');
    await until(
      'the expiry',
      () => orderOf(buyer, orderId),
      (order) => order.status === 'EXPIRED',
      30_000,
    );

    // Its order.expired, as the relay published it, dead-lettered for the payment consumer.
    await until(
      'order.expired published',
      () => outboxOf(stores.pool, [orderId]),
      (rows) => rows.some((row) => row.event_type === 'order.expired' && row.published),
      30_000,
    );
    const record = (await readPartition(stores, partition, from)).find(
      (r) => r.event.type === 'order.expired' && r.event.orderId === orderId,
    );
    if (record === undefined) throw new Error(`no order.expired of ${orderId} on partition ${partition}`);
    const offset = await deadLetter(stores, record, 'payment');
    expect(await paymentRows(stores.pool, [orderId])).toEqual([]);
    expect(await pspCharges(stores.pool, [orderId])).toEqual([
      expect.objectContaining({ status: 'succeeded', amount_cents: PRICE_CENTS }),
    ]);

    // From this letter on only: older letters of a long-lived stack are not this test's to replay.
    const log = await replayDeadLetters(['--only', 'payment', '--from-offset', offset]);
    expect(log.filter((line) => line.msg === 'letter replayed')).toEqual([
      expect.objectContaining({
        consumer: 'payment',
        offset,
        eventId: record.event.eventId,
        eventType: 'order.expired',
        orderId,
      }),
    ]);
    expect(log.find((line) => line.msg === 'dlq replay finished')).toMatchObject({
      replayed: 1,
      failed: null,
    });

    // The handler closed the reference: the PSP refunded the charge and the REFUNDED row records it, with
    // the consumers still down.
    expect(await paymentRows(stores.pool, [orderId])).toEqual([
      { order_id: orderId, status: 'REFUNDED', amount_cents: PRICE_CENTS },
    ]);
    expect(await pspCharges(stores.pool, [orderId])).toEqual([
      expect.objectContaining({ status: 'refunded', amount_cents: PRICE_CENTS }),
    ]);

    // Back, the consumers redeliver the order's events; every handler is idempotent, so nothing changes.
    await startServices('consumers');
    const report = await verifyDrops(stores, [drop.dropId]);
    expect(problemsIn(report)).toEqual([]);
    expect(report.drops[0]?.ledger).toMatchObject({ capturedCents: 0, refundedCents: PRICE_CENTS });
    console.info(
      `dlq:replay: order.expired of ${orderId} dead-lettered at offset ${offset} and replayed inside the ` +
        `network with the consumers down; payments REFUNDED ${PRICE_CENTS}, PSP captured 0; invariants pass`,
    );
  });
});

import { randomUUID } from 'node:crypto';
import { OrderEvent } from '@flashdrop/contracts';
import { InvariantViolation, REFERENCE_CLOSED_DECLINE_CODE } from '@flashdrop/domain';
import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cancelOrder } from './checkout';
import { createDb, type Db } from './client';
import { getOrder, getOrderDetailForUser, toOrderDetail } from './orders';
import {
  hasPspClosure,
  listUnclosedOrders,
  markPaid,
  markPaymentFailed,
  recordPspClosure,
  recordRefund,
} from './payments';
import { createPool, POOL_PROFILES } from './pool';
import { payments, pspClosures, sweeperQuarantine, userDropQuota } from './schema';
import { expireDueOrders, quarantineOrder } from './sweeper';
import { createTestDatabase, type TestDatabase } from './test-database';
import { checkCounters, createDrop, createUsers, eventsOf } from './test-fixtures';
import { holdOrder, lapse, placeOrder, SHIPPING } from './test-orders';

/*
 * The payment consumer's transitions (design §4.4, §6.5) against real Postgres 17: PAID and PAYMENT_FAILED
 * with their payments rows, counters and events, the CAS losing to expiry and cancel, and REFUNDED rows.
 */

let test: TestDatabase;
let pool: pg.Pool;
let db: Db;

beforeAll(async () => {
  test = await createTestDatabase();
  pool = createPool({
    connectionString: test.url,
    logger: { warn: () => undefined },
    ...POOL_PROFILES.api,
    max: 40,
  });
  db = createDb(pool);
});

afterAll(async () => {
  await pool?.end();
  await test?.drop();
});

async function placed(qty = 2) {
  const { dropId, productId } = await createDrop(db, { total: 10, perUserLimit: 3 });
  const [userId = ''] = await createUsers(db, 1);
  const { orderId } = await placeOrder(db, dropId, userId, { qty });
  return { dropId, productId, userId, orderId };
}

const paymentOf = async (orderId: string) =>
  (await db.select().from(payments).where(eq(payments.orderId, orderId)))[0];
const closureOf = async (orderId: string) =>
  (await db.select().from(pspClosures).where(eq(pspClosures.orderId, orderId)))[0];
const claimedBy = async (userId: string) =>
  (await db.select().from(userDropQuota).where(eq(userDropQuota.userId, userId)))[0]?.claimed;

describe('markPaid', () => {
  it('pays the order: SUCCEEDED payment, reserved to sold, order.paid, and the quota keeps the units', async () => {
    const { dropId, productId, userId, orderId } = await placed(2);
    const chargeId = `ch_${randomUUID()}`;

    const outcome = await markPaid(db, { orderId, pspChargeId: chargeId, traceId: 'trace-pay' });

    const order = await getOrder(db, orderId);
    expect(outcome).toEqual({ kind: 'won', order });
    expect(order).toMatchObject({ status: 'PAID', closedAt: null, closeReason: null, version: 3 });
    expect(order?.paidAt).toBeInstanceOf(Date);
    expect(await paymentOf(orderId)).toMatchObject({
      pspChargeId: chargeId,
      amountCents: 3998,
      status: 'SUCCEEDED',
      declineCode: null,
    });
    const events = await eventsOf(db, orderId);
    expect(events.map((e) => e.type)).toEqual(['order.reserved', 'order.placed', 'order.paid']);
    expect(OrderEvent.parse(events[2]?.payload)).toMatchObject({
      orderVersion: 3,
      productId,
      traceId: 'trace-pay',
      data: { qty: 2, totalCents: 3998, pspChargeId: chargeId },
    });
    expect(await claimedBy(userId)).toBe(2);
    expect(await checkCounters(db, dropId)).toMatchObject({
      reserved: 0,
      sold: 2,
      liveUnits: 0,
      paidUnits: 2,
      quotaMismatches: [],
    });
  });

  it('is a no-op on a duplicate delivery: lost to its own earlier win', async () => {
    const { dropId, orderId } = await placed();
    const chargeId = `ch_${randomUUID()}`;
    await markPaid(db, { orderId, pspChargeId: chargeId });

    const again = await markPaid(db, { orderId, pspChargeId: chargeId });

    expect(again.kind).toBe('lost');
    expect(again.order.status).toBe('PAID');
    expect((await eventsOf(db, orderId)).filter((e) => e.type === 'order.paid')).toHaveLength(1);
    expect(await checkCounters(db, dropId)).toMatchObject({ reserved: 0, sold: 2 });
  });

  it('loses to an expiry or a cancel that committed first, and reports what it lost to', async () => {
    const expired = await placed();
    await lapse(db, expired.orderId);
    await expireDueOrders(db);
    const cancelled = await placed();
    await cancelOrder(db, { orderId: cancelled.orderId, userId: cancelled.userId });

    for (const [{ dropId, orderId }, status] of [
      [expired, 'EXPIRED'],
      [cancelled, 'CANCELLED'],
    ] as const) {
      const outcome = await markPaid(db, { orderId, pspChargeId: `ch_${randomUUID()}` });
      expect(outcome.kind).toBe('lost');
      expect(outcome.order.status).toBe(status);
      expect(await paymentOf(orderId)).toBeUndefined();
      expect(await checkCounters(db, dropId)).toMatchObject({ reserved: 0, sold: 0, quotaMismatches: [] });
    }
  });

  it('never pays an order that was not checked out', async () => {
    const { dropId } = await createDrop(db, { total: 10 });
    const [userId = ''] = await createUsers(db, 1);
    const orderId = await holdOrder(db, dropId, userId);

    const outcome = await markPaid(db, { orderId, pspChargeId: `ch_${randomUUID()}` });

    expect(outcome.kind).toBe('lost');
    expect(outcome.order.status).toBe('RESERVED');
  });
});

describe('markPaymentFailed', () => {
  it('fails the order: FAILED payment with the decline code, quota and stock back, order.payment_failed', async () => {
    const { dropId, userId, orderId } = await placed(2);
    const chargeId = `ch_${randomUUID()}`;

    const outcome = await markPaymentFailed(db, {
      orderId,
      declineCode: 'card_declined',
      pspChargeId: chargeId,
      traceId: 'trace-fail',
    });

    const order = await getOrder(db, orderId);
    expect(outcome).toEqual({ kind: 'won', order });
    expect(order).toMatchObject({ status: 'PAYMENT_FAILED', closeReason: 'DECLINED', paidAt: null });
    expect(order?.closedAt).toBeInstanceOf(Date);
    expect(await paymentOf(orderId)).toMatchObject({
      pspChargeId: chargeId,
      amountCents: 3998,
      status: 'FAILED',
      declineCode: 'card_declined',
    });
    const events = await eventsOf(db, orderId);
    expect(events.at(-1)?.type).toBe('order.payment_failed');
    expect(OrderEvent.parse(events.at(-1)?.payload)).toMatchObject({
      orderVersion: 3,
      traceId: 'trace-fail',
      data: { qty: 2, declineCode: 'card_declined' },
    });
    expect(await claimedBy(userId)).toBe(0);
    expect(await checkCounters(db, dropId)).toMatchObject({ reserved: 0, sold: 0, quotaMismatches: [] });
  });

  it('records a reference_closed refusal without a charge id; a no-op once the order ended', async () => {
    const live = await placed();
    expect(
      (await markPaymentFailed(db, { orderId: live.orderId, declineCode: REFERENCE_CLOSED_DECLINE_CODE }))
        .kind,
    ).toBe('won');
    expect(await paymentOf(live.orderId)).toMatchObject({
      pspChargeId: null,
      declineCode: 'reference_closed',
    });

    const ended = await placed();
    await lapse(db, ended.orderId);
    await expireDueOrders(db);
    const outcome = await markPaymentFailed(db, { orderId: ended.orderId, declineCode: 'reference_closed' });
    expect(outcome.kind).toBe('lost');
    expect(outcome.order.status).toBe('EXPIRED');
    expect(await paymentOf(ended.orderId)).toBeUndefined();
    expect(await checkCounters(db, ended.dropId)).toMatchObject({ reserved: 0, quotaMismatches: [] });
  });
});

describe('recordRefund', () => {
  it('records a REFUNDED payment for an order that ended unpaid, once', async () => {
    const { orderId, userId } = await placed();
    await cancelOrder(db, { orderId, userId });
    const refund = { orderId, pspChargeId: `ch_${randomUUID()}`, amountCents: 3998 };

    expect(await recordRefund(db, refund)).toBe(true);
    expect(await recordRefund(db, refund)).toBe(false);
    expect(await paymentOf(orderId)).toMatchObject({
      pspChargeId: refund.pspChargeId,
      amountCents: 3998,
      status: 'REFUNDED',
    });
    // The close itself is recorded with the refund, in the same statement.
    expect(await closureOf(orderId)).toBeDefined();
  });

  it('records a close that refunded nothing, once, and refuses one for a paid order', async () => {
    const { orderId, userId } = await placed();
    await cancelOrder(db, { orderId, userId });

    expect(await hasPspClosure(db, orderId)).toBe(false);
    await recordPspClosure(db, orderId);
    await recordPspClosure(db, orderId);
    expect(await closureOf(orderId)).toBeDefined();
    expect(await hasPspClosure(db, orderId)).toBe(true);
    expect(await paymentOf(orderId)).toBeUndefined();

    const paid = await placed();
    await markPaid(db, { orderId: paid.orderId, pspChargeId: `ch_${randomUUID()}` });
    await expect(recordPspClosure(db, paid.orderId)).rejects.toBeInstanceOf(InvariantViolation);
    expect(await closureOf(paid.orderId)).toBeUndefined();
  });

  it('keeps the FAILED row of a declined order: one payments row per order', async () => {
    const { orderId } = await placed();
    await markPaymentFailed(db, { orderId, declineCode: 'card_declined', pspChargeId: `ch_${randomUUID()}` });

    expect(await recordRefund(db, { orderId, pspChargeId: `ch_${randomUUID()}`, amountCents: 3998 })).toBe(
      false,
    );
    expect((await paymentOf(orderId))?.status).toBe('FAILED');
  });

  it('refuses to record a refund for a paid or a live order: an INV-4 breach', async () => {
    const paid = await placed();
    await markPaid(db, { orderId: paid.orderId, pspChargeId: `ch_${randomUUID()}` });
    const live = await placed();

    for (const { orderId } of [paid, live]) {
      await expect(
        recordRefund(db, { orderId, pspChargeId: `ch_${randomUUID()}`, amountCents: 3998 }),
      ).rejects.toBeInstanceOf(InvariantViolation);
    }
    expect((await paymentOf(paid.orderId))?.status).toBe('SUCCEEDED');
    expect(await paymentOf(live.orderId)).toBeUndefined();
  });
});

describe('listUnclosedOrders', () => {
  it('lists the orders that ended unpaid after checkout and were never closed, oldest first', async () => {
    const expired = await placed();
    await lapse(db, expired.orderId);
    await expireDueOrders(db);
    const cancelled = await placed();
    await cancelOrder(db, { orderId: cancelled.orderId, userId: cancelled.userId });
    // Never owed a close: still paying, paid, declined (one charge key, declined), or ended before checkout.
    const live = await placed();
    const paid = await placed();
    await markPaid(db, { orderId: paid.orderId, pspChargeId: `ch_${randomUUID()}` });
    const declined = await placed();
    await markPaymentFailed(db, { orderId: declined.orderId, declineCode: 'card_declined' });
    const { dropId } = await createDrop(db, { total: 10 });
    const [holder = ''] = await createUsers(db, 1);
    const abandoned = await holdOrder(db, dropId, holder);
    await cancelOrder(db, { orderId: abandoned, userId: holder });
    const closed = await placed();
    await cancelOrder(db, { orderId: closed.orderId, userId: closed.userId });
    await recordPspClosure(db, closed.orderId);
    const parked = await placed();
    await cancelOrder(db, { orderId: parked.orderId, userId: parked.userId });
    await quarantineOrder(db, 'close-unpaid', parked.orderId, new Error('PSP refused the close'));

    const owed = await listUnclosedOrders(db, { olderThanSeconds: 0 });
    const mine = owed.filter(
      (o) =>
        [expired, cancelled, live, paid, declined, closed, parked].some((x) => x.orderId === o.id) ||
        o.id === abandoned,
    );
    expect(mine.map((o) => [o.id, o.status])).toEqual([
      [expired.orderId, 'EXPIRED'],
      [cancelled.orderId, 'CANCELLED'],
    ]);
    // The consumer gets the first minute.
    const recent = await listUnclosedOrders(db);
    expect(recent.map((o) => o.id)).not.toContain(cancelled.orderId);
    expect(
      await db.select().from(sweeperQuarantine).where(eq(sweeperQuarantine.orderId, parked.orderId)),
    ).toHaveLength(1);
  });
});

describe('getOrderDetailForUser', () => {
  it('shows the owner the checkout details and the decline code; nobody else sees the order', async () => {
    const { userId, orderId } = await placed();
    await markPaymentFailed(db, { orderId, declineCode: 'reference_closed' });
    const [stranger = ''] = await createUsers(db, 1);

    const detail = await getOrderDetailForUser(db, orderId, userId);
    if (detail === undefined) throw new Error('the owner must see the order');
    expect(toOrderDetail(detail, new Date())).toMatchObject({
      id: orderId,
      status: 'PAYMENT_FAILED',
      shipping: SHIPPING,
      paymentMethod: 'pm_ok',
      declineCode: 'reference_closed',
    });
    expect(await getOrderDetailForUser(db, orderId, stranger)).toBeUndefined();
  });

  it('has no checkout details before checkout', async () => {
    const { dropId } = await createDrop(db, { total: 10 });
    const [userId = ''] = await createUsers(db, 1);
    const orderId = await holdOrder(db, dropId, userId);

    const detail = await getOrderDetailForUser(db, orderId, userId);
    if (detail === undefined) throw new Error('the owner must see the order');
    expect(toOrderDetail(detail, new Date())).toMatchObject({
      status: 'RESERVED',
      shipping: null,
      paymentMethod: null,
      declineCode: null,
    });
  });
});

import { randomUUID } from 'node:crypto';
import { OrderEvent } from '@flashdrop/contracts';
import { checkoutFingerprint } from '@flashdrop/domain/identity';
import { and, eq, sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CheckoutSubmission, cancelOrder, extendHold, submitCheckout } from './checkout';
import { createDb, type Db } from './client';
import { getOrder } from './orders';
import { orderEvent, outboxRow } from './outbox';
import { markPaid } from './payments';
import { createPool, POOL_PROFILES } from './pool';
import { outbox, userDropQuota } from './schema';
import { expireDueOrders } from './sweeper';
import { createTestDatabase, type TestDatabase } from './test-database';
import { checkCounters, createDrop, createUsers, eventsOf } from './test-fixtures';
import { holdOrder, lapse, listenOutbox, placeOrder, SHIPPING } from './test-orders';

/*
 * The buyer's transitions after reserve (design §4.4, §5.1, §5.2) against real Postgres 17: checkout
 * submit with its replay classification, cancel and the hold extension. Every test runs on its own drop
 * and checks INV-2 and INV-3 (`checkCounters`) after the transition.
 */

let test: TestDatabase;
/** An api-shaped pool (statement_timeout 2 s, transaction_timeout 5 s), wide enough for real contention. */
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

const count = (values: readonly string[], value: string) => values.filter((v) => v === value).length;

async function liveHold(qty = 1) {
  const { dropId, productId } = await createDrop(db, { total: 10, perUserLimit: 3 });
  const [userId = ''] = await createUsers(db, 1);
  const orderId = await holdOrder(db, dropId, userId, qty);
  return { dropId, productId, userId, orderId };
}

function submission(orderId: string, userId: string, overrides: Partial<CheckoutSubmission> = {}) {
  return {
    orderId,
    userId,
    checkoutKey: 'checkout-key-1',
    shipping: SHIPPING,
    paymentMethod: 'pm_ok',
    ...overrides,
  } satisfies CheckoutSubmission;
}

describe('submitCheckout', () => {
  it('moves a live hold to PENDING_PAYMENT with the payment deadline, an order.placed event and a relay wake-up', async () => {
    const { dropId, productId, userId, orderId } = await liveHold(2);
    const listener = await listenOutbox(db, test.url);

    const outcome = await submitCheckout(db, submission(orderId, userId, { traceId: 'trace-submit' }));

    expect(outcome.kind).toBe('submitted');
    if (outcome.kind !== 'submitted') throw new Error('unreachable');
    const order = await getOrder(db, orderId);
    expect(outcome.order).toEqual(order);
    expect(outcome.product).toEqual({
      id: productId,
      slug: `p-${productId}`,
      title: 'Integration test product',
      imageKeys: [],
    });
    expect(order).toMatchObject({
      status: 'PENDING_PAYMENT',
      checkoutKey: 'checkout-key-1',
      checkoutHash: checkoutFingerprint({ orderId, shipping: SHIPPING, paymentMethod: 'pm_ok' }),
      shipping: SHIPPING,
      paymentMethod: 'pm_ok',
      version: 2,
      closedAt: null,
    });
    if (order === undefined) throw new Error('unreachable');
    // expires_at = now() + the drop's payment_seconds (300 by default), by Postgres time.
    expect(order.expiresAt.getTime() - order.updatedAt.getTime()).toBe(300_000);

    const events = await eventsOf(db, orderId);
    expect(events.map((e) => e.type)).toEqual(['order.reserved', 'order.placed']);
    expect(OrderEvent.parse(events[1]?.payload)).toMatchObject({
      type: 'order.placed',
      orderVersion: 2,
      productId,
      dropId,
      userId,
      traceId: 'trace-submit',
      occurredAt: order.updatedAt.toISOString(),
      data: {
        qty: 2,
        totalCents: 3998,
        currency: 'USD',
        paymentMethod: 'pm_ok',
        expiresAt: order.expiresAt.toISOString(),
      },
    });
    // Submit changes no counter: the units stay reserved and claimed until the order is paid or ends.
    expect(await checkCounters(db, dropId)).toMatchObject({ reserved: 2, liveUnits: 2, quotaMismatches: [] });
    await listener.drain();
    expect(listener.count()).toBe(1);
    await listener.close();
  });

  it('replays the same key and body, as the order is now, without writing anything', async () => {
    const { dropId, userId, orderId } = await liveHold();
    await submitCheckout(db, submission(orderId, userId));

    const replay = await submitCheckout(db, submission(orderId, userId));

    expect(replay.kind).toBe('replay');
    expect(replay.kind === 'replay' && replay.order.version).toBe(2);
    expect((await eventsOf(db, orderId)).map((e) => e.type)).toEqual(['order.reserved', 'order.placed']);

    await markPaid(db, { orderId, pspChargeId: `ch_${randomUUID()}` });
    const afterPayment = await submitCheckout(db, submission(orderId, userId));
    expect(afterPayment.kind === 'replay' && afterPayment.order.status).toBe('PAID');
    expect(await checkCounters(db, dropId)).toMatchObject({ reserved: 0, sold: 1, quotaMismatches: [] });
  });

  it('classifies a refused submit: 422 for another body, 409 for another key', async () => {
    const { userId, orderId } = await liveHold();
    await submitCheckout(db, submission(orderId, userId));

    expect(await submitCheckout(db, submission(orderId, userId, { paymentMethod: 'pm_decline' }))).toEqual({
      kind: 'refused',
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(
      await submitCheckout(db, submission(orderId, userId, { shipping: { ...SHIPPING, line2: 'Suite 4' } })),
    ).toEqual({ kind: 'refused', code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await submitCheckout(db, submission(orderId, userId, { checkoutKey: 'another-tab-key' }))).toEqual(
      {
        kind: 'refused',
        code: 'ALREADY_SUBMITTED',
      },
    );
    expect(await getOrder(db, orderId)).toMatchObject({
      checkoutKey: 'checkout-key-1',
      paymentMethod: 'pm_ok',
    });
  });

  it('answers 410 for a hold past its deadline, whether or not the sweeper expired it yet', async () => {
    const { dropId, userId, orderId } = await liveHold();
    await lapse(db, orderId);

    expect(await submitCheckout(db, submission(orderId, userId))).toEqual({
      kind: 'refused',
      code: 'RESERVATION_EXPIRED',
    });
    // Postgres time decides: nothing was written, and the order is left for the sweeper.
    expect(await getOrder(db, orderId)).toMatchObject({ status: 'RESERVED', checkoutKey: null, version: 1 });

    await expireDueOrders(db);
    expect(await getOrder(db, orderId)).toMatchObject({ status: 'EXPIRED' });
    expect(await submitCheckout(db, submission(orderId, userId))).toEqual({
      kind: 'refused',
      code: 'RESERVATION_EXPIRED',
    });
    expect(await checkCounters(db, dropId)).toMatchObject({ reserved: 0, liveUnits: 0, quotaMismatches: [] });
  });

  it('answers 409 CONFLICT for an order cancelled before checkout', async () => {
    const { userId, orderId } = await liveHold();
    await cancelOrder(db, { orderId, userId });

    expect(await submitCheckout(db, submission(orderId, userId))).toEqual({
      kind: 'refused',
      code: 'CONFLICT',
    });
  });

  it("answers not found for an unknown order and for another user's, which it leaves alone", async () => {
    const { orderId } = await liveHold();
    const [stranger = ''] = await createUsers(db, 1);

    expect(await submitCheckout(db, submission(randomUUID(), stranger))).toEqual({ kind: 'not_found' });
    expect(await submitCheckout(db, submission(orderId, stranger))).toEqual({ kind: 'not_found' });
    expect(await getOrder(db, orderId)).toMatchObject({ status: 'RESERVED', checkoutKey: null });
  });

  it('serializes concurrent submits on the row: one wins, same-key copies replay it, other keys get 409', async () => {
    const same = await liveHold();
    const sameKey = await Promise.all(
      Array.from({ length: 20 }, () => submitCheckout(db, submission(same.orderId, same.userId))),
    );
    const sameKinds = sameKey.map((o) => o.kind);
    expect(count(sameKinds, 'submitted')).toBe(1);
    expect(count(sameKinds, 'replay')).toBe(19);

    const tabs = await liveHold();
    const otherKeys = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        submitCheckout(db, submission(tabs.orderId, tabs.userId, { checkoutKey: `tab-key-${i}` })),
      ),
    );
    const otherKinds = otherKeys.map((o) => (o.kind === 'refused' ? o.code : o.kind));
    expect(count(otherKinds, 'submitted')).toBe(1);
    expect(count(otherKinds, 'ALREADY_SUBMITTED')).toBe(19);

    for (const orderId of [same.orderId, tabs.orderId]) {
      expect((await eventsOf(db, orderId)).map((e) => e.type)).toEqual(['order.reserved', 'order.placed']);
    }
  });
});

describe('cancelOrder', () => {
  it.each(['RESERVED', 'PENDING_PAYMENT'] as const)(
    'cancels a %s order: quota and stock back, order.cancelled, no relay wake-up',
    async (fromStatus) => {
      const { dropId, userId, orderId } = await liveHold(2);
      if (fromStatus === 'PENDING_PAYMENT') await submitCheckout(db, submission(orderId, userId));
      const listener = await listenOutbox(db, test.url);

      const outcome = await cancelOrder(db, { orderId, userId, traceId: 'trace-cancel' });

      expect(outcome.kind).toBe('cancelled');
      const order = await getOrder(db, orderId);
      expect(outcome.kind === 'cancelled' && outcome.order).toEqual(order);
      expect(order).toMatchObject({ status: 'CANCELLED', closeReason: 'USER', paidAt: null });
      expect(order?.closedAt).toBeInstanceOf(Date);
      const events = await eventsOf(db, orderId);
      expect(events.at(-1)?.type).toBe('order.cancelled');
      expect(OrderEvent.parse(events.at(-1)?.payload)).toMatchObject({
        orderVersion: order?.version,
        traceId: 'trace-cancel',
        data: { qty: 2, fromStatus },
      });
      const [quota] = await db.select().from(userDropQuota).where(eq(userDropQuota.userId, userId));
      expect(quota?.claimed).toBe(0);
      expect(await checkCounters(db, dropId)).toMatchObject({
        reserved: 0,
        liveUnits: 0,
        quotaMismatches: [],
      });
      // No NOTIFY: its commit would queue behind every notifying commit with the hot row locked (§5.4).
      await listener.drain();
      expect(listener.count()).toBe(0);
      await listener.close();
    },
  );

  it('writes the order.cancelled envelope of packages/contracts, as the TypeScript producer would', async () => {
    for (const traceId of ['trace-pin', undefined]) {
      const { productId, userId, orderId } = await liveHold(2);
      await submitCheckout(db, submission(orderId, userId));

      const outcome = await cancelOrder(db, { orderId, userId, traceId });

      if (outcome.kind !== 'cancelled') throw new Error(`expected cancelled, got ${outcome.kind}`);
      const { order } = outcome;
      const [row] = await db
        .select()
        .from(outbox)
        .where(and(sql`${outbox.payload}->>'orderId' = ${orderId}`, eq(outbox.eventType, 'order.cancelled')));
      if (row === undefined) throw new Error('no order.cancelled row');
      // fd_cancel_order builds the envelope in SQL (§6.2's exception); outboxRow validates with OrderEvent.
      const expected = outboxRow(
        orderEvent(
          'order.cancelled',
          order,
          { qty: 2, fromStatus: 'PENDING_PAYMENT' },
          { occurredAt: order.updatedAt, traceId },
        ),
      );
      expect(row.payload).toEqual({ ...(expected.payload as object), eventId: row.eventId });
      expect(row).toMatchObject({
        topic: expected.topic,
        partitionKey: productId,
        eventType: 'order.cancelled',
        headers: expected.headers,
      });
      expect(row.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it('answers a repeated cancel like the first, and changes nothing more', async () => {
    const { dropId, userId, orderId } = await liveHold();
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => cancelOrder(db, { orderId, userId })),
    );

    const kinds = outcomes.map((o) => o.kind);
    expect(count(kinds, 'cancelled')).toBe(1);
    expect(count(kinds, 'replay')).toBe(9);
    expect((await eventsOf(db, orderId)).map((e) => e.type)).toEqual(['order.reserved', 'order.cancelled']);
    expect(await checkCounters(db, dropId)).toMatchObject({ reserved: 0, quotaMismatches: [] });
  });

  it('refuses an order that was paid or expired first: 409, nothing changes', async () => {
    const { dropId } = await createDrop(db, { total: 10 });
    const [userId = ''] = await createUsers(db, 1);
    const paid = await placeOrder(db, dropId, userId);
    await markPaid(db, { orderId: paid.orderId, pspChargeId: `ch_${randomUUID()}` });
    const expired = await holdOrder(db, dropId, userId);
    await lapse(db, expired);
    await expireDueOrders(db);

    for (const orderId of [paid.orderId, expired]) {
      expect(await cancelOrder(db, { orderId, userId })).toEqual({ kind: 'refused', code: 'CONFLICT' });
    }
    expect(await checkCounters(db, dropId)).toMatchObject({ reserved: 0, sold: 1, quotaMismatches: [] });
  });

  it("answers not found for another user's order and leaves it alone", async () => {
    const { orderId } = await liveHold();
    const [stranger = ''] = await createUsers(db, 1);

    expect(await cancelOrder(db, { orderId, userId: stranger })).toEqual({ kind: 'not_found' });
    expect(await getOrder(db, orderId)).toMatchObject({ status: 'RESERVED' });
  });

  it('with from=RESERVED loses to a submit from another tab: the placed order is left to its payment', async () => {
    const { dropId, userId, orderId } = await liveHold();
    await submitCheckout(db, submission(orderId, userId));

    expect(await cancelOrder(db, { orderId, userId, from: 'RESERVED' })).toEqual({
      kind: 'refused',
      code: 'CONFLICT',
    });
    expect(await getOrder(db, orderId)).toMatchObject({ status: 'PENDING_PAYMENT' });
    expect((await eventsOf(db, orderId)).map((e) => e.type)).toEqual(['order.reserved', 'order.placed']);
    expect(await checkCounters(db, dropId)).toMatchObject({ reserved: 1, quotaMismatches: [] });

    const held = await liveHold();
    const cancelled = await cancelOrder(db, { orderId: held.orderId, userId: held.userId, from: 'RESERVED' });
    expect(cancelled.kind).toBe('cancelled');
  });
});

describe('extendHold', () => {
  it('adds 60 s once to a live RESERVED hold, with no event and no counter change', async () => {
    const { dropId, userId, orderId } = await liveHold();
    const before = await getOrder(db, orderId);

    const outcome = await extendHold(db, { orderId, userId });

    expect(outcome.kind).toBe('extended');
    const after = await getOrder(db, orderId);
    expect(outcome.kind === 'extended' && outcome.order).toEqual(after);
    expect(after).toMatchObject({ status: 'RESERVED', extensions: 1, version: 2 });
    expect((after?.expiresAt.getTime() ?? 0) - (before?.expiresAt.getTime() ?? 0)).toBe(60_000);
    expect((await eventsOf(db, orderId)).map((e) => e.type)).toEqual(['order.reserved']);
    expect(await checkCounters(db, dropId)).toMatchObject({ reserved: 1, quotaMismatches: [] });

    expect(await extendHold(db, { orderId, userId })).toEqual({ kind: 'refused', code: 'CONFLICT' });
    expect(await getOrder(db, orderId)).toMatchObject({ extensions: 1, expiresAt: after?.expiresAt });
  });

  it('refuses a hold past its deadline, a submitted order, and concurrent second extensions', async () => {
    const lapsed = await liveHold();
    await lapse(db, lapsed.orderId);
    expect(await extendHold(db, lapsed)).toEqual({ kind: 'refused', code: 'CONFLICT' });

    const submitted = await liveHold();
    await submitCheckout(db, submission(submitted.orderId, submitted.userId));
    expect(await extendHold(db, submitted)).toEqual({ kind: 'refused', code: 'CONFLICT' });

    const raced = await liveHold();
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => extendHold(db, raced)));
    expect(
      count(
        outcomes.map((o) => o.kind),
        'extended',
      ),
    ).toBe(1);
    expect(await getOrder(db, raced.orderId)).toMatchObject({ extensions: 1 });
  });

  it("answers not found for another user's order", async () => {
    const { orderId } = await liveHold();
    const [stranger = ''] = await createUsers(db, 1);

    expect(await extendHold(db, { orderId, userId: stranger })).toEqual({ kind: 'not_found' });
    expect(await getOrder(db, orderId)).toMatchObject({ extensions: 0 });
  });
});

describe('outbox wake-ups (§5.4)', () => {
  it('notifies the relay for submit only, never for reserve, payment, extend or cancel', async () => {
    const { dropId } = await createDrop(db, { total: 10 });
    const [userId = ''] = await createUsers(db, 1);
    const listener = await listenOutbox(db, test.url);

    const held = await holdOrder(db, dropId, userId); // reserve: no NOTIFY
    await extendHold(db, { orderId: held, userId }); // extend: no NOTIFY
    await submitCheckout(db, submission(held, userId)); // 1
    await markPaid(db, { orderId: held, pspChargeId: `ch_${randomUUID()}` }); // payment: no NOTIFY
    const other = await holdOrder(db, dropId, userId);
    await cancelOrder(db, { orderId: other, userId }); // cancel: no NOTIFY (it would queue holding the hot row)
    await listener.drain();

    expect(listener.count()).toBe(1);
    await listener.close();
    const { rows } = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM outbox WHERE payload->>'dropId' = ${dropId}`,
    );
    expect(rows[0]?.n).toBe(5);
  });
});

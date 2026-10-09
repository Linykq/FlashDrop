import { randomUUID } from 'node:crypto';
import { TERMINAL_ORDER_STATUSES } from '@flashdrop/domain';
import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cancelOrder, extendHold, submitCheckout } from './checkout';
import { createDb, type Db } from './client';
import { pgErrorOf } from './errors';
import { getOrder } from './orders';
import { markPaid, markPaymentFailed } from './payments';
import { createPool, POOL_PROFILES } from './pool';
import { expireDueOrders } from './sweeper';
import { createTestDatabase, type TestDatabase, waitForLockWaiters } from './test-database';
import {
  checkCounters,
  createDrop,
  createUsers,
  eventsOf,
  gate,
  reached,
  reservation,
} from './test-fixtures';
import { holdOrder, lapse, placeOrder, SHIPPING } from './test-orders';
import { transaction } from './transaction';
import { recordReservation } from './transitions';

/*
 * Races between the transitions of §4.4 on real Postgres 17. The orders row lock is the single
 * linearization point for every race on one order: exactly one transition decides it, its counters and its
 * event commit with it, and the loser changes nothing. Across orders, every transaction locks in the global
 * order orders -> user_drop_quota -> drop_inventory (last), so a mixed load on shared quota and inventory
 * rows never deadlocks (§3).
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
    max: 60,
  });
  db = createDb(pool);
});

afterAll(async () => {
  await pool?.end();
  await test?.drop();
});

const TERMINAL_EVENTS = new Set([
  'order.paid',
  'order.payment_failed',
  'order.expired',
  'order.cancelled',
  'order.rejected',
]);

/** Each order has exactly one terminal event, the one its final status implies, and it is the last. */
async function expectOneOutcomeEach(orderIds: readonly string[]): Promise<void> {
  const eventFor: Record<string, string> = {
    PAID: 'order.paid',
    PAYMENT_FAILED: 'order.payment_failed',
    EXPIRED: 'order.expired',
    CANCELLED: 'order.cancelled',
  };
  for (const orderId of orderIds) {
    const order = await getOrder(db, orderId);
    const types = (await eventsOf(db, orderId)).map((e) => e.type);
    const terminal = types.filter((type) => TERMINAL_EVENTS.has(type));
    const status = order?.status ?? 'missing';
    if ((TERMINAL_ORDER_STATUSES as readonly string[]).includes(status)) {
      expect({ orderId, terminal }).toEqual({ orderId, terminal: [eventFor[status]] });
      expect(types.at(-1)).toBe(eventFor[status]);
    } else {
      expect({ orderId, terminal }).toEqual({ orderId, terminal: [] });
    }
  }
}

/** Waits until `n` backends of this database wait on a row lock. */
describe('one order, one outcome (§4.4)', () => {
  it('lets exactly one of a payment and a cancel queued on a locked order decide it', async () => {
    const { dropId } = await createDrop(db, { total: 10 });
    const [userId = ''] = await createUsers(db, 1);
    const { orderId } = await placeOrder(db, dropId, userId);
    const locked = gate();
    const release = gate();

    // Something holds the row (an earlier transition in flight); both CASes queue on it.
    const holder = transaction(db, async (tx) => {
      await tx.execute(sql`SELECT 1 FROM orders WHERE id = ${orderId} FOR UPDATE`);
      locked.open();
      await release.wait;
    });
    await reached(locked.wait, holder);
    const payment = markPaid(db, { orderId, pspChargeId: `ch_${randomUUID()}` });
    const cancel = cancelOrder(db, { orderId, userId });
    await waitForLockWaiters(test.pool, 2);
    release.open();
    await holder;
    const [paid, cancelled] = await Promise.all([payment, cancel]);

    const status = (await getOrder(db, orderId))?.status;
    if (status === 'PAID') {
      expect(paid.kind).toBe('won');
      expect(cancelled).toEqual({ kind: 'refused', code: 'CONFLICT' });
    } else {
      expect(status).toBe('CANCELLED');
      expect(cancelled.kind).toBe('cancelled');
      expect(paid).toMatchObject({ kind: 'lost', order: { status: 'CANCELLED' } });
    }
    await expectOneOutcomeEach([orderId]);
    expect(await checkCounters(db, dropId)).toMatchObject({ quotaMismatches: [] });
  });

  it('decides each of 20 orders exactly once while payment, cancel and expiry race on all of them', async () => {
    const { dropId } = await createDrop(db, { total: 40, perUserLimit: 10 });
    const users = await createUsers(db, 4);
    const placed = await Promise.all(
      Array.from({ length: 20 }, (_, i) => placeOrder(db, dropId, users[i % users.length] ?? '')),
    );
    const ids = placed.map((p) => p.orderId);
    // Half are past their payment deadline, so the sweeper competes for them too.
    await Promise.all(ids.filter((_, i) => i % 2 === 0).map((id) => lapse(db, id)));

    const results = await Promise.allSettled([
      ...ids.map((orderId) => markPaid(db, { orderId, pspChargeId: `ch_${randomUUID()}` })),
      ...ids.map((orderId, i) => cancelOrder(db, { orderId, userId: users[i % users.length] ?? '' })),
      ...Array.from({ length: 4 }, () => expireDueOrders(db)),
    ]);

    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    const statuses = await Promise.all(ids.map(async (id) => (await getOrder(db, id))?.status));
    expect(statuses.every((s) => s === 'PAID' || s === 'CANCELLED' || s === 'EXPIRED')).toBe(true);
    await expectOneOutcomeEach(ids);
    const counters = await checkCounters(db, dropId);
    expect(counters).toMatchObject({ reserved: 0, liveUnits: 0, quotaMismatches: [] });
    expect(counters.sold).toBe(counters.paidUnits);
  });

  it('serializes submit and cancel: a cancel always ends the order, the submit replays or is refused', async () => {
    const { dropId } = await createDrop(db, { total: 20, perUserLimit: 10 });
    const [userId = ''] = await createUsers(db, 1);
    const ids = await Promise.all(Array.from({ length: 10 }, () => holdOrder(db, dropId, userId)));

    const outcomes = await Promise.all(
      ids.map((orderId) =>
        Promise.all([
          submitCheckout(db, {
            orderId,
            userId,
            checkoutKey: `key-${orderId}`,
            shipping: SHIPPING,
            paymentMethod: 'pm_ok',
          }),
          cancelOrder(db, { orderId, userId }),
        ]),
      ),
    );

    for (const [submit, cancel] of outcomes) {
      expect(cancel.kind).toBe('cancelled');
      // Submit first: it committed, then the cancel took the PENDING_PAYMENT order. Cancel first: refused.
      expect(['submitted', 'refused']).toContain(submit.kind);
      if (submit.kind === 'refused') expect(submit.code).toBe('CONFLICT');
    }
    await expectOneOutcomeEach(ids);
    expect(await checkCounters(db, dropId)).toMatchObject({ reserved: 0, liveUnits: 0, quotaMismatches: [] });
  });
});

describe('the global lock order (§3)', () => {
  it('runs every transition at once on shared quota and inventory rows without a deadlock', async () => {
    const drops = await Promise.all([
      createDrop(db, { total: 500, perUserLimit: 10 }),
      createDrop(db, { total: 500, perUserLimit: 10 }),
    ]);
    const users = await createUsers(db, 12);
    // Every user holds orders in both drops, so their quota rows and both inventory rows are shared.
    const held: { orderId: string; userId: string }[] = [];
    const placed: { orderId: string; userId: string }[] = [];
    await Promise.all(
      users.flatMap((userId) =>
        drops.flatMap(({ dropId }) => [
          holdOrder(db, dropId, userId).then((orderId) => held.push({ orderId, userId })),
          holdOrder(db, dropId, userId).then((orderId) => held.push({ orderId, userId })),
          placeOrder(db, dropId, userId).then(({ orderId }) => placed.push({ orderId, userId })),
          placeOrder(db, dropId, userId).then(({ orderId }) => placed.push({ orderId, userId })),
        ]),
      ),
    );
    // A quarter of each kind is already due, for the sweeper's multi-row batches.
    await Promise.all([...held, ...placed].filter((_, i) => i % 4 === 0).map((o) => lapse(db, o.orderId)));

    const work: Promise<unknown>[] = [];
    held.forEach(({ orderId, userId }, i) => {
      const op = i % 4;
      if (op === 0) work.push(cancelOrder(db, { orderId, userId }));
      if (op === 1) work.push(extendHold(db, { orderId, userId }));
      if (op === 2) {
        work.push(
          submitCheckout(db, {
            orderId,
            userId,
            checkoutKey: `k-${orderId}`,
            shipping: SHIPPING,
            paymentMethod: 'pm_ok',
          }),
        );
      }
      if (op === 3) work.push(cancelOrder(db, { orderId, userId }), extendHold(db, { orderId, userId }));
    });
    placed.forEach(({ orderId, userId }, i) => {
      const op = i % 3;
      if (op === 0) work.push(markPaid(db, { orderId, pspChargeId: `ch_${randomUUID()}` }));
      if (op === 1) work.push(markPaymentFailed(db, { orderId, declineCode: 'card_declined' }));
      if (op === 2)
        work.push(
          cancelOrder(db, { orderId, userId }),
          markPaid(db, { orderId, pspChargeId: `ch_${randomUUID()}` }),
        );
    });
    // New reservations by the same users on the same drops, through the real reserve transaction.
    const reserved: string[] = [];
    for (const userId of users) {
      for (const { dropId } of drops) {
        const r = reservation(userId, dropId);
        reserved.push(r.id);
        work.push(recordReservation(db, { ...r, gen: 0 }));
      }
    }
    for (let i = 0; i < 6; i++) work.push(expireDueOrders(db));

    const results = await Promise.allSettled(work);

    const failures = results.flatMap((r) =>
      r.status === 'rejected' ? [`${pgErrorOf(r.reason)?.code ?? '?'} ${String(r.reason)}`] : [],
    );
    expect(failures).toEqual([]);
    // Whatever the sweeper skipped while rows were locked, it expires now.
    while (true) {
      const tick = await expireDueOrders(db);
      if (tick.kind !== 'batch' || tick.expired.length === 0) break;
    }
    for (const { dropId } of drops) {
      const counters = await checkCounters(db, dropId);
      expect(counters).toMatchObject({ quotaMismatches: [] });
      expect(counters.reserved).toBe(counters.liveUnits);
      expect(counters.sold).toBe(counters.paidUnits);
      expect(counters.reserved + counters.sold).toBeLessThanOrEqual(counters.total);
    }
    await expectOneOutcomeEach([...held, ...placed].map((o) => o.orderId));
    await expectOneOutcomeEach(reserved);
  });
});

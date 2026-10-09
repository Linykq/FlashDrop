import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrderEvent } from '@flashdrop/contracts';
import { cancelOrder, eq, getOrder, payments, REPO_CATALOG_DIR, seedDatabase, sql } from '@flashdrop/db';
import { createSubscriber, dropKeys, readStock, userChannel } from '@flashdrop/inventory';
import {
  classifyFailure,
  dispatchOrderEvent,
  type HandlerContext,
  type OrderEventHandlers,
} from '@flashdrop/messaging';
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { isTransientError } from '../loop';
import { expireOrders } from '../sweeper/expire-orders';
import { type FakePsp, startFakePsp } from '../test/fake-psp';
import {
  armDrop,
  claimedBy,
  createDrop,
  createUsers,
  createWorkerTestEnv,
  eventOf,
  eventTypesOf,
  inventoryOf,
  lapse,
  placeOrder,
  reserve,
  type WorkerTestEnv,
} from '../test/harness';
import { paymentHandlers } from './payment';
import { createPspClient, PspUnavailableError } from './psp-client';
import { settlementHandlers } from './settlement';

/*
 * The payment consumer's handlers (design §6.5) against the Compose Postgres (a database of this file's
 * own), the tests' Redis and a PSP whose failure modes each test sets. Events are the real outbox rows,
 * delivered through the same dispatch as the runner's. The PSP ledger is the evidence for INV-4: per order,
 * captured money equals its total if PAID and 0 otherwise, and no reference ever holds two charges.
 */

let env: WorkerTestEnv;
let psp: FakePsp;
let payment: OrderEventHandlers;
let settlement: OrderEventHandlers;
let context: HandlerContext;

beforeAll(async () => {
  env = await createWorkerTestEnv();
  psp = await startFakePsp();
  context = { logger: env.deps.logger };
  // A short client timeout, so a withheld answer becomes an unknown outcome quickly.
  const client = createPspClient({ baseUrl: psp.url, timeoutMs: 500 });
  payment = paymentHandlers({ db: env.db, redis: env.redis, psp: client });
  settlement = settlementHandlers(env.deps);
});

afterEach(() => {
  psp.beforeCharge(undefined);
  psp.afterRecorded(undefined);
});

afterAll(async () => {
  await psp?.close();
  await env?.close();
});

/** Delivers an event to the payment group's handler, as the runner and `dlq:replay` do. */
async function pay(event: OrderEvent): Promise<void> {
  expect(await dispatchOrderEvent(payment, event, context)).toBe(true);
}

/** Delivers the order's terminal event to the settlement group's handler. */
async function settle(
  orderId: string,
  type: 'order.paid' | 'order.payment_failed' | 'order.expired',
): Promise<void> {
  expect(await dispatchOrderEvent(settlement, await eventOf(env, orderId, type), context)).toBe(true);
}

/** A placed order on a fresh armed drop of 5 units. */
async function placed(options: Parameters<typeof placeOrder>[3] = {}) {
  const dropId = await createDrop(env, { total: 5, limit: 2 });
  await armDrop(env, dropId);
  const [userId = ''] = await createUsers(env.db, 1);
  const orderId = await placeOrder(env, dropId, userId, options);
  return { dropId, userId, orderId, event: await eventOf(env, orderId, 'order.placed') };
}

async function paymentRow(orderId: string) {
  const [row] = await env.db.select().from(payments).where(eq(payments.orderId, orderId));
  return row;
}

/** What the runner would make of a handler's failure. */
const failureClass = (error: unknown) => classifyFailure(error, isTransientError);

describe('order.placed', () => {
  it('charges once and pays the order however often it is delivered; settlement then sells the units', async () => {
    const { dropId, userId, orderId, event } = await placed({ qty: 2 });
    const pushed: unknown[] = [];
    const subscriber = createSubscriber(env.redis, { name: 'payment-test-sub', logger: env.deps.logger });
    await subscriber.connect();
    try {
      await subscriber.subscribe(userChannel(userId), (message) => void pushed.push(JSON.parse(message)));

      await pay(event);
      // Redelivered, then two more copies at once (a rebalance can give two members the same partition).
      await pay(event);
      await Promise.all([pay(event), pay(event)]);

      const order = await getOrder(env.db, orderId);
      expect(order).toMatchObject({ status: 'PAID' });
      const [charge, ...more] = psp.charges(orderId);
      expect(more).toEqual([]);
      expect(charge).toMatchObject({
        status: 'succeeded',
        amountCents: 3_998,
        idempotencyKey: `charge:${orderId}`,
      });
      expect(psp.capturedCents(orderId)).toBe(3_998);
      expect(await paymentRow(orderId)).toMatchObject({
        status: 'SUCCEEDED',
        pspChargeId: charge?.id,
        amountCents: 3_998,
      });
      expect(await eventTypesOf(env, orderId)).toEqual(['order.reserved', 'order.placed', 'order.paid']);
      expect(await inventoryOf(env, dropId)).toMatchObject({ reserved: 0, sold: 2 });
      // Bought units still count toward the limit (INV-3).
      expect(await claimedBy(env, dropId, userId)).toBe(2);
      await vi.waitFor(() =>
        expect(pushed).toContainEqual({ type: 'order', orderId, status: 'PAID', version: order?.version }),
      );

      await settle(orderId, 'order.paid');
      await settle(orderId, 'order.paid');
      expect(await readStock(env.redis, dropId)).toMatchObject({ avail: 3, held: 0, sold: 2 });
    } finally {
      await subscriber.close();
    }
  });

  it('records a decline as PAYMENT_FAILED: Postgres frees the units at once, settlement gives Redis its stock back', async () => {
    const { dropId, userId, orderId, event } = await placed({ paymentMethod: 'pm_decline' });
    expect(await readStock(env.redis, dropId)).toMatchObject({ avail: 4, held: 1 });

    await pay(event);
    await pay(event);

    expect(await getOrder(env.db, orderId)).toMatchObject({
      status: 'PAYMENT_FAILED',
      closeReason: 'DECLINED',
    });
    expect(await paymentRow(orderId)).toMatchObject({ status: 'FAILED', declineCode: 'card_declined' });
    expect(psp.charges(orderId)).toEqual([expect.objectContaining({ status: 'declined' })]);
    expect(psp.capturedCents(orderId)).toBe(0);
    expect(await inventoryOf(env, dropId)).toMatchObject({ reserved: 0, sold: 0 });
    expect(await claimedBy(env, dropId, userId)).toBe(0);

    await settle(orderId, 'order.payment_failed');
    expect(await readStock(env.redis, dropId)).toMatchObject({ avail: 5, held: 0, sold: 0 });
    expect(await env.redis.hGet(dropKeys(dropId).uq, userId)).toBeNull();
  });

  it('makes no PSP call when order.placed is redelivered for a declined order', async () => {
    const { orderId, event } = await placed({ paymentMethod: 'pm_decline' });
    await pay(event);
    expect(await getOrder(env.db, orderId)).toMatchObject({ status: 'PAYMENT_FAILED' });
    expect(psp.attempts(orderId)).toBe(1);

    // Redeliveries are routine: a transient failure seeks the partition back over finished messages.
    await pay(event);
    await pay(event);

    expect(psp.attempts(orderId)).toBe(1);
    expect(psp.closes(orderId)).toBe(0);
  });

  it('retries an unknown outcome with the same key: a timeout after success leaves exactly one charge', async () => {
    const { dropId, orderId, event } = await placed();
    psp.withholdNextSuccess();

    const timedOut = await pay(event).catch((error: unknown) => error);
    expect(timedOut).toBeInstanceOf(PspUnavailableError);
    expect(failureClass(timedOut)).toBe('transient');
    // The PSP took the money; Postgres does not know yet.
    expect(psp.capturedCents(orderId)).toBe(1_999);
    expect(await getOrder(env.db, orderId)).toMatchObject({ status: 'PENDING_PAYMENT' });

    // A 503 that recorded nothing is just as unknown to the consumer, and retried the same way.
    psp.failNext(1);
    expect(failureClass(await pay(event).catch((error: unknown) => error))).toBe('transient');

    await pay(event);

    expect(await getOrder(env.db, orderId)).toMatchObject({ status: 'PAID' });
    expect(psp.attempts(orderId)).toBe(2); // the 503 never reached the ledger
    const [charge, ...more] = psp.charges(orderId);
    expect(more).toEqual([]);
    expect(psp.capturedCents(orderId)).toBe(1_999);
    expect(await paymentRow(orderId)).toMatchObject({ status: 'SUCCEEDED', pspChargeId: charge?.id });
    expect(await inventoryOf(env, dropId)).toMatchObject({ reserved: 0, sold: 1 });
  });

  it('refunds a charge whose order expired while it was in flight (the payment CAS loses to expiry)', async () => {
    const { dropId, orderId, event } = await placed();
    psp.afterRecorded(async () => {
      await lapse(env, orderId);
      await expireOrders(env.deps);
    });

    await pay(event);

    expect(await getOrder(env.db, orderId)).toMatchObject({ status: 'EXPIRED' });
    expect(psp.charges(orderId)).toEqual([expect.objectContaining({ status: 'refunded' })]);
    expect(psp.capturedCents(orderId)).toBe(0);
    expect(psp.isClosed(orderId)).toBe(true);
    expect(await paymentRow(orderId)).toMatchObject({ status: 'REFUNDED', amountCents: 1_999 });
    expect(await eventTypesOf(env, orderId)).toEqual(['order.reserved', 'order.placed', 'order.expired']);

    // The expiry's own event finds the close recorded and leaves the PSP alone.
    await pay(await eventOf(env, orderId, 'order.expired'));
    expect(psp.closes(orderId)).toBe(1);
    expect(psp.charges(orderId)).toHaveLength(1);
    expect(await paymentRow(orderId)).toMatchObject({ status: 'REFUNDED' });
    await settle(orderId, 'order.expired');
    expect(await readStock(env.redis, dropId)).toMatchObject({ avail: 5, held: 0, sold: 0 });
  });

  it('keeps a payment whose CAS committed first, even past the deadline (the expiry then loses)', async () => {
    const { dropId, orderId, event } = await placed();
    // The deadline passes while the charge is in flight, before the sweeper gets to the order.
    psp.afterRecorded(() => lapse(env, orderId));
    await pay(event);

    await expireOrders(env.deps);

    expect(await getOrder(env.db, orderId)).toMatchObject({ status: 'PAID' });
    expect(psp.capturedCents(orderId)).toBe(1_999);
    expect(psp.isClosed(orderId)).toBe(false);
    expect(await eventTypesOf(env, orderId)).toEqual(['order.reserved', 'order.placed', 'order.paid']);
    expect(await inventoryOf(env, dropId)).toMatchObject({ reserved: 0, sold: 1 });
  });

  it('refunds an earlier charge when order.placed is redelivered after the order expired', async () => {
    const { orderId, event } = await placed();
    // The first delivery charged and lost the answer; the order expired before the redelivery.
    psp.withholdNextSuccess();
    await expect(pay(event)).rejects.toBeInstanceOf(PspUnavailableError);
    await lapse(env, orderId);
    await expireOrders(env.deps);
    expect(psp.capturedCents(orderId)).toBe(1_999);

    await pay(event);

    expect(await getOrder(env.db, orderId)).toMatchObject({ status: 'EXPIRED' });
    expect(psp.capturedCents(orderId)).toBe(0);
    expect(await paymentRow(orderId)).toMatchObject({ status: 'REFUNDED', amountCents: 1_999 });
  });

  it('makes no PSP call for a redelivered order.placed or order.expired once the close is recorded', async () => {
    const { orderId, event } = await placed();
    psp.withholdNextSuccess();
    await expect(pay(event)).rejects.toBeInstanceOf(PspUnavailableError);
    await lapse(env, orderId);
    await expireOrders(env.deps);
    const expired = await eventOf(env, orderId, 'order.expired');
    await pay(expired);
    expect(psp.closes(orderId)).toBe(1);
    expect(await paymentRow(orderId)).toMatchObject({ status: 'REFUNDED', amountCents: 1_999 });

    // The pair redelivered after the close was recorded: nothing left to refund, nothing can be charged.
    await pay(event);
    await pay(expired);

    expect(psp.closes(orderId)).toBe(1);
    expect(psp.attempts(orderId)).toBe(1);
    expect(psp.capturedCents(orderId)).toBe(0);
  });

  it('refunds a charge whose order was cancelled while it was in flight (cancel vs. payment)', async () => {
    const { userId, orderId, event } = await placed();
    psp.afterRecorded(async () => {
      expect((await cancelOrder(env.db, { orderId, userId })).kind).toBe('cancelled');
    });

    await pay(event);

    expect(await getOrder(env.db, orderId)).toMatchObject({ status: 'CANCELLED', closeReason: 'USER' });
    expect(psp.capturedCents(orderId)).toBe(0);
    expect(await paymentRow(orderId)).toMatchObject({ status: 'REFUNDED' });
    await pay(await eventOf(env, orderId, 'order.cancelled'));
    expect(psp.charges(orderId)).toHaveLength(1);
  });

  it('takes a charge refused on a closed reference as a lost CAS that changes nothing', async () => {
    const { userId, orderId, event } = await placed();
    // Between this delivery's read (PENDING_PAYMENT) and its charge, the order is cancelled and the
    // cancel's event closes the reference: the PSP must refuse the charge.
    psp.beforeCharge(async () => {
      psp.beforeCharge(undefined);
      await cancelOrder(env.db, { orderId, userId });
      await pay(await eventOf(env, orderId, 'order.cancelled'));
    });

    await pay(event);

    expect(psp.attempts(orderId)).toBe(1);
    expect(psp.charges(orderId)).toEqual([]);
    expect(await getOrder(env.db, orderId)).toMatchObject({ status: 'CANCELLED' });
    expect(await paymentRow(orderId)).toBeUndefined();
  });

  it('dead-letters order.placed for an order that never reached checkout', async () => {
    const dropId = await createDrop(env);
    await armDrop(env, dropId);
    const [userId = ''] = await createUsers(env.db, 1);
    const orderId = await reserve(env, dropId, userId);
    const reserved = await eventOf(env, orderId, 'order.reserved');
    const forged: OrderEvent = {
      ...reserved,
      type: 'order.placed',
      data: {
        qty: 1,
        totalCents: 1_999,
        currency: 'USD',
        paymentMethod: 'pm_ok',
        expiresAt: reserved.data.expiresAt,
      },
    };

    const error = await pay(forged).catch((e: unknown) => e);

    expect(failureClass(error)).toBe('poison');
    expect(psp.attempts(orderId)).toBe(0);
  });
});

describe('order.expired and order.cancelled', () => {
  it('close the reference of an order that ended after checkout', async () => {
    const { orderId, userId } = await placed();
    await cancelOrder(env.db, { orderId, userId });

    const cancelled = await eventOf(env, orderId, 'order.cancelled');

    await pay(cancelled);
    await pay(cancelled);

    expect(psp.isClosed(orderId)).toBe(true);
    expect(psp.closes(orderId)).toBe(1); // the redelivery found the closure recorded
    expect(await paymentRow(orderId)).toBeUndefined();
  });

  it('cost the PSP nothing for an order that ended before checkout', async () => {
    const dropId = await createDrop(env);
    await armDrop(env, dropId);
    const [userId = ''] = await createUsers(env.db, 1);
    const orderId = await reserve(env, dropId, userId);
    await lapse(env, orderId);
    await expireOrders(env.deps);

    await pay(await eventOf(env, orderId, 'order.expired'));

    expect(psp.isClosed(orderId)).toBe(false);
  });
});

describe('seeded history', () => {
  it("passes through the payment and settlement groups without a PSP call or a change: the seed's sales are paid and settled", async () => {
    const uploadDir = await mkdtemp(join(tmpdir(), 'fd-seed-events-'));
    onTestFinished(() => rm(uploadDir, { recursive: true, force: true }));
    await seedDatabase(env.db, {
      catalogDir: REPO_CATALOG_DIR,
      uploadDir,
      logger: { info: () => undefined },
    });
    const { rows } = await env.db.execute(sql`
      SELECT ob.payload FROM outbox ob JOIN orders o ON o.id = (ob.payload->>'orderId')::uuid
      WHERE o.idempotency_key LIKE 'seed-reserve-%' ORDER BY ob.id`);
    const events = rows.map((row) => OrderEvent.parse(row.payload));
    expect(events.map((event) => event.type).slice(0, 3)).toEqual([
      'order.reserved',
      'order.placed',
      'order.paid',
    ]);
    const before = await env.db.execute(sql`SELECT id, status, version, updated_at FROM orders ORDER BY id`);

    for (const event of events) {
      await dispatchOrderEvent(payment, event, context);
      await dispatchOrderEvent(settlement, event, context);
    }

    for (const orderId of new Set(events.map((event) => event.orderId))) {
      expect(psp.attempts(orderId)).toBe(0);
      expect(psp.closes(orderId)).toBe(0);
    }
    const after = await env.db.execute(sql`SELECT id, status, version, updated_at FROM orders ORDER BY id`);
    expect(after.rows).toEqual(before.rows);
  });
});

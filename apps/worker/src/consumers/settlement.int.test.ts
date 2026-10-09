import type { OrderEvent } from '@flashdrop/contracts';
import { cancelOrder, getOrder, markPaid, markPaymentFailed } from '@flashdrop/db';
import {
  dropKeys,
  fdConfirm,
  fdSetStatus,
  readDropState,
  readStock,
  redisDropViolations,
} from '@flashdrop/inventory';
import { classifyFailure, dispatchOrderEvent, type HandlerContext } from '@flashdrop/messaging';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isTransientError } from '../loop';
import { expireOrders } from '../sweeper/expire-orders';
import { settleSafetyNet } from '../sweeper/settle-safety-net';
import {
  alertsNamed,
  armDrop,
  createDrop,
  createUsers,
  createWorkerTestEnv,
  eventOf,
  inventoryOf,
  lapse,
  placeOrder,
  reserve,
  type WorkerTestEnv,
} from '../test/harness';
import { settlementHandlers } from './settlement';

/*
 * The settlement consumer's handlers (design §6.5) against the Compose Postgres (a database of this file's
 * own) and the tests' Redis. Events are the real outbox rows, delivered through the runner's dispatch.
 */

let env: WorkerTestEnv;
let context: HandlerContext;
const running = new AbortController().signal;

beforeAll(async () => {
  env = await createWorkerTestEnv();
  context = { logger: env.deps.logger };
});

afterAll(async () => {
  await env?.close();
});

const settle = (event: OrderEvent) => dispatchOrderEvent(settlementHandlers(env.deps), event, context);
const failureClass = (error: unknown) => classifyFailure(error, isTransientError);

/** Redis agrees with Postgres's stock of record (INV-6) and with itself (INV-9 and the entry sums). */
async function expectRedisMatchesPostgres(dropId: string) {
  const [state, inventory] = await Promise.all([readDropState(env.redis, dropId), inventoryOf(env, dropId)]);
  expect(state.inv).toMatchObject({
    avail: inventory.total - inventory.sold - inventory.reserved,
    held: inventory.reserved,
    sold: inventory.sold,
  });
  expect(redisDropViolations(state)).toEqual([]);
}

async function rsvState(dropId: string, rid: string): Promise<string | undefined> {
  const raw = await env.redis.hGet(dropKeys(dropId).rsv, rid);
  return raw === null ? undefined : (JSON.parse(raw) as { s: string }).s;
}

async function armedDrop(total = 5) {
  const dropId = await createDrop(env, { total, limit: 2 });
  await armDrop(env, dropId);
  const [userId = ''] = await createUsers(env.db, 1);
  return { dropId, userId };
}

describe('settlement', () => {
  it('commits a paid order’s units in Redis once, however often order.paid is delivered', async () => {
    const { dropId, userId } = await armedDrop();
    const orderId = await placeOrder(env, dropId, userId, { qty: 2 });
    await markPaid(env.db, { orderId, pspChargeId: 'ch_settlement_test' });
    const paid = await eventOf(env, orderId, 'order.paid');

    expect(await settle(paid)).toBe(true);
    await settle(paid);
    await Promise.all([settle(paid), settle(paid)]);

    expect(await rsvState(dropId, orderId)).toBe('COMMITTED');
    expect(await readStock(env.redis, dropId)).toMatchObject({ avail: 3, held: 0, sold: 2 });
    expect((await getOrder(env.db, orderId))?.redisSettledAt).toBeInstanceOf(Date);
    await expectRedisMatchesPostgres(dropId);
  });

  it('gives back the stock and quota of an order that expired, was cancelled or failed payment', async () => {
    const { dropId, userId } = await armedDrop(6);
    const [other = ''] = await createUsers(env.db, 1);
    const expired = await reserve(env, dropId, userId);
    const cancelled = await placeOrder(env, dropId, userId);
    const failed = await placeOrder(env, dropId, other, { paymentMethod: 'pm_decline' });
    await lapse(env, expired);
    await expireOrders(env.deps);
    await cancelOrder(env.db, { orderId: cancelled, userId });
    await markPaymentFailed(env.db, {
      orderId: failed,
      declineCode: 'card_declined',
      pspChargeId: 'ch_declined',
    });
    // Postgres committed every outcome; Redis is lower until settlement applies them (§4.3).
    expect(await readStock(env.redis, dropId)).toMatchObject({ avail: 3, held: 3 });

    for (const event of [
      await eventOf(env, expired, 'order.expired'),
      await eventOf(env, cancelled, 'order.cancelled'),
      await eventOf(env, failed, 'order.payment_failed'),
    ]) {
      await settle(event);
      await settle(event);
    }

    for (const orderId of [expired, cancelled, failed])
      expect(await rsvState(dropId, orderId)).toBe('RELEASED');
    expect(await readStock(env.redis, dropId)).toMatchObject({ avail: 6, held: 0, sold: 0 });
    expect(await env.redis.hLen(dropKeys(dropId).uq)).toBe(0);
    await expectRedisMatchesPostgres(dropId);
  });

  it('does nothing for an order the safety net settled first', async () => {
    const { dropId, userId } = await armedDrop();
    const orderId = await reserve(env, dropId, userId);
    await lapse(env, orderId);
    await expireOrders(env.deps);
    await settleSafetyNet(env.deps, running, { olderThanSeconds: 0 });
    const settledAt = (await getOrder(env.db, orderId))?.redisSettledAt;
    expect(settledAt).toBeInstanceOf(Date);

    await settle(await eventOf(env, orderId, 'order.expired'));

    expect((await getOrder(env.db, orderId))?.redisSettledAt).toEqual(settledAt);
    expect(await readStock(env.redis, dropId)).toMatchObject({ avail: 5, held: 0 });
  });

  it('retries while the drop is RECONCILING, then settles once it is rebuilt', async () => {
    const { dropId, userId } = await armedDrop();
    const orderId = await reserve(env, dropId, userId);
    await lapse(env, orderId);
    await expireOrders(env.deps);
    const event = await eventOf(env, orderId, 'order.expired');
    await fdSetStatus(env.redis, dropId, 'RECONCILING');

    const error = await settle(event).catch((e: unknown) => e);
    expect(failureClass(error)).toBe('transient');
    expect((await getOrder(env.db, orderId))?.redisSettledAt).toBeNull();

    await armDrop(env, dropId);
    await settle(event);

    expect((await getOrder(env.db, orderId))?.redisSettledAt).toBeInstanceOf(Date);
    await expectRedisMatchesPostgres(dropId);
  });

  it('dead-letters an order whose Redis entry holds the opposite outcome (INV-8), with an alert', async () => {
    const { dropId, userId } = await armedDrop();
    const orderId = await reserve(env, dropId, userId);
    // Redis committed a hold that Postgres then expired: an INV-8 breach a release must not paper over.
    await fdConfirm(env.redis, dropId, orderId);
    await lapse(env, orderId);
    await expireOrders(env.deps);

    const error = await settle(await eventOf(env, orderId, 'order.expired')).catch((e: unknown) => e);

    expect(failureClass(error)).toBe('poison');
    expect(alertsNamed(env, 'redis_conflict')).toContainEqual(expect.objectContaining({ status: 'EXPIRED' }));
    expect(await rsvState(dropId, orderId)).toBe('COMMITTED');
    expect((await getOrder(env.db, orderId))?.redisSettledAt).toBeNull();
  });
});

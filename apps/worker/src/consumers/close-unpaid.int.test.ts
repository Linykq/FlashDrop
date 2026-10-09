import { eq, getOrder, payments, pspClosures, sweeperQuarantine } from '@flashdrop/db';
import { dispatchOrderEvent, type OrderEventHandlers } from '@flashdrop/messaging';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { expireOrders } from '../sweeper/expire-orders';
import { FAKE_PSP_API_KEY, type FakePsp, startFakePsp } from '../test/fake-psp';
import {
  alertsNamed,
  armDrop,
  createDrop,
  createUsers,
  createWorkerTestEnv,
  eventOf,
  lapse,
  placeOrder,
  type WorkerTestEnv,
} from '../test/harness';
import { CLOSE_UNPAID_CONCURRENCY, type CloseUnpaidDeps, closeUnpaid } from './close-unpaid';
import { paymentHandlers } from './payment';
import { createPspClient, PspUnavailableError } from './psp-client';

/*
 * The close-unpaid loop (design §6.5) against the Compose Postgres (a database of this file's own) and a PSP
 * whose failures each test sets: a charge that raced its order's end is refunded even when the payment
 * group never handled the order's end (its event dead-lettered), and a close that keeps failing is parked
 * with an alert instead of being retried by every tick.
 */

let env: WorkerTestEnv;
let psp: FakePsp;
let payment: OrderEventHandlers;
let deps: CloseUnpaidDeps;

beforeAll(async () => {
  env = await createWorkerTestEnv();
  psp = await startFakePsp();
  const client = createPspClient({ baseUrl: psp.url, apiKey: FAKE_PSP_API_KEY, timeoutMs: 500 });
  payment = paymentHandlers({ db: env.db, redis: env.redis, psp: client });
  deps = { db: env.db, psp: client, logger: env.deps.logger };
});

afterEach(() => {
  psp.refuseCloses(undefined);
  psp.hangCloses(false);
});

afterAll(async () => {
  await psp?.close();
  await env?.close();
});

const noAbort = new AbortController().signal;
/** A tick that does not wait the consumer's minute first. */
const tick = () => closeUnpaid(deps, noAbort, { olderThanSeconds: 0 });

/**
 * An order whose charge succeeded at the PSP but whose answer never arrived, and which then expired: the
 * money is captured on an EXPIRED order, and only a close of its reference gives it back.
 */
async function chargedThenExpired(): Promise<string> {
  const dropId = await createDrop(env, { total: 5, limit: 2 });
  await armDrop(env, dropId);
  const [userId = ''] = await createUsers(env.db, 1);
  const orderId = await placeOrder(env, dropId, userId);
  psp.withholdNextSuccess();
  const placed = await eventOf(env, orderId, 'order.placed');
  await expect(dispatchOrderEvent(payment, placed, { logger: env.deps.logger })).rejects.toBeInstanceOf(
    PspUnavailableError,
  );
  await lapse(env, orderId);
  await expireOrders(env.deps);
  expect(await getOrder(env.db, orderId)).toMatchObject({ status: 'EXPIRED' });
  expect(psp.capturedCents(orderId)).toBe(1_999);
  return orderId;
}

/** `count` orders that expired after checkout, with nothing captured: each owes a close. */
async function expiredAfterCheckout(count: number): Promise<string[]> {
  const dropId = await createDrop(env, { total: count, limit: 1 });
  await armDrop(env, dropId);
  const users = await createUsers(env.db, count);
  const orderIds = await Promise.all(users.map((userId) => placeOrder(env, dropId, userId)));
  for (const orderId of orderIds) await lapse(env, orderId);
  await expireOrders(env.deps);
  return orderIds;
}

const paymentOf = async (orderId: string) =>
  (await env.db.select().from(payments).where(eq(payments.orderId, orderId)))[0];
const closureOf = async (orderId: string) =>
  (await env.db.select().from(pspClosures).where(eq(pspClosures.orderId, orderId)))[0];
const quarantined = async (orderId: string) =>
  env.db.select().from(sweeperQuarantine).where(eq(sweeperQuarantine.orderId, orderId));

describe('close-unpaid', () => {
  it("refunds a raced charge whose order's end the payment group never handled (a dead-lettered event)", async () => {
    const orderId = await chargedThenExpired();

    // The consumer gets the first minute: a default tick leaves the order alone.
    await closeUnpaid(deps, noAbort);
    expect(psp.isClosed(orderId)).toBe(false);

    await tick();

    expect(psp.isClosed(orderId)).toBe(true);
    expect(psp.capturedCents(orderId)).toBe(0);
    expect(await paymentOf(orderId)).toMatchObject({ status: 'REFUNDED', amountCents: 1_999 });
    expect(await closureOf(orderId)).toBeDefined();
    // Recorded, so the order.expired the group may still get is a replay, and no later tick closes it again.
    await expect(
      dispatchOrderEvent(payment, await eventOf(env, orderId, 'order.expired'), { logger: env.deps.logger }),
    ).resolves.toBe(true);
    expect(psp.charges(orderId)).toHaveLength(1);
  });

  it('leaves alone an order the payment group closed, even when nothing was captured', async () => {
    const dropId = await createDrop(env, { total: 5, limit: 2 });
    await armDrop(env, dropId);
    const [userId = ''] = await createUsers(env.db, 1);
    const orderId = await placeOrder(env, dropId, userId);
    await lapse(env, orderId);
    await expireOrders(env.deps);
    await dispatchOrderEvent(payment, await eventOf(env, orderId, 'order.expired'), {
      logger: env.deps.logger,
    });
    expect(await closureOf(orderId)).toBeDefined();
    psp.refuseCloses(orderId); // a close now would fail and show up as a quarantine

    await tick();

    expect(await quarantined(orderId)).toEqual([]);
  });

  it('parks a close the PSP keeps refusing, with an alert, and still closes the others', async () => {
    const refused = await chargedThenExpired();
    const other = await chargedThenExpired();
    psp.refuseCloses(refused);
    // The payment group's own close fails the same way: unclassified, so it ends in the DLQ.
    await expect(
      dispatchOrderEvent(payment, await eventOf(env, refused, 'order.expired'), { logger: env.deps.logger }),
    ).rejects.toThrow(/refused the request \(400\)/);

    await tick();

    expect(psp.capturedCents(other)).toBe(0);
    expect(psp.capturedCents(refused)).toBe(1_999);
    expect(await quarantined(refused)).toEqual([
      expect.objectContaining({ loop: 'close-unpaid', error: expect.stringMatching(/\(400\)/) }),
    ]);
    expect(alertsNamed(env, 'sweeper_quarantine')).toContainEqual(
      expect.objectContaining({ loop: 'close-unpaid', orderId: refused }),
    );
    // Parked: later ticks skip it until someone looks.
    psp.refuseCloses(undefined);
    await tick();
    expect(psp.isClosed(refused)).toBe(false);
  });

  it('waits out a PSP outage without parking anything, and closes on a later tick', async () => {
    const orderId = await chargedThenExpired();
    psp.failNext(1);

    await expect(tick()).rejects.toBeInstanceOf(PspUnavailableError);
    expect(await quarantined(orderId)).toEqual([]);
    expect(psp.capturedCents(orderId)).toBe(1_999);

    await tick();
    expect(psp.capturedCents(orderId)).toBe(0);
    expect(await paymentOf(orderId)).toMatchObject({ status: 'REFUNDED' });
  });

  it('stops calling a PSP that hangs: a tick makes one round of closes at most, then ends', async () => {
    const owed = await expiredAfterCheckout(CLOSE_UNPAID_CONCURRENCY * 3);
    psp.hangCloses(true);
    const before = psp.totalCloses();

    await expect(tick()).rejects.toBeInstanceOf(PspUnavailableError);

    // Every lane timed out on its first close and started no other; a tick that kept going would have
    // called the PSP for all 24 orders, a client timeout per lane per order.
    expect(psp.totalCloses() - before).toBeLessThanOrEqual(CLOSE_UNPAID_CONCURRENCY);
    for (const orderId of owed) expect(await quarantined(orderId)).toEqual([]);

    psp.hangCloses(false);
    await tick();
    for (const orderId of owed) expect(await closureOf(orderId)).toBeDefined();
  });

  it('starts no close once its time budget is spent, and leaves the rest to the next tick', async () => {
    const owed = await expiredAfterCheckout(CLOSE_UNPAID_CONCURRENCY + 4);
    const before = psp.totalCloses();
    // The budget runs out while the first round is in flight, however fast the machine: the clock reads
    // past any deadline once the PSP has received a close.
    const now = () => (psp.totalCloses() > before ? Number.POSITIVE_INFINITY : 0);

    await closeUnpaid(deps, noAbort, { olderThanSeconds: 0, now });

    // One close per lane, each run to its end and recorded; no lane started another.
    expect(psp.totalCloses() - before).toBe(CLOSE_UNPAID_CONCURRENCY);
    for (const orderId of owed) {
      expect((await closureOf(orderId)) !== undefined).toBe(psp.closes(orderId) > 0);
    }
    await tick();
    for (const orderId of owed) expect(await closureOf(orderId)).toBeDefined();
  });

  it('starts no close at all when the budget is spent before the first', async () => {
    const [orderId = ''] = await expiredAfterCheckout(1);
    const before = psp.totalCloses();

    await closeUnpaid(deps, noAbort, { olderThanSeconds: 0, budgetMs: 0 });

    expect(psp.totalCloses()).toBe(before);
    expect(await closureOf(orderId)).toBeUndefined();
    await tick();
    expect(await closureOf(orderId)).toBeDefined();
  });
});

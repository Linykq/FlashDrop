import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { KafkaEnv, loadEnv } from '@flashdrop/config';
import type { OrderEvent } from '@flashdrop/contracts';
import { cancelOrder, eq, getOrder, payments, recordReservation } from '@flashdrop/db';
import { holdTestHook, waitForLockWaiters } from '@flashdrop/db/testing';
import { DomainError } from '@flashdrop/domain';
import { requestFingerprint, reservationId } from '@flashdrop/domain/identity';
import {
  checkDrop,
  createReservationService,
  createReservePorts,
  dropKeys,
  fdReserve,
  type ReservationService,
  type ReservePorts,
  type ReserveRequest,
  readDropState,
  readStock,
  sampleDrop,
  settleRedis,
} from '@flashdrop/inventory';
import {
  type ConsumerRunner,
  createGroupLagReader,
  createKafka,
  createPublisher,
  dispatchOrderEvent,
  type OrderEventHandlers,
} from '@flashdrop/messaging';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startConsumer } from './consumers';
import { paymentHandlers } from './consumers/payment';
import { createPspClient } from './consumers/psp-client';
import { expireOrders } from './sweeper/expire-orders';
import { createOrphanScan } from './sweeper/orphan-scan';
import { FAKE_PSP_API_KEY, type FakePsp, startFakePsp } from './test/fake-psp';
import {
  ageHold,
  apiReservations,
  armDrop,
  createDrop,
  createUsers,
  createWorkerTestEnv,
  eventOf,
  eventTypesOf,
  holdOnly,
  inventoryOf,
  lapse,
  placeOrder,
  reserve,
  type WorkerTestEnv,
} from './test/harness';

/*
 * The race matrix of design §13, forced rather than hoped for. `FD_TEST_HOOKS` makes named points in the code
 * under test wait while the test holds them (`@flashdrop/db` test-hooks): the test stops one side inside its
 * transaction, row locks held, runs the other side into it, then lets the first side commit. Every case ends
 * on the money and the stock: the fake PSP's ledger (one charge per order, captured = total if PAID, else 0)
 * and Postgres's counters.
 *
 * The rest of the matrix lives next to the code it races:
 * - cancel commits between the charge and the PAID CAS (refund): `consumers/payment.int.test.ts`;
 * - same-key reserves, one rolling back SOLD_OUT, the other committing: `packages/db` reservation tests;
 * - rebuild vs an in-flight reserve: here for the generation fence's other side, `apps/api` race-matrix for
 *   the API's 503 and healed retry, `packages/inventory` sync tests for a reserve that passed the fence first;
 * - rebuild vs a tombstone written after its snapshot (an API refusal, an orphan): here;
 * - rebuild vs rebuild, status changes during a rebuild: `packages/inventory` sync tests.
 */

// Read once, at the first hook point, which runs inside a test.
process.env.FD_TEST_HOOKS = 'true';

let env: WorkerTestEnv;
let psp: FakePsp;
let payment: OrderEventHandlers;

beforeAll(async () => {
  env = await createWorkerTestEnv();
  psp = await startFakePsp();
  payment = paymentHandlers({
    db: env.db,
    redis: env.redis,
    psp: createPspClient({ baseUrl: psp.url, apiKey: FAKE_PSP_API_KEY }),
  });
});

afterAll(async () => {
  await psp?.close();
  await env?.close();
});

/** A PENDING_PAYMENT order on a fresh armed drop of 5 units, and its `order.placed` as the relay sends it. */
async function placed() {
  const dropId = await createDrop(env, { total: 5, limit: 2 });
  await armDrop(env, dropId);
  const [userId = ''] = await createUsers(env.db, 1);
  const orderId = await placeOrder(env, dropId, userId);
  return { dropId, userId, orderId, event: await eventOf(env, orderId, 'order.placed') };
}

/** Delivers `order.placed` to the payment group's handler, as the runner does. */
async function pay(event: Awaited<ReturnType<typeof placed>>['event']): Promise<void> {
  expect(await dispatchOrderEvent(payment, event, { logger: env.deps.logger })).toBe(true);
}

async function paymentRow(orderId: string) {
  const [row] = await env.db.select().from(payments).where(eq(payments.orderId, orderId));
  return row;
}

describe('payment CAS vs expiry (§4.4: the orders row lock decides)', () => {
  it('expiry first: the PAID CAS queues behind the expiry, loses, and the charge is refunded (net 0)', async () => {
    const { dropId, orderId, event } = await placed();
    await lapse(env, orderId);
    const hook = await holdTestHook(env.pool, 'expired.locked');
    const expiring = expireOrders(env.deps);
    await hook.waitForArrivals();
    // The expiry holds the row, EXPIRED but uncommitted. The payment reads PENDING_PAYMENT (MVCC), the PSP
    // charges, and the CAS waits on the row lock.
    const paying = pay(event);
    await waitForLockWaiters(env.pool);
    expect(psp.capturedCents(orderId)).toBe(1_999);

    await hook.release();
    await Promise.all([expiring, paying]);

    expect(await getOrder(env.db, orderId)).toMatchObject({ status: 'EXPIRED', closeReason: 'TIMEOUT' });
    expect(psp.charges(orderId)).toEqual([expect.objectContaining({ status: 'refunded' })]);
    expect(psp.capturedCents(orderId)).toBe(0);
    expect(await paymentRow(orderId)).toMatchObject({ status: 'REFUNDED', amountCents: 1_999 });
    expect(await eventTypesOf(env, orderId)).toEqual(['order.reserved', 'order.placed', 'order.expired']);
    expect(await inventoryOf(env, dropId)).toMatchObject({ reserved: 0, sold: 0 });
  });

  it('payment first: the expiry skips the row the PAID CAS holds, and the payment stands past its deadline', async () => {
    const { dropId, orderId, event } = await placed();
    await lapse(env, orderId);
    const hook = await holdTestHook(env.pool, 'paid.locked');
    const paying = pay(event);
    await hook.waitForArrivals();

    // Due by the clock, but locked by the payment: SKIP LOCKED passes it over rather than waiting.
    await expireOrders(env.deps);
    await hook.release();
    await paying;
    await expireOrders(env.deps);

    expect(await getOrder(env.db, orderId)).toMatchObject({ status: 'PAID' });
    expect(psp.capturedCents(orderId)).toBe(1_999);
    expect(psp.isClosed(orderId)).toBe(false);
    expect(await paymentRow(orderId)).toMatchObject({ status: 'SUCCEEDED', amountCents: 1_999 });
    expect(await eventTypesOf(env, orderId)).toEqual(['order.reserved', 'order.placed', 'order.paid']);
    expect(await inventoryOf(env, dropId)).toMatchObject({ reserved: 0, sold: 1 });
  });
});

describe('cancel vs payment', () => {
  it('payment first: a cancel queued behind the PAID CAS is refused (409) and changes nothing', async () => {
    const { dropId, userId, orderId, event } = await placed();
    const hook = await holdTestHook(env.pool, 'paid.locked');
    const paying = pay(event);
    await hook.waitForArrivals();
    const cancelling = cancelOrder(env.db, { orderId, userId });
    await waitForLockWaiters(env.pool);

    await hook.release();
    await paying;

    expect(await cancelling).toEqual({ kind: 'refused', code: 'CONFLICT' });
    expect(await getOrder(env.db, orderId)).toMatchObject({ status: 'PAID' });
    expect(psp.capturedCents(orderId)).toBe(1_999);
    expect(await eventTypesOf(env, orderId)).toEqual(['order.reserved', 'order.placed', 'order.paid']);
    expect(await inventoryOf(env, dropId)).toMatchObject({ reserved: 0, sold: 1 });
  });
});

describe('duplicate order.placed in one batch', () => {
  it('runs the copies one after another: one charge, PAID, no refund', async () => {
    const { KAFKA_BROKERS } = loadEnv([KafkaEnv]);
    const kafka = createKafka({ brokers: KAFKA_BROKERS, clientId: 'race-matrix-test', logLevel: 'error' });
    const admin = kafka.admin();
    const suffix = randomUUID();
    const topic = `fdtest.race.orders.${suffix}`;
    const dlqTopic = `fdtest.race.dlq.${suffix}`;
    const groupId = `fdtest.race.payment.${suffix}`;
    await admin.connect();
    await admin.createTopics({
      topics: [
        { topic, numPartitions: 1, replicationFactor: 1 },
        { topic: dlqTopic, numPartitions: 1, replicationFactor: 1 },
      ],
    });
    const publisher = createPublisher({ kafka, logger: env.deps.logger });
    const lag = createGroupLagReader(kafka, { topic, timeoutMs: 10_000 });
    let runner: ConsumerRunner | undefined;
    try {
      const { orderId, event } = await placed();
      const recordOf = (e: OrderEvent) => ({
        topic,
        key: e.productId,
        value: JSON.stringify(e),
        headers: { 'event-id': e.eventId, 'event-type': e.type },
      });
      // Everything is in the log before the group exists. A new member's first two fetches take one message
      // each (client 1.10.1 sizes its cache from 1, by the consumption rate it measured one fetch earlier),
      // so two fillers the payment group ignores go first, and the copies come out of the third fetch
      // together, as one batch. Checked: with grouping by offset instead of order, this test fails.
      const filler = recordOf(await eventOf(env, orderId, 'order.reserved'));
      await publisher.publish([filler, filler, recordOf(event), recordOf(event)]);
      // A slow charge: a copy run alongside the first would read PENDING_PAYMENT and charge again.
      psp.beforeCharge(() => sleep(300));
      runner = await startConsumer(
        'payment',
        { ...env.deps, psp: createPspClient({ baseUrl: psp.url, apiKey: FAKE_PSP_API_KEY }) },
        { kafka, dlq: publisher, topic, dlqTopic, groupId },
      );

      await vi.waitFor(
        async () => expect(await getOrder(env.db, orderId)).toMatchObject({ status: 'PAID' }),
        { timeout: 30_000, interval: 100 },
      );
      await vi.waitFor(
        async () => {
          const [partition] = await lag.read(groupId);
          expect(partition?.committed).toBe('4');
        },
        { timeout: 30_000, interval: 100 },
      );
      // The test only discriminates if both copies (offsets 2 and 3) came in one batch: a copy in a later
      // batch would read PAID and charge nothing whatever the grouping.
      const batches = env.logs.filter((line) => line.msg === 'batch received' && line.groupId === groupId);
      expect(
        batches.some((line) => Number(line.firstOffset) <= 2 && Number(line.lastOffset) >= 3),
        JSON.stringify(batches.map(({ firstOffset, lastOffset }) => [firstOffset, lastOffset])),
      ).toBe(true);
      expect(psp.attempts(orderId)).toBe(1);
      expect(psp.charges(orderId)).toEqual([expect.objectContaining({ status: 'succeeded' })]);
      expect(psp.isClosed(orderId)).toBe(false);
      expect(await paymentRow(orderId)).toMatchObject({ status: 'SUCCEEDED' });
      expect(await eventTypesOf(env, orderId)).toEqual(['order.reserved', 'order.placed', 'order.paid']);
    } finally {
      psp.beforeCharge(undefined);
      await runner?.stop();
      await publisher.close();
      await lag.close();
      await admin.deleteGroups([groupId]).catch(() => undefined);
      await admin.deleteTopics({ topics: [topic, dlqTopic] }).catch(() => undefined);
      await admin.disconnect();
    }
  });
});

describe('orphan tombstone vs a late reserve insert (§4.6)', () => {
  /** Lua's half of a reserve, as an api that stalled (or crashed) after Lua leaves it. */
  async function admitted() {
    const dropId = await createDrop(env, { total: 3 });
    await armDrop(env, dropId);
    const [userId = ''] = await createUsers(env.db, 1);
    const idempotencyKey = `key_${randomUUID().replaceAll('-', '')}`;
    const rid = reservationId({ userId, dropId, idempotencyKey });
    const fingerprint = requestFingerprint({ dropId, qty: 1 });
    const hold = await fdReserve(env.redis, { dropId, rid, userId, qty: 1, fingerprint, idempotencyKey });
    if (hold.kind !== 'RESERVED') throw new Error(`fd_reserve answered ${hold.kind}`);
    await ageHold(env, dropId, rid);
    const lateInsert = () =>
      recordReservation(env.db, {
        id: rid,
        userId,
        dropId,
        qty: 1,
        idempotencyKey,
        requestHash: fingerprint,
        gen: hold.gen,
      });
    return { dropId, rid, lateInsert };
  }

  const rsvState = async (dropId: string, rid: string) => {
    const raw = await env.redis.hGet(dropKeys(dropId).rsv, rid);
    return raw === null ? null : (JSON.parse(raw) as { s: string }).s;
  };

  it('the insert lands first: the tombstone inserts nothing, emits no order.rejected, and the hold stays', async () => {
    const { dropId, rid, lateInsert } = await admitted();
    const hook = await holdTestHook(env.pool, 'orphan.unrecorded');
    // The scan has found no order for the expired hold and is about to tombstone it.
    const scanning = createOrphanScan(env.deps)(new AbortController().signal);
    await hook.waitForArrivals();
    expect((await lateInsert()).kind).toBe('created');

    await hook.release();
    await scanning;

    const order = await getOrder(env.db, rid);
    expect(order).toMatchObject({ status: 'RESERVED' });
    expect(await eventTypesOf(env, rid)).toEqual(['order.reserved']);
    // The scan followed the winner: a live order's hold is re-scored to its deadline plus the grace.
    expect(await rsvState(dropId, rid)).toBe('HELD');
    expect(await env.redis.zScore(dropKeys(dropId).exp, rid)).toBe(
      (order?.expiresAt.getTime() ?? 0) + 30_000,
    );
    expect(await readStock(env.redis, dropId)).toMatchObject({ avail: 2, held: 1 });
    expect(await inventoryOf(env, dropId)).toMatchObject({ reserved: 1 });
  });

  it('the tombstone lands first: the late insert replays REJECTED, and the hold is released once', async () => {
    const { dropId, rid, lateInsert } = await admitted();
    const hook = await holdTestHook(env.pool, 'orphan.unrecorded');
    const scanning = createOrphanScan(env.deps)(new AbortController().signal);
    await hook.waitForArrivals();
    await hook.release();
    await scanning;

    expect((await lateInsert()).kind).toBe('replay');

    expect(await getOrder(env.db, rid)).toMatchObject({ status: 'REJECTED', closeReason: 'ORPHANED' });
    expect(await eventTypesOf(env, rid)).toEqual(['order.rejected']);
    expect(await rsvState(dropId, rid)).toBe('RELEASED');
    expect(await readStock(env.redis, dropId)).toMatchObject({ avail: 3, held: 0 });
    expect(await inventoryOf(env, dropId)).toMatchObject({ reserved: 0 });
  });
});

describe('a tombstone written after a rebuild snapshot (§4.7)', () => {
  const breaker = { healthy: () => true, run: <T>(call: () => Promise<T>) => call() };

  /** The api's answer: 'created' or 'replayed', else the code of the refusal it threw. */
  async function answer(service: ReservationService, request: ReserveRequest): Promise<string> {
    try {
      return (await service.reserve(request, env.deps.logger)).replayed ? 'replayed' : 'created';
    } catch (error) {
      if (error instanceof DomainError) return error.code;
      throw error;
    }
  }

  /** Every invariant of the drop holds, the equality ones included (Redis has an entry for every order). */
  async function expectAgreed(dropId: string) {
    const sample = await sampleDrop(env.deps, dropId);
    if (sample === undefined) throw new Error(`no sample of drop ${dropId}`);
    expect(checkDrop(sample)).toEqual([]);
  }

  it('a Postgres refusal: settling it records the rid RELEASED, so a same-key retry replays instead of holding stock', async () => {
    const dropId = await createDrop(env, { total: 2, limit: 2 });
    await armDrop(env, dropId);
    const [ada = '', cy = '', bo = ''] = await createUsers(env.db, 3);
    const adaOrder = await reserve(env, dropId, ada);
    await reserve(env, dropId, cy);
    // Redis optimistic by one unit: Lua admits Bo, and Postgres refuses him SOLD_OUT.
    await env.redis.hIncrBy(dropKeys(dropId).inv, 'avail', 1);
    const idempotencyKey = `key_${randomUUID().replaceAll('-', '')}`;
    const request = { userId: bo, dropId, idempotencyKey, qty: 1, traceId: randomUUID() };
    const rid = reservationId({ userId: bo, dropId, idempotencyKey });

    // Bo's api is slow to write the tombstone...
    const real = createReservePorts({ db: env.db, redis: env.redis, breaker, nudger: env.deps.nudger });
    const atTombstone = Promise.withResolvers<void>();
    const tombstoneGate = Promise.withResolvers<void>();
    const slow: ReservePorts = {
      ...real,
      async tombstone(tombstone) {
        atTombstone.resolve();
        await tombstoneGate.promise;
        return real.tombstone(tombstone);
      },
    };
    const first = answer(
      createReservationService(slow, () => new Date()),
      request,
    );
    await atTombstone.promise;
    // ...while the refusal rebuild fences, snapshots (no order for Bo yet) and drops his hold with rsv.
    await armDrop(env, dropId);
    expect((await readDropState(env.redis, dropId)).entries.has(rid)).toBe(false);
    tombstoneGate.resolve();
    expect(await first).toBe('SOLD_OUT');
    expect(await getOrder(env.db, rid)).toMatchObject({ status: 'REJECTED', closeReason: 'SOLD_OUT' });

    // Redis holds none of the order's units: the settlement moves no stock and records the rid RELEASED.
    const rebuilt = await readStock(env.redis, dropId);
    expect(await settleRedis(env.deps, rid)).toEqual({ kind: 'SETTLED', via: 'MISSING' });
    expect((await readDropState(env.redis, dropId)).entries.get(rid)).toMatchObject({
      u: bo,
      q: 1,
      s: 'RELEASED',
      k: idempotencyKey,
    });
    // No stock counter moves; seq does, as on every write.
    expect(await readStock(env.redis, dropId)).toEqual(rebuilt && { ...rebuilt, seq: rebuilt.seq + 1 });
    expect(rebuilt).not.toBeNull();
    await expectAgreed(dropId);

    // A unit comes back, then Bo's client retries the answer it lost: a replay of the refusal, no hold.
    expect(await cancelOrder(env.db, { orderId: adaOrder, userId: ada })).toMatchObject({
      kind: 'cancelled',
    });
    expect(await settleRedis(env.deps, adaOrder)).toMatchObject({ kind: 'SETTLED', via: 'OK' });
    const freed = await readStock(env.redis, dropId);
    expect(freed).toMatchObject({ avail: 1, held: 1 });
    expect(await answer(apiReservations(env), request)).toBe('SOLD_OUT');
    expect(await readStock(env.redis, dropId)).toEqual(freed);
    expect(await inventoryOf(env, dropId)).toMatchObject({ reserved: 1, sold: 0 });
    await expectAgreed(dropId);
  });

  it("orphan-scan's tombstone: the rid is recorded RELEASED and no exp member is left", async () => {
    const dropId = await createDrop(env, { total: 3 });
    await armDrop(env, dropId);
    const [userId = ''] = await createUsers(env.db, 1);
    const rid = await holdOnly(env, dropId, userId);
    await ageHold(env, dropId, rid);
    const hook = await holdTestHook(env.pool, 'orphan.unrecorded');
    // The scan found no order for the expired hold and read its entry; it is about to tombstone it...
    const scanning = createOrphanScan(env.deps)(new AbortController().signal);
    await hook.waitForArrivals();
    // ...while a rebuild drops the hold: Postgres has no order for it.
    await armDrop(env, dropId);
    expect((await readDropState(env.redis, dropId)).entries.has(rid)).toBe(false);
    await hook.release();
    await scanning;

    expect(await getOrder(env.db, rid)).toMatchObject({ status: 'REJECTED', closeReason: 'ORPHANED' });
    expect(await eventTypesOf(env, rid)).toEqual(['order.rejected']);
    const state = await readDropState(env.redis, dropId);
    expect(state.entries.get(rid)).toMatchObject({ u: userId, q: 1, s: 'RELEASED' });
    expect(state.expiries.has(rid)).toBe(false);
    expect(state.inv).toMatchObject({ avail: 3, held: 0, sold: 0 });
    await expectAgreed(dropId);
  });
});

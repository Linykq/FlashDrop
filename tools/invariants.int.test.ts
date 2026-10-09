import { randomUUID } from 'node:crypto';
import { createLogger, KafkaEnv, loadEnv, RedisEnv } from '@flashdrop/config';
import type { OrderEvent, PaymentMethod } from '@flashdrop/contracts';
import {
  applyDropAction,
  createDb,
  createPool,
  createTestBuyers,
  createTestDrop,
  type Db,
  eq,
  markPaid,
  markPaymentFailed,
  POOL_PROFILES,
  parseRows,
  projectSalesEvents,
  pspCharges,
  recordRefund,
  recordReservation,
  relayOutboxBatch,
  sql,
  submitCheckout,
  sweeperQuarantine,
  transaction,
} from '@flashdrop/db';
import { createTestDatabase, type TestDatabase } from '@flashdrop/db/testing';
import { pspChargeKey } from '@flashdrop/domain';
import { requestFingerprint, reservationId } from '@flashdrop/domain/identity';
import {
  connectCommandClient,
  createSyncNudger,
  DROP_LOCK_POOL_PROFILE,
  dropKeys,
  type FlashdropRedis,
  fdReserve,
  readDropState,
  settleRedis,
  syncDropFromPostgres,
} from '@flashdrop/inventory';
import {
  createConsumerRunner,
  createGroupLagReader,
  createKafka,
  createPublisher,
  type OrderEventHandlers,
  outboxRecord,
} from '@flashdrop/messaging';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { z } from 'zod';
import { createEventsProbe, SAMPLE_TIMEOUT_MS } from './event-samples';
import { type InvariantsReport, verifyInvariants } from './invariant-samples';

/*
 * `verify:invariants` against Compose Postgres, Redis and Kafka: a consistent drop passes, and every kind of
 * breach the checker exists for is caught. Each test arms its own drop the way the admin route does, in a
 * throwaway database of this file: the running stack's worker schedules, reconciles and sweeps every armed
 * drop of the development database, and would repair a breach before the checker saw it. The PSP ledger is
 * written directly, as payment-mock would. The event pipeline is checked on a throwaway topic and group,
 * never on `orders.v1`, whose groups belong to the running stack. afterAll deletes the drops' Redis keys and
 * the database.
 */

const quiet = { info: () => undefined, warn: () => undefined };
let database: TestDatabase;
let pool: ReturnType<typeof createPool>;
let lockPool: ReturnType<typeof createPool>;
let db: Db;
let redis: FlashdropRedis;
const created: string[] = [];

beforeAll(async () => {
  database = await createTestDatabase();
  pool = createPool({ connectionString: database.url, logger: quiet, ...POOL_PROFILES.api, max: 4 });
  lockPool = createPool({ connectionString: database.url, logger: quiet, ...DROP_LOCK_POOL_PROFILE, max: 2 });
  db = createDb(pool);
  // The tests' own Redis (vitest.config.ts), so this tree's library replaces any other copy of its version.
  redis = await connectCommandClient({
    url: loadEnv([RedisEnv]).REDIS_URL,
    name: 'verify-invariants-test',
    logger: quiet,
    library: { replaceSameVersion: true },
  });
});

afterAll(async () => {
  for (const dropId of created) {
    const k = dropKeys(dropId);
    await redis.del([k.inv, k.rsv, k.uq, k.exp]);
  }
  redis.destroy();
  await Promise.all([pool.end(), lockPool.end()]);
  await database.drop();
});

const sync = (dropId: string) =>
  syncDropFromPostgres({ db, redis, logger: quiet, lock: { pool: lockPool, logger: quiet } }, dropId);

async function armedDrop(stock = 10): Promise<string> {
  const { dropId } = await createTestDrop(db, {
    stock,
    perUserLimit: 2,
    holdSeconds: 120,
    paymentSeconds: 300,
    durationSeconds: 3_600,
    priceCents: 1_999,
  });
  created.push(dropId);
  await applyDropAction(db, dropId, 'arm');
  expect((await sync(dropId)).kind).toBe('REBUILT');
  return dropId;
}

/** The reserve path of §5.2 without the HTTP layer: Lua admits, then Postgres records the hold. */
async function reserve(dropId: string, userId: string, qty = 1, record = true): Promise<string> {
  const idempotencyKey = randomUUID();
  const rid = reservationId({ userId, dropId, idempotencyKey });
  const fingerprint = requestFingerprint({ dropId, qty });
  const admitted = await fdReserve(redis, { dropId, rid, userId, qty, fingerprint, idempotencyKey });
  if (admitted.kind !== 'RESERVED') throw new Error(`fd_reserve answered ${admitted.kind}`);
  if (record) {
    const recorded = await recordReservation(db, {
      id: rid,
      userId,
      dropId,
      qty,
      idempotencyKey,
      requestHash: fingerprint,
      gen: admitted.gen,
    });
    expect(recorded.kind).toBe('created');
  }
  return rid;
}

const LiveOrder = z.object({ user_id: z.string(), drop_id: z.string(), qty: z.int() });

/** What the sweeper does to one due order, in lock order: the order, its quota, the inventory last. */
async function expireOrder(rid: string): Promise<void> {
  await transaction(db, async (tx) => {
    const { rows } = await tx.execute(sql`
      UPDATE orders SET status = 'EXPIRED', close_reason = 'TIMEOUT', closed_at = now(),
                        version = version + 1, updated_at = now()
      WHERE id = ${rid} AND status IN ('RESERVED', 'PENDING_PAYMENT') RETURNING user_id, drop_id, qty`);
    for (const order of parseRows(LiveOrder, rows, 'expireOrder')) {
      await tx.execute(sql`
        UPDATE user_drop_quota SET claimed = claimed - ${order.qty}
        WHERE user_id = ${order.user_id} AND drop_id = ${order.drop_id}`);
      await tx.execute(sql`
        UPDATE drop_inventory SET reserved = reserved - ${order.qty}, updated_at = now()
        WHERE drop_id = ${order.drop_id}`);
    }
  });
}

const settle = (rid: string) =>
  settleRedis({ db, redis, nudger: createSyncNudger({ db, logger: quiet }) }, rid);

/** A reserve and a checkout submit: an order in PENDING_PAYMENT, as the payment consumer finds it. */
async function place(
  dropId: string,
  userId: string,
  paymentMethod: PaymentMethod = 'pm_ok',
): Promise<string> {
  const orderId = await reserve(dropId, userId);
  const submitted = await submitCheckout(db, {
    orderId,
    userId,
    checkoutKey: randomUUID(),
    shipping: {
      name: 'Ada Buyer',
      line1: '1 Market Street',
      city: 'San Francisco',
      postalCode: '94105',
      country: 'US',
    },
    paymentMethod,
  });
  expect(submitted.kind).toBe('submitted');
  return orderId;
}

/** A charge in the PSP's book for the order's reference, as payment-mock records it (§6.5). */
async function charge(
  orderId: string,
  status: 'succeeded' | 'declined',
  key = pspChargeKey(orderId),
): Promise<string> {
  const id = `ch_${randomUUID().replaceAll('-', '')}`;
  await db.insert(pspCharges).values({
    id,
    idempotencyKey: key,
    reference: orderId,
    amountCents: 1_999,
    method: status === 'succeeded' ? 'pm_ok' : 'pm_decline',
    status,
  });
  return id;
}

/** What payment-mock's close does to a reference's succeeded charges. */
async function refund(chargeId: string): Promise<void> {
  await db
    .update(pspCharges)
    .set({ status: 'refunded', refundedAt: new Date() })
    .where(eq(pspCharges.id, chargeId));
}

const verify = (dropId: string, timeoutMs = 0) =>
  verifyInvariants({ db, redis }, { dropIds: [dropId], timeoutMs });

function failing(report: InvariantsReport): string[] {
  return report.invariants.filter((result) => result.status === 'fail').map((result) => result.id);
}

function messages(report: InvariantsReport): string[] {
  return report.invariants.flatMap((result) => result.violations.map((v) => `${v.invariant} ${v.message}`));
}

describe('verify:invariants', () => {
  it('passes on a consistent drop with live holds, and writes nothing', async () => {
    const dropId = await armedDrop(10);
    const [a, b, c] = await createTestBuyers(db, 3);
    if (a === undefined || b === undefined || c === undefined) throw new Error('createTestBuyers');
    await reserve(dropId, a.id);
    await reserve(dropId, a.id);
    await reserve(dropId, b.id, 2);
    const expired = await reserve(dropId, c.id);
    await expireOrder(expired);
    await settle(expired);
    const before = await readDropState(redis, dropId);

    const report = await verify(dropId);

    expect(messages(report)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.quiescence.reached).toBe(true);
    expect(report.invariants.find((result) => result.id === 'INV-4')?.status).toBe('pass');
    // No event probe given: INV-5 is skipped, never reported as passed.
    expect(report.invariants.find((result) => result.id === 'INV-5')?.status).toBe('skipped');
    expect(report.events).toBeNull();
    expect(report.drops[0]).toMatchObject({
      idle: true,
      postgres: { total: 10, available: 6, reserved: 4, sold: 0, orders: { RESERVED: 3, EXPIRED: 1 } },
      redis: { avail: 6, held: 4, sold: 0 },
    });
    expect(await readDropState(redis, dropId)).toEqual(before);
  });

  it('waits for a terminal order to be settled, and fails when it never is', async () => {
    const dropId = await armedDrop();
    const [buyer] = await createTestBuyers(db, 1);
    if (buyer === undefined) throw new Error('createTestBuyers');
    const rid = await reserve(dropId, buyer.id);
    await expireOrder(rid);

    const stuck = await verify(dropId);
    expect(stuck.ok).toBe(false);
    expect(stuck.quiescence.reached).toBe(false);
    expect(messages(stuck)).toEqual(['INV-6 not quiescent: 1 terminal orders not yet applied to Redis']);
    expect(stuck.quiescence.checks.find((check) => check.status === 'fail')?.name).toBe(
      'Every terminal order applied to Redis',
    );

    const settling = new Promise((resolve) => setTimeout(resolve, 300)).then(() => settle(rid));
    const report = await verify(dropId, 10_000);
    await settling;
    expect(messages(report)).toEqual([]);
    expect(report.quiescence.reached).toBe(true);
    expect(report.quiescence.waitedMs).toBeGreaterThan(0);
  });

  it('catches an optimistic Redis and passes again after a rebuild', async () => {
    const dropId = await armedDrop(10);
    const [buyer] = await createTestBuyers(db, 1);
    if (buyer === undefined) throw new Error('createTestBuyers');
    await reserve(dropId, buyer.id);
    await redis.hIncrBy(dropKeys(dropId).inv, 'avail', 3);

    const report = await verify(dropId);
    expect(failing(report)).toEqual(['INV-6', 'INV-7', 'INV-9']);
    expect(messages(report)).toContain('INV-7 Redis avail 12 > Postgres available 9');

    expect((await sync(dropId)).kind).toBe('REBUILT');
    expect(messages(await verify(dropId))).toEqual([]);
  });

  it('catches Postgres counters that disagree with the orders', async () => {
    const dropId = await armedDrop(10);
    const [buyer] = await createTestBuyers(db, 1);
    if (buyer === undefined) throw new Error('createTestBuyers');
    await reserve(dropId, buyer.id);
    await db.execute(sql`UPDATE drop_inventory SET reserved = reserved + 1 WHERE drop_id = ${dropId}`);
    await db.execute(sql`UPDATE user_drop_quota SET claimed = claimed + 1 WHERE drop_id = ${dropId}`);

    const report = await verify(dropId);
    expect(failing(report)).toEqual(['INV-2', 'INV-3', 'INV-6', 'INV-7']);
    expect(messages(report)).toEqual(
      expect.arrayContaining([
        'INV-2 reserved 2 != 1 RESERVED/PENDING_PAYMENT units',
        `INV-3 user ${buyer.id}: claimed 2 != 1 held or bought units`,
        `INV-6 Redis uq[${buyer.id}] 1 != claimed 2`,
        'INV-7 Redis held 1 < Postgres reserved 2',
      ]),
    );

    await db.execute(sql`UPDATE drop_inventory SET reserved = reserved - 1 WHERE drop_id = ${dropId}`);
    await db.execute(sql`UPDATE user_drop_quota SET claimed = claimed - 1 WHERE drop_id = ${dropId}`);
  });

  it('catches an rsv entry that contradicts its order', async () => {
    const dropId = await armedDrop(10);
    const [buyer] = await createTestBuyers(db, 1);
    if (buyer === undefined) throw new Error('createTestBuyers');
    const rid = await reserve(dropId, buyer.id);
    const k = dropKeys(dropId);
    const entry = z.record(z.string(), z.unknown()).parse(JSON.parse((await redis.hGet(k.rsv, rid)) ?? '{}'));
    // A confirm that ran before Postgres committed PAID: conservation still holds, the ordering rule does not.
    await redis
      .multi()
      .hSet(k.rsv, rid, JSON.stringify({ ...entry, s: 'COMMITTED' }))
      .hIncrBy(k.inv, 'held', -1)
      .hIncrBy(k.inv, 'sold', 1)
      .zRem(k.exp, rid)
      .exec();

    const report = await verify(dropId);
    expect(failing(report)).toEqual(['INV-6', 'INV-7', 'INV-8']);
    expect(messages(report)).toContain('INV-8 Redis COMMITTED, order RESERVED');
  });

  it('waits for a missing Redis state, an orphan hold and reports quarantined orders', async () => {
    const dropId = await armedDrop(10);
    const [a, b] = await createTestBuyers(db, 2);
    if (a === undefined || b === undefined) throw new Error('createTestBuyers');
    await reserve(dropId, a.id, 1, false);
    const quarantined = await reserve(dropId, b.id);
    await db.insert(sweeperQuarantine).values({ loop: 'expire-orders', orderId: quarantined, error: 'test' });

    const orphaned = await verify(dropId);
    expect(messages(orphaned)).toEqual([
      'INV-6 order RESERVED, quarantined by expire-orders',
      'INV-6 not quiescent: 1 Redis holds without an order',
    ]);

    await redis.del(dropKeys(dropId).inv);
    const missing = await verify(dropId);
    expect(messages(missing)).toContain('INV-6 not quiescent: no Redis state');
    expect(missing.drops[0]?.redis).toBeNull();
  });

  it('checks the money of every order against the PSP ledger (INV-4)', async () => {
    const dropId = await armedDrop(10);
    const [a, b, c] = await createTestBuyers(db, 3);
    if (a === undefined || b === undefined || c === undefined) throw new Error('createTestBuyers');
    // Paid: the charge succeeded, then the PAID CAS won.
    const paid = await place(dropId, a.id);
    const paidCharge = await charge(paid, 'succeeded');
    expect((await markPaid(db, { orderId: paid, pspChargeId: paidCharge })).kind).toBe('won');
    await settle(paid);
    // Declined: the PSP took nothing.
    const declined = await place(dropId, b.id, 'pm_decline');
    const declinedCharge = await charge(declined, 'declined');
    const failed = await markPaymentFailed(db, {
      orderId: declined,
      declineCode: 'card_declined',
      pspChargeId: declinedCharge,
    });
    expect(failed.kind).toBe('won');
    await settle(declined);
    // A charge that raced the expiry: the sweeper's CAS won, the PSP still captured.
    const late = await place(dropId, c.id);
    await expireOrder(late);
    await settle(late);
    const lateCharge = await charge(late, 'succeeded');

    const inFlight = await verify(dropId);
    expect(messages(inFlight)).toEqual([
      'INV-4 not quiescent: 1 orders that ended unpaid hold a captured charge',
    ]);
    expect(
      inFlight.quiescence.checks.filter((check) => check.status === 'fail').map((check) => check.name),
    ).toEqual(['No unpaid order holding money, every refund recorded']);

    // The payment consumer closes the reference, which refunds the charge, and records the refund.
    await refund(lateCharge);
    expect(messages(await verify(dropId))).toEqual([
      'INV-4 not quiescent: 1 refunds not yet recorded as REFUNDED payments',
    ]);
    expect(await recordRefund(db, { orderId: late, pspChargeId: lateCharge, amountCents: 1_999 })).toBe(true);
    const settled = await verify(dropId);
    expect(messages(settled)).toEqual([]);
    expect(settled.drops[0]).toMatchObject({
      postgres: { sold: 1, orders: { PAID: 1, PAYMENT_FAILED: 1, EXPIRED: 1 } },
      ledger: {
        charges: { succeeded: 1, declined: 1, refunded: 1 },
        capturedCents: 1_999,
        refundedCents: 1_999,
      },
    });

    // A second capture of the paid order under another key: a double charge.
    await charge(paid, 'succeeded', `charge:again:${paid}`);
    const doubled = await verify(dropId);
    expect(failing(doubled)).toEqual(['INV-4']);
    expect(messages(doubled)).toEqual([
      'INV-4 2 succeeded charges for one reference',
      'INV-4 PSP net captured 3998 for a PAID order of 1999',
    ]);
  });
});

/**
 * A throwaway topic, dead-letter topic and group on the Compose broker, a relay that empties the outbox into
 * the topic instead of orders.v1, and a runner for the group. Everything is removed when the test finishes.
 */
async function testPipeline() {
  const kafka = createKafka({
    brokers: loadEnv([KafkaEnv]).KAFKA_BROKERS,
    clientId: 'verify-invariants-test',
    logLevel: 'error',
  });
  const logger = createLogger({ name: 'verify-invariants-test', level: 'silent' });
  const admin = kafka.admin();
  await admin.connect();
  onTestFinished(() => admin.disconnect());
  const topic = `fdtest.verify.${randomUUID()}`;
  const dlqTopic = `fdtest.verify-dlq.${randomUUID()}`;
  const groupId = `fdtest.verify.${randomUUID()}`;
  await admin.createTopics({
    topics: [
      { topic, numPartitions: 2, replicationFactor: 1 },
      { topic: dlqTopic, numPartitions: 1, replicationFactor: 1 },
    ],
  });
  onTestFinished(async () => {
    await admin.deleteGroups([groupId]).catch(() => undefined);
    await admin.deleteTopics({ topics: [topic, dlqTopic] });
  });
  const publisher = createPublisher({ kafka, logger });
  onTestFinished(() => publisher.close());
  const lag = createGroupLagReader(kafka, { topic, timeoutMs: SAMPLE_TIMEOUT_MS });
  onTestFinished(() => lag.close());

  /** The relay's batches, sent to the test topic; returns how many events it published. */
  async function relayAll(): Promise<number> {
    let relayed = 0;
    for (;;) {
      const batch = await relayOutboxBatch(db, (rows) =>
        publisher.publish(rows.map((row) => ({ ...outboxRecord(row), topic }))),
      );
      if (batch.kind !== 'published') throw new Error('another relay holds the lock of a throwaway database');
      if (batch.messages.length === 0) return relayed;
      relayed += batch.messages.length;
    }
  }

  async function startGroup(name: string, handlers: OrderEventHandlers): Promise<void> {
    const runner = createConsumerRunner({
      kafka,
      name,
      groupId,
      topic,
      dlqTopic,
      handlers,
      dlq: publisher,
      logger,
      concurrency: 4,
    });
    onTestFinished(() => runner.stop());
    await runner.start();
  }

  return { admin, lag, topic, dlqTopic, groupId, publisher, relayAll, startGroup };
}

describe('verify:invariants on the event pipeline', () => {
  it('waits for the relay and every checked consumer group (INV-5)', async () => {
    const { admin, lag, topic, dlqTopic, groupId, publisher, relayAll, startGroup } = await testPipeline();
    const events = createEventsProbe({
      db,
      admin,
      lag,
      topic,
      dlqTopic,
      groups: [{ name: 'test', groupId }],
    });
    const verifyAll = (dropId: string, timeoutMs = 0, maxDeadLetters?: number) =>
      verifyInvariants({ db, redis, events }, { dropIds: [dropId], timeoutMs, maxDeadLetters });

    const dropId = await armedDrop(10);
    const [buyer] = await createTestBuyers(db, 1);
    if (buyer === undefined) throw new Error('createTestBuyers');
    await reserve(dropId, buyer.id);

    // Its `order.reserved` row, and every earlier test's events, wait for a relay.
    const unrelayed = await verifyAll(dropId);
    expect(failing(unrelayed)).toEqual(['INV-5']);
    expect(messages(unrelayed)).toEqual([
      expect.stringMatching(/^INV-5 not quiescent: \d+ outbox rows not yet published, the oldest for /),
    ]);

    const relayed = await relayAll();
    expect(relayed).toBeGreaterThan(0);
    const unconsumed = await verifyAll(dropId);
    expect(messages(unconsumed)).toEqual([
      expect.stringMatching(
        new RegExp(
          `^INV-5 not quiescent: test \\(group ${groupId}\\): ${relayed} events not yet processed on partitions .+; ` +
            'no commits there yet: is the test role running\\?$',
        ),
      ),
    ]);

    // A group that finishes every event (it acts on none of them).
    await startGroup('test', {});
    const report = await verifyAll(dropId, 30_000);
    expect(messages(report)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.quiescence.reached).toBe(true);
    expect(report.invariants.find((result) => result.id === 'INV-5')?.status).toBe('pass');
    expect(report.events).toMatchObject({
      outbox: { pending: 0 },
      groups: [{ name: 'test', groupId, lag: 0, partitions: 2 }],
      deadLetters: 0,
      maxDeadLetters: null,
    });
    // Without the dashboard role's group among those checked, its projection is not compared.
    expect(report.drops[0]?.dashboard).toBeNull();

    // A dead letter leaves every group at lag 0 (the runner commits past it), so only the DLQ shows it:
    // reported without a ceiling, a breach of INV-5 above one (`--max-dead-letters`, CI's jobs).
    await publisher.publish([
      { topic: dlqTopic, key: null, value: '{}', headers: { 'x-consumer': 'test', 'x-error': 'poison' } },
    ]);
    const reported = await verifyAll(dropId, 30_000);
    expect(reported.ok).toBe(true);
    expect(reported.events).toMatchObject({ deadLetters: 1, maxDeadLetters: null });
    const gated = await verifyAll(dropId, 30_000, 0);
    expect(gated.ok).toBe(false);
    expect(failing(gated)).toEqual(['INV-5']);
    expect(messages(gated)).toEqual(['INV-5 1 dead letter in the DLQ topic, at most 0 allowed']);
    expect(gated.quiescence.reached).toBe(true);
    expect((await verifyAll(dropId, 30_000, 1)).ok).toBe(true);
  });

  it('holds each drop’s dashboard to its orders once the group that writes it caught up (INV-5, §9)', async () => {
    const { admin, lag, topic, dlqTopic, groupId, relayAll, startGroup } = await testPipeline();
    const events = createEventsProbe({
      db,
      admin,
      lag,
      topic,
      dlqTopic,
      groups: [{ name: 'dashboard', groupId }],
    });
    const verifyAll = (dropId: string) =>
      verifyInvariants({ db, redis, events }, { dropIds: [dropId], timeoutMs: 30_000 });
    const dropId = await armedDrop(10);
    const [buyer] = await createTestBuyers(db, 1);
    if (buyer === undefined) throw new Error('createTestBuyers');
    await reserve(dropId, buyer.id, 2);
    await relayAll();
    // The sales-dashboard group's effect, one event per transaction (the worker's consumer group-commits).
    const project = async (event: OrderEvent) => {
      await projectSalesEvents(db, [event]);
    };
    await startGroup('dashboard', {
      'order.reserved': project,
      'order.placed': project,
      'order.paid': project,
      'order.payment_failed': project,
      'order.expired': project,
      'order.cancelled': project,
      'order.rejected': project,
    });

    const report = await verifyAll(dropId);
    expect(messages(report)).toEqual([]);
    expect(report.drops[0]?.dashboard).toMatchObject({ totals: { reserved: 1, placed: 0 }, eventless: 0 });

    // The projection lost an event: INV-5 names the counter, and the minutes no longer add up either.
    await db.execute(sql`UPDATE drop_sales_totals SET reserved = 0 WHERE drop_id = ${dropId}`);
    expect(messages(await verifyAll(dropId))).toEqual([
      'INV-5 dashboard reserved 0 != 1 from its orders',
      'INV-5 dashboard minutes add up to reserved 1, its totals say 0',
    ]);
  });
});

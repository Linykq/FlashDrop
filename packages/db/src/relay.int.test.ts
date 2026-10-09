import { randomUUID } from 'node:crypto';
import { OrderEvent } from '@flashdrop/contracts';
import { inArray, sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client';
import { isTransientDbError } from './errors';
import { insertOutboxEvents, orderEvent } from './outbox';
import { createPool, POOL_PROFILES } from './pool';
import { deleteExpiredProcessedEvents, insertProcessedEvents, uuidv7Floor } from './processed-events';
import { deletePublishedOutbox, type OutboxMessage, outboxBacklog, relayOutboxBatch } from './relay';
import { outbox, processedEvents } from './schema';
import { createTestDatabase, type TestDatabase, waitForLockWaiters } from './test-database';
import { gate, reached } from './test-fixtures';
import { transaction } from './transaction';

/*
 * The outbox relay's statements (design §5.4) and consumer dedupe (§6.4) against real Postgres 17. The
 * relay claims every pending row of the database, so each test starts and ends with nothing pending.
 */

let test: TestDatabase;
/** Two relay-profile pools: two relay processes. */
let relayPool: pg.Pool;
let standbyPool: pg.Pool;
let relay: Db;
let standby: Db;
let db: Db;

const RELAY_APP = 'relay-under-test';

beforeAll(async () => {
  test = await createTestDatabase();
  const quiet = { warn: () => undefined };
  relayPool = createPool({
    connectionString: test.url,
    logger: quiet,
    ...POOL_PROFILES.relay,
    applicationName: RELAY_APP,
  });
  standbyPool = createPool({ connectionString: test.url, logger: quiet, ...POOL_PROFILES.relay });
  relay = createDb(relayPool);
  standby = createDb(standbyPool);
  db = test.db;
});

afterAll(async () => {
  await relayPool?.end();
  await standbyPool?.end();
  await test?.drop();
});

/** Commits `n` order.rejected events (any event type will do for the relay) and returns their event ids. */
async function commitEvents(n: number, options: { traceId?: string } = {}): Promise<string[]> {
  const productId = randomUUID();
  const events = Array.from({ length: n }, () =>
    orderEvent(
      'order.rejected',
      { id: randomUUID(), version: 1, productId, dropId: randomUUID(), userId: randomUUID() },
      { qty: 1, reason: 'SOLD_OUT' },
      { occurredAt: new Date(), traceId: options.traceId },
    ),
  );
  await transaction(db, (tx) => insertOutboxEvents(tx, events));
  return events.map((event) => event.eventId);
}

/** Publishes everything pending, batch by batch, and returns what was sent. */
async function drain(on: Db = relay): Promise<OutboxMessage[]> {
  const sent: OutboxMessage[] = [];
  for (;;) {
    const batch = await relayOutboxBatch(on, async (messages) => {
      sent.push(...messages);
    });
    if (batch.kind === 'busy') throw new Error('unexpectedly busy');
    if (batch.messages.length === 0) return sent;
  }
}

describe('relayOutboxBatch', () => {
  it('publishes pending rows oldest first as Kafka-ready messages, then marks them', async () => {
    const eventIds = await commitEvents(3, { traceId: 'trace-relay' });

    const sent = await drain();

    expect(sent.map((m) => m.eventId)).toEqual(eventIds);
    expect(sent.map((m) => BigInt(m.id))).toEqual(
      [...sent.map((m) => BigInt(m.id))].sort((a, b) => (a < b ? -1 : 1)),
    );
    const [first] = sent;
    expect(first).toMatchObject({
      topic: 'orders.v1',
      eventType: 'order.rejected',
      headers: { 'trace-id': 'trace-relay' },
    });
    const event = OrderEvent.parse(first?.payload);
    expect(first?.partitionKey).toBe(event.productId);
    expect(await outboxBacklog(db)).toEqual({ pending: 0, oldestSeconds: null });
    const rows = await db.select().from(outbox).where(inArray(outbox.eventId, eventIds));
    expect(rows.every((row) => row.publishedAt instanceof Date)).toBe(true);
  });

  it('takes at most `limit` rows per batch', async () => {
    await commitEvents(7);
    const sizes: number[] = [];
    for (;;) {
      const batch = await relayOutboxBatch(relay, async () => undefined, { limit: 3 });
      if (batch.kind === 'busy') throw new Error('unexpectedly busy');
      sizes.push(batch.messages.length);
      if (batch.messages.length === 0) break;
    }
    expect(sizes).toEqual([3, 3, 1, 0]);
  });

  it('rolls back when the send fails: nothing is marked, and the next batch sends the same rows', async () => {
    const eventIds = await commitEvents(2);

    await expect(
      relayOutboxBatch(relay, async () => {
        throw new Error('broker unavailable');
      }),
    ).rejects.toThrow('broker unavailable');

    expect((await outboxBacklog(db)).pending).toBe(2);
    expect((await drain()).map((m) => m.eventId)).toEqual(eventIds);
  });

  it('runs one publisher at a time: a standby is busy while a batch is in flight', async () => {
    const eventIds = await commitEvents(2);
    const sending = gate();
    const acked = gate();

    const first = relayOutboxBatch(relay, async () => {
      sending.open();
      await acked.wait;
    });
    await reached(sending.wait, first);

    expect(await relayOutboxBatch(standby, async () => undefined)).toEqual({ kind: 'busy' });
    acked.open();
    const batch = await first;
    expect(batch.kind === 'published' && batch.messages.map((m) => m.eventId)).toEqual(eventIds);
    expect(await outboxBacklog(db)).toEqual({ pending: 0, oldestSeconds: null });
  });

  it('loses nothing when the relay dies mid-batch: its lock and rows go with its session', async () => {
    const eventIds = await commitEvents(3);
    const sending = gate();
    const acked = gate();

    const doomed = relayOutboxBatch(relay, async () => {
      sending.open();
      await acked.wait;
    });
    await reached(sending.wait, doomed);
    // The batch's connection is idle in its transaction while the send is in flight: end that session.
    const { rows } = await db.execute<{ ended: boolean }>(sql`
      SELECT pg_terminate_backend(pid) AS ended FROM pg_stat_activity
      WHERE datname = current_database() AND application_name = ${RELAY_APP} AND state = 'idle in transaction'`);
    expect(rows).toEqual([{ ended: true }]);
    acked.open();

    const error = await doomed.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isTransientDbError(error)).toBe(true);
    // The standby takes over at its next poll and sends the same rows: consumers dedupe the copies.
    expect((await drain(standby)).map((m) => m.eventId)).toEqual(eventIds);
  });

  it("waits for a row another session locked, so one order's events still go out in id order", async () => {
    const order = {
      id: randomUUID(),
      version: 1,
      productId: randomUUID(),
      dropId: randomUUID(),
      userId: randomUUID(),
    };
    const placed = orderEvent(
      'order.placed',
      { ...order, version: 2 },
      {
        qty: 1,
        totalCents: 100,
        currency: 'USD',
        paymentMethod: 'pm_ok',
        expiresAt: new Date().toISOString(),
      },
      { occurredAt: new Date() },
    );
    const expired = orderEvent(
      'order.expired',
      { ...order, version: 3 },
      { qty: 1, fromStatus: 'PENDING_PAYMENT' },
      { occurredAt: new Date() },
    );
    await transaction(db, (tx) => insertOutboxEvents(tx, [placed]));
    // A probe (or a psql session) locks the order's first event while its second one commits.
    const locked = gate();
    const release = gate();
    const probe = transaction(db, async (tx) => {
      await tx.execute(sql`SELECT id FROM outbox WHERE event_id = ${placed.eventId}::uuid FOR UPDATE`);
      locked.open();
      await release.wait;
    });
    await reached(locked.wait, probe);
    await transaction(db, (tx) => insertOutboxEvents(tx, [expired]));

    const sent = drain();
    // The relay queues on the locked row. With SKIP LOCKED it published order.expired alone, at once.
    await Promise.race([sent, waitForLockWaiters(test.pool, 1, 5_000)]);
    release.open();
    await probe;

    expect((await sent).map((m) => m.eventType)).toEqual(['order.placed', 'order.expired']);
  });

  it('publishes a row that commits after a newer one at the next poll: status polling, not an id cursor', async () => {
    const inserted = gate();
    const commit = gate();
    const productId = randomUUID();
    const late = orderEvent(
      'order.rejected',
      { id: randomUUID(), version: 1, productId, dropId: randomUUID(), userId: randomUUID() },
      { qty: 1, reason: 'LIMIT' },
      { occurredAt: new Date() },
    );
    const slow = transaction(db, async (tx) => {
      await insertOutboxEvents(tx, [late]);
      inserted.open();
      await commit.wait;
    });
    await reached(inserted.wait, slow);
    const [early] = await commitEvents(1);

    // The late row has the lower id but is not committed: the relay cannot see it, and does not wait for it.
    expect((await drain()).map((m) => m.eventId)).toEqual([early]);
    commit.open();
    await slow;
    expect((await drain()).map((m) => m.eventId)).toEqual([late.eventId]);
  });
});

describe('deletePublishedOutbox', () => {
  it('deletes rows published more than 7 days ago in batches, and never an unpublished one', async () => {
    const productId = randomUUID();
    const row = (age: string, published: boolean) => ({
      eventId: randomUUID(),
      topic: 'orders.v1',
      partitionKey: productId,
      eventType: 'order.rejected',
      payload: {},
      createdAt: sql`now() - ${age}::interval`,
      publishedAt: published ? sql`now() - ${age}::interval` : null,
    });
    const old = [row('8 days', true), row('9 days', true), row('30 days', true)];
    const kept = [row('6 days', true), row('20 days', false), row('1 hour', true)];
    await db.insert(outbox).values([...old, ...kept]);

    const deleted = await deletePublishedOutbox(db, { batchSize: 2 });

    expect(deleted).toBe(3);
    const left = await db
      .select({ eventId: outbox.eventId })
      .from(outbox)
      .where(
        inArray(
          outbox.eventId,
          [...old, ...kept].map((r) => r.eventId),
        ),
      );
    expect(left.map((r) => r.eventId).sort()).toEqual(kept.map((r) => r.eventId).sort());
    expect(await deletePublishedOutbox(db)).toBe(0);
    // The unpublished row is the relay's: hand it over so the next test starts with nothing pending.
    await drain();
  });
});

describe('insertProcessedEvents', () => {
  it('returns only the ids this consumer has not processed before, once each', async () => {
    const [a = '', b = '', c = ''] = [randomUUID(), randomUUID(), randomUUID()];
    await transaction(db, (tx) => insertProcessedEvents(tx, 'sales-dashboard', [a, b]));

    const fresh = await transaction(db, (tx) => insertProcessedEvents(tx, 'sales-dashboard', [b, c, c, a]));
    const otherConsumer = await transaction(db, (tx) => insertProcessedEvents(tx, 'another-group', [a]));

    expect([...fresh]).toEqual([c]);
    expect([...otherConsumer]).toEqual([a]);
    expect(await transaction(db, (tx) => insertProcessedEvents(tx, 'sales-dashboard', []))).toEqual(
      new Set(),
    );
  });

  it('records nothing when the effect transaction rolls back, so a redelivery applies it', async () => {
    const id = randomUUID();
    await expect(
      transaction(db, async (tx) => {
        await insertProcessedEvents(tx, 'sales-dashboard', [id]);
        throw new Error('the projection failed');
      }),
    ).rejects.toThrow('the projection failed');

    expect([...(await transaction(db, (tx) => insertProcessedEvents(tx, 'sales-dashboard', [id])))]).toEqual([
      id,
    ]);
  });

  it('lets exactly one of two overlapping batches claim each id, without deadlocking', async () => {
    const ids = Array.from({ length: 50 }, () => randomUUID());
    const reversed = [...ids].reverse();

    const claims = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        transaction(db, (tx) => insertProcessedEvents(tx, 'zombie-test', i % 2 === 0 ? ids : reversed)),
      ),
    );

    const all = claims.flatMap((set) => [...set]);
    expect(all.sort()).toEqual([...ids].sort());
  });
});

describe('deleteExpiredProcessedEvents', () => {
  /** A uuidv7 as `uuidv7()` writes one, made `daysAgo` days ago. */
  const eventIdOf = (daysAgo: number) =>
    `${uuidv7Floor(Date.now() - daysAgo * 86_400_000).slice(0, 14)}7${randomUUID().slice(15)}`;

  it('deletes records whose event and insert are both past 45 days, per consumer, in batches', async () => {
    // This test database belongs to this file, so every consumer row here is the test's.
    const consumers = ['retention-a', 'retention-b'];
    const row = (consumer: string, eventDays: number, processedDays: number) => ({
      consumer,
      eventId: eventIdOf(eventDays),
      processedAt: sql`now() - make_interval(days => ${processedDays})`,
    });
    const old = [row('retention-a', 50, 49), row('retention-a', 46, 46), row('retention-b', 60, 59)];
    const kept = [
      row('retention-a', 44, 44),
      // An old event replayed from the DLQ recently: its record stays a full retention after the insert.
      row('retention-b', 50, 3),
      row('retention-b', 1, 1),
    ];
    await db.insert(processedEvents).values([...old, ...kept]);

    const deleted = await deleteExpiredProcessedEvents(db, { batchSize: 1, consumers });

    expect(deleted).toBe(3);
    const left = await db
      .select({ eventId: processedEvents.eventId })
      .from(processedEvents)
      .where(inArray(processedEvents.consumer, consumers));
    expect(left.map((r) => r.eventId).sort()).toEqual(kept.map((r) => r.eventId).sort());
    expect(await deleteExpiredProcessedEvents(db, { consumers })).toBe(0);
  });

  it('floors a millisecond below every uuidv7 created in it or later', () => {
    const at = Date.parse('2026-10-09T12:00:00.000Z');
    expect(uuidv7Floor(at)).toBe('01a12088-d200-0000-0000-000000000000');
    expect(eventIdOf(0) > uuidv7Floor(Date.now() - 1_000)).toBe(true);
  });
});

import { randomUUID } from 'node:crypto';
import { ORDERS_PARTITIONS, TOPICS } from '@flashdrop/config';
import type { OrderEvent } from '@flashdrop/contracts';
import { type Db, insertProcessedEvents, isNull, outbox, outboxRow, sql, transaction } from '@flashdrop/db';
import { createTestDatabase, type TestDatabase } from '@flashdrop/db/testing';
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { EVENT_HEADERS, headerText } from './headers';
import { partitionForKey } from './partitioner';
import { createPublisher, type Publisher } from './publisher';
import { createRelay, outboxRelayStore, type Relay, type RelayStore } from './relay';
import { createConsumerRunner } from './runner';
import { readToEnd, testAdmin, testGroup, testKafka, testTopic } from './test/kafka';
import { captureLogger, testEvent } from './test/support';

/*
 * The outbox relay against Compose Postgres (a throwaway database per test) and Kafka (throwaway topics),
 * design §5.4 and §13: keyed publishing on Java's partitions, late commits, a crash between send and mark,
 * two relays, and a broker that cannot take the records yet.
 */

const kafka = testKafka('relay-test');
const quiet = captureLogger();
let publisher: Publisher;

beforeAll(() => {
  publisher = createPublisher({ kafka, logger: quiet.logger });
});

afterAll(async () => {
  await publisher.close();
});

const WAIT = { timeout: 30_000, interval: 50 };

async function testDatabase(): Promise<TestDatabase> {
  const database = await createTestDatabase();
  onTestFinished(() => database.drop());
  return database;
}

function startRelay(store: RelayStore, options: { batchSize?: number } = {}) {
  const log = captureLogger();
  const relay: Relay = createRelay({
    store,
    publisher,
    logger: log.logger,
    pollMs: 50,
    backoff: { baseMs: 100, capMs: 500 },
    ...options,
  });
  onTestFinished(() => relay.stop());
  relay.start();
  return { relay, log };
}

async function insertEvents(db: Db, topic: string, events: readonly OrderEvent[]): Promise<void> {
  await db.insert(outbox).values(events.map((event) => ({ ...outboxRow(event), topic })));
}

async function unpublished(db: Db): Promise<number> {
  return db.$count(outbox, isNull(outbox.publishedAt));
}

const traced = (event: OrderEvent): OrderEvent => ({
  ...event,
  traceId: `trace-${event.eventId.slice(0, 8)}`,
});

describe('outbox relay', () => {
  it('publishes rows keyed by productId on murmur2(productId) % 6, with the event headers, in id order', async () => {
    const { db } = await testDatabase();
    const admin = await testAdmin(kafka);
    const topic = await testTopic(admin, 'relay', ORDERS_PARTITIONS);
    const products = Array.from({ length: 12 }, () => randomUUID());
    const events = Array.from({ length: 60 }, (_, i) =>
      traced(testEvent(i % 2 === 0 ? 'order.reserved' : 'order.placed', { productId: products[i % 12] })),
    );
    await insertEvents(db, topic, events);

    startRelay(outboxRelayStore(db));
    await vi.waitFor(async () => expect(await unpublished(db)).toBe(0), WAIT);

    const records = await readToEnd(kafka, admin, topic);
    expect(records).toHaveLength(60);
    const byId = new Map(events.map((event) => [event.eventId, event]));
    for (const record of records) {
      const event = byId.get(headerText(record.headers, EVENT_HEADERS.eventId) ?? '');
      expect(event, 'record of an inserted event').toBeDefined();
      expect(record.key).toBe(event?.productId);
      expect(record.partition).toBe(partitionForKey(record.key ?? '', ORDERS_PARTITIONS));
      expect(JSON.parse(record.value ?? 'null')).toEqual(event);
      expect(headerText(record.headers, EVENT_HEADERS.eventType)).toBe(event?.type);
      expect(headerText(record.headers, EVENT_HEADERS.schemaVersion)).toBe('1');
      expect(headerText(record.headers, EVENT_HEADERS.traceId)).toBe(event?.traceId);
    }
    // Within a partition, records follow the outbox (insertion) order.
    const position = new Map(events.map((event, i) => [event.eventId, i]));
    for (let p = 0; p < ORDERS_PARTITIONS; p++) {
      const order = records
        .filter((record) => record.partition === p)
        .map((record) => position.get(headerText(record.headers, EVENT_HEADERS.eventId) ?? '') ?? -1);
      expect(order).toEqual([...order].sort((a, b) => a - b));
    }
  });

  it('does not skip a row that commits after a later row was published', async () => {
    const { db, pool } = await testDatabase();
    const admin = await testAdmin(kafka);
    const topic = await testTopic(admin, 'relay-late', 1);
    const late = testEvent('order.placed');
    const early = testEvent('order.placed');
    startRelay(outboxRelayStore(db));

    // `late` takes the lower id but commits last: an id cursor would have moved past it.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = outboxRow(late);
      await client.query(
        `INSERT INTO outbox (event_id, topic, partition_key, event_type, payload, headers)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          row.eventId,
          topic,
          row.partitionKey,
          row.eventType,
          JSON.stringify(row.payload),
          JSON.stringify({}),
        ],
      );
      await insertEvents(db, topic, [early]);
      await vi.waitFor(async () => expect((await readToEnd(kafka, admin, topic)).length).toBe(1), WAIT);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    await vi.waitFor(async () => expect(await unpublished(db)).toBe(0), WAIT);
    const records = await readToEnd(kafka, admin, topic);
    expect(records.map((record) => headerText(record.headers, EVENT_HEADERS.eventId))).toEqual([
      early.eventId,
      late.eventId,
    ]);
    const ids = await db.select({ id: outbox.id, eventId: outbox.eventId }).from(outbox).orderBy(outbox.id);
    expect(ids.map((row) => row.eventId)).toEqual([late.eventId, early.eventId]);
  });

  it('republishes a batch after a crash between send and mark, and a deduping consumer ends in the same state', async () => {
    const { db } = await testDatabase();
    const admin = await testAdmin(kafka);
    const topic = await testTopic(admin, 'relay-crash', 3);
    const dlqTopic = await testTopic(admin, 'relay-crash-dlq', 1);
    const events = Array.from({ length: 20 }, () => testEvent('order.paid'));
    await insertEvents(db, topic, events);

    // The process dies after the broker acked the batch and before the mark commits: the transaction
    // rolls back and the rows are still due.
    const store = outboxRelayStore(db);
    let crashes = 1;
    const crashing: RelayStore = {
      ...store,
      publishBatch: (publish, limit) =>
        store.publishBatch(async (messages) => {
          await publish(messages);
          if (crashes-- > 0) throw new Error('Connection terminated unexpectedly');
        }, limit),
    };
    const { log } = startRelay(crashing);
    await vi.waitFor(async () => expect(await unpublished(db)).toBe(0), WAIT);
    expect(log.lines.filter((l) => l.msg === 'relay batch failed; rolled back')).toHaveLength(1);
    const records = await readToEnd(kafka, admin, topic);
    expect(records).toHaveLength(40);

    // The consumers' dedupe (processed_events, in the effect's transaction) applies each event once,
    // however often it arrives.
    const deliveries = new Map<string, number>();
    const effects: string[] = [];
    const consumer = createConsumerRunner({
      kafka,
      name: 'dedupe-test',
      groupId: testGroup(admin, 'relay-crash'),
      topic,
      dlqTopic,
      dlq: publisher,
      logger: quiet.logger,
      concurrency: 8,
      handlers: {
        'order.paid': async (event) => {
          deliveries.set(event.eventId, (deliveries.get(event.eventId) ?? 0) + 1);
          await transaction(db, async (tx) => {
            const fresh = await insertProcessedEvents(tx, 'dedupe-test', [event.eventId]);
            if (fresh.has(event.eventId)) effects.push(event.eventId);
          });
        },
      },
    });
    onTestFinished(() => consumer.stop());
    await consumer.start();

    await vi.waitFor(() => expect([...deliveries.values()].reduce((a, b) => a + b, 0)).toBe(40), WAIT);
    expect([...deliveries.values()].every((count) => count === 2)).toBe(true);
    expect(effects.toSorted()).toEqual(events.map((event) => event.eventId).toSorted());
  });

  it('runs one publisher at a time: two relays publish every row exactly once', async () => {
    const { db } = await testDatabase();
    const admin = await testAdmin(kafka);
    const topic = await testTopic(admin, 'relay-pair', 3);
    const store = outboxRelayStore(db);
    const first = startRelay(store, { batchSize: 7 });
    const second = startRelay(store, { batchSize: 7 });

    const events = Array.from({ length: 300 }, () => testEvent('order.reserved'));
    for (let i = 0; i < events.length; i += 30) {
      await insertEvents(db, topic, events.slice(i, i + 30));
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await vi.waitFor(async () => expect(await unpublished(db)).toBe(0), WAIT);

    const ids = (await readToEnd(kafka, admin, topic)).map((r) =>
      headerText(r.headers, EVENT_HEADERS.eventId),
    );
    expect(ids).toHaveLength(300);
    expect(new Set(ids).size).toBe(300);
    expect(first.relay.health().published + second.relay.health().published).toBe(300);
  });

  it('rolls back and backs off while Kafka cannot take the records, then drains', async () => {
    const { db } = await testDatabase();
    const admin = await testAdmin(kafka);
    // A topic that does not exist yet: every send times out after message.timeout.ms (10 s).
    const topic = `fdtest.relay-later.${randomUUID()}`;
    await insertEvents(db, topic, [testEvent('order.cancelled'), testEvent('order.cancelled')]);
    const { relay, log } = startRelay(outboxRelayStore(db));

    await vi.waitFor(() => expect(relay.health().consecutiveFailures).toBeGreaterThan(0), WAIT);
    expect(await unpublished(db)).toBe(2);
    const failure = log.lines.find((l) => l.msg === 'relay batch failed; rolled back');
    expect(failure?.err).toMatchObject({ type: 'PublishError', kind: 'timeout', transient: true });

    await admin.createTopics({ topics: [{ topic, numPartitions: 1, replicationFactor: 1 }] });
    onTestFinished(() => admin.deleteTopics({ topics: [topic] }));
    await vi.waitFor(async () => expect(await unpublished(db)).toBe(0), WAIT);
    // The relay updates its counters after its commit resolves, so the rows can read published a moment before
    // health() says so.
    await vi.waitFor(
      () => expect(relay.health()).toMatchObject({ healthy: true, consecutiveFailures: 0, published: 2 }),
      WAIT,
    );
  }, 90_000);

  it('cleans up rows published more than the retention ago', async () => {
    const { db } = await testDatabase();
    const admin = await testAdmin(kafka);
    const topic = await testTopic(admin, 'relay-cleanup', 1);
    await insertEvents(db, topic, [
      testEvent('order.paid'),
      testEvent('order.paid'),
      testEvent('order.paid'),
    ]);
    await db.execute(sql`UPDATE outbox SET published_at = now() - interval '8 days'
                         WHERE id = (SELECT min(id) FROM outbox)`);

    startRelay(outboxRelayStore(db));
    await vi.waitFor(async () => expect(await db.$count(outbox)).toBe(2), WAIT);
    await vi.waitFor(async () => expect(await unpublished(db)).toBe(0), WAIT);
  });
});

describe('orders.v1', () => {
  // The `partitioning` check of §13 over whatever the running stack has published so far (read-only: an
  // ephemeral group that commits nothing). Test records never go to orders.v1, whose real groups would
  // consume them.
  it('holds every record on murmur2(productId) % 6, keyed by its productId', async () => {
    const admin = await testAdmin(kafka);
    const records = await readToEnd(kafka, admin, TOPICS.orders);
    for (const record of records) {
      const payload: unknown = JSON.parse(record.value ?? 'null');
      expect(payload).toMatchObject({ productId: record.key });
      expect(record.partition).toBe(partitionForKey(record.key ?? '', ORDERS_PARTITIONS));
    }
  }, 120_000);
});

import type { OutboxMessage, RelayBatch } from '@flashdrop/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OutgoingRecord, Publisher } from './publisher';
import { createRelay, outboxRecord, type Relay, type RelayStore } from './relay';
import { captureLogger, testEvent } from './test/support';

/** An in-memory outbox with the batch's transaction semantics: rows are marked only if publish resolved. */
class FakeOutbox implements RelayStore {
  readonly rows: OutboxMessage[] = [];
  readonly published = new Set<string>();
  otherRelayHoldsLock = false;
  claims = 0;
  cleanups = 0;
  cleanup: () => Promise<number> = async () => 0;

  add(count: number, createdAt = new Date()): OutboxMessage[] {
    const added = Array.from({ length: count }, (_, index) => {
      const id = String(this.rows.length + index + 1);
      const event = testEvent('order.reserved');
      return {
        id,
        eventId: event.eventId,
        topic: 'orders.test',
        partitionKey: event.productId,
        eventType: event.type,
        payload: event,
        headers: { 'trace-id': `trace-${id}` },
        createdAt,
      };
    });
    this.rows.push(...added);
    return added;
  }

  async publishBatch(
    publish: (messages: readonly OutboxMessage[]) => Promise<void>,
    limit: number,
  ): Promise<RelayBatch> {
    if (this.otherRelayHoldsLock) return { kind: 'busy' };
    this.claims++;
    const messages = this.rows.filter((row) => !this.published.has(row.id)).slice(0, limit);
    if (messages.length === 0) return { kind: 'published', messages };
    await publish(messages);
    for (const message of messages) this.published.add(message.id);
    return { kind: 'published', messages };
  }

  deletePublished(): Promise<number> {
    this.cleanups++;
    return this.cleanup();
  }
}

class FakePublisher implements Publisher {
  readonly sent: OutgoingRecord[][] = [];
  failNext = 0;
  /** What `ready()` does: resolve (connected), reject (broker unreachable) or hang (connecting). */
  connect: () => Promise<void> = async () => undefined;

  ready(): Promise<void> {
    return this.connect();
  }

  async publish(records: readonly OutgoingRecord[]): Promise<void> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('broker unavailable');
    }
    this.sent.push([...records]);
  }

  async close(): Promise<void> {}
}

const relays: Relay[] = [];
afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.stop()));
});

function startRelay(
  store: FakeOutbox,
  publisher: FakePublisher,
  options: { pollMs?: number; batchSize?: number } = {},
) {
  const log = captureLogger();
  const relay = createRelay({
    store,
    publisher,
    logger: log.logger,
    pollMs: options.pollMs ?? 10,
    batchSize: options.batchSize ?? 500,
    backoff: { baseMs: 5, capMs: 20 },
    cleanupEveryMs: 20,
  });
  relays.push(relay);
  relay.start();
  return { relay, log };
}

describe('outboxRecord', () => {
  it('keys the record by the partition key and adds the event headers to the row headers', () => {
    const [row] = new FakeOutbox().add(1);
    if (row === undefined) throw new Error('no row');

    expect(outboxRecord(row)).toEqual({
      topic: 'orders.test',
      key: row.partitionKey,
      value: JSON.stringify(row.payload),
      headers: {
        'trace-id': 'trace-1',
        'event-id': row.eventId,
        'event-type': 'order.reserved',
        'schema-version': '1',
      },
    });
  });

  it('leaves the schema version out when the payload has none, rather than refusing the row', () => {
    const [row] = new FakeOutbox().add(1);
    if (row === undefined) throw new Error('no row');
    expect(outboxRecord({ ...row, payload: { foo: 1 } }).headers).not.toHaveProperty('schema-version');
  });
});

describe('createRelay', () => {
  it('publishes due rows in id order and marks them published in the same transaction', async () => {
    const store = new FakeOutbox();
    const publisher = new FakePublisher();
    store.add(3);
    const { relay } = startRelay(store, publisher);

    await vi.waitFor(() => expect(store.published.size).toBe(3));
    store.add(2);
    await vi.waitFor(() => expect(store.published.size).toBe(5));

    const keys = publisher.sent.flat().map((record) => record.headers?.['event-id']);
    expect(keys).toEqual(store.rows.map((row) => row.eventId));
    expect(relay.health()).toMatchObject({ healthy: true, published: 5, consecutiveFailures: 0 });
  });

  it('rolls back on a failed send and retries after a backoff until it succeeds', async () => {
    const store = new FakeOutbox();
    const publisher = new FakePublisher();
    publisher.failNext = 3;
    store.add(2);
    const { log } = startRelay(store, publisher);

    await vi.waitFor(() => expect(store.published.size).toBe(2));
    expect(publisher.sent).toHaveLength(1);
    const failures = log.lines.filter((line) => line.msg === 'relay batch failed; rolled back');
    expect(failures.map((line) => line.failures)).toEqual([1, 2, 3]);
    expect(log.lines.some((line) => line.msg === 'relay recovered')).toBe(true);
  });

  it('claims nothing while another relay holds the fence', async () => {
    const store = new FakeOutbox();
    const publisher = new FakePublisher();
    store.otherRelayHoldsLock = true;
    store.add(1);
    const { relay } = startRelay(store, publisher);

    await vi.waitFor(() => expect(relay.health().healthy).toBe(true));
    expect(store.claims).toBe(0);
    store.otherRelayHoldsLock = false;
    await vi.waitFor(() => expect(store.published.size).toBe(1));
  });

  it('claims the next batch at once after a full one, and wakes early on NOTIFY', async () => {
    const store = new FakeOutbox();
    const publisher = new FakePublisher();
    store.add(5);
    const { relay } = startRelay(store, publisher, { pollMs: 60_000, batchSize: 2 });

    // 2 + 2 + 1: two full batches drain without waiting for the 60 s poll.
    await vi.waitFor(() => expect(store.published.size).toBe(5));
    expect(publisher.sent.map((batch) => batch.length)).toEqual([2, 2, 1]);

    store.add(1);
    relay.wake();
    await vi.waitFor(() => expect(store.published.size).toBe(6));
  });

  it('alerts when the oldest due row is older than 10 s', async () => {
    const store = new FakeOutbox();
    store.add(2, new Date(Date.now() - 15_000));
    const { log, relay } = startRelay(store, new FakePublisher());

    await vi.waitFor(() => expect(store.published.size).toBe(2));
    expect(log.alerts('outbox_lag')).toHaveLength(1);
    await vi.waitFor(() => expect(relay.health().oldestUnpublishedMs).toBe(0));
  });

  it('cleans up at start and on its own schedule, without holding up publishing', async () => {
    const store = new FakeOutbox();
    const slow = Promise.withResolvers<number>();
    store.cleanup = () => slow.promise;
    store.add(2);
    startRelay(store, new FakePublisher());

    await vi.waitFor(() => expect(store.published.size).toBe(2));
    expect(store.cleanups).toBe(1);
    store.cleanup = async () => 0;
    slow.resolve(5_000);
    await vi.waitFor(() => expect(store.cleanups).toBeGreaterThanOrEqual(2));
  });

  it('keeps publishing when a cleanup fails', async () => {
    const store = new FakeOutbox();
    store.cleanup = () => Promise.reject(new Error('lock timeout'));
    store.add(1);
    const { log } = startRelay(store, new FakePublisher());

    await vi.waitFor(() => expect(store.published.size).toBe(1));
    expect(log.lines.some((line) => line.msg === 'outbox cleanup failed')).toBe(true);
  });

  it('waits out a broker it cannot connect to without opening a batch, then publishes', async () => {
    const store = new FakeOutbox();
    const publisher = new FakePublisher();
    let refusals = 2;
    const claimsWhileRefused: number[] = [];
    publisher.connect = async () => {
      if (refusals-- <= 0) return;
      claimsWhileRefused.push(store.claims);
      throw new Error('kafka producer did not connect within 8000 ms');
    };
    store.add(1);
    const { log } = startRelay(store, publisher);

    await vi.waitFor(() => expect(store.published.size).toBe(1));
    // No claim (no transaction, no locked rows) while the producer could not connect.
    expect(claimsWhileRefused).toEqual([0, 0]);
    const failures = log.lines.filter((line) => line.msg === 'relay batch failed; rolled back');
    expect(failures).toHaveLength(2);
  });

  it('abandons a wait for the producer to connect when it stops', async () => {
    const store = new FakeOutbox();
    const publisher = new FakePublisher();
    const connecting = Promise.withResolvers<void>();
    publisher.connect = () => connecting.promise;
    store.add(1);
    const { relay } = startRelay(store, publisher);

    const stopping = Date.now();
    await relay.stop();
    expect(Date.now() - stopping).toBeLessThan(1_000);
    expect(store.claims).toBe(0);
    connecting.reject(new Error('connect failed after the stop'));
  });

  it('stops promptly while waiting for the next poll', async () => {
    const store = new FakeOutbox();
    const { relay } = startRelay(store, new FakePublisher(), { pollMs: 60_000 });
    await vi.waitFor(() => expect(store.claims).toBe(1));

    const stopping = Date.now();
    await relay.stop();
    expect(Date.now() - stopping).toBeLessThan(1_000);
    expect(relay.health().healthy).toBe(false);
  });
});

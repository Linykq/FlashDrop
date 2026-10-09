import { KafkaJS } from '@confluentinc/kafka-javascript';
import { InvariantViolation, TransientError } from '@flashdrop/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderEventHandlers } from './handlers';
import { DLQ_HEADERS } from './headers';
import type { OutgoingRecord, Publisher } from './publisher';
import { type ConsumerRunner, type ConsumerRunnerOptions, createConsumerRunner } from './runner';
import { captureLogger, testEvent } from './test/support';

/*
 * The runner's batch, retry and commit logic (design §6.4) against a fake client, so each rule is checked
 * deterministically: what is resolved and committed, where the partition seeks, how many resume timers
 * exist, when a message is dead-lettered, and that the commit check only moves forward. The broker-timed
 * behaviour (rebalances, real pause/seek) is covered by runner.int.test.ts.
 */

const TOPIC = 'orders.unit';
const codes = KafkaJS.ErrorCodes;

interface Call {
  readonly partition: number;
  readonly offset: string;
}

/** The parts of the client's consumer the runner uses, recording what it was asked to do. */
class FakeConsumer {
  rebalance: ((error: KafkaJS.LibrdKafkaError, assignment: KafkaJS.TopicPartition[]) => void) | undefined;
  eachBatch: ((payload: KafkaJS.EachBatchPayload) => Promise<void>) | undefined;
  readonly commits: Call[] = [];
  readonly seeks: Call[] = [];
  readonly resumed: number[] = [];
  /** What `committed()` reports, per partition; the client's -1001 when absent. */
  readonly landed = new Map<number, string>();
  disconnected = false;

  async connect(): Promise<void> {}
  async subscribe(): Promise<void> {}
  async run(config: { eachBatch: (payload: KafkaJS.EachBatchPayload) => Promise<void> }): Promise<void> {
    this.eachBatch = config.eachBatch;
  }
  async commitOffsets(offsets: { partition: number; offset: string }[]): Promise<void> {
    for (const { partition, offset } of offsets) this.commits.push({ partition, offset });
  }
  async committed(partitions: { partition: number }[]) {
    return partitions.map(({ partition }) => ({
      topic: TOPIC,
      partition,
      offset: this.landed.get(partition) ?? '-1001',
    }));
  }
  seek({ partition, offset }: { partition: number; offset: string }): void {
    this.seeks.push({ partition, offset });
  }
  resume(topics: { partitions: number[] }[]): void {
    for (const { partitions } of topics) this.resumed.push(...partitions);
  }
  async disconnect(): Promise<void> {
    this.disconnected = true;
  }
}

class FakeDlq implements Publisher {
  readonly letters: OutgoingRecord[] = [];
  failNext = 0;
  async ready(): Promise<void> {}
  async publish(records: readonly OutgoingRecord[]): Promise<void> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('dlq unavailable');
    }
    this.letters.push(...records);
  }
  async close(): Promise<void> {}
}

interface Delivery {
  /** Offsets passed to `resolveOffset`. */
  readonly resolved: string[];
  /** Calls to the resume function `pause()` returned. */
  readonly resumes: { count: number };
  readonly pauses: { count: number };
}

let consumer: FakeConsumer;
let dlq: FakeDlq;
let runner: ConsumerRunner;
let log: ReturnType<typeof captureLogger>;

function start(handlers: OrderEventHandlers, options: Partial<ConsumerRunnerOptions> = {}) {
  const admin = {
    connect: async () => undefined,
    disconnect: async () => undefined,
    fetchTopicOffsets: async () => [{ partition: 0, low: '0', high: '1000', offset: '1000' }],
  };
  const kafka = {
    consumer: (config: { rebalance_cb: FakeConsumer['rebalance'] }) => {
      consumer.rebalance = config.rebalance_cb;
      return consumer;
    },
    admin: () => admin,
  };
  runner = createConsumerRunner({
    // The fake implements exactly the client surface the runner calls; the rest of the type is unused.
    kafka: kafka as unknown as KafkaJS.Kafka,
    name: 'unit-consumer',
    groupId: 'unit-group',
    handlers,
    dlq,
    logger: log.logger,
    concurrency: 4,
    topic: TOPIC,
    backoff: { baseMs: 100, capMs: 1_000 },
    unclassifiedBackoff: { baseMs: 1_000, capMs: 1_000 },
    ...options,
  });
  return runner.start();
}

function assign(...partitions: number[]): void {
  const error = { code: codes.ERR__ASSIGN_PARTITIONS } as KafkaJS.LibrdKafkaError;
  consumer.rebalance?.(
    error,
    partitions.map((partition) => ({ topic: TOPIC, partition })),
  );
}

function revoke(...partitions: number[]): void {
  const error = { code: codes.ERR__REVOKE_PARTITIONS } as KafkaJS.LibrdKafkaError;
  consumer.rebalance?.(
    error,
    partitions.map((partition) => ({ topic: TOPIC, partition })),
  );
}

/** Events for `orders` (one entry per message, by order name) at consecutive offsets from `first`. */
function messages(first: number, orders: readonly string[]) {
  const ids = new Map<string, string>();
  return orders.map((name, index) => {
    const orderId = ids.get(name) ?? crypto.randomUUID();
    ids.set(name, orderId);
    const event = testEvent('order.paid', { orderId });
    return {
      key: Buffer.from(event.productId),
      value: Buffer.from(JSON.stringify(event)),
      offset: String(first + index),
      headers: {},
      timestamp: '0',
      size: 0,
      attributes: 0,
      orderName: name,
    };
  });
}

type Messages = ReturnType<typeof messages>;

async function deliver(partition: number, batch: Messages): Promise<Delivery> {
  const delivery: Delivery = { resolved: [], resumes: { count: 0 }, pauses: { count: 0 } };
  const payload = {
    batch: { topic: TOPIC, partition, messages: batch, highWatermark: '1000' },
    resolveOffset: (offset: string) => delivery.resolved.push(offset),
    pause: () => {
      delivery.pauses.count++;
      return () => {
        delivery.resumes.count++;
      };
    },
    isStale: () => false,
    isRunning: () => true,
    heartbeat: async () => undefined,
  };
  if (consumer.eachBatch === undefined) throw new Error('the runner is not running');
  // The fake carries the payload fields the runner reads; the rest of the type is unused.
  await consumer.eachBatch(payload as unknown as KafkaJS.EachBatchPayload);
  return delivery;
}

/** Handlers that fail per order name, as `failures` says. */
function handlersFailing(batch: Messages, fail: (name: string) => Error | undefined): OrderEventHandlers {
  const names = new Map(
    batch.map((m) => [(JSON.parse(m.value.toString()) as { orderId: string }).orderId, m.orderName]),
  );
  return {
    'order.paid': async (event) => {
      const error = fail(names.get(event.orderId) ?? '');
      if (error !== undefined) throw error;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  consumer = new FakeConsumer();
  dlq = new FakeDlq();
  log = captureLogger();
});

afterEach(async () => {
  await runner?.stop();
  vi.useRealTimers();
});

describe('createConsumerRunner', () => {
  it('commits only the contiguous finished prefix and seeks back to the first unfinished offset', async () => {
    const batch = messages(10, ['a', 'b', 'c', 'b', 'd']);
    await start(
      handlersFailing(batch, (name) => (name === 'b' ? new TransientError('psp down') : undefined)),
    );
    assign(0);

    const delivery = await deliver(0, batch);

    // 10 (a) finished; 11 (b) failed; c and d finished past the gap and are simply delivered again.
    expect(delivery.resolved).toEqual(['10']);
    expect(consumer.commits).toEqual([{ partition: 0, offset: '11' }]);
    expect(consumer.seeks).toEqual([{ partition: 0, offset: '11' }]);
    expect(delivery.pauses.count).toBe(1);
    expect(runner.health()).toMatchObject({ retrying: [0], lastError: 'TransientError: psp down' });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(delivery.resumes.count).toBe(1);
  });

  it('keeps one resume timer per partition, and none survives stop()', async () => {
    const batch = messages(0, ['a']);
    await start(handlersFailing(batch, () => new TransientError('psp down')));
    assign(0);

    const first = await deliver(0, batch);
    const second = await deliver(0, batch); // a redelivery while the first backoff is pending
    expect(runner.health().retrying).toEqual([0]);

    await runner.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(first.resumes.count + second.resumes.count).toBe(0);
    expect(consumer.disconnected).toBe(true);
  });

  it('resumes a paused partition at once when it is revoked, and forgets it', async () => {
    const batch = messages(0, ['a']);
    await start(handlersFailing(batch, () => new TransientError('psp down')));
    assign(0, 1);

    await deliver(0, batch);
    revoke(0);

    expect(consumer.resumed).toEqual([0]);
    expect(runner.health()).toMatchObject({ partitions: [1], retrying: [] });
  });

  it('dead-letters an unclassified failure only after 5 attempts and a minute of failing', async () => {
    const batch = messages(0, ['a']);
    await start(handlersFailing(batch, () => new Error('bug')));
    assign(0);

    // Five quick attempts are not enough: a minute must pass too.
    for (let attempt = 1; attempt <= 6; attempt++) {
      await deliver(0, batch);
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(dlq.letters).toEqual([]);
    expect(consumer.commits).toEqual([]);

    await vi.advanceTimersByTimeAsync(30_000);
    const done = await deliver(0, batch);

    expect(dlq.letters).toHaveLength(1);
    expect(dlq.letters[0]?.headers?.[DLQ_HEADERS.attempts]).toBe('7');
    expect(done.resolved).toEqual(['0']);
    expect(consumer.commits).toEqual([{ partition: 0, offset: '1' }]);
    expect(log.alerts('dlq_write').map((a) => a.reason)).toEqual(['exhausted']);
  });

  it('dead-letters a poison message at once, and retries it while the DLQ refuses the copy', async () => {
    const batch = messages(0, ['a', 'b']);
    await start(
      handlersFailing(batch, (name) => (name === 'a' ? new InvariantViolation('INV-8', 'x') : undefined)),
    );
    assign(0);
    dlq.failNext = 1;

    const refused = await deliver(0, batch);
    expect(refused.resolved).toEqual([]);
    expect(consumer.seeks).toEqual([{ partition: 0, offset: '0' }]);

    const accepted = await deliver(0, batch);
    expect(dlq.letters).toHaveLength(1);
    expect(accepted.resolved).toEqual(['1']);
    expect(consumer.commits).toEqual([{ partition: 0, offset: '2' }]);
  });

  it('commits again where a commit did not land, and never moves a partition backwards', async () => {
    await start({ 'order.paid': async () => undefined }, { commitCheckEveryMs: 1_000 });
    assign(0, 1);
    await deliver(0, messages(0, ['a', 'b', 'c']));
    await deliver(1, messages(40, ['d']));
    expect(consumer.commits).toEqual([
      { partition: 0, offset: '3' },
      { partition: 1, offset: '41' },
    ]);

    // Partition 0's commit was lost in a rebalance; partition 1's group offset is already past ours.
    consumer.landed.set(1, '50');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(consumer.commits.slice(2)).toEqual([{ partition: 0, offset: '3' }]);

    consumer.landed.set(0, '3');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(consumer.commits).toHaveLength(3);
  });

  it('clears the reported error once a batch of the partition runs clean', async () => {
    let failing = true;
    await start({
      'order.paid': async () => {
        if (failing) throw new TransientError('psp down');
      },
    });
    assign(0);

    await deliver(0, messages(0, ['a']));
    expect(runner.health().lastError).toBe('TransientError: psp down');
    failing = false;
    await deliver(0, messages(0, ['a']));
    expect(runner.health()).toMatchObject({ lastError: null, consecutiveFailures: 0 });
  });
});

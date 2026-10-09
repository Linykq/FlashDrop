import { randomUUID } from 'node:crypto';
import type { KafkaJS } from '@confluentinc/kafka-javascript';
import type { OrderEvent } from '@flashdrop/contracts';
import { InvariantViolation, TransientError } from '@flashdrop/domain';
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { replayDlq } from './dlq-replay';
import type { OrderEventHandlers } from './handlers';
import { DLQ_HEADERS, headerText } from './headers';
import { createGroupLagReader, type GroupLagReader } from './lag';
import { createPublisher, type OutgoingRecord, type Publisher } from './publisher';
import { type ConsumerRunner, type ConsumerRunnerOptions, createConsumerRunner } from './runner';
import { readToEnd, testAdmin, testGroup, testKafka, testTopic } from './test/kafka';
import { captureLogger, testEvent } from './test/support';

/*
 * The consumer runner against the Compose broker (design §6.4, §13): throwaway topics and groups per test.
 */

const kafka = testKafka('runner-test');
const quiet = captureLogger();
let publisher: Publisher;

beforeAll(() => {
  publisher = createPublisher({ kafka, logger: quiet.logger });
});

afterAll(async () => {
  await publisher.close();
});

const WAIT = { timeout: 30_000, interval: 50 };

const record = (topic: string, event: OrderEvent): OutgoingRecord => ({
  topic,
  key: event.productId,
  value: JSON.stringify(event),
  headers: { 'event-id': event.eventId, 'event-type': event.type },
});

const produce = (topic: string, events: readonly OrderEvent[]) =>
  publisher.publish(events.map((event) => record(topic, event)));

interface Setup {
  readonly admin: KafkaJS.Admin;
  /** Reads `topic` unless told otherwise. */
  readonly lag: GroupLagReader;
  readonly topic: string;
  readonly dlqTopic: string;
  readonly groupId: string;
}

async function setup(partitions = 1): Promise<Setup> {
  const admin = await testAdmin(kafka);
  const [topic, dlqTopic] = await Promise.all([
    testTopic(admin, 'runner', partitions),
    testTopic(admin, 'runner-dlq', 1),
  ]);
  const lag = createGroupLagReader(kafka, { topic, timeoutMs: 10_000 });
  onTestFinished(() => lag.close());
  return { admin, lag, topic, dlqTopic, groupId: testGroup(admin, 'runner') };
}

async function startRunner(
  s: Setup,
  options: Pick<ConsumerRunnerOptions, 'handlers'> & Partial<ConsumerRunnerOptions>,
): Promise<{ runner: ConsumerRunner; log: ReturnType<typeof captureLogger> }> {
  const log = captureLogger();
  const runner = createConsumerRunner({
    kafka,
    name: 'test-consumer',
    groupId: s.groupId,
    topic: s.topic,
    dlqTopic: s.dlqTopic,
    dlq: publisher,
    logger: log.logger,
    concurrency: 8,
    backoff: { baseMs: 50, capMs: 200 },
    ...options,
  });
  onTestFinished(() => runner.stop());
  await runner.start();
  return { runner, log };
}

/** The group's committed offset per partition (null when none). */
async function committed(s: Setup): Promise<Map<number, string | null>> {
  return new Map((await s.lag.read(s.groupId)).map((p) => [p.partition, p.committed]));
}

async function expectCommittedToEnd(s: Setup): Promise<void> {
  const ends = await s.admin.fetchTopicOffsets(s.topic);
  await vi.waitFor(async () => {
    const offsets = await committed(s);
    for (const end of ends) expect(offsets.get(end.partition), `partition ${end.partition}`).toBe(end.high);
  }, WAIT);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('consumer runner', () => {
  it('reads events produced before the group existed (earliest), commits to the end and reports assigned', async () => {
    const s = await setup(3);
    const events = Array.from({ length: 30 }, () => testEvent('order.paid'));
    await produce(s.topic, events);
    const before = await s.lag.read(s.groupId);
    expect(before.map((p) => p.committed)).toEqual([null, null, null]);
    expect(before.reduce((sum, p) => sum + p.lag, 0)).toBe(30);
    const seen = new Set<string>();

    const { runner } = await startRunner(s, {
      handlers: {
        'order.paid': async (event) => {
          seen.add(event.eventId);
        },
      },
    });

    await vi.waitFor(() => expect(seen.size).toBe(30), WAIT);
    await expectCommittedToEnd(s);
    expect((await s.lag.read(s.groupId)).map((p) => p.lag)).toEqual([0, 0, 0]);
    expect(runner.health()).toMatchObject({ healthy: true, partitions: [0, 1, 2], retrying: [], stuck: [] });
  });

  it('runs copies of one event one after another, so an idempotent handler applies them once', async () => {
    const s = await setup(1);
    const productId = randomUUID();
    const duplicate = testEvent('order.placed', { productId });
    const others = Array.from({ length: 10 }, () => testEvent('order.placed', { productId }));
    await produce(s.topic, [duplicate, ...others.slice(0, 1), duplicate, ...others.slice(1), duplicate]);
    const applied = new Set<string>();
    let effects = 0;
    let deliveries = 0;

    await startRunner(s, {
      handlers: {
        // Check-then-act with a gap: two concurrent copies would both pass the check.
        'order.placed': async (event) => {
          if (event.eventId === duplicate.eventId) deliveries++;
          if (applied.has(event.eventId)) return;
          await sleep(20);
          applied.add(event.eventId);
          effects++;
        },
      },
    });

    await expectCommittedToEnd(s);
    expect(deliveries).toBe(3);
    expect(effects).toBe(11);
  });

  it('dead-letters poison messages with their headers, alerts, moves on, and dlq:replay runs the named handler', async () => {
    const s = await setup(1);
    const productId = randomUUID();
    const [first, broken, last] = [
      testEvent('order.paid', { productId }),
      testEvent('order.paid', { productId }),
      testEvent('order.paid', { productId }),
    ];
    await produce(s.topic, [first]);
    await publisher.publish([
      { topic: s.topic, key: productId, value: '{"not":"an envelope"', headers: { 'event-id': 'garbage' } },
      {
        topic: s.topic,
        key: productId,
        value: JSON.stringify({ ...testEvent('order.paid', { productId }), type: 'order.shipped' }),
      },
    ]);
    await produce(s.topic, [broken, last]);
    const handled: string[] = [];

    const { log } = await startRunner(s, {
      handlers: {
        'order.paid': async (event) => {
          if (event.eventId === broken.eventId) throw new InvariantViolation('INV-8', 'redis CONFLICT');
          handled.push(event.eventId);
        },
      },
    });

    await expectCommittedToEnd(s);
    expect(handled).toEqual([first.eventId, last.eventId]);
    const letters = await readToEnd(kafka, s.admin, s.dlqTopic);
    expect(letters.map((l) => headerText(l.headers, DLQ_HEADERS.origOffset))).toEqual(['1', '2', '3']);
    for (const letter of letters) {
      expect(letter.key).toBe(productId);
      expect(headerText(letter.headers, DLQ_HEADERS.consumer)).toBe('test-consumer');
      expect(headerText(letter.headers, DLQ_HEADERS.attempts)).toBe('1');
      expect(headerText(letter.headers, DLQ_HEADERS.origPartition)).toBe('0');
    }
    expect(letters[0]?.value).toBe('{"not":"an envelope"');
    expect(headerText(letters[0]?.headers, 'event-id')).toBe('garbage');
    expect(headerText(letters[2]?.headers, DLQ_HEADERS.error)).toBe(
      'InvariantViolation: INV-8: redis CONFLICT',
    );
    expect(log.alerts('dlq_write').map((a) => a.reason)).toEqual(['invalid', 'invalid', 'invariant']);

    // The replay runs only the handler named in x-consumer, directly, and reports what it cannot replay.
    const replayed: string[] = [];
    const neverRun: OrderEventHandlers = {
      'order.paid': async () => {
        throw new Error('another consumer ran');
      },
    };
    // Each replay records its progress in its own group here (`dlq-replay` in production): the admin
    // health tile counts the letters past it as the ones still to act on.
    const progressOf = async (progressGroup: string) =>
      (await s.lag.read(progressGroup, s.dlqTopic)).map((p) => [p.committed, p.lag]);
    const done = testGroup(s.admin, 'dlq-progress');
    const dryRun = await replayDlq({
      kafka,
      topic: s.dlqTopic,
      logger: quiet.logger,
      consumers: { 'test-consumer': { 'order.paid': async () => undefined } },
      dryRun: true,
      progressGroup: done,
    });
    expect(dryRun.replayed.map((l) => l.offset)).toEqual(['2']);
    expect(await progressOf(done)).toEqual([[null, 3]]);

    const report = await replayDlq({
      kafka,
      topic: s.dlqTopic,
      logger: quiet.logger,
      consumers: {
        'test-consumer': { 'order.paid': async (event) => void replayed.push(event.eventId) },
        other: neverRun,
      },
      progressGroup: done,
    });
    expect(replayed).toEqual([broken.eventId]);
    expect(report.replayed.map((l) => l.offset)).toEqual(['2']);
    expect(report.unhandled).toEqual([]);
    expect(report.invalid.map((l) => l.offset)).toEqual(['0', '1']);
    expect(report.failed).toBeUndefined();
    // Undecodable letters are reported once and can never be replayed: they count as dealt with.
    expect(await progressOf(done)).toEqual([['3', 0]]);

    // A consumer that no longer handles the type: the letter is reported as unhandled, not as replayed.
    const withoutHandler = await replayDlq({
      kafka,
      topic: s.dlqTopic,
      logger: quiet.logger,
      consumers: { 'test-consumer': {} },
      progressGroup: done,
    });
    expect(withoutHandler.replayed).toEqual([]);
    expect(withoutHandler.unhandled.map((l) => l.offset)).toEqual(['2']);

    // A failing handler stops the replay at that letter, and the progress there. A replay of letters
    // already handled never moves the progress back.
    const failingHandlers = {
      'test-consumer': { 'order.paid': () => Promise.reject(new TransientError('psp down')) },
    };
    const stuck = testGroup(s.admin, 'dlq-progress');
    for (const progressGroup of [done, stuck]) {
      const failing = await replayDlq({
        kafka,
        topic: s.dlqTopic,
        logger: quiet.logger,
        consumers: failingHandlers,
        progressGroup,
      });
      expect(failing.failed).toMatchObject({
        offset: '2',
        consumer: 'test-consumer',
        error: 'TransientError: psp down',
      });
    }
    expect(await progressOf(done)).toEqual([['3', 0]]);
    expect(await progressOf(stuck)).toEqual([['2', 1]]);

    // Letters left to another consumer are not dealt with: the progress stays before them.
    const otherOnly = testGroup(s.admin, 'dlq-progress');
    const onlyOther = await replayDlq({
      kafka,
      topic: s.dlqTopic,
      logger: quiet.logger,
      consumers: { 'test-consumer': {}, other: neverRun },
      only: 'other',
      progressGroup: otherOnly,
    });
    expect(onlyOther.skipped).toBe(3);
    expect(await progressOf(otherOnly)).toEqual([[null, 3]]);
  });

  it('retries a transient failure by pausing and seeking, never reordering an order and never dead-lettering', async () => {
    const s = await setup(1);
    const productId = randomUUID();
    const orderX = randomUUID();
    const orderY = randomUUID();
    const [x1, y1, x2, y2, x3] = [
      testEvent('order.paid', { productId, orderId: orderX, orderVersion: 1 }),
      testEvent('order.paid', { productId, orderId: orderY, orderVersion: 1 }),
      testEvent('order.paid', { productId, orderId: orderX, orderVersion: 2 }),
      testEvent('order.paid', { productId, orderId: orderY, orderVersion: 2 }),
      testEvent('order.paid', { productId, orderId: orderX, orderVersion: 3 }),
    ];
    await produce(s.topic, [x1, y1, x2, y2, x3]);
    let x2Attempts = 0;
    const completed: string[] = [];

    const { log } = await startRunner(s, {
      handlers: {
        'order.paid': async (event) => {
          if (event.eventId === x2.eventId && ++x2Attempts <= 2)
            throw new TransientError('postgres restarting');
          await sleep(5);
          completed.push(event.eventId);
        },
      },
    });

    await expectCommittedToEnd(s);
    expect(x2Attempts).toBe(3);
    const firstCompletion = (id: string) => completed.indexOf(id);
    expect(firstCompletion(x1.eventId)).toBeLessThan(firstCompletion(x2.eventId));
    expect(firstCompletion(x2.eventId)).toBeLessThan(firstCompletion(x3.eventId));
    expect(new Set(completed)).toEqual(new Set([x1, y1, x2, y2, x3].map((e) => e.eventId)));
    expect(log.lines.filter((l) => l.msg === 'partition paused for a retry').map((l) => l.offset)).toEqual([
      '2',
      '2',
    ]);
    expect(log.alerts('dlq_write')).toEqual([]);
    expect(await readToEnd(kafka, s.admin, s.dlqTopic)).toEqual([]);
  });

  it('retries an unclassified failure a few times, then dead-letters it with its attempt count', async () => {
    const s = await setup(1);
    const productId = randomUUID();
    const bug = testEvent('order.expired', { productId });
    const after = testEvent('order.expired', { productId });
    await produce(s.topic, [bug, after]);
    let attempts = 0;
    const handled: string[] = [];

    // The minute an unclassified failure must also keep failing for is checked in runner.test.ts.
    await startRunner(s, {
      maxUnclassifiedAttempts: 3,
      unclassifiedGiveUpMs: 0,
      unclassifiedBackoff: { baseMs: 50, capMs: 200 },
      handlers: {
        'order.expired': async (event) => {
          if (event.eventId === bug.eventId) {
            attempts++;
            throw new TypeError("Cannot read properties of undefined (reading 'status')");
          }
          handled.push(event.eventId);
        },
      },
    });

    await expectCommittedToEnd(s);
    expect(attempts).toBe(3);
    expect(handled).toContain(after.eventId);
    const [letter] = await readToEnd(kafka, s.admin, s.dlqTopic);
    expect(headerText(letter?.headers, DLQ_HEADERS.attempts)).toBe('3');
  });

  it('gets its commits to land when it finishes a backlog inside a rebalance: lag reaches 0', async () => {
    // A finishes the partitions it keeps while B's join rebalances the group. Its commits in that window are
    // queued, resolve, and are refused by the broker unseen (REBALANCE_IN_PROGRESS); with nothing left to
    // consume it would never commit again. Without the commit check this failed 4 runs in 5.
    const s = await setup(6);
    const events = Array.from({ length: 12_000 }, () => testEvent('order.paid'));
    for (let i = 0; i < events.length; i += 500) await produce(s.topic, events.slice(i, i + 500));
    const seen = new Set<string>();
    const options = {
      commitCheckEveryMs: 1_000,
      concurrency: 16,
      handlers: {
        'order.paid': async (event: OrderEvent) => {
          await sleep(1);
          seen.add(event.eventId);
        },
      },
    };

    await startRunner(s, options);
    await vi.waitFor(() => expect(seen.size).toBeGreaterThan(3_000), WAIT);
    await startRunner(s, options);

    await vi.waitFor(() => expect(seen.size).toBe(events.length), { ...WAIT, timeout: 60_000 });
    await vi.waitFor(
      async () => expect((await s.lag.read(s.groupId)).map((p) => p.lag)).toEqual([0, 0, 0, 0, 0, 0]),
      { timeout: 15_000, interval: 250 },
    );
  });

  it('is healthy only while it owns a partition: a member that gains nothing is not', async () => {
    const s = await setup(1);
    await produce(s.topic, [testEvent('order.paid')]);
    const handlers: OrderEventHandlers = { 'order.paid': async () => undefined };

    const { runner: first } = await startRunner(s, { handlers });
    await vi.waitFor(() => expect(first.health().healthy).toBe(true), WAIT);
    const { runner: second, log } = await startRunner(s, { handlers });
    // Cooperative-sticky: the newcomer gets an assign callback with an empty list (M0 delta 3).
    await vi.waitFor(() => expect(log.lines.some((l) => l.msg === 'partitions assigned')).toBe(true), WAIT);
    expect(second.health()).toMatchObject({ healthy: false, partitions: [] });
    expect(first.health().healthy).toBe(true);

    await first.stop();
    await vi.waitFor(() => expect(second.health()).toMatchObject({ healthy: true, partitions: [0] }), WAIT);
    expect(first.health().healthy).toBe(false);
  });

  it('stops cleanly while a paused partition waits for its resume', async () => {
    const s = await setup(1);
    await produce(s.topic, [testEvent('order.cancelled')]);
    const { runner } = await startRunner(s, {
      backoff: { baseMs: 10_000, capMs: 10_000 },
      handlers: { 'order.cancelled': () => Promise.reject(new TransientError('redis away')) },
    });
    await vi.waitFor(() => expect(runner.health().retrying).toEqual([0]), WAIT);

    // A resume that fired after disconnect would throw uncaught and fail this run (M0 delta 4).
    await runner.stop();
    expect(runner.health()).toMatchObject({ healthy: false, retrying: [] });
    await sleep(200);
  });

  it('alerts when the committed offset fell below the log start', async () => {
    const s = await setup(1);
    await produce(
      s.topic,
      Array.from({ length: 8 }, () => testEvent('order.paid')),
    );
    // The group committed offset 2, then retention removed offsets 0-4 it never processed.
    const early = kafka.consumer({ kafkaJS: { groupId: s.groupId, fromBeginning: true, autoCommit: false } });
    const commitDone = Promise.withResolvers<void>();
    await early.connect();
    await early.subscribe({ topics: [s.topic] });
    await early.run({
      eachBatch: async () => {
        await early.commitOffsets([{ topic: s.topic, partition: 0, offset: '2' }]);
        commitDone.resolve();
      },
    });
    await commitDone.promise;
    await early.disconnect();
    await s.admin.deleteTopicRecords({ topic: s.topic, partitions: [{ partition: 0, offset: '5' }] });

    const gate = Promise.withResolvers<void>();
    const { log } = await startRunner(s, { handlers: { 'order.paid': () => gate.promise } });
    try {
      await vi.waitFor(() => expect(log.alerts('offset_below_log_start')).toHaveLength(1), WAIT);
    } finally {
      gate.resolve();
    }
    expect(log.alerts('offset_below_log_start')[0]).toMatchObject({
      partition: 0,
      committed: '2',
      logStart: '5',
    });
  });
});

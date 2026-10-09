import type { OrderEvent } from '@flashdrop/contracts';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createGroupLagReader, type PartitionLag } from './lag';
import { createPublisher } from './publisher';
import { createConsumerRunner } from './runner';
import { testAdmin, testGroup, testKafka, testTopic } from './test/kafka';
import { captureLogger, testEvent } from './test/support';

/*
 * The lag reader against the Compose broker, on a throwaway topic and group: it reports the log's watermarks
 * against the group's commits, and it never joins the group it reads, so `dash:rebuild` can still delete the
 * group's offsets while an api holds a reader on it.
 */

const kafka = testKafka('lag-test');
const WAIT = { timeout: 30_000, interval: 100 };

describe('createGroupLagReader', () => {
  it('reads the lag before and after a group commits, on any topic, without joining the group', async () => {
    const admin = await testAdmin(kafka);
    const topic = await testTopic(admin, 'lag', 3);
    const dlqTopic = await testTopic(admin, 'lag-dlq', 1);
    const groupId = testGroup(admin, 'lag');
    const log = captureLogger();
    const publisher = createPublisher({ kafka, logger: log.logger });
    onTestFinished(() => publisher.close());
    const events: OrderEvent[] = Array.from({ length: 30 }, () => testEvent('order.paid'));
    await publisher.publish(
      events.map((event) => ({ topic, key: event.productId, value: JSON.stringify(event), headers: {} })),
    );
    const reader = createGroupLagReader(kafka, { topic, timeoutMs: 10_000 });
    onTestFinished(() => reader.close());

    // What the reader must report, from the log's watermarks: nothing committed, or everything.
    const watermarks = (await admin.fetchTopicOffsets(topic)).sort((a, b) => a.partition - b.partition);
    const uncommitted: PartitionLag[] = watermarks.map((w) => ({
      partition: w.partition,
      committed: null,
      end: w.high,
      lag: Number(BigInt(w.high) - BigInt(w.low)),
    }));
    const caughtUp: PartitionLag[] = watermarks.map((w) => ({
      partition: w.partition,
      // A partition no key landed on has nothing to commit.
      committed: w.high === w.low ? null : w.high,
      end: w.high,
      lag: 0,
    }));

    const before = await reader.read(groupId);
    expect(before).toEqual(uncommitted);
    expect(before.reduce((sum, p) => sum + p.lag, 0)).toBe(30);
    expect(await reader.read(groupId, dlqTopic)).toEqual([
      { partition: 0, committed: null, end: '0', lag: 0 },
    ]);

    const runner = createConsumerRunner({
      kafka,
      name: 'lag-test',
      groupId,
      topic,
      dlqTopic,
      dlq: publisher,
      logger: log.logger,
      concurrency: 8,
      handlers: { 'order.paid': async () => undefined },
    });
    await runner.start();
    try {
      await vi.waitFor(async () => {
        expect((await reader.read(groupId)).map((p) => p.lag)).toEqual([0, 0, 0]);
      }, WAIT);
      expect(await reader.read(groupId)).toEqual(caughtUp);
    } finally {
      await runner.stop();
    }

    // The reader is still connected to the group: a member would make the broker refuse this.
    const [group] = (await admin.describeGroups([groupId])).groups;
    expect(group?.members).toEqual([]);
    await admin.deleteGroups([groupId]);
    expect((await reader.read(groupId)).reduce((sum, p) => sum + p.lag, 0)).toBe(30);
  });
});

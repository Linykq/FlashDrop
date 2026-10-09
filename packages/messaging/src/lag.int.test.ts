import type { OrderEvent } from '@flashdrop/contracts';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createGroupLagReader, fetchGroupLag } from './lag';
import { createPublisher } from './publisher';
import { createConsumerRunner } from './runner';
import { testAdmin, testGroup, testKafka, testTopic } from './test/kafka';
import { captureLogger, testEvent } from './test/support';

/*
 * The long-lived lag reader against the Compose broker, on a throwaway topic and group: it reports what the
 * admin API reports, and it never joins the group it reads, so `dash:rebuild` can still delete the group's
 * offsets while an api holds a reader on it.
 */

const kafka = testKafka('lag-test');
const WAIT = { timeout: 30_000, interval: 100 };

describe('createGroupLagReader', () => {
  it('reads the lag the admin API reads, before and after a group commits, without joining the group', async () => {
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

    const before = await reader.read(groupId);
    expect(before).toEqual(await fetchGroupLag(admin, groupId, topic));
    expect(before.map((p) => p.committed)).toEqual([null, null, null]);
    expect(before.reduce((sum, p) => sum + p.lag, 0)).toBe(30);

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
      expect(await reader.read(groupId)).toEqual(await fetchGroupLag(admin, groupId, topic));
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

import { KafkaJS } from '@confluentinc/kafka-javascript';
import { describe, expect, it, vi } from 'vitest';
import { createGroupLagReader } from './lag';

/*
 * The lag reader's handling of the group coordinator's answers, against a fake client: a brand-new broker
 * answers NOT_COORDINATOR until it has loaded `__consumer_offsets` (lag.ts).
 */

const { ERR_NOT_COORDINATOR, ERR_COORDINATOR_LOAD_IN_PROGRESS, ERR_GROUP_AUTHORIZATION_FAILED } =
  KafkaJS.ErrorCodes;
const kafkaError = (code: number) => new KafkaJS.KafkaJSError(`code ${code}`, { code });

function fakeKafka(committed: KafkaJS.Consumer['committed']) {
  const consumer = {
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    committed,
  };
  const admin = {
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    fetchTopicOffsets: vi.fn(async () => [{ partition: 0, offset: '7', high: '7', low: '0' }]),
  };
  // The fake implements exactly the client surface the reader calls; the rest of the type is unused.
  return { admin: () => admin, consumer: () => consumer } as unknown as KafkaJS.Kafka;
}

describe('createGroupLagReader', () => {
  it('asks the coordinator again while it moves or loads, then reports the commit', async () => {
    const committed = vi
      .fn<KafkaJS.Consumer['committed']>()
      .mockRejectedValueOnce(kafkaError(ERR_NOT_COORDINATOR))
      .mockRejectedValueOnce(kafkaError(ERR_COORDINATOR_LOAD_IN_PROGRESS))
      .mockResolvedValue([{ topic: 't', partition: 0, offset: '5', metadata: null }]);
    const reader = createGroupLagReader(fakeKafka(committed), { topic: 't', timeoutMs: 5_000 });

    expect(await reader.read('g')).toEqual([{ partition: 0, committed: '5', end: '7', lag: 2 }]);
    expect(committed).toHaveBeenCalledTimes(3);
    await reader.close();
  });

  it('gives up on a coordinator that never answers at its deadline, and at once on any other error', async () => {
    const loading = vi.fn<KafkaJS.Consumer['committed']>().mockRejectedValue(kafkaError(ERR_NOT_COORDINATOR));
    const slow = createGroupLagReader(fakeKafka(loading), { topic: 't', timeoutMs: 300 });
    await expect(slow.read('g')).rejects.toThrow();
    const calls = loading.mock.calls.length;
    expect(calls).toBeGreaterThan(1);
    // Nothing keeps asking once the read has rejected.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(loading).toHaveBeenCalledTimes(calls);
    await slow.close();

    const denied = vi
      .fn<KafkaJS.Consumer['committed']>()
      .mockRejectedValue(kafkaError(ERR_GROUP_AUTHORIZATION_FAILED));
    const refused = createGroupLagReader(fakeKafka(denied), { topic: 't', timeoutMs: 5_000 });
    await expect(refused.read('g')).rejects.toMatchObject({ code: ERR_GROUP_AUTHORIZATION_FAILED });
    expect(denied).toHaveBeenCalledTimes(1);
    await refused.close();
  });
});

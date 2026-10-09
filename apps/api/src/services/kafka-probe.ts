import { DLQ_REPLAY_GROUP, TOPICS, withTimeout } from '@flashdrop/config';
import {
  countTopicRecords,
  createGroupLagReader,
  type createKafka,
  type PartitionLag,
} from '@flashdrop/messaging';

/** The Kafka client `createKafka` builds; api depends on the client only through @flashdrop/messaging. */
export type KafkaClient = ReturnType<typeof createKafka>;

/** The DLQ as the health tile shows it. */
export interface DeadLetterCount {
  /** Letters past the `dlq-replay` group's committed offset: what `dlq:replay` has not handled yet. */
  readonly unreplayed: number;
  /** Every letter the topic still holds (30 days of them), replayed or not. */
  readonly retained: number;
}

/**
 * What the admin health tiles read from Kafka (design §12): each group's lag on `orders.v1` and the letters
 * in `orders.v1.dlq`. Every read is bounded, so a Kafka outage shows as "did not answer" rather than a hung
 * page.
 */
export interface KafkaProbe {
  groupLag(groupId: string): Promise<PartitionLag[]>;
  deadLetters(): Promise<DeadLetterCount>;
  close(): Promise<void>;
}

const TIMEOUT_MS = 2_000;

/**
 * Over the long-lived lag reader (it never calls the admin API's group offsets request, which a broker
 * restart turns into a SIGABRT in client 1.10.1) and an admin client for watermarks only.
 */
export function createKafkaProbe(kafka: KafkaClient): KafkaProbe {
  const lag = createGroupLagReader(kafka, { timeoutMs: TIMEOUT_MS });
  // `dlq:replay` commits its progress as this group's offsets on the DLQ (§6.4): its lag is what is left.
  const replayProgress = createGroupLagReader(kafka, { topic: TOPICS.ordersDlq, timeoutMs: TIMEOUT_MS });
  const admin = kafka.admin();
  let connected: Promise<void> | undefined;

  async function retained(): Promise<number> {
    if (connected === undefined) {
      const connecting = admin.connect();
      connected = connecting;
      connecting.catch(() => {
        if (connected === connecting) connected = undefined;
      });
    }
    await connected;
    return countTopicRecords(admin, TOPICS.ordersDlq);
  }

  async function deadLetters(): Promise<DeadLetterCount> {
    const [partitions, total] = await Promise.all([replayProgress.read(DLQ_REPLAY_GROUP), retained()]);
    return { unreplayed: partitions.reduce((sum, partition) => sum + partition.lag, 0), retained: total };
  }

  return {
    groupLag: (groupId) => lag.read(groupId),
    deadLetters: () => bounded(deadLetters(), TIMEOUT_MS),
    async close() {
      const opened = connected;
      // Every client closes even when one fails; the failures go to the caller, which logs them.
      const results = await Promise.allSettled([
        lag.close(),
        replayProgress.close(),
        opened === undefined
          ? Promise.resolve()
          : bounded(
              opened.then(() => admin.disconnect()),
              TIMEOUT_MS,
            ),
      ]);
      const failures = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
      if (failures.length > 0) throw new AggregateError(failures, 'kafka probe did not close cleanly');
    },
  };
}

/** A Kafka read that answers within `ms` or fails as "did not answer". */
function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  return withTimeout(promise, ms, () => new Error(`Kafka did not answer within ${ms} ms`));
}

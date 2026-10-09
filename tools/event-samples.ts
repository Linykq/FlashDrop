import type { KafkaJS } from '@confluentinc/kafka-javascript';
import { CONSUMER_GROUPS, TOPICS } from '@flashdrop/config';
import { type Executor, outboxBacklog } from '@flashdrop/db';
import type { EventsSample } from '@flashdrop/inventory';
import { fetchGroupLag } from '@flashdrop/messaging';

/*
 * Sampling the event pipeline for INV-5 (design §1.1, §13): the outbox backlog in Postgres and, from the
 * broker's point of view, how far each checked consumer group has committed. Read-only: the admin API reads
 * watermarks and committed offsets and never joins a group, so a running consumer is never disturbed.
 */

/** The groups INV-5 waits for (§6.3). */
export const CHECKED_GROUPS: readonly { readonly name: string; readonly groupId: string }[] = [
  { name: 'payment', groupId: CONSUMER_GROUPS.payment },
  { name: 'settlement', groupId: CONSUMER_GROUPS.settlement },
  { name: 'dashboard', groupId: CONSUMER_GROUPS.dashboard },
];

/** How long one sample may take before the broker counts as unreachable. */
const SAMPLE_TIMEOUT_MS = 15_000;

export interface EventsProbeOptions {
  readonly db: Executor;
  /** A connected admin client. */
  readonly admin: KafkaJS.Admin;
  readonly topic?: string;
  /** Counted for the report; null leaves the count out. */
  readonly dlqTopic?: string | null;
  readonly groups?: readonly { readonly name: string; readonly groupId: string }[];
}

export type EventsProbe = () => Promise<EventsSample>;

export function createEventsProbe(options: EventsProbeOptions): EventsProbe {
  const { db, admin, topic = TOPICS.orders, groups = CHECKED_GROUPS } = options;
  const dlqTopic = options.dlqTopic === undefined ? TOPICS.ordersDlq : options.dlqTopic;

  async function sample(): Promise<EventsSample> {
    // The outbox first: an event the relay publishes while the broker side is read shows up as a moved log
    // end, which `pendingEvents` treats as not quiescent, never as a skipped event.
    const outbox = await outboxBacklog(db);
    const [watermarks, lags, deadLetters] = await Promise.all([
      admin.fetchTopicOffsets(topic),
      Promise.all(groups.map((group) => fetchGroupLag(admin, group.groupId, topic))),
      dlqTopic === null ? null : countRecords(admin, dlqTopic),
    ]);
    return {
      outbox,
      groups: groups.map((group, index) => ({
        name: group.name,
        groupId: group.groupId,
        partitions: (lags[index] ?? []).map(({ partition, committed, lag }) => ({
          partition,
          committed,
          lag,
        })),
      })),
      logEnd: [...watermarks].sort((a, b) => a.partition - b.partition).map((w) => w.high),
      deadLetters,
    };
  }

  return () =>
    withDeadline(sample(), SAMPLE_TIMEOUT_MS, `Kafka did not answer within ${SAMPLE_TIMEOUT_MS} ms`);
}

/** Records a topic holds now: the sum over its partitions of log end minus log start. */
async function countRecords(admin: KafkaJS.Admin, topic: string): Promise<number> {
  const watermarks = await admin.fetchTopicOffsets(topic);
  return watermarks.reduce((sum, w) => sum + Number(BigInt(w.high) - BigInt(w.low)), 0);
}

/** librdkafka keeps retrying an unreachable broker, so every wait on it is bounded. */
export async function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

import type { KafkaJS } from '@confluentinc/kafka-javascript';
import { TOPICS, withTimeout } from '@flashdrop/config';
import { compareOffsets } from './offsets';

/*
 * Consumer lag from the broker's point of view (§13 quiescence: "consumer lag 0"; §12 `fd_consumer_lag`):
 * per partition, the records between the group's committed offset and the end of the log. Neither reader
 * joins the group, so neither disturbs its members.
 *
 * Two readers, because of a client bug: with client 1.10.1 a broker restart that catches the admin API's
 * group offsets request (`admin.fetchOffsets`) in flight aborts the process (SIGABRT, see runner.ts).
 * - `fetchGroupLag` uses it anyway: one-shot tools and tests (verify:invariants, the system tests), where the
 *   crash costs one run.
 * - `createGroupLagReader` is for long-lived processes (the api's admin health): it reads committed offsets
 *   the way the runner reads its own, through a consumer of the group (`committed()`), one that never
 *   subscribes and so never joins.
 * Both read the watermarks with `fetchTopicOffsets`, which the runner's retention check already runs in
 * long-lived processes.
 */

export interface PartitionLag {
  readonly partition: number;
  /** The group's committed offset; null when it has committed nothing on this partition. */
  readonly committed: string | null;
  /** The log end (high watermark). */
  readonly end: string;
  /** Records the group has yet to finish; a group without a commit starts at the log start (earliest). */
  readonly lag: number;
}

type Watermark = Awaited<ReturnType<KafkaJS.Admin['fetchTopicOffsets']>>[number];

/** Lag per partition from the watermarks and the committed offsets (anything below 0: no commit). */
function partitionLags(
  watermarks: readonly Watermark[],
  committed: ReadonlyMap<number, string>,
): PartitionLag[] {
  return watermarks
    .map((w) => {
      const offset = committed.get(w.partition);
      const hasCommit = offset !== undefined && compareOffsets(offset, '0') >= 0;
      // A commit below the log start (retention) resumes at the log start too.
      const from = hasCommit && compareOffsets(offset, w.low) > 0 ? offset : w.low;
      return {
        partition: w.partition,
        committed: hasCommit ? offset : null,
        end: w.high,
        lag: Math.max(0, Number(BigInt(w.high) - BigInt(from))),
      };
    })
    .sort((a, b) => a.partition - b.partition);
}

/** Records `topic` holds now, across its partitions: the sum of high minus low watermarks. */
export async function countTopicRecords(admin: KafkaJS.Admin, topic: string): Promise<number> {
  const watermarks = await admin.fetchTopicOffsets(topic);
  return watermarks.reduce((sum, w) => sum + Number(BigInt(w.high) - BigInt(w.low)), 0);
}

/** One-shot tools and tests only (see the header). */
export async function fetchGroupLag(
  admin: KafkaJS.Admin,
  groupId: string,
  topic: string = TOPICS.orders,
): Promise<PartitionLag[]> {
  const [watermarks, offsets] = await Promise.all([
    admin.fetchTopicOffsets(topic),
    admin.fetchOffsets({ groupId, topics: [topic] }),
  ]);
  const committed = new Map(
    offsets.filter((t) => t.topic === topic).flatMap((t) => t.partitions.map((p) => [p.partition, p.offset])),
  );
  return partitionLags(watermarks, committed);
}

export interface GroupLagReader {
  /** The group's lag on every partition of the topic. Rejects when Kafka does not answer in time. */
  read(groupId: string): Promise<PartitionLag[]>;
  /** Disconnects every client it opened. */
  close(): Promise<void>;
}

export interface GroupLagReaderOptions {
  readonly topic?: string;
  /**
   * Bounds each connect and each read. `committed()` holds a libuv pool thread until the broker answers, so
   * an unbounded read during an outage would pile them up.
   */
  readonly timeoutMs?: number;
}

const CLOSE_TIMEOUT_MS = 3_000;

/** A client that connects once, on first use; a failed connect is retried by the next use. */
interface Lazy<T> {
  readonly client: T;
  ready: Promise<void> | undefined;
}

/** Lag for a long-lived process (see the header). One consumer per group read, kept until `close()`. */
export function createGroupLagReader(
  kafka: KafkaJS.Kafka,
  options: GroupLagReaderOptions = {},
): GroupLagReader {
  const topic = options.topic ?? TOPICS.orders;
  const timeoutMs = options.timeoutMs ?? 2_000;
  const admin: Lazy<KafkaJS.Admin> = { client: kafka.admin(), ready: undefined };
  const consumers = new Map<string, Lazy<KafkaJS.Consumer>>();

  function connect(lazy: Lazy<{ connect(): Promise<void> }>): Promise<void> {
    if (lazy.ready === undefined) {
      const ready = lazy.client.connect();
      lazy.ready = ready;
      ready.catch(() => {
        if (lazy.ready === ready) lazy.ready = undefined;
      });
    }
    return lazy.ready;
  }

  function consumerOf(groupId: string): Lazy<KafkaJS.Consumer> {
    let lazy = consumers.get(groupId);
    if (lazy === undefined) {
      // Never subscribed: it reads the group's offsets from the coordinator without joining the group.
      lazy = { client: kafka.consumer({ kafkaJS: { groupId, autoCommit: false } }), ready: undefined };
      consumers.set(groupId, lazy);
    }
    return lazy;
  }

  async function read(groupId: string): Promise<PartitionLag[]> {
    const consumer = consumerOf(groupId);
    await Promise.all([connect(admin), connect(consumer)]);
    const watermarks = await admin.client.fetchTopicOffsets(topic);
    const offsets = await consumer.client.committed(
      watermarks.map((w) => ({ topic, partition: w.partition })),
      timeoutMs,
    );
    // The client reports a committed offset of 0 as null (its `offset ? offset.toString() : null`) and
    // "nothing committed" as -1001: both mean the group would start at the log start, as far as lag goes.
    return partitionLags(
      watermarks,
      new Map(offsets.map((o): [number, string] => [o.partition, o.offset ?? '-1'])),
    );
  }

  return {
    read: (groupId) =>
      withTimeout(read(groupId), timeoutMs, () => new Error(`Kafka did not answer within ${timeoutMs} ms`)),
    async close() {
      const opened = [admin, ...consumers.values()].filter((lazy) => lazy.ready !== undefined);
      const disconnected = Promise.allSettled(
        opened.map(async (lazy) => {
          await lazy.ready;
          await lazy.client.disconnect();
        }),
      );
      // A connect still waiting for an unreachable broker must not hold up the process's shutdown.
      await withTimeout(disconnected, CLOSE_TIMEOUT_MS, () => new Error('lag reader close timed out')).catch(
        () => undefined,
      );
    },
  };
}

import { setTimeout as sleep } from 'node:timers/promises';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import { TOPICS, withTimeout } from '@flashdrop/config';
import { compareOffsets } from './offsets';

/*
 * Consumer lag from the broker's point of view (§13 quiescence: "consumer lag 0"; §12 `fd_consumer_lag`):
 * per partition, the records between the group's committed offset and the end of the log.
 *
 * The reader reads committed offsets the way the runner reads its own, through a consumer of the group
 * (`committed()`) that never subscribes and so never joins or disturbs the group. It never uses the admin
 * API's group offsets request (`admin.fetchOffsets`), which kills the process with client 1.10.1
 * (librdkafka 2.15.1) in two ways:
 * - SIGSEGV when the broker answers it with a coordinator error (NOT_COORDINATOR, COORDINATOR_NOT_AVAILABLE):
 *   `rd_kafka_handle_OffsetFetch` re-queries the coordinator through the client's consumer group
 *   (`rd_kafka_cgrp_op(rk->rk_cgrp, ...)`), which an admin client does not have. A brand-new broker answers
 *   so while the first group request it gets makes it create `__consumer_offsets`: on CI's fresh infra every
 *   integration run lost a Vitest worker to it. Any coordinator that moves or reloads does the same.
 * - SIGABRT when a broker restart catches it in flight (see runner.ts).
 * A consumer has the group object: on those answers it re-finds the coordinator and rejects the call with the
 * error, so the reader asks again until its deadline (a new broker answers NOT_COORDINATOR for about a second
 * after its first group request). The watermarks come from `fetchTopicOffsets`, which the runner's retention
 * check already runs in long-lived processes.
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

export interface GroupLagReader {
  /**
   * The group's lag on every partition of `topic` (the reader's default topic when omitted). Rejects when
   * Kafka does not answer in time.
   */
  read(groupId: string, topic?: string): Promise<PartitionLag[]>;
  /** Disconnects every client it opened. */
  close(): Promise<void>;
}

export interface GroupLagReaderOptions {
  /** The topic `read` measures when it is given none. */
  readonly topic?: string;
  /**
   * Bounds each connect and each read. `committed()` holds a libuv pool thread until the broker answers, so
   * an unbounded read during an outage would pile them up.
   */
  readonly timeoutMs?: number;
}

const CLOSE_TIMEOUT_MS = 3_000;

/** The broker's answers that mean "ask the group coordinator again": it moved, or it is still loading. */
const COORDINATOR_ERRORS: ReadonlySet<number> = new Set([
  KafkaJS.ErrorCodes.ERR_COORDINATOR_LOAD_IN_PROGRESS,
  KafkaJS.ErrorCodes.ERR_COORDINATOR_NOT_AVAILABLE,
  KafkaJS.ErrorCodes.ERR_NOT_COORDINATOR,
]);
const COORDINATOR_RETRY_MS = 100;

const isCoordinatorError = (error: unknown) =>
  error instanceof KafkaJS.KafkaJSError && COORDINATOR_ERRORS.has(error.code);

/** The group's committed offsets, asked again after each coordinator error until `deadline` (epoch ms). */
async function committedOffsets(
  consumer: KafkaJS.Consumer,
  partitions: KafkaJS.TopicPartition[],
  deadline: number,
): Promise<KafkaJS.TopicPartitionOffsetAndMetadata[]> {
  for (;;) {
    try {
      return await consumer.committed(partitions, Math.max(1, deadline - Date.now()));
    } catch (error) {
      if (!isCoordinatorError(error) || Date.now() + COORDINATOR_RETRY_MS >= deadline) throw error;
      await sleep(COORDINATOR_RETRY_MS);
    }
  }
}

/** A client that connects once, on first use; a failed connect is retried by the next use. */
interface Lazy<T> {
  readonly client: T;
  ready: Promise<void> | undefined;
}

/**
 * The one way to read a group's lag (see the header), for long-lived processes and one-shot tools and tests
 * alike. One consumer per group read, kept until `close()`.
 */
export function createGroupLagReader(
  kafka: KafkaJS.Kafka,
  options: GroupLagReaderOptions = {},
): GroupLagReader {
  const defaultTopic = options.topic ?? TOPICS.orders;
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

  async function read(groupId: string, topic: string): Promise<PartitionLag[]> {
    // The same bound as the caller's timeout, so no retry outlives a read that already rejected.
    const deadline = Date.now() + timeoutMs;
    const consumer = consumerOf(groupId);
    await Promise.all([connect(admin), connect(consumer)]);
    const watermarks = await admin.client.fetchTopicOffsets(topic);
    const offsets = await committedOffsets(
      consumer.client,
      watermarks.map((w) => ({ topic, partition: w.partition })),
      deadline,
    );
    // The client reports a committed offset of 0 as null (its `offset ? offset.toString() : null`) and
    // "nothing committed" as -1001: both mean the group would start at the log start, as far as lag goes.
    return partitionLags(
      watermarks,
      new Map(offsets.map((o): [number, string] => [o.partition, o.offset ?? '-1'])),
    );
  }

  return {
    read: (groupId, topic = defaultTopic) =>
      withTimeout(
        read(groupId, topic),
        timeoutMs,
        () => new Error(`Kafka did not answer within ${timeoutMs} ms`),
      ),
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

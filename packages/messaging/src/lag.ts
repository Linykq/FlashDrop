import type { KafkaJS } from '@confluentinc/kafka-javascript';
import { TOPICS } from '@flashdrop/config';
import { compareOffsets } from './offsets';

/*
 * Consumer lag from the broker's point of view (§13 quiescence: "consumer lag 0"): per partition, the records
 * between the group's committed offset and the end of the log. Read with the admin API, so it works for any
 * group and never touches a running consumer.
 *
 * For one-shot tools and tests only (verify:invariants, the system tests), never a long-lived process: with
 * client 1.10.1 a broker restart that catches `admin.fetchOffsets` in flight aborts the process (SIGABRT,
 * see runner.ts), which costs a tool one run but would take down every replica of a service. The runner
 * reads its own commits with `consumer.committed()` for that reason.
 */

// TODO(M7): `fd_consumer_lag{group}` (§12) runs in a long-lived process; give it a reader on a
// non-subscribing consumer of the group (`committed(partitions, timeoutMs)`, as the runner does) and move the
// tools to it.

export interface PartitionLag {
  readonly partition: number;
  /** The group's committed offset; null when it has committed nothing on this partition. */
  readonly committed: string | null;
  /** The log end (high watermark). */
  readonly end: string;
  /** Records the group has yet to finish; a group without a commit starts at the log start (earliest). */
  readonly lag: number;
}

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

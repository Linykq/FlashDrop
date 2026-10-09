import { randomUUID } from 'node:crypto';
import type { KafkaJS } from '@confluentinc/kafka-javascript';
import { DLQ_REPLAY_GROUP, type Logger, TOPICS } from '@flashdrop/config';
import { describeError } from './errors';
import { type ConsumerRegistry, decodeOrderEvent, dispatchOrderEvent } from './handlers';
import { DLQ_HEADERS, headerText } from './headers';
import { compareOffsets, nextOffset } from './offsets';

/*
 * `pnpm dlq:replay` (design §6.4): reads dead letters and runs, directly, the handler of the consumer named
 * in each one's `x-consumer` header, with the same idempotency checks as a first delivery. It never
 * re-produces to `orders.v1`: that would re-feed every group, and a group whose dedupe record had aged out
 * could apply the event twice.
 *
 * A replay reads from `fromOffset` (default: the log start) to the end the topic had when it began, in
 * order, and stops at the first failure, reporting its offset so the operator can fix the cause and replay
 * from there. Replaying a letter twice is harmless, because every handler is idempotent.
 *
 * Progress is recorded as committed offsets of the `dlq-replay` group (`DLQ_REPLAY_GROUP`), which the admin
 * health tile reads: letters past it are the ones still to act on, and the topic keeps the rest for 30 days
 * as forensics. Per partition the commit moves past a letter only when it and every letter before it in
 * this run were dealt with (replayed, of a type nobody handles any more, undecodable and reported, or below
 * `fromOffset`, which the operator vouches for); a letter left to another consumer by `only`, or one that
 * failed, holds it there. It never moves back, and a dry run commits nothing.
 */

export interface DlqReplayOptions {
  readonly kafka: KafkaJS.Kafka;
  readonly consumers: ConsumerRegistry;
  readonly logger: Logger;
  readonly topic?: string;
  /** Replay only the letters of this consumer; the others are skipped. */
  readonly only?: string;
  /** Skip letters below this offset (on every partition). */
  readonly fromOffset?: string;
  /** Decode and report, but run no handler. */
  readonly dryRun?: boolean;
  /** Where the progress is committed; `DLQ_REPLAY_GROUP` by default (tests pass their own). */
  readonly progressGroup?: string;
  /** Give up if the end is not reached within this long (Kafka unreachable). */
  readonly timeoutMs?: number;
}

export interface ReplayedLetter {
  readonly partition: number;
  readonly offset: string;
  readonly consumer: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly orderId: string;
}

export interface UnreplayableLetter {
  readonly partition: number;
  readonly offset: string;
  readonly consumer: string | undefined;
  readonly error: string;
}

export interface DlqReplayReport {
  /** Letters whose handler ran (or, in a dry run, would run). */
  readonly replayed: readonly ReplayedLetter[];
  /**
   * Letters of an event type their consumer has no handler for (it was taken out since they were written):
   * nothing to run, so they are passed over, as a first delivery of that type would be.
   */
  readonly unhandled: readonly ReplayedLetter[];
  /** Letters whose value is not a valid envelope: nothing can replay them; they stay for forensics. */
  readonly invalid: readonly UnreplayableLetter[];
  /** Letters of other consumers than `only`, or below `fromOffset`. */
  readonly skipped: number;
  /** The letter the replay stopped at: its handler failed, or its consumer is not registered. */
  readonly failed: UnreplayableLetter | undefined;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export async function replayDlq(options: DlqReplayOptions): Promise<DlqReplayReport> {
  const { kafka, consumers, only, dryRun = false } = options;
  const topic = options.topic ?? TOPICS.ordersDlq;
  const logger = options.logger.child({ dlqReplay: topic, dryRun });
  const replayed: ReplayedLetter[] = [];
  const unhandled: ReplayedLetter[] = [];
  const invalid: UnreplayableLetter[] = [];
  let skipped = 0;
  let failed: UnreplayableLetter | undefined;

  if (only !== undefined && consumers[only] === undefined) {
    throw new Error(`unknown consumer ${only}; registered: ${Object.keys(consumers).join(', ')}`);
  }

  // The end of each partition as the replay begins: letters written later wait for the next replay.
  const admin = kafka.admin();
  await admin.connect();
  let ends: Map<number, string>;
  try {
    const watermarks = await admin.fetchTopicOffsets(topic);
    ends = new Map(
      watermarks.filter((w) => compareOffsets(w.high, w.low) > 0).map((w) => [w.partition, w.high]),
    );
  } finally {
    await admin.disconnect();
  }
  if (ends.size === 0) return { replayed, unhandled, invalid, skipped, failed };

  /** Whether the letter is dealt with, so the progress may move past it (see the header). */
  async function replayOne(partition: number, message: KafkaJS.KafkaMessage): Promise<boolean> {
    const consumer = headerText(message.headers, DLQ_HEADERS.consumer);
    const at = { partition, offset: message.offset, consumer };
    if (options.fromOffset !== undefined && compareOffsets(message.offset, options.fromOffset) < 0) {
      skipped++;
      return true;
    }
    if (only !== undefined && consumer !== only) {
      skipped++;
      return false;
    }
    const decoded = decodeOrderEvent(message.value);
    if (!decoded.ok) {
      invalid.push({ ...at, error: decoded.error });
      return true;
    }
    const handlers = consumer === undefined ? undefined : consumers[consumer];
    if (consumer === undefined || handlers === undefined) {
      failed = { ...at, error: `no registered consumer named ${consumer ?? '(missing x-consumer)'}` };
      return false;
    }
    const { event } = decoded;
    const letter = {
      partition,
      offset: message.offset,
      consumer,
      eventId: event.eventId,
      eventType: event.type,
      orderId: event.orderId,
    };
    const log = logger.child(letter);
    if (handlers[event.type] === undefined) {
      log.warn('letter skipped: its consumer has no handler for this event type');
      unhandled.push(letter);
      return true;
    }
    if (!dryRun) {
      try {
        await dispatchOrderEvent(handlers, event, { logger: log });
      } catch (error) {
        log.error({ err: error }, 'replay failed');
        failed = { ...at, error: describeError(error) };
        return false;
      }
    }
    log.info(dryRun ? 'letter would be replayed' : 'letter replayed');
    replayed.push(letter);
    return true;
  }

  // Never subscribes, so it never joins its group: it only reads and commits the group's offsets.
  const progress = dryRun
    ? undefined
    : kafka.consumer({ kafkaJS: { groupId: options.progressGroup ?? DLQ_REPLAY_GROUP, autoCommit: false } });
  /** Per partition, the group's committed offset as this run knows it. */
  const committed = new Map<number, string>();
  /** Partitions whose progress stopped at a letter that was not dealt with. */
  const held = new Set<number>();

  async function advance(partition: number, offset: string): Promise<void> {
    if (progress === undefined || held.has(partition)) return;
    const next = nextOffset(offset);
    const current = committed.get(partition);
    if (current !== undefined && compareOffsets(next, current) <= 0) return;
    await progress.commitOffsets([{ topic, partition, offset: next }]);
    committed.set(partition, next);
  }

  // An ephemeral group that never commits: the replay keeps no position of its own.
  const consumer = kafka.consumer({
    kafkaJS: { groupId: `dlq-replay-${randomUUID()}`, fromBeginning: true, autoCommit: false },
  });
  const finished = Promise.withResolvers<void>();
  let closing = false;
  /** Per partition, the next offset to replay: a redelivered letter is never replayed twice in one run. */
  const next = new Map<number, string>();
  const remaining = new Set(ends.keys());
  const timer = setTimeout(
    () => finished.reject(new Error(`DLQ replay did not reach the end of ${topic} in time`)),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  try {
    if (progress !== undefined) {
      await progress.connect();
      const offsets = await progress.committed([...ends.keys()].map((partition) => ({ topic, partition })));
      for (const { partition, offset } of offsets) {
        // The client reports a committed 0 as null and "nothing committed" as -1001; both mean no progress
        // yet (see lag.ts), despite the declared string type.
        const at = offset ?? '-1';
        if (compareOffsets(at, '0') > 0) committed.set(partition, at);
      }
    }
    await consumer.connect();
    await consumer.subscribe({ topics: [topic] });
    await consumer.run({
      eachBatchAutoResolve: false,
      eachBatch: async ({ batch, resolveOffset }) => {
        const end = ends.get(batch.partition);
        for (const message of batch.messages) {
          if (closing || end === undefined || compareOffsets(message.offset, end) >= 0) break;
          const from = next.get(batch.partition);
          if (from !== undefined && compareOffsets(message.offset, from) < 0) continue;
          const dealtWith = await replayOne(batch.partition, message);
          if (dealtWith) await advance(batch.partition, message.offset);
          else held.add(batch.partition);
          if (failed !== undefined) break;
          // Stored locally so the client reads on from here; never committed, the group is thrown away.
          resolveOffset(message.offset);
          next.set(batch.partition, nextOffset(message.offset));
          if (nextOffset(message.offset) === end) remaining.delete(batch.partition);
        }
        if (failed !== undefined || remaining.size === 0) {
          closing = true;
          finished.resolve();
        }
      },
    });
    await finished.promise;
  } finally {
    clearTimeout(timer);
    await Promise.all([consumer.disconnect(), progress?.disconnect()]);
  }
  return { replayed, unhandled, invalid, skipped, failed };
}

import { randomUUID } from 'node:crypto';
import type { KafkaJS } from '@confluentinc/kafka-javascript';
import { type Logger, TOPICS } from '@flashdrop/config';
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
 * A replay is stateless: it reads from `fromOffset` (default: the log start) to the end the topic had when
 * it began, in order, and stops at the first failure, reporting its offset so the operator can fix the cause
 * and replay from there. Replaying a letter twice is harmless, because every handler is idempotent.
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

  async function replayOne(partition: number, message: KafkaJS.KafkaMessage): Promise<void> {
    const consumer = headerText(message.headers, DLQ_HEADERS.consumer);
    const at = { partition, offset: message.offset, consumer };
    if (options.fromOffset !== undefined && compareOffsets(message.offset, options.fromOffset) < 0) {
      skipped++;
      return;
    }
    if (only !== undefined && consumer !== only) {
      skipped++;
      return;
    }
    const decoded = decodeOrderEvent(message.value);
    if (!decoded.ok) {
      invalid.push({ ...at, error: decoded.error });
      return;
    }
    const handlers = consumer === undefined ? undefined : consumers[consumer];
    if (consumer === undefined || handlers === undefined) {
      failed = { ...at, error: `no registered consumer named ${consumer ?? '(missing x-consumer)'}` };
      return;
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
      return;
    }
    if (!dryRun) {
      try {
        await dispatchOrderEvent(handlers, event, { logger: log });
      } catch (error) {
        log.error({ err: error }, 'replay failed');
        failed = { ...at, error: describeError(error) };
        return;
      }
    }
    log.info(dryRun ? 'letter would be replayed' : 'letter replayed');
    replayed.push(letter);
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
          await replayOne(batch.partition, message);
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
    await consumer.disconnect();
  }
  return { replayed, unhandled, invalid, skipped, failed };
}

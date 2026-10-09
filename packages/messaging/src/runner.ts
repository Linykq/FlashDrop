import { KafkaJS } from '@confluentinc/kafka-javascript';
import { type Logger, TOPICS } from '@flashdrop/config';
import { alert } from '@flashdrop/domain';
import pLimit from 'p-limit';
import { type BackoffPolicy, CONSUMER_BACKOFF, fullJitterDelayMs, UNCLASSIFIED_BACKOFF } from './backoff';
import { groupInOrder, type MessageOutcome, type Retry, runUnits } from './batch';
import { classifyFailure, describeError } from './errors';
import { type DecodedEvent, decodeOrderEvent, dispatchOrderEvent, type OrderEventHandlers } from './handlers';
import { DLQ_HEADERS, EVENT_HEADERS, headersAsText, headerText } from './headers';
import { batchProgress, compareOffsets, nextOffset } from './offsets';
import type { OutgoingRecord, Publisher } from './publisher';

/*
 * The consumer runner (design §6.4, M0 spike §2): one consumer instance per group, so one group's slow batch
 * never stalls another's.
 *
 * - Manual commits: after each batch, resolve and commit only the end of the contiguous finished run
 *   (`batchProgress`). Dead-lettered messages count as finished.
 * - Commits are confirmed. `commitOffsets` resolves once librdkafka has queued the commit (`commitAsync`),
 *   not once the broker accepted it, and the client swallows a later failure (its `offset_commit_cb` is
 *   internal). A commit sent during a cooperative rebalance is refused that way (REBALANCE_IN_PROGRESS), so a
 *   partition that finished its backlog inside the rebalance would keep its old committed offset forever:
 *   lag never reaches 0 (verify:invariants waits for it, §13) and a restart redelivers from there. So every
 *   few seconds the runner reads the group's committed offsets and commits again where its own finished
 *   prefix is ahead (observed in M3: without it, 4 of 5 runs of the runner's rebalance test got stuck).
 * - Committed offsets are read through the consumer (`committed()`), never the admin client's
 *   `fetchOffsets`: with client 1.10.1 (librdkafka 2.15.1) a broker restart that catches an admin group
 *   offsets request in flight kills the process (assertion `eonce->refcnt > 0` in
 *   `rd_kafka_enq_once_del_source_return`, SIGABRT). The commit check runs every 5 s, so every Kafka restart
 *   took both `consumers` replicas down (M4 integration: `checkout-decoupled`, and a probe that crashed
 *   with `fetchOffsets` and survived restarts with `committed()` and `fetchTopicOffsets`).
 * - Grouped concurrency: one unit per order, sequential inside, `p-limit(concurrency)` across units.
 * - Failures: poison (invalid envelope, unknown type, `InvariantViolation`) goes to the DLQ at once;
 *   transient failures pause the partition, seek to the first unfinished offset and resume after a
 *   full-jitter backoff (100 ms -> 30 s), forever. Unclassified failures (anything else, typically a bug)
 *   retry the same way on a slower schedule (1 s -> 30 s), and go to the DLQ only once they failed
 *   `maxUnclassifiedAttempts` times AND for at least `unclassifiedGiveUpMs` (60 s): a deterministic bug
 *   must not stall every product of the partition forever, and an outage the classifier does not know must
 *   not flood the DLQ within a second either. A failure ends only its own order's unit; the batch keeps
 *   starting other orders until `retryBudget` messages failed (`runUnits`).
 * - Bounded batches: the slowest batch in flight gates the whole member (fetches, seeks, rebalances; M0
 *   delta 5), so after `batchDeadlineMs` no new message starts; the batch waits for those in flight (bounded
 *   by the handlers' own timeouts), commits its finished prefix and returns. The client then resumes at the
 *   first unfinished offset by itself.
 * - Health is the owned-partition set, kept from `rebalance_cb`, the client's only rebalance signal. Under
 *   cooperative-sticky a member that gains nothing still gets an assign callback, with an empty list
 *   (M0 delta 3), so "had an assign callback" is not "owns partitions".
 */

export interface ConsumerRunnerOptions {
  readonly kafka: KafkaJS.Kafka;
  /** Written into `x-consumer` on dead letters; `dlq:replay` runs the handlers registered under it. */
  readonly name: string;
  readonly groupId: string;
  readonly handlers: OrderEventHandlers;
  /** Where dead letters go; a message is not finished until the DLQ acknowledged its copy. */
  readonly dlq: Publisher;
  readonly logger: Logger;
  /** Orders processed at once across this consumer's batches (§6.3: payment 32, settlement 16). */
  readonly concurrency: number;
  /** Transient infrastructure errors that do not extend `TransientError` (Postgres, Redis outages). */
  readonly isTransient?: (error: unknown) => boolean;
  readonly topic?: string;
  readonly dlqTopic?: string;
  readonly batchDeadlineMs?: number;
  /** `js.consumer.max.batch.size`: messages per `eachBatch` call. */
  readonly maxBatchSize?: number;
  /** Batches of different partitions in flight at once; the partitions one of two replicas owns. */
  readonly partitionsConsumedConcurrently?: number;
  readonly backoff?: BackoffPolicy;
  /** Deliveries of a message failing with an unclassified error before it may be dead-lettered. */
  readonly maxUnclassifiedAttempts?: number;
  /** How long a message must have kept failing with unclassified errors before it may be dead-lettered. */
  readonly unclassifiedGiveUpMs?: number;
  readonly unclassifiedBackoff?: BackoffPolicy;
  /** Failed messages in one batch after which it starts no new message (`runUnits`). */
  readonly retryBudget?: number;
  /** A partition retrying the same message for this long raises `partition_stuck`. */
  readonly stuckAlertMs?: number;
  /** How often to compare committed offsets with the log start (`offset_below_log_start`). */
  readonly retentionCheckEveryMs?: number;
  /** How often to check that this member's commits landed, and commit again where they did not. */
  readonly commitCheckEveryMs?: number;
}

/** Bounds a committed-offsets read while the coordinator is unreachable (a broker restart). */
const COMMITTED_READ_TIMEOUT_MS = 2_000;

export const RUNNER_DEFAULTS = {
  batchDeadlineMs: 5_000,
  maxBatchSize: 32,
  partitionsConsumedConcurrently: 3,
  maxUnclassifiedAttempts: 5,
  unclassifiedGiveUpMs: 60_000,
  retryBudget: 3,
  stuckAlertMs: 5 * 60_000,
  retentionCheckEveryMs: 60_000,
  commitCheckEveryMs: 5_000,
} as const;

/** Shaped like the worker's loop health, plus what a consumer group adds. */
export interface ConsumerHealth {
  readonly name: string;
  /** True while this member owns at least one partition (§6.4: healthy means assigned). */
  readonly healthy: boolean;
  /** When a batch last finished, ISO 8601; null before the first one. */
  readonly lastOkAt: string | null;
  /** The longest current run of retries of one partition. */
  readonly consecutiveFailures: number;
  readonly lastError: string | null;
  readonly groupId: string;
  readonly partitions: readonly number[];
  /** Paused partitions waiting for their backoff to resume them. */
  readonly retrying: readonly number[];
  /** Partitions that have retried the same message for longer than `stuckAlertMs`. */
  readonly stuck: readonly number[];
}

export interface ConsumerRunner {
  readonly name: string;
  /** Connects, subscribes and starts consuming; resolves once the run loop has started. */
  start(): Promise<void>;
  /** Starts no new message, cancels pending resumes, waits for batches in flight, disconnects. */
  stop(): Promise<void>;
  health(): ConsumerHealth;
}

interface PartitionState {
  /** Batches in a row that ended in a retry without progress: the backoff exponent. */
  retries: number;
  /** When the current run of retries started. */
  stuckSince: number | undefined;
  stuckAlerted: boolean;
  /** The deferred resume of the paused partition: at most one per partition. */
  resumeTimer: NodeJS.Timeout | undefined;
  /** Unclassified failures per offset: how many, and since when. */
  readonly attempts: Map<string, UnclassifiedAttempts>;
  /** The last failure of this partition's current run of retries; cleared by a batch without one. */
  lastError: string | undefined;
  /** The offset after this member's finished prefix: what it last committed, landed or not. */
  processed: string | undefined;
}

interface UnclassifiedAttempts {
  readonly count: number;
  readonly firstFailedAt: number;
}

interface Incoming {
  readonly message: KafkaJS.KafkaMessage;
  readonly decoded: DecodedEvent;
}

const DONE: MessageOutcome = { kind: 'done' };
const MAX_ERROR_HEADER_LENGTH = 2_000;

const codes = KafkaJS.ErrorCodes;

export function createConsumerRunner(options: ConsumerRunnerOptions): ConsumerRunner {
  const { kafka, name, groupId, handlers, dlq } = options;
  const topic = options.topic ?? TOPICS.orders;
  const dlqTopic = options.dlqTopic ?? TOPICS.ordersDlq;
  const isTransient = options.isTransient ?? (() => false);
  const batchDeadlineMs = options.batchDeadlineMs ?? RUNNER_DEFAULTS.batchDeadlineMs;
  const backoff = options.backoff ?? CONSUMER_BACKOFF;
  const maxUnclassifiedAttempts = options.maxUnclassifiedAttempts ?? RUNNER_DEFAULTS.maxUnclassifiedAttempts;
  const unclassifiedGiveUpMs = options.unclassifiedGiveUpMs ?? RUNNER_DEFAULTS.unclassifiedGiveUpMs;
  const unclassifiedBackoff = options.unclassifiedBackoff ?? UNCLASSIFIED_BACKOFF;
  const retryBudget = options.retryBudget ?? RUNNER_DEFAULTS.retryBudget;
  const stuckAlertMs = options.stuckAlertMs ?? RUNNER_DEFAULTS.stuckAlertMs;
  const logger = options.logger.child({ consumer: name, groupId, topic });

  const limit = pLimit(options.concurrency);
  const owned = new Set<number>();
  const partitions = new Map<number, PartitionState>();
  const belowLogStart = new Set<number>();
  let started = false;
  let stopping = false;
  let lastBatchAt: number | undefined;
  let retentionTimer: NodeJS.Timeout | undefined;
  let checkingRetention = false;
  let commitCheckTimer: NodeJS.Timeout | undefined;
  let checkingCommits = false;

  const stateOf = (partition: number): PartitionState => {
    let state = partitions.get(partition);
    if (state === undefined) {
      state = {
        retries: 0,
        stuckSince: undefined,
        stuckAlerted: false,
        resumeTimer: undefined,
        attempts: new Map(),
        lastError: undefined,
        processed: undefined,
      };
      partitions.set(partition, state);
    }
    return state;
  };

  /** Called by the client before it applies an assignment change; the client then (un)assigns itself. */
  function onRebalance(error: KafkaJS.LibrdKafkaError, assignment: KafkaJS.TopicPartition[]): void {
    const changed = assignment.filter((tp) => tp.topic === topic).map((tp) => tp.partition);
    if (error.code === codes.ERR__ASSIGN_PARTITIONS) {
      for (const partition of changed) owned.add(partition);
      logger.info({ assigned: changed, owned: [...owned] }, 'partitions assigned');
      if (changed.length > 0) void checkRetention();
    } else if (error.code === codes.ERR__REVOKE_PARTITIONS) {
      for (const partition of changed) release(partition);
      logger.info({ revoked: changed, owned: [...owned] }, 'partitions revoked');
    }
  }

  const consumer = kafka.consumer({
    kafkaJS: {
      groupId,
      // auto.offset.reset=earliest: a group without committed offsets (every new CI group) must not skip
      // events produced before its first assignment. Safe because every handler is idempotent (§6.4).
      fromBeginning: true,
      autoCommit: false,
      partitionAssigners: [KafkaJS.PartitionAssigners.cooperativeSticky],
    },
    'js.consumer.max.batch.size': options.maxBatchSize ?? RUNNER_DEFAULTS.maxBatchSize,
    rebalance_cb: onRebalance,
  });
  // Watermarks only (`fetchTopicOffsets`), for the retention check: see the header on group offsets.
  const admin = kafka.admin();

  /**
   * The group's committed offsets for `owned` partitions, through this consumer's own coordinator. The read
   * blocks a libuv pool thread until it returns, so it is bounded, and each check runs one at a time.
   */
  async function committedOffsets(ownedNow: readonly number[]): Promise<Map<number, string>> {
    const offsets = await consumer.committed(
      ownedNow.map((partition) => ({ topic, partition })),
      COMMITTED_READ_TIMEOUT_MS,
    );
    // The client reports a committed offset of 0 as null (its `offset ? offset.toString() : null`), and
    // "nothing committed" as -1001: both compare below every offset this member could have finished.
    return new Map(offsets.map((o): [number, string] => [o.partition, o.offset ?? '-1']));
  }

  /** Forgets a revoked partition. Its deferred resume is cancelled: a resume() after disconnect kills the process. */
  function release(partition: number): void {
    owned.delete(partition);
    belowLogStart.delete(partition);
    const state = partitions.get(partition);
    partitions.delete(partition);
    if (state?.resumeTimer === undefined) return;
    clearTimeout(state.resumeTimer);
    // Resume now instead, before the client applies the revoke: the client keeps its paused set across a
    // revoke, so if this member got the partition back later, nothing would ever resume it.
    try {
      consumer.resume([{ topic, partitions: [partition] }]);
    } catch (err) {
      logger.debug({ err, partition }, 'resume on revoke skipped'); // ERR__STATE: disconnecting
    }
  }

  async function deadLetter(
    partition: number,
    message: KafkaJS.KafkaMessage,
    error: string,
    attempts: number,
    reason: 'invalid' | 'invariant' | 'exhausted',
    log: Logger,
  ): Promise<MessageOutcome> {
    const record: OutgoingRecord = {
      topic: dlqTopic,
      key: message.key,
      value: message.value,
      headers: {
        ...headersAsText(message.headers),
        [DLQ_HEADERS.consumer]: name,
        [DLQ_HEADERS.error]: error.slice(0, MAX_ERROR_HEADER_LENGTH),
        [DLQ_HEADERS.attempts]: String(attempts),
        [DLQ_HEADERS.origPartition]: String(partition),
        [DLQ_HEADERS.origOffset]: message.offset,
      },
    };
    try {
      await dlq.publish([record]);
    } catch (dlqError) {
      log.warn({ err: dlqError }, 'dead-letter write failed; retrying the message');
      return { kind: 'retry', reason: 'dlq_unavailable', error: dlqError };
    }
    alert(log, 'dlq_write', { reason, attempts, error }, 'message dead-lettered');
    return DONE;
  }

  async function work(
    partition: number,
    state: PartitionState,
    { message, decoded }: Incoming,
  ): Promise<MessageOutcome> {
    const base = { partition, offset: message.offset };
    if (!decoded.ok) return deadLetter(partition, message, decoded.error, 1, 'invalid', logger.child(base));
    const { event } = decoded;
    const log = logger.child({
      ...base,
      eventId: event.eventId,
      eventType: event.type,
      orderId: event.orderId,
      traceId: event.traceId ?? headerText(message.headers, EVENT_HEADERS.traceId),
    });
    try {
      await dispatchOrderEvent(handlers, event, { logger: log });
      state.attempts.delete(message.offset);
      return DONE;
    } catch (error) {
      const described = describeError(error);
      state.lastError = described;
      const failure = classifyFailure(error, isTransient);
      if (failure === 'transient') {
        log.warn({ err: error }, 'transient failure; the partition retries after a backoff');
        return { kind: 'retry', reason: 'transient', error };
      }
      const now = Date.now();
      const previous = state.attempts.get(message.offset);
      const attempts = (previous?.count ?? 0) + 1;
      const firstFailedAt = previous?.firstFailedAt ?? now;
      const keepTrying = attempts < maxUnclassifiedAttempts || now - firstFailedAt < unclassifiedGiveUpMs;
      if (failure === 'unclassified' && keepTrying) {
        state.attempts.set(message.offset, { count: attempts, firstFailedAt });
        log.error({ err: error, attempts, failingForMs: now - firstFailedAt }, 'handler failed; retrying');
        return { kind: 'retry', reason: 'unclassified', error };
      }
      state.attempts.delete(message.offset);
      const reason = failure === 'poison' ? 'invariant' : 'exhausted';
      return deadLetter(partition, message, described, attempts, reason, log);
    }
  }

  async function commit(partition: number, offset: string): Promise<void> {
    try {
      await consumer.commitOffsets([{ topic, partition, offset }]);
    } catch (err) {
      // Not fatal: the stored offset goes out with the next commit, and a new owner after a rebalance
      // merely redelivers what this one finished.
      logger.warn({ err, partition, offset }, 'offset commit failed');
    }
  }

  function scheduleRetry(
    payload: KafkaJS.EachBatchPayload,
    state: PartitionState,
    firstPending: string,
    retry: Retry,
  ): void {
    const { partition } = payload.batch;
    const policy = retry.reason === 'unclassified' ? unclassifiedBackoff : backoff;
    const delayMs = fullJitterDelayMs(policy, state.retries);
    state.retries++;
    const now = Date.now();
    state.stuckSince ??= now;
    if (!state.stuckAlerted && now - state.stuckSince >= stuckAlertMs) {
      state.stuckAlerted = true;
      alert(
        logger,
        'partition_stuck',
        {
          partition,
          offset: firstPending,
          stuckForMs: now - state.stuckSince,
          error: describeError(retry.error),
        },
        'partition stuck on one message',
      );
    }
    // pause() stops fetching for this partition only, and its resume is armed before anything else can
    // throw, so a paused partition always has one. Backoff is that deferred resume, never a sleep here.
    const resume = payload.pause();
    clearTimeout(state.resumeTimer);
    state.resumeTimer = setTimeout(() => {
      state.resumeTimer = undefined;
      try {
        resume();
      } catch (err) {
        logger.debug({ err, partition }, 'deferred resume skipped'); // ERR__STATE: disconnected meanwhile
      }
    }, delayMs);
    // The explicit seek moves the partition back to the first unfinished message, which the client's own
    // seek-back (after the highest resolved offset) would miss once later messages finished first (M0
    // delta 4). Only the contiguous prefix is resolved, so if the seek failed, that seek-back lands on the
    // same offset.
    try {
      consumer.seek({ topic, partition, offset: firstPending });
    } catch (err) {
      logger.warn({ err, partition, offset: firstPending }, 'seek failed; relying on the client seek-back');
    }
    logger.info(
      { partition, offset: firstPending, reason: retry.reason, retries: state.retries, retryInMs: delayMs },
      'partition paused for a retry',
    );
  }

  async function eachBatch(payload: KafkaJS.EachBatchPayload): Promise<void> {
    const { batch } = payload;
    const state = stateOf(batch.partition);
    const deadline = Date.now() + batchDeadlineMs;
    logger.debug(
      {
        partition: batch.partition,
        firstOffset: batch.messages[0]?.offset,
        lastOffset: batch.messages.at(-1)?.offset,
        size: batch.messages.length,
      },
      'batch received',
    );
    const incoming: Incoming[] = batch.messages.map((message) => ({
      message,
      decoded: decodeOrderEvent(message.value),
    }));
    // Invalid messages are units of their own: they have no order to belong to.
    const units = groupInOrder(incoming, ({ message, decoded }) =>
      decoded.ok ? `order:${decoded.event.orderId}` : `offset:${message.offset}`,
    );
    const { done, retry } = await runUnits(units, {
      limit,
      mayStart: () => !stopping && !payload.isStale() && Date.now() < deadline,
      retryBudget,
      work: (item) => work(batch.partition, state, item),
    });

    const doneOffsets = new Set([...done].map((item) => item.message.offset));
    const { lastDone, firstPending } = batchProgress(
      batch.messages.map((message) => message.offset),
      doneOffsets,
    );
    lastBatchAt = Date.now();
    if (retry === undefined) state.lastError = undefined;
    if (lastDone !== undefined) {
      payload.resolveOffset(lastDone);
      state.processed = nextOffset(lastDone);
      await commit(batch.partition, state.processed);
      for (const offset of state.attempts.keys()) {
        if (compareOffsets(offset, lastDone) <= 0) state.attempts.delete(offset);
      }
      if (state.stuckAlerted) logger.info({ partition: batch.partition }, 'stuck partition moving again');
      state.retries = 0;
      state.stuckSince = undefined;
      state.stuckAlerted = false;
    }
    // Past the deadline or stopping, the client itself resumes at the first unfinished offset (the one after
    // the highest resolved), which is exactly `firstPending` because only the contiguous prefix is resolved.
    if (firstPending === undefined || retry === undefined || stopping) return;
    scheduleRetry(payload, state, firstPending, retry);
  }

  /**
   * Commits again, for each owned partition, the finished prefix whose commit the broker does not have (see
   * the header). Only forward: a partition revoked meanwhile has no state left, and one still owned only
   * moves to an offset this member finished. A late repeat that lands after a newer commit of the same
   * partition is corrected by the next check.
   */
  async function confirmCommits(): Promise<void> {
    if (checkingCommits || owned.size === 0 || stopping) return;
    checkingCommits = true;
    try {
      const landed = await committedOffsets([...owned]);
      for (const partition of owned) {
        const processed = partitions.get(partition)?.processed;
        if (processed === undefined || stopping) continue;
        const offset = landed.get(partition);
        // '-1' (nothing committed) compares below every offset.
        if (offset !== undefined && compareOffsets(offset, processed) >= 0) continue;
        logger.info(
          { partition, committed: offset ?? null, processed },
          'commit did not land; committing again',
        );
        await commit(partition, processed);
      }
    } catch (err) {
      logger.warn({ err }, 'commit check failed');
    } finally {
      checkingCommits = false;
    }
  }

  async function checkRetention(): Promise<void> {
    if (checkingRetention || owned.size === 0 || stopping) return;
    checkingRetention = true;
    try {
      const [watermarks, commits] = await Promise.all([
        admin.fetchTopicOffsets(topic),
        committedOffsets([...owned]),
      ]);
      const logStart = new Map(watermarks.map((w) => [w.partition, w.low]));
      for (const partition of owned) {
        const offset = commits.get(partition);
        const low = logStart.get(partition);
        // -1: nothing committed yet, so the group starts at the log start (earliest).
        if (offset === undefined || low === undefined || compareOffsets(offset, '0') < 0) continue;
        if (compareOffsets(offset, low) >= 0) {
          belowLogStart.delete(partition);
        } else if (!belowLogStart.has(partition)) {
          belowLogStart.add(partition);
          alert(
            logger,
            'offset_below_log_start',
            { partition, committed: offset, logStart: low },
            'retention deleted events this group never processed',
          );
        }
      }
    } catch (err) {
      logger.warn({ err }, 'retention check failed');
    } finally {
      checkingRetention = false;
    }
  }

  return {
    name,
    async start() {
      if (started) throw new Error(`consumer ${name} already started`);
      started = true;
      // The dead-letter producer connects now rather than inside the first batch that needs it: a batch's
      // budget is its deadline plus the PSP timeout, and a connect may take longer.
      await dlq.ready();
      await admin.connect();
      await consumer.connect();
      await consumer.subscribe({ topics: [topic] });
      await consumer.run({
        eachBatchAutoResolve: false,
        partitionsConsumedConcurrently:
          options.partitionsConsumedConcurrently ?? RUNNER_DEFAULTS.partitionsConsumedConcurrently,
        eachBatch,
      });
      retentionTimer = setInterval(
        () => void checkRetention(),
        options.retentionCheckEveryMs ?? RUNNER_DEFAULTS.retentionCheckEveryMs,
      );
      commitCheckTimer = setInterval(
        () => void confirmCommits(),
        options.commitCheckEveryMs ?? RUNNER_DEFAULTS.commitCheckEveryMs,
      );
      logger.info('consumer started');
    },
    async stop() {
      if (stopping) return;
      stopping = true;
      clearInterval(retentionTimer);
      clearInterval(commitCheckTimer);
      // Before disconnect(): a deferred resume() that fires after it throws, uncaught (M0 delta 4).
      for (const state of partitions.values()) {
        clearTimeout(state.resumeTimer);
        state.resumeTimer = undefined;
      }
      // Waits for the batches in flight; they start no new message once `stopping` is set.
      await consumer.disconnect();
      await admin.disconnect();
      owned.clear();
      logger.info('consumer stopped');
    },
    health() {
      const states = [...partitions.entries()];
      // The error of the partition that has retried longest, if any is retrying.
      const failing = states
        .map(([, state]) => state)
        .filter((state) => state.lastError !== undefined)
        .sort((a, b) => b.retries - a.retries);
      return {
        name,
        healthy: started && !stopping && owned.size > 0,
        lastOkAt: lastBatchAt === undefined ? null : new Date(lastBatchAt).toISOString(),
        consecutiveFailures: Math.max(0, ...states.map(([, state]) => state.retries)),
        lastError: failing[0]?.lastError ?? null,
        groupId,
        partitions: [...owned].sort((a, b) => a - b),
        retrying: states.filter(([, s]) => s.resumeTimer !== undefined).map(([p]) => p),
        stuck: states.filter(([, s]) => s.stuckAlerted).map(([p]) => p),
      };
    },
  };
}

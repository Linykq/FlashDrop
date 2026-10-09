import type { Logger } from '@flashdrop/config';
import {
  type Db,
  deleteExpiredProcessedEvents,
  deletePublishedOutbox,
  type OutboxMessage,
  RELAY_BATCH,
  type RelayBatch,
  relayOutboxBatch,
} from '@flashdrop/db';
import { alert } from '@flashdrop/domain';
import { z } from 'zod';
import { type BackoffPolicy, fullJitterDelayMs, RELAY_BACKOFF } from './backoff';
import { describeError } from './errors';
import { EVENT_HEADERS } from './headers';
import { type OutgoingRecord, PublishError, type Publisher } from './publisher';

/*
 * The outbox relay loop (design §5.4), run by the worker's `relay` role:
 *
 *   loop: wait for a NOTIFY outbox (`wake`) or 250 ms
 *     connect the producer if needed (`Publisher.ready`, bounded at 8 s) with no transaction open, so a
 *     broker outage at start or after a fatal producer error never holds rows or the xmin horizon
 *     one fenced batch in one transaction (`relayOutboxBatch`): advisory xact lock, claim up to 500 rows
 *     FOR UPDATE in id order, publish them awaiting the broker acks, mark them, commit
 *     on failure: the transaction rolled back (or none was opened); back off 1 s -> 30 s with full jitter
 *   hourly, beside the loop: delete rows published more than 7 days ago, then consumer dedupe records past
 *   their 45 days (`processed_events`, §3), 5,000 per statement
 *
 * - Every send settles (acked or failed) within `message.timeout.ms` (10 s), below the relay session's
 *   `transaction_timeout` (20 s), and the publisher rejects only after every record settled, so a failed
 *   batch rolls back with nothing left in flight, and an outage pins a transaction (and the xmin horizon)
 *   for about 10 s at most.
 * - A crash after the send and before the commit republishes the batch: consumers dedupe (§6.4).
 * - Per-order order: an order's next event has a higher id and goes out later in the same batch or in a
 *   later one; the batch is sent in id order and the idempotent producer keeps each partition's send order.
 */

/** The relay's Postgres side: the db package's relay statements, on a pool with `POOL_PROFILES.relay`. */
export interface RelayStore {
  /** One fenced batch; `publish` runs inside its transaction, and its rejection rolls the batch back. */
  publishBatch(
    publish: (messages: readonly OutboxMessage[]) => Promise<void>,
    limit: number,
  ): Promise<RelayBatch>;
  /** Deletes the rows past retention; returns how many. */
  deletePublished(): Promise<number>;
  /** Deletes the consumers' dedupe records past retention; returns how many. */
  deleteProcessed(): Promise<number>;
}

/** The store over `db`, which must come from a pool with `POOL_PROFILES.relay` (§5.4 session limits). */
export function outboxRelayStore(db: Db): RelayStore {
  return {
    publishBatch: (publish, limit) => relayOutboxBatch(db, publish, { limit }),
    deletePublished: () => deletePublishedOutbox(db),
    deleteProcessed: () => deleteExpiredProcessedEvents(db),
  };
}

export interface RelayOptions {
  readonly store: RelayStore;
  readonly publisher: Publisher;
  readonly logger: Logger;
  readonly batchSize?: number;
  readonly pollMs?: number;
  readonly backoff?: BackoffPolicy;
  readonly cleanupEveryMs?: number;
  /** The oldest unpublished row older than this raises `outbox_lag`. */
  readonly lagAlertMs?: number;
}

export const RELAY_DEFAULTS = {
  batchSize: RELAY_BATCH,
  pollMs: 250,
  cleanupEveryMs: 60 * 60_000,
  lagAlertMs: 10_000,
} as const;

/** One alert line per condition per minute: an outage would otherwise alert on every retry. */
const ALERT_EVERY_MS = 60_000;
/** A failed cleanup is retried after this long rather than an hour later. */
const CLEANUP_RETRY_MS = 60_000;
/** Healthy while a batch (or a fenced-out attempt) succeeded this recently. */
const HEALTHY_WITHIN_MS = 30_000;

export interface RelayHealth {
  readonly name: 'relay';
  readonly healthy: boolean;
  readonly lastOkAt: string | null;
  readonly consecutiveFailures: number;
  readonly lastError: string | null;
  /**
   * Age of the oldest row of the last batch this relay claimed (0 when none was due); null before its first
   * claim. A standby fenced out by the active relay does not update it.
   */
  readonly oldestUnpublishedMs: number | null;
  /** Rows published (and committed) since start. */
  readonly published: number;
}

export interface Relay {
  start(): void;
  /**
   * A `NOTIFY outbox` arrived, or the LISTEN connection was (re)established: poll now instead of at the
   * next tick. A wake during a failure backoff does not cut the backoff short.
   */
  wake(): void;
  /**
   * Stops after the batch and the cleanup in flight, which commit or roll back as usual. A wait for the
   * producer to connect is abandoned at once: no transaction is open during it.
   */
  stop(): Promise<void>;
  health(now?: number): RelayHealth;
}

const SchemaVersioned = z.object({ schemaVersion: z.int() });

/** The Kafka record of an outbox row: keyed by productId, with the event headers of §5.4. */
export function outboxRecord(row: OutboxMessage): OutgoingRecord {
  const versioned = SchemaVersioned.safeParse(row.payload);
  return {
    topic: row.topic,
    key: row.partitionKey,
    value: JSON.stringify(row.payload),
    headers: {
      ...row.headers,
      [EVENT_HEADERS.eventId]: row.eventId,
      [EVENT_HEADERS.eventType]: row.eventType,
      ...(versioned.success ? { [EVENT_HEADERS.schemaVersion]: String(versioned.data.schemaVersion) } : {}),
    },
  };
}

export function createRelay(options: RelayOptions): Relay {
  const { store, publisher } = options;
  const batchSize = options.batchSize ?? RELAY_DEFAULTS.batchSize;
  const pollMs = options.pollMs ?? RELAY_DEFAULTS.pollMs;
  const backoff = options.backoff ?? RELAY_BACKOFF;
  const cleanupEveryMs = options.cleanupEveryMs ?? RELAY_DEFAULTS.cleanupEveryMs;
  const lagAlertMs = options.lagAlertMs ?? RELAY_DEFAULTS.lagAlertMs;
  const logger = options.logger.child({ component: 'relay' });

  let running = false;
  let stopped = false;
  let loopDone: Promise<void> | undefined;
  /** The wait in progress between batches; `wakeable` is false during a failure backoff. */
  let waiting: { readonly end: () => void; readonly wakeable: boolean } | undefined;
  /** A wake that arrived while a batch ran: the next poll wait is skipped. */
  let woken = false;
  let failures = 0;
  let lastOkAt: number | undefined;
  let lastError: string | undefined;
  let oldestUnpublishedMs: number | null = null;
  let published = 0;
  let lagAlertedAt = Number.NEGATIVE_INFINITY;
  let rejectedAlertedAt = Number.NEGATIVE_INFINITY;
  let cleanupTimer: NodeJS.Timeout | undefined;
  let cleanupDone: Promise<void> | undefined;
  let signalStop = () => {};
  const stopRequested = new Promise<void>((resolve) => {
    signalStop = resolve;
  });

  const wait = (ms: number, wakeable: boolean) =>
    new Promise<void>((resolve) => {
      if (stopped || (wakeable && woken)) {
        woken = false;
        resolve();
        return;
      }
      const timer = setTimeout(() => end(), ms);
      const end = () => {
        clearTimeout(timer);
        waiting = undefined;
        resolve();
      };
      waiting = { end, wakeable };
    });

  /** Claims are in id order, which is not commit order, so the oldest row may sit anywhere in the batch. */
  const observeLag = (messages: readonly OutboxMessage[]) => {
    const now = Date.now();
    const oldest = messages.reduce((min, message) => Math.min(min, message.createdAt.getTime()), now);
    oldestUnpublishedMs = Math.max(0, now - oldest);
    if (oldestUnpublishedMs > lagAlertMs && now - lagAlertedAt >= ALERT_EVERY_MS) {
      lagAlertedAt = now;
      alert(logger, 'outbox_lag', { oldestUnpublishedMs, due: messages.length }, 'outbox is behind');
    }
  };

  const runBatch = () =>
    store.publishBatch(async (messages) => {
      observeLag(messages);
      await publisher.publish(messages.map(outboxRecord));
    }, batchSize);

  /** False when the relay stopped while it waited. A failed connect rejects, like a failed batch. */
  const producerReady = async (): Promise<boolean> => {
    await Promise.race([publisher.ready(), stopRequested]);
    return !stopped;
  };

  const onFailure = (error: unknown, retryInMs: number) => {
    const now = Date.now();
    if (error instanceof PublishError && !error.transient) {
      if (now - rejectedAlertedAt >= ALERT_EVERY_MS) {
        rejectedAlertedAt = now;
        alert(
          logger,
          'relay_rejected',
          { err: error, failures, retryInMs },
          'kafka refuses an outbox record',
        );
      }
      return;
    }
    logger.warn({ err: error, failures, retryInMs }, 'relay batch failed; rolled back');
  };

  const loop = async () => {
    while (!stopped) {
      let pause: { readonly ms: number; readonly wakeable: boolean };
      try {
        if (!(await producerReady())) return;
        const batch = await runBatch();
        if (failures > 0) logger.info({ failures }, 'relay recovered');
        failures = 0;
        lastOkAt = Date.now();
        lastError = undefined;
        if (batch.kind === 'published') {
          if (batch.messages.length === 0) oldestUnpublishedMs = 0;
          published += batch.messages.length;
        }
        // A full batch means more rows are due: claim the next one at once.
        const full = batch.kind === 'published' && batch.messages.length >= batchSize;
        pause = { ms: full ? 0 : pollMs, wakeable: true };
      } catch (error) {
        failures++;
        lastError = describeError(error);
        pause = { ms: fullJitterDelayMs(backoff, failures - 1), wakeable: false };
        onFailure(error, pause.ms);
      }
      if (pause.ms > 0) await wait(pause.ms, pause.wakeable);
    }
  };

  /** Beside the loop, not in it: a large cleanup must not hold up publishing. */
  const cleanup = () => {
    cleanupTimer = undefined;
    if (stopped) return;
    cleanupDone = (async () => {
      let nextInMs = cleanupEveryMs;
      try {
        const deleted = await store.deletePublished();
        if (deleted > 0) logger.info({ deleted }, 'deleted published outbox rows past retention');
        // The relay is the pipeline's one hourly housekeeper; the consumers keep no timer of their own.
        const records = await store.deleteProcessed();
        if (records > 0) logger.info({ deleted: records }, 'deleted consumer dedupe records past retention');
      } catch (err) {
        logger.warn({ err }, 'outbox cleanup failed');
        nextInMs = CLEANUP_RETRY_MS;
      }
      if (!stopped) cleanupTimer = setTimeout(cleanup, nextInMs);
    })();
  };

  return {
    start() {
      if (running || stopped) return;
      running = true;
      loopDone = loop().catch((err: unknown) => logger.fatal({ err }, 'relay loop crashed'));
      cleanup();
    },
    wake() {
      if (waiting?.wakeable) waiting.end();
      else woken = true;
    },
    async stop() {
      stopped = true;
      signalStop();
      clearTimeout(cleanupTimer);
      waiting?.end();
      await Promise.all([loopDone, cleanupDone]);
    },
    health(now = Date.now()) {
      return {
        name: 'relay',
        healthy: running && !stopped && lastOkAt !== undefined && now - lastOkAt <= HEALTHY_WITHIN_MS,
        lastOkAt: lastOkAt === undefined ? null : new Date(lastOkAt).toISOString(),
        consecutiveFailures: failures,
        lastError: lastError ?? null,
        oldestUnpublishedMs,
        published,
      };
    },
  };
}

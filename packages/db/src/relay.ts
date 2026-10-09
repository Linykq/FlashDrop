import { BugError } from '@flashdrop/domain';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Executor } from './client';
import { PgTimestamp, PgUuid, parseRows } from './rows';
import { transaction } from './transaction';

/*
 * The outbox relay's statements (design §5.4, worker `relay` role). Every status change wrote its event to
 * `outbox` in its own transaction; the relay publishes the rows to Kafka and marks them, so an event reaches
 * Kafka if and only if its change committed (INV-5), at least once.
 *
 * Status-based polling, not an id cursor: identity order is not commit order, so `WHERE id > last` would
 * skip a row that commits late, a lost event. Any row still `published_at IS NULL` is picked up by the next
 * poll, however late it committed.
 */

/** Rows one batch publishes at most (the relay loop's `RELAY_DEFAULTS.batchSize`). */
export const RELAY_BATCH = 500;

/** How long published rows are kept: as long as Kafka keeps the events (§6.1). */
export const OUTBOX_RETENTION_SECONDS = 7 * 24 * 60 * 60;

/** Rows one cleanup statement deletes at most, so no single delete holds locks or WAL for long. */
export const OUTBOX_CLEANUP_BATCH = 5_000;

/** One outbox row, as the relay turns it into a Kafka message. */
export interface OutboxMessage {
  /** `outbox.id` (bigint) as text; only ever handed back to Postgres. */
  readonly id: string;
  /** uuidv7, the consumers' dedupe key; the `event-id` header. */
  readonly eventId: string;
  readonly topic: string;
  /** The productId: the message key, so every event of an order lands on one partition (§6.1). */
  readonly partitionKey: string;
  /** The `event-type` header. */
  readonly eventType: string;
  /** The `OrderEvent` envelope, validated before the insert; the message value. */
  readonly payload: Record<string, unknown>;
  /** Extra headers recorded with the event (`trace-id`). */
  readonly headers: Readonly<Record<string, string>>;
  readonly createdAt: Date;
}

const OutboxRow = z
  .object({
    id: z.string().regex(/^\d+$/),
    event_id: PgUuid,
    topic: z.string(),
    partition_key: z.string(),
    event_type: z.string(),
    payload: z.record(z.string(), z.unknown()),
    headers: z.record(z.string(), z.string()),
    created_at: PgTimestamp,
  })
  .transform(
    (row): OutboxMessage => ({
      id: row.id,
      eventId: row.event_id,
      topic: row.topic,
      partitionKey: row.partition_key,
      eventType: row.event_type,
      payload: row.payload,
      headers: row.headers,
      createdAt: row.created_at,
    }),
  );

export type RelayBatch =
  /** Another relay holds the publisher lock; try again at the next poll. */
  | { readonly kind: 'busy' }
  /** Published and marked, oldest first; empty when nothing was pending. */
  | { readonly kind: 'published'; readonly messages: readonly OutboxMessage[] };

/**
 * One relay batch (§5.4), all in ONE transaction on a pool with `POOL_PROFILES.relay`
 * (`idle_in_transaction_session_timeout=30s`, `transaction_timeout=20s`):
 *
 *   1. `pg_try_advisory_xact_lock(hashtext('fd.relay'))`, or give up (`busy`): one publisher at a time;
 *   2. lock up to `limit` unpublished rows, `ORDER BY id ... FOR UPDATE`;
 *   3. `publish(messages)`: it must resolve only once the broker acknowledged every message, and settle
 *      within the producer's `message.timeout.ms` (10 s), well inside `transaction_timeout`;
 *   4. mark them `published_at = now()` and commit.
 *
 * If `publish` throws, the transaction rolls back: the rows stay unpublished and the next batch sends them
 * again. The lock is transaction-scoped on this connection, so a relay that dies mid-batch (or whose
 * session Postgres ends) releases both the lock and its rows at once, and a standby takes over at its next
 * poll. Only a relay that lost its Postgres session while its send was still in flight can make the standby
 * re-send rows the broker then receives twice; consumers dedupe (§6.4). Per-order ordering holds: an
 * order's next event is written by a transaction that starts after the previous one committed, so it has a
 * higher id and goes out in the same batch, later in it, or in a later batch.
 *
 * Plain `FOR UPDATE`, not `SKIP LOCKED`: the advisory lock already admits one publisher, so skipping buys
 * nothing, and it would let a row that another session happens to lock (a probe, a psql `FOR UPDATE`) be
 * passed over while the same order's later row goes out first: `order.expired` before `order.placed`. A
 * locked row delays the batch instead, for as long as that session holds it (bounded by the relay's
 * `transaction_timeout`).
 */
export async function relayOutboxBatch(
  db: Db,
  publish: (messages: readonly OutboxMessage[]) => Promise<void>,
  options: { readonly limit?: number } = {},
): Promise<RelayBatch> {
  return transaction(db, async (tx): Promise<RelayBatch> => {
    const lock = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(hashtext('fd.relay')) AS locked`);
    if (parseRows(z.object({ locked: z.boolean() }), lock.rows, 'relay lock')[0]?.locked !== true) {
      return { kind: 'busy' };
    }
    // `ORDER BY outbox.id`, qualified: a bare `id` would name the text alias of the select list, and sort
    // 1, 10, 100, 11, 2: an order's later event could then go out before its earlier one.
    const { rows } = await tx.execute(sql`
      SELECT id::text AS id, event_id, topic, partition_key, event_type, payload, headers, created_at
      FROM outbox WHERE published_at IS NULL
      ORDER BY outbox.id LIMIT ${options.limit ?? RELAY_BATCH} FOR UPDATE`);
    const messages = parseRows(OutboxRow, rows, 'relay batch');
    if (messages.length === 0) return { kind: 'published', messages };

    await publish(messages);
    const ids = messages.map((message) => message.id);
    const marked = await tx.execute(sql`
      UPDATE outbox SET published_at = now() WHERE id = ANY(${sql.param(ids)}::bigint[])`);
    if (marked.rowCount !== ids.length) {
      throw new BugError(`relay marked ${marked.rowCount} of ${ids.length} locked outbox rows`);
    }
    return { kind: 'published', messages };
  });
}

export interface OutboxBacklog {
  /** Rows not yet published. */
  readonly pending: number;
  /** Age of the oldest of them by Postgres time; null when none. Alert above 10 s (§5.4, §12). */
  readonly oldestSeconds: number | null;
}

const BacklogRow = z.object({ pending: z.int(), oldest_seconds: z.number().nullable() });

/** The relay's lag (`fd_outbox_oldest_unpublished_seconds`, admin health). Reads the pending index only. */
export async function outboxBacklog(db: Executor): Promise<OutboxBacklog> {
  const { rows } = await db.execute(sql`
    SELECT count(*)::int AS pending, extract(epoch FROM now() - min(created_at))::float8 AS oldest_seconds
    FROM outbox WHERE published_at IS NULL`);
  const [row] = parseRows(BacklogRow, rows, 'outboxBacklog');
  if (row === undefined) throw new BugError('outboxBacklog: an aggregate returned no row');
  return { pending: row.pending, oldestSeconds: row.oldest_seconds };
}

/**
 * The relay's hourly cleanup (§5.4): deletes rows published more than `retentionSeconds` ago (7 days, when
 * Kafka has dropped the events too), `batchSize` (5,000) per statement and transaction, until a batch comes
 * back short. Returns the number deleted. Unpublished rows are never touched, however old. Safe to run on
 * several relays at once: a row deleted twice is deleted once.
 *
 * Each batch walks the primary key from the oldest row, which is where published rows past retention sit,
 * so a batch stops as soon as it has found its rows; only the last, short batch reads the rest of the table.
 */
export async function deletePublishedOutbox(
  db: Db,
  options: { readonly retentionSeconds?: number; readonly batchSize?: number } = {},
): Promise<number> {
  const retention = options.retentionSeconds ?? OUTBOX_RETENTION_SECONDS;
  const batchSize = options.batchSize ?? OUTBOX_CLEANUP_BATCH;
  let deleted = 0;
  for (;;) {
    const result = await db.execute(sql`
      DELETE FROM outbox WHERE id IN (
        SELECT id FROM outbox
        WHERE published_at < now() - make_interval(secs => ${retention})
        ORDER BY id LIMIT ${batchSize})`);
    const count = result.rowCount ?? 0;
    deleted += count;
    if (count < batchSize) return deleted;
  }
}

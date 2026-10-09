import { CONSUMER_GROUPS } from '@flashdrop/config';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Tx } from './client';
import { PgUuid, parseRows } from './rows';

/*
 * Consumer dedupe (design §6.3, §6.4): `processed_events (consumer, event_id)` records each event a
 * consumer has applied. Inserted in the same transaction as the effect, so the record exists exactly when
 * the effect committed: a redelivered event (relay re-send, rebalance, zombie consumer, DLQ replay) finds its
 * row and is skipped. Rows are kept 45 days, longer than Kafka's 7 and the DLQ's 30 plus a replay window.
 */

/** How long a dedupe record is kept: past the last moment its event can be delivered again. */
export const PROCESSED_EVENTS_RETENTION_SECONDS = 45 * 24 * 60 * 60;

/** Rows one cleanup statement deletes at most, like the outbox cleanup's batches. */
export const PROCESSED_EVENTS_CLEANUP_BATCH = 5_000;

/**
 * The smallest uuid of the millisecond `ms`: a uuidv7 starts with its creation time (48 bits, big-endian),
 * and Postgres compares uuids bytewise, so every uuidv7 created before `ms` sorts below it.
 */
export function uuidv7Floor(ms: number): string {
  const hex = Math.max(0, Math.floor(ms)).toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-0000-0000-000000000000`;
}

/**
 * The relay's hourly cleanup of dedupe records (§3: kept 45 days), per consumer, `batchSize` per statement
 * until a batch comes back short; returns the number deleted.
 *
 * An event can be delivered again only while Kafka (7 days) or the DLQ (30 days) holds it, and both count
 * from about when it happened, so a record goes once its event is older than the retention: event ids are
 * uuidv7, so that bound is a range of the primary key (`event_id < uuidv7Floor(cutoff)`) and needs no index
 * of its own. `processed_at` is checked as well, so a record is never deleted within the retention of its own
 * insert either, whatever its id. Every consumer that dedupes is a consumer group, so the groups are the
 * consumers to sweep.
 */
export async function deleteExpiredProcessedEvents(
  db: Db,
  options: {
    readonly retentionSeconds?: number;
    readonly batchSize?: number;
    readonly consumers?: readonly string[];
  } = {},
): Promise<number> {
  const retention = options.retentionSeconds ?? PROCESSED_EVENTS_RETENTION_SECONDS;
  const batchSize = options.batchSize ?? PROCESSED_EVENTS_CLEANUP_BATCH;
  const floor = uuidv7Floor(Date.now() - retention * 1000);
  let deleted = 0;
  for (const consumer of options.consumers ?? Object.values(CONSUMER_GROUPS)) {
    for (;;) {
      const result = await db.execute(sql`
        DELETE FROM processed_events WHERE (consumer, event_id) IN (
          SELECT consumer, event_id FROM processed_events
          WHERE consumer = ${consumer} AND event_id < ${floor}::uuid
            AND processed_at < now() - make_interval(secs => ${retention})
          ORDER BY event_id LIMIT ${batchSize})`);
      const count = result.rowCount ?? 0;
      deleted += count;
      if (count < batchSize) break;
    }
  }
  return deleted;
}

/**
 * Records `eventIds` as processed by `consumer`, inside the caller's effect transaction, and returns the ids
 * that were new, in Postgres's lowercase spelling (as `uuidv7` writes them): the caller applies exactly
 * those. An id another transaction is inserting right now waits
 * for it: if that one commits, the id is not new here; if it rolls back, it is.
 *
 * The ids are inserted in sorted order, so two transactions inserting overlapping batches (a zombie and its
 * replacement) take the unique-index locks in the same order and cannot deadlock. Duplicates within the
 * batch count once.
 */
export async function insertProcessedEvents(
  tx: Tx,
  consumer: string,
  eventIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (eventIds.length === 0) return new Set();
  const { rows } = await tx.execute(sql`
    INSERT INTO processed_events (consumer, event_id)
    SELECT ${consumer}::text, e.id FROM unnest(${sql.param([...new Set(eventIds)])}::uuid[]) AS e(id)
    ORDER BY e.id
    ON CONFLICT DO NOTHING
    RETURNING event_id`);
  return new Set(
    parseRows(z.object({ event_id: PgUuid }), rows, 'insertProcessedEvents').map((r) => r.event_id),
  );
}

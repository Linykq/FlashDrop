import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Tx } from './client';
import { PgUuid, parseRows } from './rows';

/*
 * Consumer dedupe (design §6.3, §6.4): `processed_events (consumer, event_id)` records each event a
 * consumer has applied. Inserted in the same transaction as the effect, so the record exists exactly when
 * the effect committed: a redelivered event (relay re-send, rebalance, zombie consumer, DLQ replay) finds its
 * row and is skipped. Rows are kept 45 days, longer than Kafka's 7 and the DLQ's 30 plus a replay window.
 */

// TODO(M7): the dashboard consumer's projection transaction calls this; until then only tests do.
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

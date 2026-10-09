import type { PostgresRefusal } from '@flashdrop/domain';
import { BugError } from '@flashdrop/domain';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Tx } from './client';
import { pgErrorOf } from './errors';
import type { OrderWithProduct } from './orders';
import { hotRowBusy, orderWithProduct, STATEMENT_TIMEOUT } from './reserve-rows';
import { parseRows } from './rows';
import type { NewReservation } from './transitions';

/*
 * The reserve transaction's three steps (migration 0006) one at a time, exported only as
 * `@flashdrop/db/testing`: integration tests hold a reserve transaction open between steps to stage races.
 * Production records a reservation with the single statement `recordReservation`, which commits in the
 * round trip that runs it. A caller composing these would hold the drop's hot inventory row across network
 * round trips, which ADR 0007 rules out.
 */

/**
 * Step 1 (`fd_insert_reserved_order`): inserts the order as RESERVED with the drop's product and price,
 * `expires_at = now() + hold_seconds`. Undefined when the rid already exists: a replay. A same-key request
 * still in flight holds the primary key, so this waits for it and then replays its outcome, which is why no
 * "in progress" state exists (§4.5). It is also undefined for a drop id that does not exist, which Lua never
 * admits. The conflict has no target, so both unique indexes of the rid's identity are arbiters (see 0006).
 */
export async function insertOrderOnConflictDoNothing(
  tx: Tx,
  r: NewReservation,
): Promise<OrderWithProduct | undefined> {
  const { rows } = await tx.execute(sql`
    SELECT o.*, p.slug AS product_slug, p.title AS product_title, p.image_keys AS product_image_keys
    FROM fd_insert_reserved_order(${r.id}::uuid, ${r.userId}::uuid, ${r.dropId}::uuid, ${r.qty}::int,
                                  ${r.idempotencyKey}::text, ${r.requestHash}::bytea) o
    JOIN products p ON p.id = o.product_id`);
  return orderWithProduct(rows, 'fd_insert_reserved_order');
}

const Claimed = z.object({ claimed: z.boolean() });

/**
 * Step 2 (`fd_claim_quota`): adds `qty` to the user's quota for the drop, unless that would pass the limit
 * (`within_limit`, INV-3). The upsert locks the quota row, so concurrent claims of one user, from any number
 * of tabs and keys, serialize on it and each sees the committed total. False: the limit would be passed.
 */
export async function claimQuota(tx: Tx, userId: string, dropId: string, qty: number): Promise<boolean> {
  const { rows } = await tx.execute(
    sql`SELECT fd_claim_quota(${userId}::uuid, ${dropId}::uuid, ${qty}::int) AS claimed`,
  );
  const [row] = parseRows(Claimed, rows, 'fd_claim_quota');
  return row?.claimed === true;
}

export type TakeStockResult = 'OK' | Exclude<PostgresRefusal, 'LIMIT'>;

const StockTaken = z.object({ result: z.enum(['OK', 'STALE_GEN', 'NOT_LIVE', 'SOLD_OUT']) });

/**
 * Step 3, the last (`fd_take_stock`): takes `qty` units of the drop on the hot row (§5.2). One conditional
 * UPDATE carries the generation fence (§4.7), the stock backstop (INV-1) and the window backstop; on 0 rows
 * it classifies the refusal as STALE_GEN (retry with the same key), then NOT_LIVE, then SOLD_OUT.
 *
 * A statement timeout here is the winners' queue on the row (every reservation of the drop takes it), so it
 * is rethrown as `HotRowBusyError`: still 503 `RETRY`, but not evidence that Postgres is failing.
 */
export async function takeStock(tx: Tx, dropId: string, qty: number, gen: number): Promise<TakeStockResult> {
  const { rows } = await tx
    .execute(sql`SELECT fd_take_stock(${dropId}::uuid, ${qty}::int, ${gen}::int) AS result`)
    .catch((error: unknown) => {
      if (pgErrorOf(error)?.code === STATEMENT_TIMEOUT) throw hotRowBusy(dropId, error);
      throw error;
    });
  const [row] = parseRows(StockTaken, rows, 'fd_take_stock');
  if (row === undefined) throw new BugError('fd_take_stock returned no row');
  return row.result;
}

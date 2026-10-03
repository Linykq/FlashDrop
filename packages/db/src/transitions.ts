import type { ProductSummary } from '@flashdrop/contracts';
import type { PostgresRefusal, RejectReason } from '@flashdrop/domain';
import { BugError, TERMINAL_ORDER_STATUSES } from '@flashdrop/domain';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Executor, Tx } from './client';
import { HotRowBusyError, pgErrorOf } from './errors';
import { type OrderRecord, type OrderWithProduct, parseOrderRows } from './orders';
import { insertOutboxEvents, orderEvent, outboxRow } from './outbox';
import { PgUuid, parseRows } from './rows';
import { literalList } from './schema/columns';
import { transaction } from './transaction';

/*
 * The guarantee-carrying statements of a reservation's life in Postgres (design §4.4, §4.5, §5.2), written
 * by hand through Drizzle's `sql` template so the ORM never decides lock order or statement shape (§3).
 *
 * Global lock order: orders row -> user_drop_quota row -> drop_inventory row, always last. The reserve
 * transaction follows it statement by statement, so the hot inventory row is held for one statement plus
 * the commit, and a transaction holding it never waits on anything else: it cannot be part of a deadlock.
 */

const TERMINAL = literalList(TERMINAL_ORDER_STATUSES);

/** A Lua-admitted reservation to record: the rid, who, what, and the request it came from. */
export interface NewReservation {
  /** rid = `reservationId({userId, dropId, idempotencyKey})`. */
  readonly id: string;
  readonly userId: string;
  readonly dropId: string;
  readonly qty: number;
  readonly idempotencyKey: string;
  /** `requestFingerprint({dropId, qty})`. */
  readonly requestHash: Buffer;
}

/**
 * Inserts the order as RESERVED with the drop's product and price, `expires_at = now() + hold_seconds`.
 * Undefined when the rid already exists: a replay. A same-key request still in flight holds the primary
 * key, so this waits for it and then replays its outcome, which is why no "in progress" state exists (§4.5).
 * It is also undefined for a drop id that does not exist, which Lua never admits.
 *
 * `ON CONFLICT DO NOTHING` names no conflict target on purpose. A same-key request collides on two unique
 * indexes, the primary key and `(user_id, drop_id, idempotency_key)`, which encode the same identity
 * (rid = uuidv5 of that triple). With `ON CONFLICT (id)` only the primary key is an arbiter, and two
 * concurrent same-key inserts could meet on the other index first and fail with 23505 instead of
 * replaying (seen under a 50-request storm). Without a target every unique index is an arbiter.
 *
 * The same statement reads the product summary the 201 answer shows, so a winner needs no second read.
 */
export async function insertOrderOnConflictDoNothing(
  tx: Tx,
  r: NewReservation,
): Promise<OrderWithProduct | undefined> {
  const { rows } = await tx.execute(sql`
    WITH ins AS (
      INSERT INTO orders (id, user_id, drop_id, product_id, qty, unit_price_cents, currency, status,
                          idempotency_key, request_hash, expires_at)
      SELECT ${r.id}::uuid, ${r.userId}::uuid, d.id, d.product_id, ${r.qty}::int, d.price_cents, d.currency, 'RESERVED',
             ${r.idempotencyKey}::text, ${r.requestHash}::bytea, now() + make_interval(secs => d.hold_seconds)
      FROM drops d WHERE d.id = ${r.dropId}
      ON CONFLICT DO NOTHING
      RETURNING *)
    SELECT ins.*, p.slug AS product_slug, p.title AS product_title, p.image_keys AS product_image_keys
    FROM ins JOIN products p ON p.id = ins.product_id`);
  const [order] = parseOrderRows(rows, 'insertOrderOnConflictDoNothing');
  const [product] = parseRows(InsertedProduct, rows, 'insertOrderOnConflictDoNothing product');
  if (order === undefined || product === undefined) return undefined;
  return { order, product: { id: order.productId, ...product } };
}

const InsertedProduct = z
  .object({ product_slug: z.string(), product_title: z.string(), product_image_keys: z.array(z.string()) })
  .transform((row) => ({
    slug: row.product_slug,
    title: row.product_title,
    imageKeys: row.product_image_keys,
  }));

/**
 * Adds `qty` to the user's quota for the drop, unless that would pass the limit (`within_limit`, INV-3).
 * The first claim copies the drop's per-user limit into `limit_qty`; armed drops never change it, so the
 * copy cannot go stale. The upsert locks the quota row, so concurrent claims of one user, from any number
 * of tabs and keys, serialize on it and each sees the committed total. False: the limit would be passed.
 */
export async function claimQuota(tx: Tx, userId: string, dropId: string, qty: number): Promise<boolean> {
  const { rows } = await tx.execute(sql`
    INSERT INTO user_drop_quota (user_id, drop_id, claimed, limit_qty)
    SELECT ${userId}::uuid, d.id, ${qty}::int, d.per_user_limit FROM drops d
    WHERE d.id = ${dropId} AND ${qty}::int <= d.per_user_limit
    ON CONFLICT (user_id, drop_id) DO UPDATE SET claimed = user_drop_quota.claimed + EXCLUDED.claimed
      WHERE user_drop_quota.claimed + EXCLUDED.claimed <= user_drop_quota.limit_qty
    RETURNING claimed`);
  return rows.length === 1;
}

export type TakeStockResult = 'OK' | Exclude<PostgresRefusal, 'LIMIT'>;

const StockState = z.object({ gen: z.int(), available: z.int(), open: z.boolean() });

/**
 * Takes `qty` units of the drop: the last statement of the reserve transaction, on the hot row (§5.2).
 * One conditional UPDATE carries three guarantees: the generation fence (a rebuild since Lua admitted the
 * request makes it fail, §4.7), the stock backstop (INV-1, whatever Redis said), and the window backstop
 * (no order outside SCHEDULED/LIVE and `[starts_at, ends_at)`, whatever the Redis status). The join reads
 * `drops` through MVCC and locks nothing there.
 *
 * On 0 rows the transaction re-reads and classifies, in this order: STALE_GEN (retry with the same key),
 * NOT_LIVE, SOLD_OUT. The re-read may see later commits than the UPDATE did; any answer it gives is still a
 * refusal of this transaction, and SOLD_OUT is the default.
 *
 * A statement timeout here is the winners' queue on the row (every reservation of the drop takes it), so it
 * is rethrown as `HotRowBusyError`: still 503 `RETRY`, but not evidence that Postgres is failing.
 */
export async function takeStock(tx: Tx, dropId: string, qty: number, gen: number): Promise<TakeStockResult> {
  const taken = await tx
    .execute(sql`
      UPDATE drop_inventory di SET reserved = di.reserved + ${qty}, updated_at = now()
      FROM drops d
      WHERE di.drop_id = ${dropId} AND d.id = di.drop_id
        AND di.redis_gen = ${gen}
        AND di.total - di.sold - di.reserved >= ${qty}
        AND d.status IN ('SCHEDULED', 'LIVE') AND now() >= d.starts_at AND now() < d.ends_at
      RETURNING di.reserved`)
    .catch((error: unknown) => {
      if (pgErrorOf(error)?.code === '57014') {
        throw new HotRowBusyError(`stock row of drop ${dropId} busy past the statement timeout`, {
          cause: error,
        });
      }
      throw error;
    });
  if (taken.rows.length === 1) return 'OK';

  const { rows } = await tx.execute(sql`
    SELECT di.redis_gen AS gen, di.total - di.sold - di.reserved AS available,
           d.status IN ('SCHEDULED', 'LIVE') AND now() >= d.starts_at AND now() < d.ends_at AS open
    FROM drop_inventory di JOIN drops d ON d.id = di.drop_id
    WHERE di.drop_id = ${dropId}`);
  const [state] = parseRows(StockState, rows, 'takeStock re-read');
  if (state === undefined) throw new BugError(`takeStock: drop ${dropId} has no inventory`);
  if (state.gen !== gen) return 'STALE_GEN';
  if (!state.open) return 'NOT_LIVE';
  return 'SOLD_OUT';
}

export type ReservationOutcome =
  /** Committed. The product summary comes from the insert statement itself, for the 201 answer. */
  | { readonly kind: 'created'; readonly order: OrderRecord; readonly product: ProductSummary }
  /**
   * The rid already has an order; the caller reads and replays it (`reserveReplay`). Should the read find
   * nothing, the drop id was unknown, which Lua never admits: a bug.
   */
  | { readonly kind: 'replay' }
  /** Rolled back. SOLD_OUT, LIMIT and NOT_LIVE are tombstoned by the caller; STALE_GEN is retried. */
  | { readonly kind: 'refused'; readonly reason: PostgresRefusal };

class Refusal extends Error {
  readonly reason: PostgresRefusal;

  constructor(reason: PostgresRefusal) {
    super(`reservation refused: ${reason}`);
    this.reason = reason;
  }
}

/**
 * The reserve transaction (§5.2), for a hold Lua granted under generation `gen`: the order, the quota, the
 * `order.reserved` outbox row, then the stock, in lock order. Use a pool with the api profile
 * (`statement_timeout=2s`, `transaction_timeout=5s`), so no reserve transaction outlives the orphan scan's
 * 30 s of grace (§4.6). It sends no NOTIFY (§5.4).
 */
export async function recordReservation(
  db: Db,
  r: NewReservation & { readonly gen: number; readonly traceId?: string },
): Promise<ReservationOutcome> {
  try {
    return await transaction(db, async (tx): Promise<ReservationOutcome> => {
      const inserted = await insertOrderOnConflictDoNothing(tx, r);
      if (inserted === undefined) return { kind: 'replay' };
      const { order, product } = inserted;
      if (!(await claimQuota(tx, r.userId, r.dropId, r.qty))) throw new Refusal('LIMIT');
      await insertOutboxEvents(tx, [
        orderEvent(
          'order.reserved',
          order,
          { qty: order.qty, unitPriceCents: order.unitPriceCents, expiresAt: order.expiresAt.toISOString() },
          { occurredAt: order.createdAt, traceId: r.traceId },
        ),
      ]);
      const stock = await takeStock(tx, r.dropId, r.qty, r.gen);
      if (stock !== 'OK') throw new Refusal(stock);
      return { kind: 'created', order, product };
    });
  } catch (error) {
    if (error instanceof Refusal) return { kind: 'refused', reason: error.reason };
    throw error;
  }
}

/** A refusal to record as a REJECTED order: the request's identity, and why. */
export interface RejectedTombstone extends NewReservation {
  readonly reason: RejectReason;
  readonly traceId?: string;
}

const TombstoneDrop = z.object({ product_id: z.string(), price_cents: z.int(), currency: z.string() });

/**
 * Writes the REJECTED tombstone and its `order.rejected` outbox row in ONE statement (§5.2), so the event
 * exists if and only if the tombstone was inserted. Against a concurrent insert of the same rid (a same-key
 * request that committed RESERVED, or a late reserve racing the orphan scan) the primary key decides: the
 * loser waits for the winner, inserts nothing, and therefore emits nothing. True when this call inserted it.
 * As in `insertOrderOnConflictDoNothing`, no conflict target: the key index is an arbiter too, or the race
 * could end in a 23505 (and a quarantined orphan) instead of a no-op.
 *
 * Postgres never granted stock to a tombstone, so no counter changes. Armed drops are immutable, so the
 * product and price read first are still the drop's when the statement runs.
 */
export async function insertRejectedTombstone(db: Executor, t: RejectedTombstone): Promise<boolean> {
  const drop = await db.execute(
    sql`SELECT product_id, price_cents, currency FROM drops WHERE id = ${t.dropId}`,
  );
  const [d] = parseRows(TombstoneDrop, drop.rows, 'insertRejectedTombstone drop');
  if (d === undefined) throw new BugError(`insertRejectedTombstone: unknown drop ${t.dropId}`);

  const event = outboxRow(
    orderEvent(
      'order.rejected',
      { id: t.id, version: 1, productId: d.product_id, dropId: t.dropId, userId: t.userId },
      { qty: t.qty, reason: t.reason },
      { occurredAt: new Date(), traceId: t.traceId },
    ),
  );
  const { rows } = await db.execute(sql`
    WITH t AS (
      INSERT INTO orders (id, user_id, drop_id, product_id, qty, unit_price_cents, currency, status, close_reason,
                          idempotency_key, request_hash, expires_at, closed_at)
      VALUES (${t.id}, ${t.userId}, ${t.dropId}, ${d.product_id}, ${t.qty}, ${d.price_cents}, ${d.currency},
              'REJECTED', ${t.reason}, ${t.idempotencyKey}, ${t.requestHash}, now(), now())
      ON CONFLICT DO NOTHING
      RETURNING product_id)
    INSERT INTO outbox (event_id, topic, partition_key, event_type, payload, headers)
    SELECT ${event.eventId}::uuid, ${event.topic}::text, t.product_id::text, ${event.eventType}::text,
           ${JSON.stringify(event.payload)}::jsonb, ${JSON.stringify(event.headers)}::jsonb
    FROM t
    RETURNING id`);
  return rows.length === 1;
}

/**
 * Records that Redis has applied the order's terminal outcome (§6.5). Only a terminal order can be marked:
 * marking a live one would hide it from the settle safety net after it ends, and its stock would leak.
 * Idempotent; false when it was already marked or is not terminal.
 */
export async function markRedisSettled(db: Executor, orderId: string): Promise<boolean> {
  const { rows } = await db.execute(sql`
    UPDATE orders SET redis_settled_at = now()
    WHERE id = ${orderId} AND redis_settled_at IS NULL AND status IN (${TERMINAL})
    RETURNING id`);
  return rows.length === 1;
}

/**
 * `markRedisSettled` for a batch, in one statement and one commit (the safety net settles a page of orders
 * concurrently, then records them together). Returns the ids it marked.
 */
export async function markRedisSettledMany(db: Executor, orderIds: readonly string[]): Promise<string[]> {
  if (orderIds.length === 0) return [];
  const { rows } = await db.execute(sql`
    UPDATE orders SET redis_settled_at = now()
    WHERE id = ANY(${sql.param([...orderIds])}::uuid[]) AND redis_settled_at IS NULL AND status IN (${TERMINAL})
    RETURNING id`);
  return parseRows(z.object({ id: PgUuid }), rows, 'markRedisSettledMany').map((row) => row.id);
}

const Generation = z.object({ redis_gen: z.int() });

/**
 * The generation fence of a rebuild (§4.7 step 2). Run it on the pool, never inside a longer transaction:
 * it commits at once. Its row lock waits for every reserve transaction that already passed the generation
 * check; every later one carries the old generation and fails `takeStock` with STALE_GEN. Returns the new
 * generation, or undefined for a drop without inventory.
 */
export async function fenceRedisGeneration(db: Db, dropId: string): Promise<number | undefined> {
  const { rows } = await db.execute(sql`
    UPDATE drop_inventory SET redis_gen = redis_gen + 1 WHERE drop_id = ${dropId} RETURNING redis_gen`);
  return parseRows(Generation, rows, 'fenceRedisGeneration')[0]?.redis_gen;
}

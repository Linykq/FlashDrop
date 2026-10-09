import type { ProductSummary } from '@flashdrop/contracts';
import {
  ADMISSION_REFUSALS,
  BugError,
  type PostgresRefusal,
  type RejectReason,
  TERMINAL_ORDER_STATUSES,
} from '@flashdrop/domain';
import { uuidv7 } from '@flashdrop/domain/identity';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Executor } from './client';
import { pgErrorOf } from './errors';
import type { OrderRecord } from './orders';
import { orderEvent, outboxRow } from './outbox';
import { hotRowBusy, orderWithProduct, STATEMENT_TIMEOUT } from './reserve-rows';
import { PgUuid, parseRows } from './rows';
import { literalList } from './schema/columns';

/*
 * The guarantee-carrying statements of a reservation's life in Postgres (design §4.4, §4.5, §5.2), written
 * by hand so the ORM never decides lock order or statement shape (§3).
 *
 * The reserve transaction runs server-side, in the PL/pgSQL functions of migration 0006 (§5.2 "Hot row",
 * escalation step 1): `recordReservation` is one statement, committed in the round trip that runs it, so the
 * hot inventory row is never held while a COMMIT travels from the api. Its three steps also exist one at a time
 * (`reserve-steps.ts`), for the tests that hold a reserve transaction open between them; production never
 * composes them (ADR 0007).
 *
 * Global lock order: orders row -> user_drop_quota row -> drop_inventory row, always last. A transaction
 * holding the hot row never waits on anything else, so it cannot be part of a deadlock.
 */

const TERMINAL = literalList(TERMINAL_ORDER_STATUSES);

/** The SQLSTATE `fd_record_reservation` refuses with (migration 0006); DETAIL carries the reason. */
const RESERVATION_REFUSED = 'FD001';

const Refusal = z.enum([...ADMISSION_REFUSALS, 'STALE_GEN']) satisfies z.ZodType<PostgresRefusal>;

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

export type ReservationOutcome =
  /** Committed. The product summary comes from the reserve statement itself, for the 201 answer. */
  | { readonly kind: 'created'; readonly order: OrderRecord; readonly product: ProductSummary }
  /**
   * The rid already has an order; the caller reads and replays it (`reserveReplay`). Should the read find
   * nothing, the drop id was unknown, which Lua never admits: a bug.
   */
  | { readonly kind: 'replay' }
  /** Rolled back. SOLD_OUT, LIMIT and NOT_LIVE are tombstoned by the caller; STALE_GEN is retried. */
  | { readonly kind: 'refused'; readonly reason: PostgresRefusal };

/**
 * The reserve transaction (§5.2) for a hold Lua granted under generation `gen`: the order, the quota, the
 * `order.reserved` outbox row, then the stock, in lock order, all in ONE statement (`fd_record_reservation`)
 * outside any explicit transaction. Postgres commits it when the function returns, in the same round trip,
 * so the hot row is held for zero network round trips. It sends no NOTIFY (§5.4).
 *
 * Use a pool with the api profile: `statement_timeout` (2 s) bounds the whole transaction, below the orphan
 * scan's 30 s grace (§4.6). A timeout while queued on the hot row (the context of the error names
 * `fd_take_stock`) is `HotRowBusyError`; one anywhere else stays a plain statement timeout, as it was when
 * each step was a statement of its own.
 */
export async function recordReservation(
  db: Db,
  r: NewReservation & { readonly gen: number; readonly traceId?: string },
): Promise<ReservationOutcome> {
  let rows: readonly unknown[];
  try {
    ({ rows } = await db.execute(sql`
      SELECT (r.reserved_order).*, r.product_slug, r.product_title, r.product_image_keys
      FROM fd_record_reservation(${r.id}::uuid, ${r.userId}::uuid, ${r.dropId}::uuid, ${r.qty}::int,
                                 ${r.idempotencyKey}::text, ${r.requestHash}::bytea, ${r.gen}::int,
                                 ${uuidv7()}::uuid, ${r.traceId ?? null}::text) r`));
  } catch (error) {
    const reason = refusalOf(error);
    if (reason !== undefined) return { kind: 'refused', reason };
    throw queuedOnHotRow(error) ? hotRowBusy(r.dropId, error) : error;
  }
  const created = orderWithProduct(rows, 'fd_record_reservation');
  return created === undefined ? { kind: 'replay' } : { kind: 'created', ...created };
}

/** The reason of a refusal `fd_record_reservation` raised, or undefined for any other error. */
function refusalOf(error: unknown): PostgresRefusal | undefined {
  const pg = pgErrorOf(error);
  if (pg?.code !== RESERVATION_REFUSED) return undefined;
  const reason = Refusal.safeParse(pg.detail);
  if (!reason.success) {
    throw new BugError(`fd_record_reservation refused with reason ${String(pg.detail)}`, { cause: error });
  }
  return reason.data;
}

/**
 * A statement timeout that fired inside `fd_take_stock`, queued on the hot row: Postgres reports the PL/pgSQL
 * call stack of the error in its context (`where`), innermost function first.
 */
function queuedOnHotRow(error: unknown): boolean {
  const pg = pgErrorOf(error);
  return pg?.code === STATEMENT_TIMEOUT && pg.where?.includes('PL/pgSQL function fd_take_stock(') === true;
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

import { BugError, LIVE_ORDER_STATUSES, TERMINAL_ORDER_STATUSES } from '@flashdrop/domain';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Executor, Tx } from './client';
import { isTransientDbError, pgErrorOf } from './errors';
import { insertOutboxEvents, orderEvent } from './outbox';
import { PgTimestamp, PgUuid, parseRows } from './rows';
import { literalList } from './schema/columns';
import { transaction } from './transaction';

/*
 * Postgres-driven expiry and its safety nets (design §4.6). Expiry is decided by Postgres time on Postgres
 * rows; Redis TTLs and keyspace notifications are never used, because a key that expires cannot give its
 * stock back.
 */

export const SWEEPER_LOOPS = ['expire-orders', 'settle-safety-net', 'orphan-scan'] as const;
export type SweeperLoop = (typeof SWEEPER_LOOPS)[number];

const LIVE = literalList(LIVE_ORDER_STATUSES);
const TERMINAL = literalList(TERMINAL_ORDER_STATUSES);

/**
 * `pg_try_advisory_xact_lock` on a named loop: one instance runs each tick, a standby skips it (§4.6). The
 * lock ends with the transaction, so a dead holder never blocks the next tick.
 */
export async function tryLoopLock(tx: Tx, loop: string): Promise<boolean> {
  const { rows } = await tx.execute(
    sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`fd.loop.${loop}`}, 0)) AS locked`,
  );
  return parseRows(z.object({ locked: z.boolean() }), rows, 'tryLoopLock')[0]?.locked === true;
}

/** An order the sweeper moved to EXPIRED, with what its `order.expired` event reports. */
export interface ExpiredOrder {
  readonly id: string;
  readonly userId: string;
  readonly dropId: string;
  readonly productId: string;
  readonly qty: number;
  readonly version: number;
  readonly fromStatus: (typeof LIVE_ORDER_STATUSES)[number];
  readonly closedAt: Date;
}

export interface QuarantinedOrder {
  readonly orderId: string;
  readonly error: string;
}

export type ExpireTick =
  /** Another instance holds the loop lock this tick. */
  | { readonly kind: 'busy' }
  | { readonly kind: 'batch'; readonly expired: readonly ExpiredOrder[] }
  /**
   * The batch failed on a non-transient error, so each due order ran in its own transaction. Every
   * quarantined order must raise an alert.
   */
  | {
      readonly kind: 'fallback';
      readonly batchError: unknown;
      readonly expired: readonly ExpiredOrder[];
      readonly quarantined: readonly QuarantinedOrder[];
    };

const ExpiredRow = z
  .object({
    id: PgUuid,
    user_id: PgUuid,
    drop_id: PgUuid,
    product_id: PgUuid,
    qty: z.int(),
    version: z.int(),
    from_status: z.enum(LIVE_ORDER_STATUSES),
    closed_at: PgTimestamp,
  })
  .transform(
    (row): ExpiredOrder => ({
      id: row.id,
      userId: row.user_id,
      dropId: row.drop_id,
      productId: row.product_id,
      qty: row.qty,
      version: row.version,
      fromStatus: row.from_status,
      closedAt: row.closed_at,
    }),
  );

const EXPIRE_SET = sql`status = 'EXPIRED', close_reason = 'TIMEOUT', closed_at = now(),
  version = version + 1, updated_at = now()`;
const EXPIRE_RETURNING = sql`o.id, o.user_id, o.drop_id, o.product_id, o.qty, o.version, due.from_status, o.closed_at`;

/** Orders one `expireDueOrders` call expires at most; a full batch means more may be due. */
export const EXPIRE_BATCH = 200;

/**
 * One `expire-orders` batch (§4.6; the loop drains: it runs batches until one comes back short or its time
 * budget is spent). One transaction, in the global lock order: lock up to `limit` due orders `FOR UPDATE SKIP LOCKED` and set them EXPIRED; give the quota back, aggregated per
 * (user, drop) and locked in key order; write the `order.expired` outbox rows; queue one
 * `pg_notify('outbox')`; give the inventory back, aggregated per drop and locked in key order, last.
 *
 * SKIP LOCKED means the sweeper never waits on an orders row: an order a payment or cancel is changing is
 * simply picked up next tick, and the CAS on its status decides the race. Being the only code that locks
 * several quota and inventory rows, it sorts them, so it cannot deadlock with itself or with reserves,
 * which lock one of each in the same order.
 *
 * If the batch fails on a non-transient error (a constraint or trigger refusing one row), the due orders
 * are retried one transaction each, and an order that still fails is quarantined, so one bad row can never
 * stop expiry platform-wide. A transient error (Postgres unavailable) is thrown, never quarantined.
 */
export async function expireDueOrders(
  db: Db,
  options: { readonly limit?: number } = {},
): Promise<ExpireTick> {
  const limit = options.limit ?? EXPIRE_BATCH;
  try {
    const expired = await transaction(db, async (tx) => {
      if (!(await tryLoopLock(tx, 'expire-orders'))) return undefined;
      const { rows } = await tx.execute(sql`
        WITH due AS (SELECT id, status AS from_status FROM orders
                     WHERE status IN (${LIVE}) AND expires_at < now()
                       AND NOT EXISTS (SELECT 1 FROM sweeper_quarantine q
                                       WHERE q.loop = 'expire-orders' AND q.order_id = orders.id)
                     ORDER BY expires_at LIMIT ${limit} FOR UPDATE SKIP LOCKED)
        UPDATE orders o SET ${EXPIRE_SET}
        FROM due WHERE o.id = due.id
        RETURNING ${EXPIRE_RETURNING}`);
      const batch = parseRows(ExpiredRow, rows, 'expire-orders batch');
      await giveBack(tx, batch);
      return batch;
    });
    return expired === undefined ? { kind: 'busy' } : { kind: 'batch', expired };
  } catch (batchError) {
    if (isTransientDbError(batchError)) throw batchError;
    return { kind: 'fallback', batchError, ...(await expireOneByOne(db, limit)) };
  }
}

async function expireOneByOne(
  db: Db,
  limit: number,
): Promise<{ expired: ExpiredOrder[]; quarantined: QuarantinedOrder[] }> {
  const { rows } = await db.execute(sql`
    SELECT id FROM orders
    WHERE status IN (${LIVE}) AND expires_at < now()
      AND NOT EXISTS (SELECT 1 FROM sweeper_quarantine q WHERE q.loop = 'expire-orders' AND q.order_id = orders.id)
    ORDER BY expires_at LIMIT ${limit}`);
  const expired: ExpiredOrder[] = [];
  const quarantined: QuarantinedOrder[] = [];
  for (const { id } of parseRows(z.object({ id: PgUuid }), rows, 'expire-orders candidates')) {
    try {
      const one = await transaction(db, async (tx) => {
        // The status condition is the CAS: an order another instance or a payment already moved is skipped.
        const result = await tx.execute(sql`
          WITH due AS (SELECT id, status AS from_status FROM orders
                       WHERE id = ${id} AND status IN (${LIVE}) AND expires_at < now()
                       FOR UPDATE SKIP LOCKED)
          UPDATE orders o SET ${EXPIRE_SET}
          FROM due WHERE o.id = due.id
          RETURNING ${EXPIRE_RETURNING}`);
        const batch = parseRows(ExpiredRow, result.rows, 'expire-orders single');
        await giveBack(tx, batch);
        return batch;
      });
      expired.push(...one);
    } catch (error) {
      if (isTransientDbError(error)) throw error;
      // Only a fresh quarantine is reported (and alerted): one another instance made was alerted there.
      if (await quarantineOrder(db, 'expire-orders', id, error)) {
        quarantined.push({ orderId: id, error: describeError(error) });
      }
    }
  }
  return { expired, quarantined };
}

/** Quota, outbox and inventory for orders just moved out of a live status, in lock order. */
async function giveBack(tx: Tx, expired: readonly ExpiredOrder[]): Promise<void> {
  if (expired.length === 0) return;

  const quotas = [...sumBy(expired, (o) => `${o.userId}/${o.dropId}`).values()];
  const users = quotas.map((q) => q.order.userId);
  const quotaDrops = quotas.map((q) => q.order.dropId);
  // ORDER BY ... FOR UPDATE locks rows in sort order, which is what keeps several quota rows deadlock-free.
  await tx.execute(sql`
    SELECT 1 FROM user_drop_quota q
    JOIN unnest(${sql.param(users)}::uuid[], ${sql.param(quotaDrops)}::uuid[]) AS v(user_id, drop_id)
      ON q.user_id = v.user_id AND q.drop_id = v.drop_id
    ORDER BY q.user_id, q.drop_id FOR UPDATE OF q`);
  const quotaRows = await tx.execute(sql`
    UPDATE user_drop_quota q SET claimed = q.claimed - v.qty
    FROM unnest(${sql.param(users)}::uuid[], ${sql.param(quotaDrops)}::uuid[], ${sql.param(quotas.map((q) => q.qty))}::int[])
      AS v(user_id, drop_id, qty)
    WHERE q.user_id = v.user_id AND q.drop_id = v.drop_id
    RETURNING q.user_id`);
  if (quotaRows.rows.length !== quotas.length) throw new BugError('expire-orders: a quota row is missing');

  await insertOutboxEvents(
    tx,
    expired.map((o) =>
      orderEvent('order.expired', o, { qty: o.qty, fromStatus: o.fromStatus }, { occurredAt: o.closedAt }),
    ),
  );
  // Queued now, delivered on commit; issued before the inventory update so that update stays the last statement.
  await tx.execute(sql`SELECT pg_notify('outbox', '')`);

  const inventory = [...sumBy(expired, (o) => o.dropId).values()];
  const dropIds = inventory.map((i) => i.order.dropId);
  await tx.execute(sql`
    SELECT 1 FROM drop_inventory WHERE drop_id = ANY(${sql.param(dropIds)}::uuid[])
    ORDER BY drop_id FOR UPDATE`);
  const inventoryRows = await tx.execute(sql`
    UPDATE drop_inventory di SET reserved = di.reserved - v.qty, updated_at = now()
    FROM unnest(${sql.param(dropIds)}::uuid[], ${sql.param(inventory.map((i) => i.qty))}::int[]) AS v(drop_id, qty)
    WHERE di.drop_id = v.drop_id
    RETURNING di.drop_id`);
  if (inventoryRows.rows.length !== inventory.length) {
    throw new BugError('expire-orders: an inventory row is missing');
  }
}

/** Units per group, with one order of the group to read the group's ids from. */
function sumBy(
  orders: readonly ExpiredOrder[],
  key: (order: ExpiredOrder) => string,
): Map<string, { readonly order: ExpiredOrder; qty: number }> {
  const sums = new Map<string, { readonly order: ExpiredOrder; qty: number }>();
  for (const order of orders) {
    const group = sums.get(key(order));
    if (group === undefined) sums.set(key(order), { order, qty: order.qty });
    else group.qty += order.qty;
  }
  return sums;
}

/**
 * What a quarantine row and its alert say about the failure. For a Postgres error: SQLSTATE, constraint and
 * Postgres's own message, not Drizzle's "Failed query" wrapper, which repeats the whole statement.
 */
function describeError(error: unknown): string {
  const pg = pgErrorOf(error);
  const text =
    pg === undefined
      ? error instanceof Error
        ? error.message
        : String(error)
      : `${pg.code ?? '?'}${pg.constraint ? ` ${pg.constraint}` : ''}: ${pg.message}`;
  return text.slice(0, 2_000);
}

/**
 * Parks an order a loop cannot process: later ticks of that loop skip it, and the caller raises an alert
 * (§4.6, §12). True when this call quarantined it.
 */
export async function quarantineOrder(
  db: Executor,
  loop: SweeperLoop,
  orderId: string,
  error: unknown,
): Promise<boolean> {
  const { rows } = await db.execute(sql`
    INSERT INTO sweeper_quarantine (loop, order_id, error) VALUES (${loop}, ${orderId}, ${describeError(error)})
    ON CONFLICT DO NOTHING
    RETURNING order_id`);
  return rows.length === 1;
}

export interface UnsettledOrder {
  readonly id: string;
  readonly dropId: string;
  readonly status: (typeof TERMINAL_ORDER_STATUSES)[number];
  readonly updatedAt: Date;
}

const UnsettledRow = z
  .object({ id: PgUuid, drop_id: PgUuid, status: z.enum(TERMINAL_ORDER_STATUSES), updated_at: PgTimestamp })
  .transform(
    (row): UnsettledOrder => ({
      id: row.id,
      dropId: row.drop_id,
      status: row.status,
      updatedAt: row.updated_at,
    }),
  );

/** One page of `listUnsettledTerminalOrders`. */
export const UNSETTLED_PAGE = 200;

/**
 * The `settle-safety-net` candidates (§4.6, every 5 s): terminal orders Redis has not applied, unchanged for
 * `olderThanSeconds` (10 s by default, so the settlement consumer gets the first go), oldest first, minus
 * the ones this loop quarantined and the drops in `excludeDropIds`: the loop pages through them and leaves
 * out every drop that answered RETRY earlier in the tick, so a drop stuck rebuilding cannot hold the head of
 * the list for every other drop. Covers a lost, slow or dead-lettered settlement event.
 */
export async function listUnsettledTerminalOrders(
  db: Executor,
  options: {
    readonly olderThanSeconds?: number;
    readonly limit?: number;
    readonly excludeDropIds?: readonly string[];
  } = {},
): Promise<UnsettledOrder[]> {
  const { rows } = await db.execute(sql`
    SELECT id, drop_id, status, updated_at FROM orders
    WHERE redis_settled_at IS NULL AND status IN (${TERMINAL})
      AND updated_at < now() - make_interval(secs => ${options.olderThanSeconds ?? 10})
      AND drop_id <> ALL(${sql.param([...(options.excludeDropIds ?? [])])}::uuid[])
      AND NOT EXISTS (SELECT 1 FROM sweeper_quarantine q
                      WHERE q.loop = 'settle-safety-net' AND q.order_id = orders.id)
    ORDER BY updated_at LIMIT ${options.limit ?? UNSETTLED_PAGE}`);
  return parseRows(UnsettledRow, rows, 'listUnsettledTerminalOrders');
}

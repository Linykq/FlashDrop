import { randomUUID } from 'node:crypto';
import {
  BugError,
  DomainError,
  DROP_ACTION_FROM,
  DROP_RETENTION_SECONDS,
  DROP_STATUSES,
  type DropAction,
  type DropStatus,
  NotFoundError,
  ORDER_STATUSES,
  PUBLIC_DROP_STATUSES,
  type PublicDropStatus,
  type RsvState,
  rsvStateOf,
  ValidationError,
} from '@flashdrop/domain';
import { and, eq, ne, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Executor } from './client';
import { constraintOf } from './errors';
import { PgUuid, parseRows } from './rows';
import { dropInventory, drops } from './schema';
import { transaction } from './transaction';

/*
 * Drops: the tracked set the background loops iterate, the Redis rebuild snapshot, and the admin and
 * scheduler status changes (design §4.1, §4.6, §4.7). Every status change of an armed drop runs under the
 * per-drop lock (`packages/inventory`), held by the caller; the statements here are still CASes on the
 * expected status, so a caller without the lock can lose a race but never overwrite a newer status.
 */

/** Prefix of a drop lock's name: the lock of drop `<id>` is keyed `hashtextextended('fd.sync:<id>', 0)`. */
export const DROP_LOCK_NAMESPACE = 'fd.sync:';

/**
 * The advisory-lock key of a drop's lock (§4.7). `packages/inventory` holds it session-level on a dedicated
 * connection (`withDropLock`); the seed takes it transaction-level. The id goes through `uuid`, so every
 * spelling of it yields the key of its lowercase form.
 */
export function dropLockKey(dropId: string): SQL {
  return sql`hashtextextended(${DROP_LOCK_NAMESPACE} || ${dropId}::uuid::text, 0)`;
}

/** `now() < ends_at + 24 h`: the drop's Redis keys may still exist (`retainAt`, §4.1). */
const WITHIN_RETENTION: SQL = sql`now() < ${drops.endsAt} + make_interval(secs => ${DROP_RETENTION_SECONDS})`;

export interface TrackedDrop {
  readonly id: string;
  readonly productId: string;
  readonly roomId: string | null;
  readonly status: PublicDropStatus;
  readonly startsAt: Date;
  readonly endsAt: Date;
}

/**
 * The tracked set (§4.1): armed drops until 24 h after they end, ENDED ones included. The sweeper, the
 * scheduler and the reconciler read it from Postgres, never from Redis, so a Redis wipe cannot hide a drop
 * from the loops that repair it.
 */
export async function listTrackedDrops(db: Executor): Promise<TrackedDrop[]> {
  const rows = await db
    .select({
      id: drops.id,
      productId: drops.productId,
      roomId: drops.roomId,
      status: drops.status,
      startsAt: drops.startsAt,
      endsAt: drops.endsAt,
    })
    .from(drops)
    .where(and(ne(drops.status, 'DRAFT'), WITHIN_RETENTION))
    .orderBy(drops.startsAt);
  return rows.map((row) => ({ ...row, status: publicStatus(row.status) }));
}

function publicStatus(status: DropStatus): PublicDropStatus {
  if (status === 'DRAFT') throw new BugError('a DRAFT drop reached the tracked set');
  return status;
}

/** Whether the drop is in the tracked set: Lua's NO_DROP then means "rebuild pending", not "no such drop". */
export async function isTrackedDrop(db: Executor, dropId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: drops.id })
    .from(drops)
    .where(and(eq(drops.id, dropId), ne(drops.status, 'DRAFT'), WITHIN_RETENTION));
  return row !== undefined;
}

/**
 * Whether an armed drop has left the tracked set for good. Exactly the complement of `isTrackedDrop` for
 * armed drops: settlement may give up on Redis for such a drop (§6.5) only because no reconciler will ever
 * rebuild it again, whatever its status says.
 */
export async function isPastRetention(db: Executor, dropId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: drops.id })
    .from(drops)
    .where(and(eq(drops.id, dropId), ne(drops.status, 'DRAFT'), sql`NOT (${WITHIN_RETENTION})`));
  return row !== undefined;
}

/** One `rsv` entry of the rebuild, in the wire shape `fd_rebuild` validates (§4.2). */
export interface RebuildEntry {
  readonly rid: string;
  readonly u: string;
  readonly q: number;
  readonly s: RsvState;
  /** `fingerprintHex(request_hash)`. */
  readonly fp: string;
  readonly k: string;
  /** `expires_at` in Unix ms; HELD entries get an `exp` score of this plus the grace. */
  readonly expAt: number;
}

/** The argument of `fd_rebuild`, field for field (§4.2 `valid_snapshot`). Times are Unix ms. */
export interface RebuildSnapshot {
  readonly gen: number;
  readonly total: number;
  readonly reserved: number;
  readonly sold: number;
  readonly meta: {
    readonly status: PublicDropStatus;
    readonly startsAt: number;
    readonly endsAt: number;
    readonly holdMs: number;
    readonly limit: number;
    readonly retainAt: number;
    readonly productId: string;
  };
  readonly entries: readonly RebuildEntry[];
  /** user id -> `claimed`, for users with a positive claim. */
  readonly quotas: Readonly<Record<string, number>>;
}

const SnapshotDrop = z.object({
  status: z.enum(DROP_STATUSES),
  product_id: PgUuid,
  per_user_limit: z.int(),
  hold_seconds: z.int(),
  starts_ms: z.number(),
  ends_ms: z.number(),
  total: z.int(),
  reserved: z.int(),
  sold: z.int(),
  redis_gen: z.int(),
});
const SnapshotOrder = z.object({
  id: PgUuid,
  user_id: PgUuid,
  qty: z.int(),
  status: z.enum(ORDER_STATUSES),
  fp: z.string(),
  idempotency_key: z.string(),
  expires_ms: z.number(),
});
const SnapshotQuota = z.object({ user_id: PgUuid, claimed: z.int() });

/**
 * The Postgres side of a rebuild (§4.7 step 3): the drop, its inventory, its quotas and every one of its
 * orders, read in one REPEATABLE READ snapshot, so the counters and the orders describe the same instant.
 * Run it after the generation fence committed: every reserve that passed the old fence has committed by
 * then and is in the snapshot; every later one fails STALE_GEN and never will be.
 *
 * The window is rounded inwards to whole milliseconds (start up, end down), so Lua's `[startsAt, endsAt)`
 * gate is never wider than the Postgres window backstop. Undefined for an unknown or DRAFT drop.
 */
export async function readRebuildSnapshot(db: Db, dropId: string): Promise<RebuildSnapshot | undefined> {
  return transaction(
    db,
    async (tx) => {
      const dropRows = await tx.execute(sql`
        SELECT d.status, d.product_id, d.per_user_limit, d.hold_seconds,
               ceil(extract(epoch FROM d.starts_at) * 1000)::float8 AS starts_ms,
               floor(extract(epoch FROM d.ends_at) * 1000)::float8 AS ends_ms,
               i.total, i.reserved, i.sold, i.redis_gen
        FROM drops d JOIN drop_inventory i ON i.drop_id = d.id
        WHERE d.id = ${dropId}`);
      const [drop] = parseRows(SnapshotDrop, dropRows.rows, 'readRebuildSnapshot drop');
      if (drop === undefined || drop.status === 'DRAFT') return undefined;

      const orderRows = await tx.execute(sql`
        SELECT id, user_id, qty, status, encode(request_hash, 'hex') AS fp, idempotency_key,
               ceil(extract(epoch FROM expires_at) * 1000)::float8 AS expires_ms
        FROM orders WHERE drop_id = ${dropId} ORDER BY id`);
      // A zero quota has no `uq` field in Redis (fd_release deletes it), so it is left out.
      const quotaRows = await tx.execute(sql`
        SELECT user_id, claimed FROM user_drop_quota WHERE drop_id = ${dropId} AND claimed > 0`);

      return {
        gen: drop.redis_gen,
        total: drop.total,
        reserved: drop.reserved,
        sold: drop.sold,
        meta: {
          status: drop.status,
          startsAt: drop.starts_ms,
          endsAt: drop.ends_ms,
          holdMs: drop.hold_seconds * 1000,
          limit: drop.per_user_limit,
          retainAt: drop.ends_ms + DROP_RETENTION_SECONDS * 1000,
          productId: drop.product_id,
        },
        entries: parseRows(SnapshotOrder, orderRows.rows, 'readRebuildSnapshot orders').map((order) => ({
          rid: order.id,
          u: order.user_id,
          q: order.qty,
          s: rsvStateOf(order.status),
          fp: order.fp,
          k: order.idempotency_key,
          expAt: order.expires_ms,
        })),
        quotas: Object.fromEntries(
          parseRows(SnapshotQuota, quotaRows.rows, 'readRebuildSnapshot quotas').map((q) => [
            q.user_id,
            q.claimed,
          ]),
        ),
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

/** A drop with its stock of record. */
export interface AdminDropRecord {
  readonly drop: typeof drops.$inferSelect;
  readonly inventory: {
    readonly total: number;
    readonly reserved: number;
    readonly sold: number;
    readonly redisGen: number;
  };
}

export async function getAdminDrop(db: Executor, dropId: string): Promise<AdminDropRecord | undefined> {
  const [row] = await db
    .select({
      drop: drops,
      inventory: {
        total: dropInventory.total,
        reserved: dropInventory.reserved,
        sold: dropInventory.sold,
        redisGen: dropInventory.redisGen,
      },
    })
    .from(drops)
    .innerJoin(dropInventory, eq(dropInventory.dropId, drops.id))
    .where(eq(drops.id, dropId));
  return row;
}

/** What an admin types for a drop (§5.1). `stock` is `drop_inventory.total`. */
export interface DropSettings {
  readonly productId: string;
  readonly roomId: string | null;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly priceCents: number;
  readonly currency: string;
  readonly perUserLimit: number;
  readonly holdSeconds: number;
  readonly paymentSeconds: number;
  readonly stock: number;
}

/** A DRAFT drop and its inventory, in one transaction. Nothing outside admin sees it until it is armed. */
export async function createDraftDrop(db: Db, settings: DropSettings): Promise<AdminDropRecord> {
  const id = randomUUID();
  return transaction(db, async (tx) => {
    const { stock, ...drop } = settings;
    await tx
      .insert(drops)
      .values({ id, ...drop, status: 'DRAFT' })
      .catch(rethrowWindow);
    await tx.insert(dropInventory).values({ dropId: id, total: stock });
    const created = await getAdminDrop(tx, id);
    if (created === undefined) throw new BugError(`createDraftDrop: ${id} vanished`);
    return created;
  });
}

/**
 * Changes a DRAFT drop. Armed drops are immutable (§4.7): their Redis meta and the `limit_qty` copied into
 * quotas would go stale. Throws `NotFoundError`, 409 `DROP_ARMED`, or a validation error for a window that
 * would end before it starts.
 */
export async function patchDraftDrop(
  db: Db,
  dropId: string,
  patch: Partial<DropSettings>,
): Promise<AdminDropRecord> {
  return transaction(db, async (tx) => {
    const { stock, ...dropPatch } = patch;
    // Locks the row, so an arm cannot slip in between the status check and the inventory change. NO KEY
    // UPDATE, never UPDATE, on a drops row: see `applyDropAction`.
    const [current] = await tx
      .select({ status: drops.status })
      .from(drops)
      .where(eq(drops.id, dropId))
      .for('no key update');
    if (current === undefined) throw new NotFoundError('Drop');
    if (current.status !== 'DRAFT') throw new DomainError('DROP_ARMED', 'An armed drop cannot be changed');
    if (Object.keys(dropPatch).length > 0) {
      await tx.update(drops).set(dropPatch).where(eq(drops.id, dropId)).catch(rethrowWindow);
    }
    if (stock !== undefined) {
      await tx.update(dropInventory).set({ total: stock }).where(eq(dropInventory.dropId, dropId));
    }
    const updated = await getAdminDrop(tx, dropId);
    if (updated === undefined) throw new BugError(`patchDraftDrop: ${dropId} has no inventory`);
    return updated;
  });
}

function rethrowWindow(error: unknown): never {
  if (constraintOf(error) === 'drops_window') {
    throw new ValidationError([{ path: 'endsAt', message: 'endsAt must be after startsAt' }], {
      cause: error,
    });
  }
  throw error;
}

export interface DropStatusChange {
  readonly from: DropStatus;
  readonly to: DropStatus;
}

const StatusChangeRow = z
  .object({ from_status: z.enum(DROP_STATUSES), to_status: z.enum(DROP_STATUSES) })
  .transform((row): DropStatusChange => ({ from: row.from_status, to: row.to_status }));

/** The status `resume` lands on: what the clock implies for the drop's window. */
const BY_CLOCK = sql`CASE WHEN now() >= d.ends_at THEN 'ENDED'::drop_status
                          WHEN now() >= d.starts_at THEN 'LIVE'::drop_status
                          ELSE 'SCHEDULED'::drop_status END`;

const ACTION_TARGET: Readonly<Record<DropAction, SQL>> = {
  arm: sql`'SCHEDULED'::drop_status`,
  pause: sql`'PAUSED'::drop_status`,
  resume: BY_CLOCK,
  end: sql`'ENDED'::drop_status`,
};

/**
 * An admin status change (§4.7), a CAS on the statuses `DROP_ACTION_FROM` allows. The caller holds the
 * drop lock and then applies the new status to Redis (`fd_set_status`, or the full sync for `arm`).
 * Throws `NotFoundError`; 409 `DROP_ARMED` for arming a drop that is no longer DRAFT; 409 `CONFLICT` for
 * any other action from a status it does not apply to, or for arming a product that already has an open
 * drop (`one_open_drop_per_product`).
 */
export async function applyDropAction(
  db: Executor,
  dropId: string,
  action: DropAction,
): Promise<DropStatusChange> {
  const from = sql.param([...DROP_ACTION_FROM[action]]);
  let rows: unknown[];
  try {
    // FOR NO KEY UPDATE, never FOR UPDATE: every reserve's order insert and quota upsert hold FOR KEY SHARE
    // on this row until they commit (their foreign keys), which conflicts with FOR UPDATE only. New KEY
    // SHARE lockers do not queue behind a waiting FOR UPDATE, so under a burst it would starve, and a hot
    // drop could not be paused or ended (§3). A status change is not a key change, so this is all it needs.
    ({ rows } = await db.execute(sql`
      WITH prev AS (SELECT id, status FROM drops WHERE id = ${dropId} FOR NO KEY UPDATE)
      UPDATE drops d SET status = ${ACTION_TARGET[action]}
      FROM prev WHERE d.id = prev.id AND prev.status = ANY(${from}::drop_status[])
      RETURNING prev.status AS from_status, d.status AS to_status`));
  } catch (error) {
    if (constraintOf(error) === 'one_open_drop_per_product') {
      throw new DomainError('CONFLICT', 'The product already has an open drop', { cause: error });
    }
    throw error;
  }
  const [change] = parseRows(StatusChangeRow, rows, `applyDropAction ${action}`);
  if (change !== undefined) return change;

  const [current] = await db.select({ status: drops.status }).from(drops).where(eq(drops.id, dropId));
  if (current === undefined) throw new NotFoundError('Drop');
  if (action === 'arm') throw new DomainError('DROP_ARMED', 'The drop is already armed');
  throw new DomainError('CONFLICT', `Cannot ${action} a drop that is ${current.status}`);
}

/**
 * The scheduler's transitions, by Postgres time: SCHEDULED -> LIVE at `starts_at`, LIVE or PAUSED -> ENDED
 * at `ends_at` (a SCHEDULED drop whose whole window has passed goes straight to ENDED).
 */
const TRANSITION_DUE = sql`((status = 'SCHEDULED' AND now() >= starts_at)
                            OR (status IN ('LIVE', 'PAUSED') AND now() >= ends_at))`;

export interface DropSchedule {
  readonly id: string;
  readonly status: PublicDropStatus;
  /** A Postgres transition is due now. */
  readonly transitionDue: boolean;
}

const ScheduleRow = z
  .object({ id: PgUuid, status: z.enum(PUBLIC_DROP_STATUSES), due: z.boolean() })
  .transform((row): DropSchedule => ({ id: row.id, status: row.status, transitionDue: row.due }));

/**
 * The tracked set as the drop scheduler sees it (§4.6), read without any lock, so the scheduler takes a
 * drop lock and a row lock only for the drops that have work: a due transition or a Redis status to repair.
 */
export async function listDropSchedule(db: Executor): Promise<DropSchedule[]> {
  const { rows } = await db.execute(sql`
    SELECT id, status, ${TRANSITION_DUE} AS due FROM drops
    WHERE status <> 'DRAFT' AND ${WITHIN_RETENTION}
    ORDER BY starts_at`);
  return parseRows(ScheduleRow, rows, 'listDropSchedule');
}

/** How long the scheduler waits for a drops row another writer holds before skipping the drop this tick. */
const SCHEDULER_LOCK_TIMEOUT = '1s';

/**
 * Applies the drop's due transition (§4.6, under the drop lock). Level-triggered: it acts on what is due
 * now, so a missed tick is caught up by the next. Undefined when nothing was due.
 *
 * The row is locked only when a transition is due (the predicate sits inside the locking CTE, and is
 * re-checked on the latest row version), with FOR NO KEY UPDATE for the reason given in `applyDropAction`,
 * and for at most `lock_timeout = 1s`: a busy row fails with 55P03, which the scheduler treats as "skip
 * this drop this tick".
 */
export async function applyDueDropTransition(db: Db, dropId: string): Promise<DropStatusChange | undefined> {
  return transaction(db, async (tx) => {
    await tx.execute(sql`SELECT set_config('lock_timeout', ${SCHEDULER_LOCK_TIMEOUT}, true)`);
    const { rows } = await tx.execute(sql`
      WITH prev AS (SELECT id, status FROM drops WHERE id = ${dropId} AND ${TRANSITION_DUE}
                    FOR NO KEY UPDATE)
      UPDATE drops d
      SET status = CASE WHEN now() >= d.ends_at THEN 'ENDED'::drop_status ELSE 'LIVE'::drop_status END
      FROM prev WHERE d.id = prev.id
      RETURNING prev.status AS from_status, d.status AS to_status`);
    return parseRows(StatusChangeRow, rows, 'applyDueDropTransition')[0];
  });
}

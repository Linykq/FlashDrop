import { type Db, PgUuid, parseRows, sql, transaction } from '@flashdrop/db';
import {
  BugError,
  DROP_RETENTION_SECONDS,
  DROP_STATUSES,
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  PSP_CHARGE_STATUSES,
} from '@flashdrop/domain';
import { z } from 'zod';
import type { FlashdropRedis } from '../client';
import { readDropState, readStock } from '../state';
import type { DropSample, LedgerCharge, PgDropSnapshot, RedisRead } from './rules';

/*
 * Reading one drop for the invariant checks (design §13, §12): a stable sample (§4.7) of its Postgres rows,
 * PSP ledger included, and its Redis keys. Read-only: every Postgres read runs in a READ ONLY transaction,
 * and the Redis reads never load the Functions library. `verify:invariants` repeats them until the system is
 * quiescent; the api's admin health page runs them once per check.
 */

/** The stores a drop is read from. */
export interface DropSampleDeps {
  readonly db: Db;
  readonly redis: FlashdropRedis;
}

const DropRow = z.object({
  status: z.enum(DROP_STATUSES),
  per_user_limit: z.int(),
  tracked: z.boolean(),
  total: z.int(),
  reserved: z.int(),
  sold: z.int(),
  redis_gen: z.int(),
  version: z.string(),
});
const OrderRow = z.object({
  id: PgUuid,
  user_id: PgUuid,
  qty: z.int(),
  status: z.enum(ORDER_STATUSES),
  total_cents: z.int(),
  fp: z.string(),
  idempotency_key: z.string(),
  due: z.boolean(),
  settled: z.boolean(),
  quarantined_by: z.array(z.string()),
  payment_status: z.enum(PAYMENT_STATUSES).nullable(),
  psp_charge_id: z.string().nullable(),
  payment_amount_cents: z.int().nullable(),
});
const ChargeRow = z.object({
  reference: z.string(),
  id: z.string(),
  status: z.enum(PSP_CHARGE_STATUSES),
  amount_cents: z.int(),
});
const QuotaRow = z.object({ user_id: PgUuid, claimed: z.int(), limit_qty: z.int() });
const VersionRow = z.object({ version: z.string() });

/**
 * Everything that changes when the drop's inventory, orders, quotas or quarantine rows change, as one
 * opaque string. Quotas change only together with an order (same transaction), and `redis_settled_at`
 * changes the unsettled count, so comparing two of these tells whether Postgres moved in between. Payments
 * and PSP charges are left out: they are only compared with orders of the same snapshot.
 */
const VERSION = sql`concat_ws('|', d.status, i.updated_at, i.redis_gen, i.reserved, i.sold,
  (SELECT count(*) FROM orders o WHERE o.drop_id = d.id),
  (SELECT count(*) FROM orders o WHERE o.drop_id = d.id AND o.redis_settled_at IS NULL),
  (SELECT max(o.updated_at) FROM orders o WHERE o.drop_id = d.id),
  (SELECT count(*) FROM sweeper_quarantine q JOIN orders o ON o.id = q.order_id WHERE o.drop_id = d.id))`;

/** The drop's Postgres side, PSP ledger included, in one REPEATABLE READ snapshot; undefined if unknown. */
export async function readPgSnapshot(db: Db, dropId: string): Promise<PgDropSnapshot | undefined> {
  return transaction(
    db,
    async (tx) => {
      const dropRows = await tx.execute(sql`
        SELECT d.status, d.per_user_limit, i.total, i.reserved, i.sold, i.redis_gen,
               (d.status <> 'DRAFT'
                AND now() < d.ends_at + make_interval(secs => ${DROP_RETENTION_SECONDS})) AS tracked,
               ${VERSION} AS version
        FROM drops d JOIN drop_inventory i ON i.drop_id = d.id
        WHERE d.id = ${dropId}`);
      const [drop] = parseRows(DropRow, dropRows.rows, 'readPgSnapshot drop');
      if (drop === undefined) return undefined;
      const orderRows = await tx.execute(sql`
        SELECT o.id, o.user_id, o.qty, o.status, o.total_cents, encode(o.request_hash, 'hex') AS fp,
               o.idempotency_key, o.expires_at < now() AS due, o.redis_settled_at IS NOT NULL AS settled,
               ARRAY(SELECT q.loop FROM sweeper_quarantine q WHERE q.order_id = o.id ORDER BY q.loop)
                 AS quarantined_by,
               p.status AS payment_status, p.psp_charge_id, p.amount_cents AS payment_amount_cents
        FROM orders o LEFT JOIN payments p ON p.order_id = o.id
        WHERE o.drop_id = ${dropId} ORDER BY o.id`);
      // The PSP's reference is the order id (§6.5). psp.charges has no index on reference, so this is one
      // hash semi-join over the ledger per drop, not a lookup per order.
      const chargeRows = await tx.execute(sql`
        SELECT c.reference, c.id, c.status, c.amount_cents FROM psp.charges c
        WHERE c.reference IN (SELECT o.id::text FROM orders o WHERE o.drop_id = ${dropId})
        ORDER BY c.created_at, c.id`);
      const quotaRows = await tx.execute(sql`
        SELECT user_id, claimed, limit_qty FROM user_drop_quota WHERE drop_id = ${dropId} ORDER BY user_id`);

      const charges = new Map<string, LedgerCharge[]>();
      for (const row of parseRows(ChargeRow, chargeRows.rows, 'readPgSnapshot charges')) {
        const list = charges.get(row.reference) ?? [];
        list.push({ id: row.id, status: row.status, amountCents: row.amount_cents });
        charges.set(row.reference, list);
      }
      return {
        status: drop.status,
        perUserLimit: drop.per_user_limit,
        tracked: drop.tracked,
        total: drop.total,
        reserved: drop.reserved,
        sold: drop.sold,
        redisGen: drop.redis_gen,
        version: drop.version,
        orders: parseRows(OrderRow, orderRows.rows, 'readPgSnapshot orders').map((order) => ({
          id: order.id,
          userId: order.user_id,
          qty: order.qty,
          status: order.status,
          totalCents: order.total_cents,
          fp: order.fp,
          idempotencyKey: order.idempotency_key,
          due: order.due,
          settled: order.settled,
          quarantinedBy: order.quarantined_by,
          payment:
            order.payment_status === null || order.payment_amount_cents === null
              ? null
              : {
                  status: order.payment_status,
                  pspChargeId: order.psp_charge_id,
                  amountCents: order.payment_amount_cents,
                },
          charges: charges.get(order.id) ?? [],
        })),
        quotas: parseRows(QuotaRow, quotaRows.rows, 'readPgSnapshot quotas').map((quota) => ({
          userId: quota.user_id,
          claimed: quota.claimed,
          limit: quota.limit_qty,
        })),
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

async function readPgVersion(db: Db, dropId: string): Promise<string | undefined> {
  const { rows } = await db.execute(sql`
    SELECT ${VERSION} AS version FROM drops d JOIN drop_inventory i ON i.drop_id = d.id WHERE d.id = ${dropId}`);
  return parseRows(VersionRow, rows, 'readPgVersion')[0]?.version;
}

/** Garbage in the drop's keys is a finding, not a crash; a dead connection still throws. */
function isMalformed(error: unknown): error is Error {
  return error instanceof z.ZodError || error instanceof SyntaxError || error instanceof BugError;
}

/** Every Function bumps `seq` on every write, and a rebuild changes `gen`: together, Redis's version. */
function redisVersion(read: RedisRead): string {
  if (read.kind === 'malformed') return 'malformed';
  const { inv } = read.state;
  return inv === null ? 'none' : `${inv.gen}:${inv.seq}`;
}

async function readRedis(redis: FlashdropRedis, dropId: string): Promise<RedisRead> {
  try {
    return { kind: 'ok', state: await readDropState(redis, dropId) };
  } catch (error) {
    if (!isMalformed(error)) throw error;
    return { kind: 'malformed', message: error.message };
  }
}

async function readRedisVersion(redis: FlashdropRedis, dropId: string): Promise<string> {
  try {
    const stock = await readStock(redis, dropId);
    return stock === null ? 'none' : `${stock.gen}:${stock.seq}`;
  } catch (error) {
    if (!isMalformed(error)) throw error;
    return 'malformed';
  }
}

/**
 * One stable-sample attempt (§4.7): Redis, then Postgres, then each side's version again. It is stable when
 * neither moved, so both reads describe the same instant. Undefined for an unknown drop.
 */
export async function sampleDrop(deps: DropSampleDeps, dropId: string): Promise<DropSample | undefined> {
  const redis = await readRedis(deps.redis, dropId);
  const pg = await readPgSnapshot(deps.db, dropId);
  if (pg === undefined) return undefined;
  const redisAfter = await readRedisVersion(deps.redis, dropId);
  const pgAfter = await readPgVersion(deps.db, dropId);
  return { dropId, pg, redis, stable: redisVersion(redis) === redisAfter && pg.version === pgAfter };
}

/**
 * Whether neither store has changed the drop since `sample` was taken, by the same versions a stable sample
 * compares. Then the sample still describes the drop, and an idle one need not be read again. Payments and
 * PSP charges are outside the version, but only an order that is pending work (holding money, or a refund
 * not yet recorded) can see them change without its own row changing, and a pending drop is always re-read.
 */
export async function unchangedSince(deps: DropSampleDeps, sample: DropSample): Promise<boolean> {
  return (
    (await readRedisVersion(deps.redis, sample.dropId)) === redisVersion(sample.redis) &&
    (await readPgVersion(deps.db, sample.dropId)) === sample.pg.version
  );
}

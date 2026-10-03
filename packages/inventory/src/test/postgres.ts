import { randomUUID } from 'node:crypto';
import {
  createDb,
  createPool,
  type Db,
  dropInventory,
  drops,
  expireDueOrders,
  insertRejectedTombstone,
  POOL_PROFILES,
  products,
  type ReservationOutcome,
  recordReservation,
  sql,
  transaction,
  users,
} from '@flashdrop/db';
import { createTestDatabase } from '@flashdrop/db/testing';
import type { DropStatus, RejectReason } from '@flashdrop/domain';
import type pg from 'pg';
import { DROP_LOCK_POOL_PROFILE } from '../drop-lock';
import type { ReserveInput } from '../functions';

/*
 * Integration-test helpers for Postgres (not exported from the package). Each test file gets a throwaway
 * database on the shared Compose server: the running stack's worker tracks every armed drop of the
 * development database, so a test drop there could be rebuilt, rescheduled or swept under the test. Redis
 * is the shared one; drops have fresh ids and tests delete their keys.
 *
 * The guarantee-carrying statements are the production ones (`recordReservation`,
 * `insertRejectedTombstone`, `expireDueOrders`), so these tests verify the code that runs, not copies of it.
 */

const quiet = { warn: () => undefined };

export interface TestPostgres {
  readonly db: Db;
  readonly pool: pg.Pool;
  readonly lockPool: pg.Pool;
  /** Closes the pools and drops the database. */
  readonly close: () => Promise<void>;
}

export async function createTestPostgres(): Promise<TestPostgres> {
  const database = await createTestDatabase();
  const pool = createPool({ connectionString: database.url, logger: quiet, ...POOL_PROFILES.api, max: 6 });
  const lockPool = createPool({
    connectionString: database.url,
    logger: quiet,
    ...DROP_LOCK_POOL_PROFILE,
    max: 4,
  });
  return {
    db: createDb(pool),
    pool,
    lockPool,
    close: async () => {
      await Promise.all([pool.end(), lockPool.end()]);
      await database.drop();
    },
  };
}

export async function createTestUser(db: Db): Promise<string> {
  const id = randomUUID();
  await db.insert(users).values({ id, email: `inv-test-${id}@example.test`, displayName: 'Inventory test' });
  return id;
}

export interface TestDrop {
  readonly dropId: string;
  readonly productId: string;
}

export async function createTestDrop(
  db: Db,
  options: {
    readonly total?: number;
    readonly limit?: number;
    readonly status?: DropStatus;
    readonly startsAt?: Date;
    readonly endsAt?: Date;
  } = {},
): Promise<TestDrop> {
  const productId = randomUUID();
  const dropId = randomUUID();
  const now = Date.now();
  await transaction(db, async (tx) => {
    await tx.insert(products).values({
      id: productId,
      slug: `inv-test-${productId}`,
      title: 'Inventory test product',
      description: 'Created by an inventory integration test.',
      imageKeys: [],
      status: 'PUBLISHED',
      source: 'test',
    });
    await tx.insert(drops).values({
      id: dropId,
      productId,
      startsAt: options.startsAt ?? new Date(now - 60_000),
      endsAt: options.endsAt ?? new Date(now + 3_600_000),
      priceCents: 1_999,
      perUserLimit: options.limit ?? 2,
      holdSeconds: 120,
      status: options.status ?? 'LIVE',
    });
    await tx.insert(dropInventory).values({ dropId, total: options.total ?? 10 });
  });
  return { dropId, productId };
}

/** The request behind a hold, as `NewReservation` spells it. */
function asReservation(hold: ReserveInput) {
  return {
    id: hold.rid,
    userId: hold.userId,
    dropId: hold.dropId,
    qty: hold.qty,
    idempotencyKey: hold.idempotencyKey,
    requestHash: Buffer.from(hold.fingerprint),
  };
}

/** The api's reserve transaction for a hold `fd_reserve` admitted under generation `gen`. */
export function recordHold(db: Db, hold: ReserveInput, gen: number): Promise<ReservationOutcome> {
  return recordReservation(db, { ...asReservation(hold), gen });
}

/** The api's REJECTED tombstone (with its `order.rejected` row) for a hold Postgres refused. */
export function rejectHold(db: Db, hold: ReserveInput, reason: RejectReason = 'SOLD_OUT'): Promise<boolean> {
  return insertRejectedTombstone(db, { ...asReservation(hold), reason });
}

/**
 * An order's terminal transition with its counters. EXPIRED is the sweeper's own `expireDueOrders`, run
 * after the order's deadline is moved into the past (the throwaway database holds only this file's orders).
 */
export async function closeOrder(
  db: Db,
  rid: string,
  outcome: 'EXPIRED' | 'PAID' | 'CANCELLED',
): Promise<void> {
  if (outcome === 'EXPIRED') {
    await db.execute(sql`UPDATE orders SET expires_at = now() - interval '1 second' WHERE id = ${rid}`);
    const tick = await expireDueOrders(db);
    if (tick.kind === 'busy' || !tick.expired.some((order) => order.id === rid)) {
      throw new Error(`order ${rid} did not expire: ${JSON.stringify(tick)}`);
    }
    return;
  }
  await transaction(db, async (tx) => {
    if (outcome === 'PAID') {
      // TODO(M4): the payment consumer's PENDING_PAYMENT -> PAID CAS replaces this.
      await tx.execute(
        sql`UPDATE orders SET status = 'PENDING_PAYMENT', version = version + 1 WHERE id = ${rid}`,
      );
      const { rows } = await tx.execute<{ drop_id: string; qty: number }>(sql`
        UPDATE orders SET status = 'PAID', paid_at = now(), version = version + 1, updated_at = now()
        WHERE id = ${rid} AND status = 'PENDING_PAYMENT' RETURNING drop_id, qty`);
      const [order] = rows;
      if (order === undefined) throw new Error(`order ${rid} is not payable`);
      await tx.execute(sql`
        UPDATE drop_inventory SET reserved = reserved - ${order.qty}, sold = sold + ${order.qty}
        WHERE drop_id = ${order.drop_id}`);
      return;
    }
    // TODO(M3): the api's cancel CAS replaces this.
    const { rows } = await tx.execute<{ drop_id: string; user_id: string; qty: number }>(sql`
      UPDATE orders SET status = 'CANCELLED', close_reason = 'USER', closed_at = now(),
                        version = version + 1, updated_at = now()
      WHERE id = ${rid} AND status IN ('RESERVED', 'PENDING_PAYMENT') RETURNING drop_id, user_id, qty`);
    const [order] = rows;
    if (order === undefined) throw new Error(`order ${rid} is not live`);
    await tx.execute(sql`
      UPDATE user_drop_quota SET claimed = claimed - ${order.qty}
      WHERE user_id = ${order.user_id} AND drop_id = ${order.drop_id}`);
    await tx.execute(
      sql`UPDATE drop_inventory SET reserved = reserved - ${order.qty} WHERE drop_id = ${order.drop_id}`,
    );
  });
}

/** Postgres's stock of record for a drop. */
export async function inventoryOf(db: Db, dropId: string) {
  const { rows } = await db.execute<{ total: number; reserved: number; sold: number; redis_gen: number }>(sql`
    SELECT total, reserved, sold, redis_gen FROM drop_inventory WHERE drop_id = ${dropId}`);
  const [row] = rows;
  if (row === undefined) throw new Error(`no inventory for ${dropId}`);
  return row;
}

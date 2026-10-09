import { randomUUID } from 'node:crypto';
import {
  cancelOrder,
  createDb,
  createPool,
  type Db,
  dropInventory,
  drops,
  expireDueOrders,
  getOrder,
  insertRejectedTombstone,
  markPaid,
  POOL_PROFILES,
  products,
  type ReservationOutcome,
  recordReservation,
  sql,
  submitCheckout,
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
 * `insertRejectedTombstone`, `submitCheckout`, `markPaid`, `cancelOrder`, `expireDueOrders`), so these
 * tests rebuild Redis from exactly the rows production writes (the payments row, the outbox events), and
 * verify the code that runs, not copies of it.
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
 * An order's terminal transition, through the production statements: PAID is the buyer's checkout submit
 * and then the payment consumer's CAS; CANCELLED the buyer's cancel (`fd_cancel_order`); EXPIRED the
 * sweeper's own `expireDueOrders`, run after the order's deadline is moved into the past (the throwaway
 * database holds only this file's orders).
 */
export async function closeOrder(
  db: Db,
  rid: string,
  outcome: 'EXPIRED' | 'PAID' | 'CANCELLED',
): Promise<void> {
  const order = await getOrder(db, rid);
  if (order === undefined) throw new Error(`no order ${rid}`);
  const { userId } = order;
  switch (outcome) {
    case 'EXPIRED': {
      await db.execute(sql`UPDATE orders SET expires_at = now() - interval '1 second' WHERE id = ${rid}`);
      const tick = await expireDueOrders(db);
      if (tick.kind === 'busy' || !tick.expired.some((expired) => expired.id === rid)) {
        throw new Error(`order ${rid} did not expire: ${JSON.stringify(tick)}`);
      }
      return;
    }
    case 'PAID': {
      const submitted = await submitCheckout(db, {
        orderId: rid,
        userId,
        checkoutKey: randomUUID(),
        shipping: SHIPPING,
        paymentMethod: 'pm_ok',
      });
      if (submitted.kind !== 'submitted')
        throw new Error(`order ${rid} was not submitted: ${submitted.kind}`);
      const paid = await markPaid(db, { orderId: rid, pspChargeId: `ch_${rid}` });
      if (paid.kind !== 'won') throw new Error(`order ${rid} was not paid: ${paid.order.status}`);
      return;
    }
    case 'CANCELLED': {
      const cancelled = await cancelOrder(db, { orderId: rid, userId });
      if (cancelled.kind !== 'cancelled')
        throw new Error(`order ${rid} was not cancelled: ${cancelled.kind}`);
      return;
    }
  }
}

const SHIPPING = {
  name: 'Inventory Test',
  line1: '1 Market Street',
  city: 'San Francisco',
  postalCode: '94105',
  country: 'US',
} as const;

/** Postgres's stock of record for a drop. */
export async function inventoryOf(db: Db, dropId: string) {
  const { rows } = await db.execute<{ total: number; reserved: number; sold: number; redis_gen: number }>(sql`
    SELECT total, reserved, sold, redis_gen FROM drop_inventory WHERE drop_id = ${dropId}`);
  const [row] = rows;
  if (row === undefined) throw new Error(`no inventory for ${dropId}`);
  return row;
}

import { randomUUID } from 'node:crypto';
import type { DropStatus } from '@flashdrop/domain';
import { requestFingerprint, reservationId } from '@flashdrop/domain/identity';
import { sql } from 'drizzle-orm';
import type { Db } from './client';
import { dropInventory, drops, products, users } from './schema';
import type { NewReservation } from './transitions';

/*
 * Integration-test fixtures (not exported from the package): fresh users and drops with unique ids, and the
 * counter checks of INV-2 and INV-3, so every test can assert that the counters still match the orders.
 */

export async function createUsers(db: Db, count: number): Promise<string[]> {
  const ids = Array.from({ length: count }, () => randomUUID());
  await db
    .insert(users)
    .values(ids.map((id) => ({ id, email: `${id}@test.example`, displayName: 'Tester' })));
  return ids;
}

export interface DropOptions {
  readonly total?: number;
  readonly perUserLimit?: number;
  readonly status?: DropStatus;
  /** Seconds relative to now. Default: started a minute ago, ends in an hour. */
  readonly startsIn?: number;
  readonly endsIn?: number;
  readonly holdSeconds?: number;
}

export interface TestDrop {
  readonly dropId: string;
  readonly productId: string;
}

/** A product, a drop of it and its inventory, LIVE inside its window unless told otherwise. */
export async function createDrop(db: Db, options: DropOptions = {}): Promise<TestDrop> {
  const productId = randomUUID();
  const dropId = randomUUID();
  await db.insert(products).values({
    id: productId,
    slug: `p-${productId}`,
    title: 'Integration test product',
    description: 'Exists only in this test database.',
    imageKeys: [],
    status: 'PUBLISHED',
  });
  await db.insert(drops).values({
    id: dropId,
    productId,
    startsAt: sql`now() + make_interval(secs => ${options.startsIn ?? -60})`,
    endsAt: sql`now() + make_interval(secs => ${options.endsIn ?? 3600})`,
    priceCents: 1999,
    perUserLimit: options.perUserLimit ?? 2,
    holdSeconds: options.holdSeconds ?? 120,
    status: options.status ?? 'LIVE',
  });
  await db.insert(dropInventory).values({ dropId, total: options.total ?? 10 });
  return { dropId, productId };
}

/** The reservation a request `(user, drop, key, qty)` would record. */
export function reservation(userId: string, dropId: string, qty = 1, key = randomUUID()): NewReservation {
  return {
    id: reservationId({ userId, dropId, idempotencyKey: key }),
    userId,
    dropId,
    qty,
    idempotencyKey: key,
    requestHash: requestFingerprint({ dropId, qty }),
  };
}

export interface CounterCheck {
  readonly total: number;
  readonly reserved: number;
  readonly sold: number;
  /** Σqty of RESERVED and PENDING_PAYMENT orders: must equal `reserved` (INV-2). */
  readonly liveUnits: number;
  readonly paidUnits: number;
  /** Quota rows whose `claimed` differs from the user's live and paid units (INV-3), or passes the limit. */
  readonly quotaMismatches: readonly { userId: string; claimed: number; units: number; limit: number }[];
}

export async function checkCounters(db: Db, dropId: string): Promise<CounterCheck> {
  const { rows } = await db.execute<{
    total: number;
    reserved: number;
    sold: number;
    live: number;
    paid: number;
  }>(sql`
    SELECT i.total, i.reserved, i.sold,
           (SELECT COALESCE(sum(qty), 0)::int FROM orders
            WHERE drop_id = i.drop_id AND status IN ('RESERVED', 'PENDING_PAYMENT')) AS live,
           (SELECT COALESCE(sum(qty), 0)::int FROM orders WHERE drop_id = i.drop_id AND status = 'PAID') AS paid
    FROM drop_inventory i WHERE i.drop_id = ${dropId}`);
  const quotas = await db.execute<{ user_id: string; claimed: number; units: number; limit_qty: number }>(sql`
    SELECT q.user_id, q.claimed, q.limit_qty,
           (SELECT COALESCE(sum(qty), 0)::int FROM orders o
            WHERE o.drop_id = q.drop_id AND o.user_id = q.user_id
              AND o.status IN ('RESERVED', 'PENDING_PAYMENT', 'PAID')) AS units
    FROM user_drop_quota q WHERE q.drop_id = ${dropId}`);
  const [row] = rows;
  if (row === undefined) throw new Error(`no inventory for ${dropId}`);
  return {
    total: row.total,
    reserved: row.reserved,
    sold: row.sold,
    liveUnits: row.live,
    paidUnits: row.paid,
    quotaMismatches: quotas.rows
      .filter((q) => q.claimed !== q.units || q.claimed > q.limit_qty)
      .map((q) => ({ userId: q.user_id, claimed: q.claimed, units: q.units, limit: q.limit_qty })),
  };
}

/** Outbox events about one order, oldest first. */
export async function eventsOf(db: Db, orderId: string): Promise<{ type: string; payload: unknown }[]> {
  const { rows } = await db.execute<{ type: string; payload: unknown }>(sql`
    SELECT event_type AS type, payload FROM outbox WHERE payload->>'orderId' = ${orderId} ORDER BY id`);
  return rows;
}

/** A promise and the function that settles it: a gate a test opens to release a paused transaction. */
export function gate(): { readonly wait: Promise<void>; readonly open: () => void } {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { wait: promise, open: () => resolve() };
}

/**
 * Waits for `point` (a gate the work opens), but fails as soon as `work` settles first: a test waiting for
 * a transaction to reach a point must not hang until its timeout, with the real error reported only as an
 * unhandled rejection, when the transaction failed before it got there.
 */
export function reached(point: Promise<void>, work: Promise<unknown>): Promise<void> {
  return Promise.race([
    point,
    work.then(
      () => Promise.reject(new Error('the work finished before reaching the point')),
      (error: unknown) => Promise.reject(error),
    ),
  ]);
}

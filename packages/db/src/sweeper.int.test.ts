import { randomInt } from 'node:crypto';
import { OrderEvent } from '@flashdrop/contracts';
import { and, eq, inArray, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client';
import { pgErrorOf } from './errors';
import { getOrder } from './orders';
import { createPool, POOL_PROFILES } from './pool';
import { orders, sweeperQuarantine, userDropQuota } from './schema';
import {
  type ExpiredOrder,
  type ExpireTick,
  expireDueOrders,
  listUnsettledTerminalOrders,
  quarantineOrder,
  tryLoopLock,
} from './sweeper';
import { createTestDatabase, type TestDatabase } from './test-database';
import {
  checkCounters,
  createDrop,
  createUsers,
  eventsOf,
  gate,
  reached,
  reservation,
} from './test-fixtures';
import { transaction } from './transaction';
import { markRedisSettled, markRedisSettledMany, recordReservation } from './transitions';

/*
 * The sweeper's expiry batch and the settle safety net (design §4.6) against real Postgres 17. Every
 * expire tick in this file runs over the whole test database, so assertions are about each test's own drop.
 */

let test: TestDatabase;
let pool: pg.Pool;
let db: Db;

beforeAll(async () => {
  test = await createTestDatabase();
  pool = createPool({
    connectionString: test.url,
    logger: { warn: () => undefined },
    ...POOL_PROFILES.api,
    max: 40,
  });
  db = createDb(pool);
});

afterAll(async () => {
  await pool?.end();
  await test?.drop();
});

/** Reserves one order per (user, qty) and returns their ids. */
async function reserveAll(
  dropId: string,
  requests: readonly (readonly [string, number])[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const [userId, qty] of requests) {
    const r = reservation(userId, dropId, qty);
    const outcome = await recordReservation(db, { ...r, gen: 0 });
    if (outcome.kind !== 'created') throw new Error(`setup reserve failed: ${JSON.stringify(outcome)}`);
    ids.push(r.id);
  }
  return ids;
}

/** Makes orders due now. `expires_at` is not frozen by orders_guard: the sweeper must accept any deadline. */
async function makeDue(ids: readonly string[]): Promise<void> {
  await db.execute(
    sql`UPDATE orders SET expires_at = now() - interval '1 second' WHERE id = ANY(${sql.param(ids)}::uuid[])`,
  );
}

/** RESERVED -> PENDING_PAYMENT, the way checkout submit does it. */
async function place(id: string): Promise<void> {
  await db
    .update(orders)
    .set({ status: 'PENDING_PAYMENT', checkoutKey: `ck-${id}`, version: sql`version + 1` })
    .where(and(eq(orders.id, id), eq(orders.status, 'RESERVED')));
}

const expiredIds = (tick: ExpireTick) =>
  'expired' in tick ? tick.expired.map((o: ExpiredOrder) => o.id) : [];

describe('expire-orders (§4.6)', () => {
  it('expires due orders and gives quota and stock back, with one order.expired each and one NOTIFY', async () => {
    const { dropId, productId } = await createDrop(db, { total: 20, perUserLimit: 5 });
    const [a = '', b = ''] = await createUsers(db, 2);
    const [a1 = '', a2 = '', b1 = '', keep = ''] = await reserveAll(dropId, [
      [a, 1],
      [a, 2],
      [b, 3],
      [b, 1],
    ]);
    await place(a2);
    await makeDue([a1, a2, b1]);

    const listener = new pg.Client({ connectionString: test.url });
    await listener.connect();
    const notifications: string[] = [];
    listener.on('notification', (n) => notifications.push(n.channel));
    await listener.query('LISTEN outbox');
    try {
      const tick = await expireDueOrders(db);

      expect(tick.kind).toBe('batch');
      expect(new Set(expiredIds(tick))).toEqual(new Set([a1, a2, b1]));
      // Delivery to another session is asynchronous: wait for the one NOTIFY, then give a second time to
      // show up, which it must not.
      await expect.poll(() => notifications).toEqual(['outbox']);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(notifications).toEqual(['outbox']);
    } finally {
      await listener.end();
    }

    for (const [id, version, fromStatus, qty] of [
      [a1, 2, 'RESERVED', 1],
      [a2, 3, 'PENDING_PAYMENT', 2],
      [b1, 2, 'RESERVED', 3],
    ] as const) {
      const order = await getOrder(db, id);
      expect(order).toMatchObject({
        status: 'EXPIRED',
        closeReason: 'TIMEOUT',
        version,
        redisSettledAt: null,
      });
      expect(order?.closedAt).toBeInstanceOf(Date);
      const events = await eventsOf(db, id);
      expect(events.map((e) => e.type)).toEqual(['order.reserved', 'order.expired']);
      expect(OrderEvent.parse(events[1]?.payload)).toMatchObject({
        orderId: id,
        orderVersion: version,
        productId,
        dropId,
        occurredAt: order?.closedAt?.toISOString(),
        data: { qty, fromStatus },
      });
    }
    expect((await getOrder(db, keep))?.status).toBe('RESERVED');

    const counters = await checkCounters(db, dropId);
    expect(counters).toMatchObject({ reserved: 1, liveUnits: 1, quotaMismatches: [] });
    const quotas = await db.select().from(userDropQuota).where(eq(userDropQuota.dropId, dropId));
    expect(Object.fromEntries(quotas.map((q) => [q.userId, q.claimed]))).toEqual({ [a]: 0, [b]: 1 });

    // Nothing is due any more: the next tick is a no-op for this drop.
    expect(expiredIds(await expireDueOrders(db))).not.toContain(a1);
  });

  it('skips the tick while another instance holds the loop lock', async () => {
    const held = gate();
    const locked = gate();
    const holder = transaction(db, async (tx) => {
      expect(await tryLoopLock(tx, 'expire-orders')).toBe(true);
      locked.open();
      await held.wait;
    });
    await reached(locked.wait, holder);
    try {
      expect(await expireDueOrders(db)).toEqual({ kind: 'busy' });
    } finally {
      held.open();
      await holder;
    }
  });

  it('falls back to one transaction per order and quarantines the order that still fails', async () => {
    const { dropId } = await createDrop(db, { total: 20, perUserLimit: 5 });
    const [good = '', bad = ''] = await createUsers(db, 2);
    const [g1 = '', g2 = '', b1 = ''] = await reserveAll(dropId, [
      [good, 1],
      [good, 2],
      [bad, 2],
    ]);
    await makeDue([g1, g2, b1]);
    // A counter bug: the bad user's quota no longer covers the order, so giving it back breaks within_limit.
    await db
      .update(userDropQuota)
      .set({ claimed: 1 })
      .where(and(eq(userDropQuota.userId, bad), eq(userDropQuota.dropId, dropId)));

    const tick = await expireDueOrders(db);

    if (tick.kind !== 'fallback') throw new Error(`expected a fallback, got ${tick.kind}`);
    expect(pgErrorOf(tick.batchError)?.constraint).toBe('within_limit');
    expect(new Set(expiredIds(tick))).toEqual(new Set([g1, g2]));
    expect(tick.quarantined).toEqual([{ orderId: b1, error: expect.stringContaining('within_limit') }]);
    expect((await getOrder(db, b1))?.status).toBe('RESERVED');
    const [row] = await db.select().from(sweeperQuarantine).where(eq(sweeperQuarantine.orderId, b1));
    expect(row).toMatchObject({
      loop: 'expire-orders',
      error: expect.stringMatching(/^23514 within_limit: new row .* violates check constraint/),
    });

    // Later ticks skip the quarantined order instead of failing on it again.
    const next = await expireDueOrders(db);
    expect(next.kind).toBe('batch');
    expect(expiredIds(next)).not.toContain(b1);
    expect((await getOrder(db, b1))?.status).toBe('RESERVED');
    // The healthy orders were given back exactly once.
    expect(await checkCounters(db, dropId)).toMatchObject({ reserved: 2, liveUnits: 2 });
  });

  it('never deadlocks with concurrent reserves, and keeps the counters exact (lock order)', async () => {
    const dropsUnderTest = await Promise.all(
      [1, 2, 3].map(() => createDrop(db, { total: 200, perUserLimit: 4 })),
    );
    const buyers = await createUsers(db, 25);
    const pick = <T>(values: readonly T[]): T => values[randomInt(values.length)] as T;
    const errors: unknown[] = [];
    let stop = false;

    const reserver = async () => {
      while (!stop) {
        const { dropId } = pick(dropsUnderTest);
        const r = reservation(pick(buyers), dropId, randomInt(1, 3));
        const outcome = await recordReservation(db, { ...r, gen: 0 }).catch((e: unknown) => {
          errors.push(e);
          return undefined;
        });
        // Half the winners are abandoned on the spot, so expiry and reserves keep hitting the same rows.
        if (outcome?.kind === 'created' && randomInt(2) === 0) await makeDue([r.id]);
      }
    };
    const sweeper = async () => {
      let ticks = 0;
      while (!stop) {
        const tick = await expireDueOrders(db, { limit: 50 }).catch((e: unknown) => {
          errors.push(e);
          return undefined;
        });
        if (tick?.kind === 'fallback') errors.push(tick.batchError);
        ticks++;
      }
      return ticks;
    };

    const reservers = Array.from({ length: 16 }, () => reserver());
    const sweepers = [sweeper(), sweeper()];
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    stop = true;
    await Promise.all(reservers);
    const ticks = await Promise.all(sweepers);

    expect(errors.map((e) => pgErrorOf(e)?.code ?? String(e))).toEqual([]);
    expect(ticks.reduce((sum, n) => sum + n, 0)).toBeGreaterThan(0);
    await expireDueOrders(db);
    for (const { dropId } of dropsUnderTest) {
      const counters = await checkCounters(db, dropId);
      expect(counters.reserved).toBe(counters.liveUnits);
      expect(counters.quotaMismatches).toEqual([]);
    }
    const expired = await db
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          inArray(
            orders.dropId,
            dropsUnderTest.map((d) => d.dropId),
          ),
          eq(orders.status, 'EXPIRED'),
        ),
      );
    expect(expired.length).toBeGreaterThan(0);
  });
});

describe('settling Redis (§4.6, §6.5)', () => {
  it('marks only terminal orders, once', async () => {
    const { dropId } = await createDrop(db);
    const [userId = ''] = await createUsers(db, 1);
    const [id = ''] = await reserveAll(dropId, [[userId, 1]]);

    expect(await markRedisSettled(db, id)).toBe(false); // live: the safety net must still see it once it ends
    await makeDue([id]);
    await expireDueOrders(db);
    expect(await markRedisSettled(db, id)).toBe(true);
    expect(await markRedisSettled(db, id)).toBe(false);
    expect((await getOrder(db, id))?.redisSettledAt).toBeInstanceOf(Date);
  });

  it('lists unsettled terminal orders after the age threshold, minus the safety net quarantine', async () => {
    const { dropId } = await createDrop(db, { perUserLimit: 3 });
    const [userId = ''] = await createUsers(db, 1);
    const [settled = '', unsettled = '', parked = ''] = await reserveAll(dropId, [
      [userId, 1],
      [userId, 1],
      [userId, 1],
    ]);
    await makeDue([settled, unsettled, parked]);
    await expireDueOrders(db);
    await markRedisSettled(db, settled);
    await quarantineOrder(db, 'settle-safety-net', parked, new Error('boom'));

    const mine = async (olderThanSeconds: number) =>
      (await listUnsettledTerminalOrders(db, { olderThanSeconds, limit: 1_000 }))
        .filter((o) => o.dropId === dropId)
        .map((o) => o.id);

    expect(await mine(60)).toEqual([]); // the settlement consumer gets the first go
    expect(await mine(0)).toEqual([unsettled]);
    expect(await quarantineOrder(db, 'settle-safety-net', parked, new Error('again'))).toBe(false);
  });

  it('pages past the drops a tick has given up on, and marks a whole page in one statement', async () => {
    const stuck = await createDrop(db, { perUserLimit: 3 });
    const other = await createDrop(db, { perUserLimit: 3 });
    const [userId = ''] = await createUsers(db, 1);
    const stuckIds = await reserveAll(stuck.dropId, [
      [userId, 1],
      [userId, 1],
    ]);
    const otherIds = await reserveAll(other.dropId, [[userId, 1]]);
    await makeDue([...stuckIds, ...otherIds]);
    await expireDueOrders(db);
    const mine = (excludeDropIds: readonly string[]) =>
      listUnsettledTerminalOrders(db, { olderThanSeconds: 0, limit: 1_000, excludeDropIds }).then((page) =>
        page.filter((o) => [stuck.dropId, other.dropId].includes(o.dropId)).map((o) => o.id),
      );

    expect(new Set(await mine([]))).toEqual(new Set([...stuckIds, ...otherIds]));
    expect(await mine([stuck.dropId])).toEqual(otherIds);

    const live = await reserveAll(other.dropId, [[userId, 1]]);
    expect(new Set(await markRedisSettledMany(db, [...stuckIds, ...live]))).toEqual(new Set(stuckIds));
    expect(await markRedisSettledMany(db, stuckIds)).toEqual([]);
    expect(await markRedisSettledMany(db, [])).toEqual([]);
    expect(await mine([])).toEqual(otherIds);
  });
});

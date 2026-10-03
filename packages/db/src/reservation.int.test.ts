import { OrderEvent } from '@flashdrop/contracts';
import { eq, sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client';
import { getOrder } from './orders';
import { insertOutboxEvents, orderEvent } from './outbox';
import { createPool, POOL_PROFILES } from './pool';
import { drops, outbox, userDropQuota } from './schema';
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
import {
  claimQuota,
  fenceRedisGeneration,
  insertOrderOnConflictDoNothing,
  insertRejectedTombstone,
  type ReservationOutcome,
  recordReservation,
  takeStock,
} from './transitions';

/*
 * The reserve transaction's guarantees (design §4.5, §5.2) against real Postgres 17, under concurrency.
 * Redis is not involved: every test plays a Lua admission that already happened (or a wrong one), and
 * checks that Postgres alone holds the line.
 */

let test: TestDatabase;
/** An api-shaped pool (statement_timeout 2 s, transaction_timeout 5 s), wide enough for real contention. */
let apiPool: pg.Pool;
let db: Db;

beforeAll(async () => {
  test = await createTestDatabase();
  apiPool = createPool({
    connectionString: test.url,
    logger: { warn: () => undefined },
    ...POOL_PROFILES.api,
    max: 40,
  });
  db = createDb(apiPool);
});

afterAll(async () => {
  await apiPool?.end();
  await test?.drop();
});

const kinds = (outcomes: readonly ReservationOutcome[]) =>
  outcomes.map((o) => (o.kind === 'refused' ? o.reason : o.kind));
const count = (values: readonly string[], value: string) => values.filter((v) => v === value).length;

describe('recordReservation', () => {
  it('records the order, its quota, its order.reserved event and its stock in one transaction', async () => {
    const { dropId, productId } = await createDrop(db, { total: 5, holdSeconds: 45 });
    const [userId = ''] = await createUsers(db, 1);
    const r = reservation(userId, dropId, 2);

    const outcome = await recordReservation(db, { ...r, gen: 0, traceId: 'trace-abc' });

    expect(outcome.kind).toBe('created');
    const order = await getOrder(db, r.id);
    expect(order).toMatchObject({
      status: 'RESERVED',
      userId,
      dropId,
      productId,
      qty: 2,
      unitPriceCents: 1999,
      totalCents: 3998,
      currency: 'USD',
      version: 1,
      idempotencyKey: r.idempotencyKey,
      requestHash: r.requestHash,
    });
    if (order === undefined) throw new Error('unreachable');
    // expires_at = now() + hold_seconds, by Postgres time.
    expect(order.expiresAt.getTime() - order.createdAt.getTime()).toBe(45_000);
    // The insert statement also read the product summary of the 201 answer, so no second read is needed.
    expect(outcome).toEqual({
      kind: 'created',
      order,
      product: { id: productId, slug: `p-${productId}`, title: 'Integration test product', imageKeys: [] },
    });

    const [quota] = await db.select().from(userDropQuota).where(eq(userDropQuota.userId, userId));
    expect(quota).toMatchObject({ claimed: 2, limitQty: 2 });

    const [row] = await db.select().from(outbox).where(sql`${outbox.payload}->>'orderId' = ${r.id}`);
    expect(row).toMatchObject({ topic: 'orders.v1', partitionKey: productId, eventType: 'order.reserved' });
    expect(row?.headers).toEqual({ 'trace-id': 'trace-abc' });
    expect(OrderEvent.parse(row?.payload)).toEqual({
      eventId: row?.eventId,
      schemaVersion: 1,
      type: 'order.reserved',
      occurredAt: order.createdAt.toISOString(),
      orderId: r.id,
      orderVersion: 1,
      productId,
      dropId,
      userId,
      traceId: 'trace-abc',
      data: { qty: 2, unitPriceCents: 1999, expiresAt: order.expiresAt.toISOString() },
    });

    expect(await checkCounters(db, dropId)).toMatchObject({ reserved: 2, liveUnits: 2, quotaMismatches: [] });
  });

  it('never oversells: 120 concurrent reserves on 30 units give exactly 30 orders (INV-1)', async () => {
    const { dropId } = await createDrop(db, { total: 30 });
    const buyers = await createUsers(db, 120);

    const outcomes = await Promise.all(
      buyers.map((userId) => recordReservation(db, { ...reservation(userId, dropId), gen: 0 })),
    );

    const results = kinds(outcomes);
    expect(count(results, 'created')).toBe(30);
    expect(count(results, 'SOLD_OUT')).toBe(90);
    const counters = await checkCounters(db, dropId);
    expect(counters).toMatchObject({ total: 30, reserved: 30, liveUnits: 30, quotaMismatches: [] });
    // A refused transaction rolled back completely: no order, no quota claim and no event remain.
    const { rows } = await db.execute<{ orders: number; quotas: number; events: number }>(sql`
      SELECT (SELECT count(*)::int FROM orders WHERE drop_id = ${dropId}) AS orders,
             (SELECT count(*)::int FROM user_drop_quota WHERE drop_id = ${dropId}) AS quotas,
             (SELECT count(*)::int FROM outbox WHERE payload->>'dropId' = ${dropId}) AS events`);
    expect(rows[0]).toEqual({ orders: 30, quotas: 30, events: 30 });
  });

  it('keeps one user within the limit across many keys and tabs (INV-3)', async () => {
    const { dropId } = await createDrop(db, { total: 100, perUserLimit: 3 });
    const [userId = ''] = await createUsers(db, 1);

    const outcomes = await Promise.all(
      [1, 2, 1, 1, 2, 1, 1, 1, 2, 1].map((qty) =>
        recordReservation(db, { ...reservation(userId, dropId, qty), gen: 0 }),
      ),
    );

    const created = outcomes.flatMap((o) => (o.kind === 'created' ? [o.order.qty] : []));
    expect(created.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(3);
    expect(kinds(outcomes).every((k) => k === 'created' || k === 'LIMIT')).toBe(true);
    const counters = await checkCounters(db, dropId);
    expect(counters.quotaMismatches).toEqual([]);
    expect(counters.reserved).toBe(counters.liveUnits);
    // Concurrent claims serialize on the quota row, so the limit is filled exactly.
    expect(counters.reserved).toBe(3);
  });

  it('refuses a first claim above the limit, and keeps the limit copied at the first claim', async () => {
    const { dropId } = await createDrop(db, { total: 100, perUserLimit: 2 });
    const [userId = ''] = await createUsers(db, 1);

    expect(await recordReservation(db, { ...reservation(userId, dropId, 3), gen: 0 })).toEqual({
      kind: 'refused',
      reason: 'LIMIT',
    });
    expect((await recordReservation(db, { ...reservation(userId, dropId, 1), gen: 0 })).kind).toBe('created');
    // Armed drops never change; even if one did, the claimed limit would not follow it.
    await db.update(drops).set({ perUserLimit: 5 }).where(eq(drops.id, dropId));
    expect(await recordReservation(db, { ...reservation(userId, dropId, 2), gen: 0 })).toEqual({
      kind: 'refused',
      reason: 'LIMIT',
    });
    const [quota] = await db.select().from(userDropQuota).where(eq(userDropQuota.userId, userId));
    expect(quota).toMatchObject({ claimed: 1, limitQty: 2 });
  });

  it.each([
    ['PAUSED', { status: 'PAUSED' }],
    ['ENDED', { status: 'ENDED' }],
    ['DRAFT', { status: 'DRAFT' }],
    ['LIVE but past ends_at', { status: 'LIVE', startsIn: -120, endsIn: -1 }],
    ['SCHEDULED before starts_at', { status: 'SCHEDULED', startsIn: 60 }],
  ] as const)('refuses NOT_LIVE outside the window, whatever Redis said: %s', async (_case, options) => {
    const { dropId } = await createDrop(db, options);
    const [userId = ''] = await createUsers(db, 1);
    const r = reservation(userId, dropId);

    expect(await recordReservation(db, { ...r, gen: 0 })).toEqual({ kind: 'refused', reason: 'NOT_LIVE' });
    expect(await getOrder(db, r.id)).toBeUndefined();
    expect(await checkCounters(db, dropId)).toMatchObject({ reserved: 0, quotaMismatches: [] });
  });

  it('admits a SCHEDULED drop inside its window: Lua opens on time, before the scheduler flips it', async () => {
    const { dropId } = await createDrop(db, { status: 'SCHEDULED', startsIn: -1 });
    const [userId = ''] = await createUsers(db, 1);

    expect((await recordReservation(db, { ...reservation(userId, dropId), gen: 0 })).kind).toBe('created');
  });

  it('classifies a refusal STALE_GEN first, then NOT_LIVE, then SOLD_OUT', async () => {
    const { dropId } = await createDrop(db, { total: 1, status: 'ENDED' });
    const [a = '', b = ''] = await createUsers(db, 2);
    await db.execute(sql`UPDATE drop_inventory SET reserved = 1 WHERE drop_id = ${dropId}`);

    expect(await recordReservation(db, { ...reservation(a, dropId), gen: 7 })).toEqual({
      kind: 'refused',
      reason: 'STALE_GEN',
    });
    expect(await recordReservation(db, { ...reservation(b, dropId), gen: 0 })).toEqual({
      kind: 'refused',
      reason: 'NOT_LIVE',
    });
    await db.update(drops).set({ status: 'LIVE' }).where(eq(drops.id, dropId));
    expect(await recordReservation(db, { ...reservation(b, dropId), gen: 0 })).toEqual({
      kind: 'refused',
      reason: 'SOLD_OUT',
    });
  });

  it('replays a rid that exists, and serializes concurrent same-key requests on the primary key', async () => {
    const { dropId } = await createDrop(db, { total: 10 });
    const [userId = ''] = await createUsers(db, 1);
    const r = reservation(userId, dropId);

    const outcomes = await Promise.all(
      Array.from({ length: 12 }, () => recordReservation(db, { ...r, gen: 0 })),
    );

    expect(count(kinds(outcomes), 'created')).toBe(1);
    expect(count(kinds(outcomes), 'replay')).toBe(11);
    expect(await recordReservation(db, { ...r, gen: 0 })).toEqual({ kind: 'replay' });
    expect(await checkCounters(db, dropId)).toMatchObject({ reserved: 1, liveUnits: 1, quotaMismatches: [] });
    expect((await eventsOf(db, r.id)).map((e) => e.type)).toEqual(['order.reserved']);
  });
});

describe('the generation fence (§4.7)', () => {
  it('waits for a reserve that passed the fence, then fails every later one with STALE_GEN', async () => {
    const { dropId } = await createDrop(db, { total: 10 });
    const [early = '', late = ''] = await createUsers(db, 2);
    const inFlight = reservation(early, dropId);
    const paused = gate();
    const tookStock = gate();

    // A reserve transaction that has taken its stock under gen 0 and not yet committed.
    const reserve = transaction(db, async (tx) => {
      await insertOrderOnConflictDoNothing(tx, inFlight);
      expect(await claimQuota(tx, early, dropId, 1)).toBe(true);
      expect(await takeStock(tx, dropId, 1, 0)).toBe('OK');
      tookStock.open();
      await paused.wait;
    });
    await reached(tookStock.wait, reserve);

    let fencedAt = 0;
    const fence = fenceRedisGeneration(db, dropId).then((gen) => {
      fencedAt = Date.now();
      return gen;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fencedAt).toBe(0); // blocked on the inventory row lock
    const committedAt = Date.now();
    paused.open();
    await reserve;

    expect(await fence).toBe(1);
    expect(fencedAt).toBeGreaterThanOrEqual(committedAt);
    // The transaction that passed the fence is committed and will be in the rebuild snapshot...
    expect((await getOrder(db, inFlight.id))?.status).toBe('RESERVED');
    // ...and one carrying the old generation rolls back completely.
    const stale = reservation(late, dropId);
    expect(await recordReservation(db, { ...stale, gen: 0 })).toEqual({
      kind: 'refused',
      reason: 'STALE_GEN',
    });
    expect(await getOrder(db, stale.id)).toBeUndefined();
    expect((await recordReservation(db, { ...stale, gen: 1 })).kind).toBe('created');
    expect(await checkCounters(db, dropId)).toMatchObject({ reserved: 2, liveUnits: 2, quotaMismatches: [] });
  });
});

describe('insertRejectedTombstone (§5.2)', () => {
  it('writes the REJECTED order and its order.rejected event in one statement, once', async () => {
    const { dropId, productId } = await createDrop(db);
    const [userId = ''] = await createUsers(db, 1);
    const r = reservation(userId, dropId, 2);

    expect(await insertRejectedTombstone(db, { ...r, reason: 'NOT_LIVE', traceId: 't-1' })).toBe(true);
    expect(await insertRejectedTombstone(db, { ...r, reason: 'NOT_LIVE' })).toBe(false);

    expect(await getOrder(db, r.id)).toMatchObject({
      status: 'REJECTED',
      closeReason: 'NOT_LIVE',
      qty: 2,
      productId,
      requestHash: r.requestHash,
      redisSettledAt: null,
    });
    const events = await eventsOf(db, r.id);
    expect(events.map((e) => e.type)).toEqual(['order.rejected']);
    expect(OrderEvent.parse(events[0]?.payload)).toMatchObject({
      orderVersion: 1,
      productId,
      traceId: 't-1',
      data: { qty: 2, reason: 'NOT_LIVE' },
    });
    // Postgres never granted stock to a tombstone.
    expect(await checkCounters(db, dropId)).toMatchObject({ reserved: 0, quotaMismatches: [] });
  });

  it('emits nothing when the rid already has an order', async () => {
    const { dropId } = await createDrop(db);
    const [userId = ''] = await createUsers(db, 1);
    const r = reservation(userId, dropId);
    await recordReservation(db, { ...r, gen: 0 });

    expect(await insertRejectedTombstone(db, { ...r, reason: 'ORPHANED' })).toBe(false);
    expect((await getOrder(db, r.id))?.status).toBe('RESERVED');
    expect((await eventsOf(db, r.id)).map((e) => e.type)).toEqual(['order.reserved']);
  });

  it.each([
    ['commits', 'RESERVED', ['order.reserved']],
    ['rolls back', 'REJECTED', ['order.rejected']],
  ] as const)(
    'against a same-key insert in flight: waits, and wins only if the insert %s',
    async (_case, finalStatus, finalEvents) => {
      const { dropId } = await createDrop(db);
      const [userId = ''] = await createUsers(db, 1);
      const r = reservation(userId, dropId);
      const inserted = gate();
      const decide = gate();

      const other = transaction(db, async (tx) => {
        const order = (await insertOrderOnConflictDoNothing(tx, r))?.order;
        if (order === undefined) throw new Error('the rid should be new');
        await insertOutboxEvents(tx, [
          orderEvent(
            'order.reserved',
            order,
            {
              qty: order.qty,
              unitPriceCents: order.unitPriceCents,
              expiresAt: order.expiresAt.toISOString(),
            },
            { occurredAt: order.createdAt },
          ),
        ]);
        inserted.open();
        await decide.wait;
        if (finalStatus === 'REJECTED') throw new Error('rolled back with SOLD_OUT');
      }).catch(() => undefined);
      await reached(inserted.wait, other);

      let settled = false;
      const tombstone = insertRejectedTombstone(db, { ...r, reason: 'SOLD_OUT' }).finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(settled).toBe(false); // waiting on the primary key
      decide.open();
      await other;

      expect(await tombstone).toBe(finalStatus === 'REJECTED');
      expect((await getOrder(db, r.id))?.status).toBe(finalStatus);
      expect((await eventsOf(db, r.id)).map((e) => e.type)).toEqual(finalEvents);
    },
  );

  it('races reserves for the same rids: one row each, and order.rejected exists iff the tombstone won', async () => {
    const { dropId } = await createDrop(db, { total: 1_000, perUserLimit: 10 });
    const buyers = await createUsers(db, 40);
    const requests = buyers.map((userId) => reservation(userId, dropId));

    await Promise.all(
      requests.flatMap((r, i) => {
        const reserve = recordReservation(db, { ...r, gen: 0 });
        const tombstone = insertRejectedTombstone(db, { ...r, reason: 'ORPHANED' });
        return i % 2 === 0 ? [reserve, tombstone] : [tombstone, reserve];
      }),
    );

    const winners = { RESERVED: 0, REJECTED: 0 };
    for (const r of requests) {
      const order = await getOrder(db, r.id);
      const types = (await eventsOf(db, r.id)).map((e) => e.type);
      if (order?.status === 'RESERVED') {
        winners.RESERVED++;
        expect(types).toEqual(['order.reserved']);
      } else {
        expect(order?.status).toBe('REJECTED');
        winners.REJECTED++;
        expect(types).toEqual(['order.rejected']);
      }
    }
    expect(winners.RESERVED + winners.REJECTED).toBe(40);
    expect(await checkCounters(db, dropId)).toMatchObject({
      reserved: winners.RESERVED,
      liveUnits: winners.RESERVED,
      quotaMismatches: [],
    });
  });
});

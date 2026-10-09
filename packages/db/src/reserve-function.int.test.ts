import { randomUUID } from 'node:crypto';
import { TOPICS } from '@flashdrop/config';
import { OrderEvent } from '@flashdrop/contracts';
import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db, type Tx } from './client';
import {
  HotRowBusyError,
  isPostgresUnavailableError,
  isTransientDbError,
  isUnknownUserError,
  pgErrorOf,
} from './errors';
import { getOrder } from './orders';
import { orderEvent, outboxRow } from './outbox';
import { createPool, POOL_PROFILES } from './pool';
import { outbox } from './schema';
import { createTestDatabase, type TestDatabase } from './test-database';
import { createDrop, createUsers, gate, reached, reservation } from './test-fixtures';
import { transaction } from './transaction';
import { claimQuota, recordReservation } from './transitions';

/*
 * The reserve transaction as one server-side function (migration 0006, design §5.2 "Hot row"): what moving
 * it out of the api must not change (lock order, rollback of every refusal, the event envelope, how a
 * timeout is classified), checked against real Postgres 17. reservation.int.test.ts covers the outcomes.
 */

let test: TestDatabase;
let apiPool: pg.Pool;
let db: Db;
/** The api profile with a short statement timeout, so the timeout tests take a fraction of a second. */
let impatientPool: pg.Pool;
let impatient: Db;

beforeAll(async () => {
  test = await createTestDatabase();
  const logger = { warn: () => undefined };
  apiPool = createPool({ connectionString: test.url, logger, ...POOL_PROFILES.api });
  db = createDb(apiPool);
  impatientPool = createPool({
    connectionString: test.url,
    logger,
    ...POOL_PROFILES.api,
    settings: { ...POOL_PROFILES.api.settings, statement_timeout: '300ms' },
  });
  impatient = createDb(impatientPool);
});

afterAll(async () => {
  await Promise.all([apiPool?.end(), impatientPool?.end()]);
  await test?.drop();
});

/** Rows the drop has in each table the reserve transaction writes. */
async function writesOf(dropId: string) {
  const { rows } = await db.execute<{ orders: number; quotas: number; events: number; reserved: number }>(sql`
    SELECT (SELECT count(*)::int FROM orders WHERE drop_id = ${dropId}) AS orders,
           (SELECT count(*)::int FROM user_drop_quota WHERE drop_id = ${dropId}) AS quotas,
           (SELECT count(*)::int FROM outbox WHERE payload->>'dropId' = ${dropId}) AS events,
           (SELECT reserved FROM drop_inventory WHERE drop_id = ${dropId}) AS reserved`);
  return rows[0];
}

/** Holds row locks in an open transaction until `release`, then rolls it back; `locked`: they are held. */
function holdLock(lock: (tx: Tx) => Promise<unknown>) {
  const held = gate();
  const released = gate();
  const work = transaction(db, async (tx) => {
    await lock(tx);
    held.open();
    await released.wait;
    throw new Error('rolled back on purpose');
  }).catch(() => undefined);
  return {
    locked: reached(held.wait, work),
    release: async () => {
      released.open();
      await work;
    },
  };
}

describe('fd_record_reservation', () => {
  it('writes the order.reserved envelope of packages/contracts, also without a trace id', async () => {
    const { dropId, productId } = await createDrop(db);
    const [userId = ''] = await createUsers(db, 1);
    const r = reservation(userId, dropId, 2);

    const outcome = await recordReservation(db, { ...r, gen: 0 });

    if (outcome.kind !== 'created') throw new Error(`expected created, got ${JSON.stringify(outcome)}`);
    const { order } = outcome;
    const [row] = await db.select().from(outbox).where(sql`${outbox.payload}->>'orderId' = ${r.id}`);
    if (row === undefined) throw new Error('no outbox row');
    // The same row the producer path of every other event writes (outboxRow validates with OrderEvent).
    const expected = outboxRow(
      orderEvent(
        'order.reserved',
        order,
        { qty: 2, unitPriceCents: order.unitPriceCents, expiresAt: order.expiresAt.toISOString() },
        { occurredAt: order.createdAt },
      ),
    );
    expect(row.payload).toEqual({ ...(expected.payload as object), eventId: row.eventId });
    expect(row).toMatchObject({
      topic: expected.topic,
      partitionKey: expected.partitionKey,
      eventType: expected.eventType,
      headers: expected.headers,
    });
    expect(row.payload).not.toHaveProperty('traceId');
    expect(row).toMatchObject({ topic: TOPICS.orders, partitionKey: productId, headers: {} });
    expect(OrderEvent.parse(row.payload).type).toBe('order.reserved');
    // A fresh uuidv7 per event: the consumers' dedupe key.
    expect(row.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it.each([
    ['LIMIT', { perUserLimit: 2 }, 3, 0],
    ['STALE_GEN', {}, 1, 5],
    ['NOT_LIVE', { status: 'PAUSED' }, 1, 0],
    ['SOLD_OUT', { total: 1 }, 1, 0],
  ] as const)(
    'rolls back the order, the quota claim and the event when it refuses: %s',
    async (reason, options, qty, gen) => {
      const { dropId } = await createDrop(db, options);
      const [userId = ''] = await createUsers(db, 1);
      if (reason === 'SOLD_OUT')
        await db.execute(sql`UPDATE drop_inventory SET reserved = 1 WHERE drop_id = ${dropId}`);
      const before = await writesOf(dropId);

      expect(await recordReservation(db, { ...reservation(userId, dropId, qty), gen })).toEqual({
        kind: 'refused',
        reason,
      });
      expect(await writesOf(dropId)).toEqual(before);
    },
  );

  it('takes the hot row last: while it waits for the quota row, the stock row is not locked', async () => {
    const { dropId } = await createDrop(db, { perUserLimit: 2 });
    const [userId = ''] = await createUsers(db, 1);
    const quota = holdLock((tx) => claimQuota(tx, userId, dropId, 1));
    await quota.locked;

    let settled = false;
    const reserve = recordReservation(db, { ...reservation(userId, dropId), gen: 0 }).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(settled).toBe(false); // queued on the quota row
    const { rows } = await db.execute(
      sql`SELECT reserved FROM drop_inventory WHERE drop_id = ${dropId} FOR NO KEY UPDATE NOWAIT`,
    );
    expect(rows).toHaveLength(1);

    await quota.release();
    expect((await reserve).kind).toBe('created');
  });

  it('answers HotRowBusyError for a timeout queued on the stock row, not counted against Postgres', async () => {
    const { dropId } = await createDrop(db);
    const [userId = ''] = await createUsers(db, 1);
    const r = reservation(userId, dropId);
    const stock = holdLock((tx) =>
      tx.execute(sql`UPDATE drop_inventory SET reserved = reserved WHERE drop_id = ${dropId}`),
    );
    await stock.locked;

    const error = await recordReservation(impatient, { ...r, gen: 0 }).catch((e: unknown) => e);
    await stock.release();

    expect(error).toBeInstanceOf(HotRowBusyError);
    expect(pgErrorOf(error)?.code).toBe('57014');
    expect(isTransientDbError(error)).toBe(true);
    expect(isPostgresUnavailableError(error)).toBe(false);
    expect(await getOrder(db, r.id)).toBeUndefined();
    expect(await writesOf(dropId)).toEqual({ orders: 0, quotas: 0, events: 0, reserved: 0 });
  });

  it('keeps a timeout queued anywhere else a plain statement timeout, as it was per statement', async () => {
    const { dropId } = await createDrop(db);
    const [userId = ''] = await createUsers(db, 1);
    const quota = holdLock((tx) => claimQuota(tx, userId, dropId, 1));
    await quota.locked;

    const error = await recordReservation(impatient, { ...reservation(userId, dropId), gen: 0 }).catch(
      (e: unknown) => e,
    );
    await quota.release();

    expect(error).not.toBeInstanceOf(HotRowBusyError);
    expect(pgErrorOf(error)?.code).toBe('57014');
    expect(isPostgresUnavailableError(error)).toBe(true);
  });

  it('lets the foreign key name an unknown user, so the api answers 401 rather than 500', async () => {
    const { dropId } = await createDrop(db);

    const error = await recordReservation(db, { ...reservation(randomUUID(), dropId), gen: 0 }).catch(
      (e: unknown) => e,
    );

    expect(isUnknownUserError(error)).toBe(true);
    expect(await writesOf(dropId)).toEqual({ orders: 0, quotas: 0, events: 0, reserved: 0 });
  });
});

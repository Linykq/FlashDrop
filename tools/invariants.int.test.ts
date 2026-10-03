import { randomUUID } from 'node:crypto';
import { loadEnv, RedisEnv } from '@flashdrop/config';
import {
  applyDropAction,
  createDb,
  createPool,
  createTestBuyers,
  createTestDrop,
  type Db,
  POOL_PROFILES,
  parseRows,
  recordReservation,
  sql,
  sweeperQuarantine,
  transaction,
} from '@flashdrop/db';
import { createTestDatabase, type TestDatabase } from '@flashdrop/db/testing';
import { requestFingerprint, reservationId } from '@flashdrop/domain/identity';
import {
  connectCommandClient,
  createSyncNudger,
  DROP_LOCK_POOL_PROFILE,
  dropKeys,
  type FlashdropRedis,
  fdReserve,
  readDropState,
  settleRedis,
  syncDropFromPostgres,
} from '@flashdrop/inventory';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type InvariantsReport, verifyInvariants } from './invariant-samples';

/*
 * `verify:invariants` against Compose Postgres and Redis: a consistent drop passes, and every kind of breach
 * the checker exists for is caught. Each test arms its own drop the way the admin route does, in a throwaway
 * database of this file: the running stack's worker schedules, reconciles and sweeps every armed drop of the
 * development database, and would repair a breach before the checker saw it. afterAll deletes the drops'
 * Redis keys and the database.
 */

const quiet = { info: () => undefined, warn: () => undefined };
let database: TestDatabase;
let pool: ReturnType<typeof createPool>;
let lockPool: ReturnType<typeof createPool>;
let db: Db;
let redis: FlashdropRedis;
const created: string[] = [];

beforeAll(async () => {
  database = await createTestDatabase();
  pool = createPool({ connectionString: database.url, logger: quiet, ...POOL_PROFILES.api, max: 4 });
  lockPool = createPool({ connectionString: database.url, logger: quiet, ...DROP_LOCK_POOL_PROFILE, max: 2 });
  db = createDb(pool);
  // The tests' own Redis (vitest.config.ts), so this tree's library replaces any other copy of its version.
  redis = await connectCommandClient({
    url: loadEnv([RedisEnv]).REDIS_URL,
    name: 'verify-invariants-test',
    logger: quiet,
    library: { replaceSameVersion: true },
  });
});

afterAll(async () => {
  for (const dropId of created) {
    const k = dropKeys(dropId);
    await redis.del([k.inv, k.rsv, k.uq, k.exp]);
  }
  redis.destroy();
  await Promise.all([pool.end(), lockPool.end()]);
  await database.drop();
});

const sync = (dropId: string) =>
  syncDropFromPostgres({ db, redis, logger: quiet, lock: { pool: lockPool, logger: quiet } }, dropId);

async function armedDrop(stock = 10): Promise<string> {
  const { dropId } = await createTestDrop(db, {
    stock,
    perUserLimit: 2,
    holdSeconds: 120,
    paymentSeconds: 300,
    durationSeconds: 3_600,
    priceCents: 1_999,
  });
  created.push(dropId);
  await applyDropAction(db, dropId, 'arm');
  expect((await sync(dropId)).kind).toBe('REBUILT');
  return dropId;
}

/** The reserve path of §5.2 without the HTTP layer: Lua admits, then Postgres records the hold. */
async function reserve(dropId: string, userId: string, qty = 1, record = true): Promise<string> {
  const idempotencyKey = randomUUID();
  const rid = reservationId({ userId, dropId, idempotencyKey });
  const fingerprint = requestFingerprint({ dropId, qty });
  const admitted = await fdReserve(redis, { dropId, rid, userId, qty, fingerprint, idempotencyKey });
  if (admitted.kind !== 'RESERVED') throw new Error(`fd_reserve answered ${admitted.kind}`);
  if (record) {
    const recorded = await recordReservation(db, {
      id: rid,
      userId,
      dropId,
      qty,
      idempotencyKey,
      requestHash: fingerprint,
      gen: admitted.gen,
    });
    expect(recorded.kind).toBe('created');
  }
  return rid;
}

const LiveOrder = z.object({ user_id: z.string(), drop_id: z.string(), qty: z.int() });

/** What the sweeper does to one due order, in lock order: the order, its quota, the inventory last. */
async function expireOrder(rid: string): Promise<void> {
  await transaction(db, async (tx) => {
    const { rows } = await tx.execute(sql`
      UPDATE orders SET status = 'EXPIRED', close_reason = 'TIMEOUT', closed_at = now(),
                        version = version + 1, updated_at = now()
      WHERE id = ${rid} AND status IN ('RESERVED', 'PENDING_PAYMENT') RETURNING user_id, drop_id, qty`);
    for (const order of parseRows(LiveOrder, rows, 'expireOrder')) {
      await tx.execute(sql`
        UPDATE user_drop_quota SET claimed = claimed - ${order.qty}
        WHERE user_id = ${order.user_id} AND drop_id = ${order.drop_id}`);
      await tx.execute(sql`
        UPDATE drop_inventory SET reserved = reserved - ${order.qty}, updated_at = now()
        WHERE drop_id = ${order.drop_id}`);
    }
  });
}

const settle = (rid: string) =>
  settleRedis({ db, redis, nudger: createSyncNudger({ db, logger: quiet }) }, rid);

const verify = (dropId: string, timeoutMs = 0) =>
  verifyInvariants({ db, redis }, { dropIds: [dropId], timeoutMs });

function failing(report: InvariantsReport): string[] {
  return report.invariants.filter((result) => result.status === 'fail').map((result) => result.id);
}

function messages(report: InvariantsReport): string[] {
  return report.invariants.flatMap((result) => result.violations.map((v) => `${v.invariant} ${v.message}`));
}

describe('verify:invariants', () => {
  it('passes on a consistent drop with live holds, and writes nothing', async () => {
    const dropId = await armedDrop(10);
    const [a, b, c] = await createTestBuyers(db, 3);
    if (a === undefined || b === undefined || c === undefined) throw new Error('createTestBuyers');
    await reserve(dropId, a.id);
    await reserve(dropId, a.id);
    await reserve(dropId, b.id, 2);
    const expired = await reserve(dropId, c.id);
    await expireOrder(expired);
    await settle(expired);
    const before = await readDropState(redis, dropId);

    const report = await verify(dropId);

    expect(messages(report)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.quiescence.reached).toBe(true);
    expect(report.invariants.find((result) => result.id === 'INV-4')?.status).toBe('skipped');
    expect(report.invariants.find((result) => result.id === 'INV-5')?.status).toBe('skipped');
    expect(report.drops[0]).toMatchObject({
      idle: true,
      postgres: { total: 10, available: 6, reserved: 4, sold: 0, orders: { RESERVED: 3, EXPIRED: 1 } },
      redis: { avail: 6, held: 4, sold: 0 },
    });
    expect(await readDropState(redis, dropId)).toEqual(before);
  });

  it('waits for a terminal order to be settled, and fails when it never is', async () => {
    const dropId = await armedDrop();
    const [buyer] = await createTestBuyers(db, 1);
    if (buyer === undefined) throw new Error('createTestBuyers');
    const rid = await reserve(dropId, buyer.id);
    await expireOrder(rid);

    const stuck = await verify(dropId);
    expect(stuck.ok).toBe(false);
    expect(stuck.quiescence.reached).toBe(false);
    expect(messages(stuck)).toEqual(['INV-6 not quiescent: 1 terminal orders not yet applied to Redis']);
    expect(stuck.quiescence.checks.find((check) => check.status === 'fail')?.name).toBe(
      'Every terminal order applied to Redis',
    );

    const settling = new Promise((resolve) => setTimeout(resolve, 300)).then(() => settle(rid));
    const report = await verify(dropId, 10_000);
    await settling;
    expect(messages(report)).toEqual([]);
    expect(report.quiescence.reached).toBe(true);
    expect(report.quiescence.waitedMs).toBeGreaterThan(0);
  });

  it('catches an optimistic Redis and passes again after a rebuild', async () => {
    const dropId = await armedDrop(10);
    const [buyer] = await createTestBuyers(db, 1);
    if (buyer === undefined) throw new Error('createTestBuyers');
    await reserve(dropId, buyer.id);
    await redis.hIncrBy(dropKeys(dropId).inv, 'avail', 3);

    const report = await verify(dropId);
    expect(failing(report)).toEqual(['INV-6', 'INV-7', 'INV-9']);
    expect(messages(report)).toContain('INV-7 Redis avail 12 > Postgres available 9');

    expect((await sync(dropId)).kind).toBe('REBUILT');
    expect(messages(await verify(dropId))).toEqual([]);
  });

  it('catches Postgres counters that disagree with the orders', async () => {
    const dropId = await armedDrop(10);
    const [buyer] = await createTestBuyers(db, 1);
    if (buyer === undefined) throw new Error('createTestBuyers');
    await reserve(dropId, buyer.id);
    await db.execute(sql`UPDATE drop_inventory SET reserved = reserved + 1 WHERE drop_id = ${dropId}`);
    await db.execute(sql`UPDATE user_drop_quota SET claimed = claimed + 1 WHERE drop_id = ${dropId}`);

    const report = await verify(dropId);
    expect(failing(report)).toEqual(['INV-2', 'INV-3', 'INV-6', 'INV-7']);
    expect(messages(report)).toEqual(
      expect.arrayContaining([
        'INV-2 reserved 2 != 1 RESERVED/PENDING_PAYMENT units',
        `INV-3 user ${buyer.id}: claimed 2 != 1 held or bought units`,
        `INV-6 Redis uq[${buyer.id}] 1 != claimed 2`,
        'INV-7 Redis held 1 < Postgres reserved 2',
      ]),
    );

    await db.execute(sql`UPDATE drop_inventory SET reserved = reserved - 1 WHERE drop_id = ${dropId}`);
    await db.execute(sql`UPDATE user_drop_quota SET claimed = claimed - 1 WHERE drop_id = ${dropId}`);
  });

  it('catches an rsv entry that contradicts its order', async () => {
    const dropId = await armedDrop(10);
    const [buyer] = await createTestBuyers(db, 1);
    if (buyer === undefined) throw new Error('createTestBuyers');
    const rid = await reserve(dropId, buyer.id);
    const k = dropKeys(dropId);
    const entry = z.record(z.string(), z.unknown()).parse(JSON.parse((await redis.hGet(k.rsv, rid)) ?? '{}'));
    // A confirm that ran before Postgres committed PAID: conservation still holds, the ordering rule does not.
    await redis
      .multi()
      .hSet(k.rsv, rid, JSON.stringify({ ...entry, s: 'COMMITTED' }))
      .hIncrBy(k.inv, 'held', -1)
      .hIncrBy(k.inv, 'sold', 1)
      .zRem(k.exp, rid)
      .exec();

    const report = await verify(dropId);
    expect(failing(report)).toEqual(['INV-6', 'INV-7', 'INV-8']);
    expect(messages(report)).toContain('INV-8 Redis COMMITTED, order RESERVED');
  });

  it('waits for a missing Redis state, an orphan hold and reports quarantined orders', async () => {
    const dropId = await armedDrop(10);
    const [a, b] = await createTestBuyers(db, 2);
    if (a === undefined || b === undefined) throw new Error('createTestBuyers');
    await reserve(dropId, a.id, 1, false);
    const quarantined = await reserve(dropId, b.id);
    await db.insert(sweeperQuarantine).values({ loop: 'expire-orders', orderId: quarantined, error: 'test' });

    const orphaned = await verify(dropId);
    expect(messages(orphaned)).toEqual([
      'INV-6 order RESERVED, quarantined by expire-orders',
      'INV-6 not quiescent: 1 Redis holds without an order',
    ]);

    await redis.del(dropKeys(dropId).inv);
    const missing = await verify(dropId);
    expect(messages(missing)).toContain('INV-6 not quiescent: no Redis state');
    expect(missing.drops[0]?.redis).toBeNull();
  });
});

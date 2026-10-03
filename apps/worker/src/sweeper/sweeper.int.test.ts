import { randomUUID } from 'node:crypto';
import {
  eq,
  getOrder,
  inArray,
  markRedisSettled,
  sql,
  sweeperQuarantine,
  userDropQuota,
} from '@flashdrop/db';
import {
  dropKeys,
  fdRelease,
  fdSetStatus,
  readDropState,
  readStock,
  redisDropViolations,
  withDropLock,
} from '@flashdrop/inventory';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ageHold,
  alertsNamed,
  armDrop,
  claimedBy,
  createDrop,
  createUsers,
  createWorkerTestEnv,
  deleteDropKeys,
  eventTypesOf,
  holdOnly,
  inventoryOf,
  lapse,
  reserve,
  type WorkerTestEnv,
} from '../test/harness';
import { dropScheduler } from './drop-scheduler';
import { expireOrders } from './expire-orders';
import { createOrphanScan } from './orphan-scan';
import { settleSafetyNet } from './settle-safety-net';

/*
 * The sweeper's loops (design §4.6), one tick at a time, against the Compose Postgres (a database of this
 * file's own) and the shared Redis. Each test makes its own drop; ticks see every drop of the file, so
 * assertions are about the test's own.
 */

let env: WorkerTestEnv;
const running = new AbortController().signal;

beforeAll(async () => {
  env = await createWorkerTestEnv();
});

afterAll(async () => {
  await env?.close();
});

/** Redis agrees with Postgres's stock of record (INV-6) and with itself (INV-9 and the entry sums). */
async function expectRedisMatchesPostgres(dropId: string) {
  const [state, inventory] = await Promise.all([readDropState(env.redis, dropId), inventoryOf(env, dropId)]);
  expect(state.inv).toMatchObject({
    avail: inventory.total - inventory.sold - inventory.reserved,
    held: inventory.reserved,
    sold: inventory.sold,
  });
  expect(redisDropViolations(state)).toEqual([]);
}

async function statusCount(dropId: string, status: string): Promise<number> {
  const { rows } = await env.db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM orders WHERE drop_id = ${dropId} AND status = ${status}`,
  );
  return rows[0]?.n ?? 0;
}

async function unsettledCount(dropId: string): Promise<number> {
  const { rows } = await env.db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM orders WHERE drop_id = ${dropId} AND redis_settled_at IS NULL`,
  );
  return rows[0]?.n ?? 0;
}

async function rsvState(dropId: string, rid: string): Promise<string | undefined> {
  const raw = await env.redis.hGet(dropKeys(dropId).rsv, rid);
  return raw === null ? undefined : (JSON.parse(raw) as { s: string }).s;
}

describe('expire-orders and settle-safety-net', () => {
  it('expire a lapsed hold in Postgres, then give its stock and quota back to Redis', async () => {
    const dropId = await createDrop(env, { total: 5, limit: 2 });
    await armDrop(env, dropId);
    const [user = ''] = await createUsers(env.db, 1);
    const rid = await reserve(env, dropId, user, 2);
    expect(await readStock(env.redis, dropId)).toMatchObject({ avail: 3, held: 2 });

    await lapse(env, rid);
    await expireOrders(env.deps);

    expect(await getOrder(env.db, rid)).toMatchObject({ status: 'EXPIRED', closeReason: 'TIMEOUT' });
    expect(await inventoryOf(env, dropId)).toMatchObject({ reserved: 0, sold: 0 });
    expect(await claimedBy(env, dropId, user)).toBe(0);
    expect(await eventTypesOf(env, rid)).toEqual(['order.reserved', 'order.expired']);
    // The ordering rule (§4.3): Postgres committed first, Redis is briefly lower, never higher.
    expect(await readStock(env.redis, dropId)).toMatchObject({ avail: 3, held: 2 });

    await settleSafetyNet(env.deps, running, { olderThanSeconds: 0 });

    expect(await rsvState(dropId, rid)).toBe('RELEASED');
    expect(await env.redis.hGet(dropKeys(dropId).uq, user)).toBeNull();
    expect((await getOrder(env.db, rid))?.redisSettledAt).toBeInstanceOf(Date);
    await expectRedisMatchesPostgres(dropId);
  });

  it('leave orders to the settlement consumer for 10 s before settling them', async () => {
    const dropId = await createDrop(env);
    await armDrop(env, dropId);
    const [user = ''] = await createUsers(env.db, 1);
    const rid = await reserve(env, dropId, user);
    await lapse(env, rid);
    await expireOrders(env.deps);

    await settleSafetyNet(env.deps, running);

    expect((await getOrder(env.db, rid))?.redisSettledAt).toBeNull();
    expect(await rsvState(dropId, rid)).toBe('HELD');
  });

  it('quarantine an order whose expiry keeps failing, with an alert, and expire the rest', async () => {
    const dropId = await createDrop(env);
    await armDrop(env, dropId);
    const [good = '', bad = ''] = await createUsers(env.db, 2);
    const fine = await reserve(env, dropId, good);
    const broken = await reserve(env, dropId, bad);
    // A bad row: the quota the expiry must give back no longer exists, so the batch fails on it.
    await env.db.execute(sql`DELETE FROM user_drop_quota WHERE user_id = ${bad} AND drop_id = ${dropId}`);
    await lapse(env, fine);
    await lapse(env, broken);

    await expireOrders(env.deps);

    expect((await getOrder(env.db, fine))?.status).toBe('EXPIRED');
    expect((await getOrder(env.db, broken))?.status).toBe('RESERVED');
    expect(
      await env.db.select().from(sweeperQuarantine).where(eq(sweeperQuarantine.orderId, broken)),
    ).toEqual([expect.objectContaining({ loop: 'expire-orders' })]);
    expect(alertsNamed(env, 'sweeper_quarantine')).toContainEqual(
      expect.objectContaining({ level: 'error', loop: 'expire-orders', orderId: broken }),
    );

    // Later ticks skip it, so it cannot stop expiry for anyone else.
    await expireOrders(env.deps);
    expect((await getOrder(env.db, broken))?.status).toBe('RESERVED');
    // Put the row back, so this drop's books close for the rest of the file.
    await env.db.insert(userDropQuota).values({ userId: bad, dropId, claimed: 1, limitQty: 2 });
  });

  // Regression: one batch of 200 per tick capped expiry at 200/s and the safety net at 40/s, so a burst of
  // abandoned holds came back minutes late. Each loop now drains within its tick, and a drop that answers
  // RETRY (stuck rebuilding) no longer holds the head of the list for every other drop.
  it('drain a burst of lapsed holds in one tick each, past a drop that is stuck rebuilding', async () => {
    const stuck = await createDrop(env, { total: 250, limit: 1 });
    const busy = await createDrop(env, { total: 250, limit: 1 });
    await armDrop(env, stuck);
    await armDrop(env, busy);
    const users = await createUsers(env.db, 460);
    // The stuck drop's orders end first, so they sit at the head of the safety net's list.
    const stuckOrders = await inBatches(users.slice(0, 230), (user) => reserve(env, stuck, user));
    const busyOrders = await inBatches(users.slice(230), (user) => reserve(env, busy, user));
    for (const rid of stuckOrders) await lapse(env, rid);
    for (const rid of busyOrders) await lapse(env, rid);

    await expireOrders(env.deps);

    expect(await statusCount(stuck, 'EXPIRED')).toBe(230);
    expect(await statusCount(busy, 'EXPIRED')).toBe(230);

    await fdSetStatus(env.redis, stuck, 'RECONCILING');
    await settleSafetyNet(env.deps, running, { olderThanSeconds: 0 });

    expect(await readStock(env.redis, busy)).toMatchObject({ avail: 250, held: 0 });
    expect(await unsettledCount(busy)).toBe(0);
    await expectRedisMatchesPostgres(busy);
    expect(await unsettledCount(stuck)).toBe(230);

    // Once the stuck drop is rebuilt, its orders settle too (as NOOPs: the rebuild counted them).
    await armDrop(env, stuck);
    await settleSafetyNet(env.deps, running, { olderThanSeconds: 0 });
    expect(await unsettledCount(stuck)).toBe(0);
    await expectRedisMatchesPostgres(stuck);
  });

  it('quarantine a settlement Redis refuses as an INV-8 breach, with an alert', async () => {
    const dropId = await createDrop(env);
    await armDrop(env, dropId);
    const [user = ''] = await createUsers(env.db, 1);
    const rid = await reserve(env, dropId, user);
    // Redis released the hold although the order went on to be paid: the opposite outcome.
    expect((await fdRelease(env.redis, dropId, rid)).kind).toBe('OK');
    await env.db.execute(sql`UPDATE orders SET status = 'PENDING_PAYMENT', version = 2 WHERE id = ${rid}`);
    await env.db.execute(sql`
      UPDATE orders SET status = 'PAID', paid_at = now() - interval '1 minute', version = 3,
                        updated_at = now() - interval '1 minute'
      WHERE id = ${rid}`);
    await env.db.execute(
      sql`UPDATE drop_inventory SET reserved = reserved - 1, sold = sold + 1 WHERE drop_id = ${dropId}`,
    );

    await settleSafetyNet(env.deps, running);

    expect(alertsNamed(env, 'redis_conflict')).toContainEqual(expect.objectContaining({ orderId: rid }));
    expect(alertsNamed(env, 'sweeper_quarantine')).toContainEqual(
      expect.objectContaining({ loop: 'settle-safety-net', orderId: rid }),
    );
    expect((await getOrder(env.db, rid))?.redisSettledAt).toBeNull();
  });
});

describe('orphan-scan', () => {
  it('tombstones an expired hold that has no order, then releases it', async () => {
    const orphanScan = createOrphanScan(env.deps);
    const dropId = await createDrop(env, { total: 4 });
    await armDrop(env, dropId);
    const [user = ''] = await createUsers(env.db, 1);
    const rid = await holdOnly(env, dropId, user, 2);
    await ageHold(env, dropId, rid);

    await orphanScan(running);

    expect(await getOrder(env.db, rid)).toMatchObject({
      status: 'REJECTED',
      closeReason: 'ORPHANED',
      qty: 2,
      userId: user,
    });
    expect(await eventTypesOf(env, rid)).toEqual(['order.rejected']);
    expect(await rsvState(dropId, rid)).toBe('RELEASED');
    expect((await getOrder(env.db, rid))?.redisSettledAt).toBeInstanceOf(Date);
    expect(await readStock(env.redis, dropId)).toMatchObject({ avail: 4, held: 0 });
    await expectRedisMatchesPostgres(dropId);
  });

  it('re-scores the hold of a live order at its Postgres deadline plus the grace', async () => {
    const orphanScan = createOrphanScan(env.deps);
    const dropId = await createDrop(env);
    await armDrop(env, dropId);
    const [user = ''] = await createUsers(env.db, 1);
    const rid = await reserve(env, dropId, user);
    await ageHold(env, dropId, rid);

    await orphanScan(running);

    const order = await getOrder(env.db, rid);
    expect(order?.status).toBe('RESERVED');
    expect(await env.redis.zScore(dropKeys(dropId).exp, rid)).toBe(
      (order?.expiresAt.getTime() ?? 0) + 30_000,
    );
    expect(await rsvState(dropId, rid)).toBe('HELD');
  });

  it('force-settles a HELD entry that Postgres already settled (a resurrected AOF tail)', async () => {
    const orphanScan = createOrphanScan(env.deps);
    const dropId = await createDrop(env, { total: 3 });
    await armDrop(env, dropId);
    const [user = ''] = await createUsers(env.db, 1);
    const rid = await reserve(env, dropId, user);
    await lapse(env, rid);
    await expireOrders(env.deps);
    // Settled once, then Redis lost the release: the entry is HELD again while Postgres says settled.
    await markRedisSettled(env.db, rid);
    await ageHold(env, dropId, rid);

    await orphanScan(running);

    expect(await rsvState(dropId, rid)).toBe('RELEASED');
    expect(await readStock(env.redis, dropId)).toMatchObject({ avail: 3, held: 0 });
    await expectRedisMatchesPostgres(dropId);
  });

  it('alerts about a hold it can neither tombstone nor quarantine, and rebuilds the drop without it', async () => {
    const orphanScan = createOrphanScan(env.deps);
    const dropId = await createDrop(env);
    await armDrop(env, dropId);
    const rid = randomUUID();
    // An exp member without its rsv entry: no Functions call ever writes one.
    await env.redis.zAdd(dropKeys(dropId).exp, { score: 1, value: rid });

    await orphanScan(running);
    await orphanScan(running);

    expect(alertsNamed(env, 'orphan_unrecordable').filter((line) => line.orderId === rid)).toHaveLength(1);
    expect(await getOrder(env.db, rid)).toBeUndefined();
    expect(await env.redis.zScore(dropKeys(dropId).exp, rid)).toBeNull();
    expect((await readStock(env.redis, dropId))?.gen).toBe(2);
    await expectRedisMatchesPostgres(dropId);
  });

  // Regression (E4): a session that outlived its user took a hold whose tombstone the user foreign key
  // refuses. It was alerted once and then kept its unit and the quota forever.
  it('returns the stock of a hold whose user no longer exists, through a rebuild', async () => {
    const orphanScan = createOrphanScan(env.deps);
    const dropId = await createDrop(env, { total: 5 });
    await armDrop(env, dropId);
    const ghost = randomUUID(); // no users row
    const rid = await holdOnly(env, dropId, ghost, 1);
    await ageHold(env, dropId, rid);
    expect(await readStock(env.redis, dropId)).toMatchObject({ avail: 4, held: 1 });

    await orphanScan(running);

    expect(await getOrder(env.db, rid)).toBeUndefined();
    const state = await readDropState(env.redis, dropId);
    expect(state.inv).toMatchObject({ avail: 5, held: 0, gen: 2 });
    expect(state.entries.has(rid)).toBe(false);
    expect(state.quotas.has(ghost)).toBe(false);
    expect(alertsNamed(env, 'orphan_unrecordable')).toContainEqual(expect.objectContaining({ orderId: rid }));
    await expectRedisMatchesPostgres(dropId);
  });

  it('rebuilds a drop whose exp keeps a member of an entry that is already settled', async () => {
    const orphanScan = createOrphanScan(env.deps);
    const dropId = await createDrop(env, { total: 3 });
    await armDrop(env, dropId);
    const [user = ''] = await createUsers(env.db, 1);
    const rid = await reserve(env, dropId, user);
    await lapse(env, rid);
    await expireOrders(env.deps);
    await settleSafetyNet(env.deps, running, { olderThanSeconds: 0 });
    expect(await rsvState(dropId, rid)).toBe('RELEASED');
    // The release's member came back: the forced settle answers NOOP and can never remove it.
    await env.redis.zAdd(dropKeys(dropId).exp, { score: 1, value: rid });

    await orphanScan(running);

    expect(await env.redis.zScore(dropKeys(dropId).exp, rid)).toBeNull();
    expect(await rsvState(dropId, rid)).toBe('RELEASED');
    await expectRedisMatchesPostgres(dropId);
  });

  // Regression (E7): ZRANGE ... LIMIT 0 200 met the same 200 quarantined members at the head every tick,
  // so an orphan scored after them was never reached.
  it('pages past members it must leave in place, so they never block the holds behind them', async () => {
    const orphanScan = createOrphanScan(env.deps);
    const dropId = await createDrop(env, { total: 300, limit: 1 });
    await armDrop(env, dropId);
    const users = await createUsers(env.db, 201);
    const parked = await inBatches(users.slice(0, 200), (user) => reserve(env, dropId, user));
    await env.db
      .insert(sweeperQuarantine)
      .values(parked.map((orderId) => ({ loop: 'orphan-scan', orderId, error: 'test: parked' })));
    await env.redis.zAdd(
      dropKeys(dropId).exp,
      parked.map((value) => ({ score: 1, value })),
      { condition: 'XX' },
    );
    const orphan = await holdOnly(env, dropId, users[200] ?? '', 1);
    await env.redis.zAdd(dropKeys(dropId).exp, { score: 2, value: orphan }, { condition: 'XX' });

    await orphanScan(running);

    expect(await getOrder(env.db, orphan)).toMatchObject({ status: 'REJECTED', closeReason: 'ORPHANED' });
    expect(await rsvState(dropId, orphan)).toBe('RELEASED');
    // Release the parked holds the normal way, so this drop's books close.
    await env.db.delete(sweeperQuarantine).where(inArray(sweeperQuarantine.orderId, parked));
  });
});

/** Runs `fn` over `items`, 20 at a time. */
async function inBatches<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += 20) out.push(...(await Promise.all(items.slice(i, i + 20).map(fn))));
  return out;
}

describe('drop-scheduler', () => {
  const statuses = async (dropId: string) => {
    const { rows } = await env.db.execute<{ status: string }>(
      sql`SELECT status FROM drops WHERE id = ${dropId}`,
    );
    return { postgres: rows[0]?.status, redis: (await readStock(env.redis, dropId))?.status };
  };

  it('opens a scheduled drop at starts_at, in Postgres and in Redis', async () => {
    const dropId = await createDrop(env, { status: 'SCHEDULED', startsIn: -1 });
    await armDrop(env, dropId);
    expect(await statuses(dropId)).toEqual({ postgres: 'SCHEDULED', redis: 'SCHEDULED' });

    await dropScheduler(env.deps, running);

    expect(await statuses(dropId)).toEqual({ postgres: 'LIVE', redis: 'LIVE' });
  });

  it('ends a live or paused drop at ends_at', async () => {
    const live = await createDrop(env, { startsIn: -120, endsIn: -1 });
    const paused = await createDrop(env, { status: 'PAUSED', startsIn: -120, endsIn: -1 });
    await armDrop(env, live);
    await armDrop(env, paused);

    await dropScheduler(env.deps, running);

    expect(await statuses(live)).toEqual({ postgres: 'ENDED', redis: 'ENDED' });
    expect(await statuses(paused)).toEqual({ postgres: 'ENDED', redis: 'ENDED' });
  });

  it('repairs a Redis status that disagrees with Postgres (level-triggered)', async () => {
    const dropId = await createDrop(env);
    await armDrop(env, dropId);
    await fdSetStatus(env.redis, dropId, 'PAUSED');

    await dropScheduler(env.deps, running);

    expect(await statuses(dropId)).toEqual({ postgres: 'LIVE', redis: 'LIVE' });
  });

  it('skips a drop whose lock is busy, and never touches a RECONCILING one', async () => {
    const busy = await createDrop(env, { status: 'SCHEDULED', startsIn: -1 });
    const reconciling = await createDrop(env);
    await armDrop(env, busy);
    await armDrop(env, reconciling);
    await fdSetStatus(env.redis, reconciling, 'RECONCILING');

    await withDropLock(env.deps.lock, busy, () => dropScheduler(env.deps, running));

    expect(await statuses(busy)).toEqual({ postgres: 'SCHEDULED', redis: 'SCHEDULED' });
    expect((await statuses(reconciling)).redis).toBe('RECONCILING');

    await dropScheduler(env.deps, running);
    expect(await statuses(busy)).toEqual({ postgres: 'LIVE', redis: 'LIVE' });
    expect((await statuses(reconciling)).redis).toBe('RECONCILING');
  });

  // Regression (E1/E2): the scheduler took FOR UPDATE on every tracked drop every second, which queued
  // behind the FOR KEY SHARE each in-flight reserve holds on the drops row, and timed out on a hot drop.
  it('ends a drop while reserves hold its row, and locks nothing for a drop with no work', async () => {
    const hot = await createDrop(env, { startsIn: -120, endsIn: -1 });
    const idle = await createDrop(env);
    await armDrop(env, hot);
    await armDrop(env, idle);
    const [user = ''] = await createUsers(env.db, 1);
    const reserving = await env.pool.connect();
    try {
      await reserving.query('BEGIN');
      // What an in-flight reserve's quota upsert holds until it commits: FOR KEY SHARE on each drop.
      for (const dropId of [hot, idle]) {
        await reserving.query(
          'INSERT INTO user_drop_quota (user_id, drop_id, claimed, limit_qty) VALUES ($1, $2, 1, 2)',
          [user, dropId],
        );
      }
      const started = Date.now();
      await dropScheduler(env.deps, running);
      expect(Date.now() - started).toBeLessThan(1_000);
      await reserving.query('ROLLBACK');
    } finally {
      reserving.release();
    }

    expect(await statuses(hot)).toEqual({ postgres: 'ENDED', redis: 'ENDED' });
    expect(await statuses(idle)).toEqual({ postgres: 'LIVE', redis: 'LIVE' });
    expect(env.logs.filter((line) => line.msg === 'drop scheduling failed')).toEqual([]);
  });

  it('never re-creates a drop Redis has lost; that is the reconciler’s job', async () => {
    const dropId = await createDrop(env);
    await armDrop(env, dropId);
    await deleteDropKeys(env.redis, dropId);

    await dropScheduler(env.deps, running);

    expect(await env.redis.exists(dropKeys(dropId).inv)).toBe(0);
  });
});

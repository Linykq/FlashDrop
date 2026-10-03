import { eq, sql, systemState } from '@flashdrop/db';
import {
  dropKeys,
  fdSetStatus,
  readDropState,
  readLiveRedisIdentity,
  readStock,
  readStoredRedisIdentity,
  redisDropViolations,
  SYNC_CHANNEL,
  withDropLock,
} from '@flashdrop/inventory';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLeaderLease } from '../leader';
import {
  alertsNamed,
  armDrop,
  createDrop,
  createUsers,
  createWorkerTestEnv,
  deleteDropKeys,
  eventually,
  inventoryOf,
  reserve,
  testIdentityStore,
  type WorkerTestEnv,
} from '../test/harness';
import { startReconciler } from './index';
import { createReconciler } from './reconcile';

/*
 * The reconciler (design §4.7) against the Compose Postgres (a database of this file's own) and the shared
 * Redis. A FLUSHALL is simulated by deleting this file's drop keys and its own epoch key: the shared Redis
 * is never flushed, and the stack's `fd:epoch` is never touched.
 */

let env: WorkerTestEnv;
let identity: ReturnType<typeof testIdentityStore>;
const running = new AbortController().signal;

beforeAll(async () => {
  env = await createWorkerTestEnv();
  identity = testIdentityStore(env);
  // The first tick finds no recorded identity (a fresh system_state) and rebuilds once; start from there.
  await createReconciler(env.deps, identity).tick(running);
});

afterAll(async () => {
  await env?.redis.del(identity.epochKey);
  await env?.close();
});

/** Redis holds exactly Postgres's state of the drop, under Postgres's generation. */
async function expectRebuilt(dropId: string) {
  const [state, inventory] = await Promise.all([readDropState(env.redis, dropId), inventoryOf(env, dropId)]);
  expect(state.inv).toMatchObject({
    gen: inventory.redis_gen,
    avail: inventory.total - inventory.sold - inventory.reserved,
    held: inventory.reserved,
    sold: inventory.sold,
  });
  expect(state.inv?.status).not.toBe('RECONCILING');
  expect(redisDropViolations(state)).toEqual([]);
  return state;
}

describe('structural checks', () => {
  it('rebuild a drop whose keys are gone, holds, quotas and idempotency records included', async () => {
    const reconciler = createReconciler(env.deps, identity);
    const dropId = await createDrop(env, { total: 6 });
    await armDrop(env, dropId);
    const [ada = '', ben = ''] = await createUsers(env.db, 2);
    const holds = [await reserve(env, dropId, ada, 2), await reserve(env, dropId, ben)];
    const { redis_gen: before } = await inventoryOf(env, dropId);
    await deleteDropKeys(env.redis, dropId);

    await reconciler.tick(running);

    const state = await expectRebuilt(dropId);
    expect((await inventoryOf(env, dropId)).redis_gen).toBe(before + 1);
    expect(state.inv).toMatchObject({ avail: 3, held: 3, status: 'LIVE' });
    expect([...state.entries.keys()].sort()).toEqual([...holds].sort());
    expect(Object.fromEntries(state.quotas)).toEqual({ [ada]: 2, [ben]: 1 });
    expect(state.expiries.size).toBe(2);
  });

  it('rebuild a drop left RECONCILING by a dead rebuild', async () => {
    const reconciler = createReconciler(env.deps, identity);
    const dropId = await createDrop(env);
    await armDrop(env, dropId);
    await fdSetStatus(env.redis, dropId, 'RECONCILING');

    await reconciler.tick(running);

    expect((await expectRebuilt(dropId)).inv?.status).toBe('LIVE');
  });

  it('rebuild a drop whose Redis generation differs from Postgres', async () => {
    const reconciler = createReconciler(env.deps, identity);
    const dropId = await createDrop(env);
    await armDrop(env, dropId);
    await env.db.execute(sql`UPDATE drop_inventory SET redis_gen = redis_gen + 5 WHERE drop_id = ${dropId}`);

    await reconciler.tick(running);

    await expectRebuilt(dropId);
  });

  it('leave a busy drop alone, and alert when it has been RECONCILING for more than 30 s', async () => {
    const reconciler = createReconciler(env.deps, identity);
    const dropId = await createDrop(env);
    await armDrop(env, dropId);
    await fdSetStatus(env.redis, dropId, 'RECONCILING');
    await env.redis.hSet(dropKeys(dropId).inv, 'reconcilingSince', Date.now() - 31_000);

    await withDropLock(env.deps.lock, dropId, () => reconciler.tick(running));

    expect((await readStock(env.redis, dropId))?.status).toBe('RECONCILING');
    expect(alertsNamed(env, 'slow_rebuild')).toContainEqual(expect.objectContaining({ dropId }));

    await reconciler.tick(running);
    await expectRebuilt(dropId);
  });

  // Regression: `slow_rebuild` was raised only while another session held the lock. A drop whose own
  // rebuilds kept failing answered 503 to every reserve with no alert at all.
  it('alert when the drop has been RECONCILING for more than 30 s and its own rebuild keeps failing', async () => {
    const reconciler = createReconciler(env.deps, identity);
    const dropId = await createDrop(env);
    await armDrop(env, dropId);
    const inv = dropKeys(dropId).inv;
    // A generation Postgres never issued (say, Postgres restored from an older backup): fd_rebuild refuses
    // every snapshot as STALE.
    await env.redis.hSet(inv, 'gen', 999_999);
    await fdSetStatus(env.redis, dropId, 'RECONCILING');
    const since = Date.now() - 31_000;
    await env.redis.hSet(inv, 'reconcilingSince', since);

    await reconciler.tick(running);

    expect((await readStock(env.redis, dropId))?.status).toBe('RECONCILING');
    // A retried sync keeps the start of the outage, so the alert measures the outage, not the last try.
    expect(await env.redis.hGet(inv, 'reconcilingSince')).toBe(String(since));
    expect(alertsNamed(env, 'rebuild_failed')).toContainEqual(expect.objectContaining({ dropId }));

    await env.redis.hSet(inv, 'gen', -1);
    await reconciler.tick(running);
    await expectRebuilt(dropId);
  });

  it('alert on a failing structural check of a drop RECONCILING for more than 30 s', async () => {
    const reconciler = createReconciler(env.deps, identity);
    const dropId = await createDrop(env, { total: 4 });
    await armDrop(env, dropId);
    await fdSetStatus(env.redis, dropId, 'RECONCILING');
    await env.redis.hSet(dropKeys(dropId).inv, 'reconcilingSince', Date.now() - 31_000);
    // The check itself fails (a tracked drop without its inventory row) before any rebuild can start.
    const { redis_gen: gen } = await inventoryOf(env, dropId);
    await env.db.execute(sql`DELETE FROM drop_inventory WHERE drop_id = ${dropId}`);
    try {
      await reconciler.tick(running);
      expect(alertsNamed(env, 'rebuild_failed').filter((line) => line.dropId === dropId)).toHaveLength(1);
      // At most once per 10 s per drop.
      await reconciler.tick(running);
      expect(alertsNamed(env, 'rebuild_failed').filter((line) => line.dropId === dropId)).toHaveLength(1);
    } finally {
      await env.db.execute(
        sql`INSERT INTO drop_inventory (drop_id, total, redis_gen) VALUES (${dropId}, 4, ${gen})`,
      );
    }
    await reconciler.tick(running);
    await expectRebuilt(dropId);
  });
});

describe('keyspace loss', () => {
  it('after a wipe, rebuilds every tracked drop, ended ones too, then records a new epoch', async () => {
    const reconciler = createReconciler(env.deps, identity);
    const live = await createDrop(env, { total: 5 });
    const ended = await createDrop(env, { total: 5 });
    await armDrop(env, live);
    await armDrop(env, ended);
    const [user = ''] = await createUsers(env.db, 1);
    const held = await reserve(env, live, user, 2);
    const late = await reserve(env, ended, user);
    // The second drop ended an hour ago: still tracked (retainAt is the end + 24 h), so it must come back.
    await env.db.execute(sql`
      UPDATE drops SET status = 'ENDED', starts_at = now() - interval '2 hours', ends_at = now() - interval '1 hour'
      WHERE id = ${ended}`);
    const epochBefore = await env.redis.get(identity.epochKey);

    // FLUSHALL, as far as this file's keys go.
    for (const dropId of env.dropIds) await deleteDropKeys(env.redis, dropId);
    await env.redis.del(identity.epochKey);
    await reconciler.tick(running);

    expect((await expectRebuilt(live)).entries.get(held)).toMatchObject({ s: 'HELD', q: 2, u: user });
    const endedState = await expectRebuilt(ended);
    expect(endedState.inv?.status).toBe('ENDED');
    expect(endedState.entries.get(late)).toMatchObject({ s: 'HELD', q: 1, u: user });
    const epoch = await env.redis.get(identity.epochKey);
    expect(epoch).not.toBeNull();
    expect(epoch).not.toBe(epochBefore);
    expect(await readStoredRedisIdentity(env.db)).toMatchObject({ epoch });
    expect(env.logs).toContainEqual(
      expect.objectContaining({ reason: 'wipe', msg: 'redis rebuilt from postgres' }),
    );
  });

  // Regression: the tracked set came in starts_at order, so every ENDED drop of the last 24 h was rebuilt
  // before the LIVE one, which answered 503 meanwhile.
  it('rebuilds open drops before ended ones', async () => {
    const reconciler = createReconciler(env.deps, identity);
    const ended = await createDrop(env);
    const live = await createDrop(env);
    await armDrop(env, ended);
    await armDrop(env, live);
    await env.db.execute(sql`
      UPDATE drops SET status = 'ENDED', starts_at = now() - interval '3 hours', ends_at = now() - interval '2 hours'
      WHERE id = ${ended}`);
    for (const dropId of [ended, live]) await deleteDropKeys(env.redis, dropId);
    await env.redis.del(identity.epochKey);
    const from = env.logs.length;

    await reconciler.tick(running);

    const order = env.logs
      .slice(from)
      .filter((line) => line.msg === 'drop rebuilt' && line.reason === 'wipe')
      .map((line) => line.dropId);
    expect(order).toContain(live);
    expect(order.indexOf(live)).toBeLessThan(order.indexOf(ended));
  });

  it('records the identity only once a busy drop is rebuilt too, and rebuilds the others once', async () => {
    const reconciler = createReconciler(env.deps, identity);
    const free = await createDrop(env);
    const busy = await createDrop(env);
    await armDrop(env, free);
    await armDrop(env, busy);
    for (const dropId of [free, busy]) await deleteDropKeys(env.redis, dropId);
    await env.redis.del(identity.epochKey);

    await withDropLock(env.deps.lock, busy, () => reconciler.tick(running));

    const freeGen = (await inventoryOf(env, free)).redis_gen;
    await expectRebuilt(free);
    expect(await readStock(env.redis, busy)).toBeNull();
    expect(await env.redis.get(identity.epochKey)).toBeNull();

    await reconciler.tick(running);

    await expectRebuilt(busy);
    expect((await inventoryOf(env, free)).redis_gen).toBe(freeGen);
    expect(await env.redis.get(identity.epochKey)).not.toBeNull();
  });

  it('after a Redis restart (another run_id), rebuilds although every key looks intact', async () => {
    const reconciler = createReconciler(env.deps, identity);
    const dropId = await createDrop(env);
    await armDrop(env, dropId);
    const { redis_gen: before } = await inventoryOf(env, dropId);
    await env.db
      .update(systemState)
      .set({ value: '0000000000000000000000000000000000000000' })
      .where(eq(systemState.key, 'redis_run_id'));

    await reconciler.tick(running);

    expect((await inventoryOf(env, dropId)).redis_gen).toBeGreaterThan(before);
    await expectRebuilt(dropId);
    const { runId } = await readLiveRedisIdentity(env.redis);
    expect(await readStoredRedisIdentity(env.db)).toMatchObject({ runId });
  });

  it('when the library is missing, reloads it and rebuilds', async () => {
    const reconciler = createReconciler(env.deps, identity);
    const dropId = await createDrop(env);
    await armDrop(env, dropId);
    const { redis_gen: before } = await inventoryOf(env, dropId);
    identity.forgetLibraryOnce();

    await reconciler.tick(running);

    expect((await inventoryOf(env, dropId)).redis_gen).toBeGreaterThan(before);
    expect(env.logs).toContainEqual(
      expect.objectContaining({ reason: 'library', msg: 'redis rebuilt from postgres' }),
    );
  });
});

describe('the reconciler role', () => {
  it('reacts to NOTIFY fd_sync at once instead of on its next periodic tick', async () => {
    const role = startReconciler(env.deps, { databaseUrl: env.url, identity, everyMs: 60_000 });
    try {
      const dropId = await createDrop(env);
      await armDrop(env, dropId);
      await eventually(async () => role.loops.every((loop) => loop.health().healthy), 5_000);
      await eventually(async () => {
        const { rows } = await env.db.execute(sql`
          SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND application_name = 'worker:reconciler:listen'
            AND query LIKE 'LISTEN%'`);
        return rows.length === 1;
      }, 5_000);
      // Let the tick that LISTEN's success asked for finish, so only the nudge can cause the next one.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await deleteDropKeys(env.redis, dropId);

      await env.db.execute(sql`SELECT pg_notify(${SYNC_CHANNEL}, ${dropId})`);

      // Not just present: a rebuild in flight shows the fail-closed RECONCILING hash first.
      const tookMs = await eventually(async () => {
        const stock = await readStock(env.redis, dropId);
        return stock !== null && stock.status !== 'RECONCILING';
      }, 5_000);
      expect(tookMs).toBeLessThan(5_000);
      await expectRebuilt(dropId);
    } finally {
      await role.stop();
    }
  });

  it('elects one leader; a standby takes over once it lets go', async () => {
    const first = createLeaderLease({ pool: env.deps.lock.pool, logger: env.deps.logger }, 'reconciler-test');
    const second = createLeaderLease(
      { pool: env.deps.lock.pool, logger: env.deps.logger },
      'reconciler-test',
    );
    try {
      expect(await first.check()).toBe(true);
      expect(await second.check()).toBe(false);
      expect(await first.check()).toBe(true);
      await first.release();
      expect(await second.check()).toBe(true);
      expect(await first.check()).toBe(false);
    } finally {
      await first.release();
      await second.release();
    }
  });
});

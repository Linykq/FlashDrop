import { randomUUID } from 'node:crypto';
import {
  claimQuota,
  type Db,
  fenceRedisGeneration,
  insertOrderOnConflictDoNothing,
  takeStock,
  transaction,
} from '@flashdrop/db';
import { DomainError, RetryError } from '@flashdrop/domain';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { fdRelease, fdReserve, fdSetStatus } from './calls';
import type { FlashdropRedis } from './client';
import { type DropLockDeps, tryWithDropLock, withDropLock } from './drop-lock';
import { commitRedisIdentity, keyspaceLoss, readLiveRedisIdentity, readStoredRedisIdentity } from './epoch';
import { createSyncNudger, SYNC_CHANNEL } from './nudge';
import { settleRedis } from './settle';
import { readDropState, readStock, redisDropViolations } from './state';
import { rebuildDrop, type SyncDeps, syncDropFromPostgres } from './sync';
import {
  closeOrder,
  createTestDrop,
  createTestPostgres,
  createTestUser,
  inventoryOf,
  recordHold,
  rejectHold,
  type TestPostgres,
} from './test/postgres';
import { connectTestRedis, deleteDropKeys, reserveInput } from './test/redis';

/*
 * The drop lock, syncDropFromPostgres with its generation fence, settleRedis and the reconciler's identity
 * helpers (design §4.7, §6.5), against a throwaway database of this file's own and the shared Redis. Each
 * test creates its own drop and deletes its Redis keys afterwards; nothing here reads or writes the
 * running stack's `fd:epoch` or `system_state`.
 */

const quiet = { info: () => undefined, warn: () => undefined };
let pgc: TestPostgres;
let redis: FlashdropRedis;
let deps: SyncDeps & { readonly lock: DropLockDeps };

beforeAll(async () => {
  pgc = await createTestPostgres();
  redis = await connectTestRedis();
  deps = { db: pgc.db, redis, logger: quiet, lock: { pool: pgc.lockPool, logger: quiet } };
});

afterAll(async () => {
  await redis?.close();
  await pgc?.close();
});

async function testDrop(options: Parameters<typeof createTestDrop>[1] = {}) {
  const drop = await createTestDrop(pgc.db, options);
  onTestFinished(() => deleteDropKeys(redis, drop.dropId));
  return drop;
}

/** fd_reserve, then the api's reserve transaction under the gen Lua answered, committed. */
async function reserve(dropId: string, userId: string, qty = 1) {
  const input = reserveInput(dropId, userId, qty);
  const admitted = await fdReserve(redis, input);
  if (admitted.kind !== 'RESERVED') throw new Error(`fd_reserve answered ${admitted.kind}`);
  const outcome = await recordHold(pgc.db, input, admitted.gen);
  if (outcome.kind !== 'created') throw new Error(`recordReservation answered ${JSON.stringify(outcome)}`);
  return input;
}

/** Redis agrees with Postgres exactly: INV-6's `avail/held/sold` part, and INV-9 inside Redis. */
async function expectAgreement(dropId: string) {
  const [state, inventory] = await Promise.all([readDropState(redis, dropId), inventoryOf(pgc.db, dropId)]);
  expect(state.inv).toMatchObject({
    gen: inventory.redis_gen,
    avail: inventory.total - inventory.sold - inventory.reserved,
    held: inventory.reserved,
    sold: inventory.sold,
  });
  expect(redisDropViolations(state)).toEqual([]);
}

/**
 * Resolves when `signal` does, and rejects if `work` settles first: a test waiting for a callback to reach
 * a point must not hang when the callback failed before it got there.
 */
function reached(signal: Promise<void>, work: Promise<unknown>): Promise<void> {
  return Promise.race([
    signal,
    work.then(
      (value) => Promise.reject(new Error(`finished before the expected point: ${JSON.stringify(value)}`)),
      (error: unknown) => Promise.reject(error),
    ),
  ]);
}

/** Kills the session holding the drop's lock, as a network partition or a crashed pooler would. */
async function killLockHolder(dropId: string): Promise<number> {
  const { rows } = await pgc.pool.query<{ pid: number }>(
    `SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted
       AND (classid::bigint << 32 | objid::bigint) = hashtextextended('fd.sync:' || $1::text, 0)`,
    [dropId],
  );
  const pid = rows[0]?.pid ?? 0;
  await pgc.pool.query('SELECT pg_terminate_backend($1)', [pid]);
  return pid;
}

/** `redis`, except that `fd_rebuild` first waits for `release`: a sync stalled after its snapshot. */
function stallingRebuild(release: Promise<void>, onStall: () => void): FlashdropRedis {
  const flashdrop = new Proxy(redis.flashdrop, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (prop !== 'fd_rebuild' || typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        onStall();
        await release;
        return value.apply(target, args);
      };
    },
  });
  return new Proxy(redis, {
    get(target, prop) {
      if (prop === 'flashdrop') return flashdrop;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** `pgc.db`, except that its first transaction (the rebuild snapshot) waits for `release`. */
function stallingSnapshot(release: Promise<void>, onStall: () => void): Db {
  let stalled = false;
  return new Proxy(pgc.db, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      if (prop !== 'transaction') return value.bind(target);
      return async (...args: unknown[]) => {
        if (!stalled) {
          stalled = true;
          onStall();
          await release;
        }
        return value.apply(target, args);
      };
    },
  });
}

describe('syncDropFromPostgres', () => {
  it('arms a drop: fail-closed first, then one rebuild under a new generation', async () => {
    const { dropId } = await testDrop({ total: 5, status: 'SCHEDULED' });

    expect(await syncDropFromPostgres(deps, dropId)).toEqual({
      kind: 'REBUILT',
      gen: 1,
      status: 'SCHEDULED',
      orders: 0,
    });
    expect(await readStock(redis, dropId)).toEqual({
      status: 'SCHEDULED',
      gen: 1,
      seq: 0,
      avail: 5,
      held: 0,
      sold: 0,
    });
    await expectAgreement(dropId);
  });

  it('rebuilds every order of the drop, terminal ones included, and the user quotas', async () => {
    const { dropId } = await testDrop({ total: 10, limit: 4 });
    await syncDropFromPostgres(deps, dropId);
    const [alice, bob] = await Promise.all([createTestUser(pgc.db), createTestUser(pgc.db)]);
    const live = await reserve(dropId, alice, 2);
    const paid = await reserve(dropId, alice, 1);
    const expired = await reserve(dropId, bob, 2);
    await closeOrder(pgc.db, paid.rid, 'PAID');
    await closeOrder(pgc.db, expired.rid, 'EXPIRED');
    const rejected = reserveInput(dropId, bob, 1);
    expect(await rejectHold(pgc.db, rejected)).toBe(true);

    // Wipe Redis entirely for this drop, as FLUSHALL would, then recover.
    await deleteDropKeys(redis, dropId);
    expect(await syncDropFromPostgres(deps, dropId)).toMatchObject({ kind: 'REBUILT', gen: 2, orders: 4 });

    const state = await readDropState(redis, dropId);
    expect(new Map([...state.entries].map(([rid, e]) => [rid, e.s]))).toEqual(
      new Map([
        [live.rid, 'HELD'],
        [paid.rid, 'COMMITTED'],
        [expired.rid, 'RELEASED'],
        [rejected.rid, 'RELEASED'],
      ]),
    );
    expect(state.quotas).toEqual(new Map([[alice, 3]]));
    expect([...state.expiries.keys()]).toEqual([live.rid]);
    await expectAgreement(dropId);
    // The idempotency records survived: a replay is answered from Redis again.
    expect(await fdReserve(redis, live)).toEqual({ kind: 'EXISTING', state: 'HELD', gen: 2 });
    expect(await fdReserve(redis, expired)).toEqual({ kind: 'EXISTING', state: 'RELEASED', gen: 2 });
  });

  it('counts an in-flight reserve that passed the generation check before the fence', async () => {
    const { dropId } = await testDrop({ total: 5 });
    await syncDropFromPostgres(deps, dropId);
    const user = await createTestUser(pgc.db);
    const input = reserveInput(dropId, user, 2);
    const admitted = await fdReserve(redis, input);
    expect(admitted).toEqual({ kind: 'RESERVED', gen: 1 });

    // The reserve transaction's own statements, paused before its commit: it holds the inventory row and
    // has passed `redis_gen = 1`.
    const passed = Promise.withResolvers<void>();
    const commit = Promise.withResolvers<void>();
    const recording = transaction(pgc.db, async (tx) => {
      const inserted = await insertOrderOnConflictDoNothing(tx, {
        id: input.rid,
        userId: user,
        dropId,
        qty: 2,
        idempotencyKey: input.idempotencyKey,
        requestHash: Buffer.from(input.fingerprint),
      });
      if (inserted === undefined) throw new Error('the rid should be new');
      if (!(await claimQuota(tx, user, dropId, 2))) throw new Error('the quota should have room');
      expect(await takeStock(tx, dropId, 2, 1)).toBe('OK');
      passed.resolve();
      await commit.promise;
    });
    await reached(passed.promise, recording);

    const sync = syncDropFromPostgres(deps, dropId);
    // The fence waits on the row lock, with the drop already fail-closed.
    await expect.poll(async () => (await readStock(redis, dropId))?.status).toBe('RECONCILING');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await inventoryOf(pgc.db, dropId)).redis_gen).toBe(1);
    commit.resolve();
    await recording;

    expect(await sync).toMatchObject({ kind: 'REBUILT', gen: 2, orders: 1 });
    const state = await readDropState(redis, dropId);
    expect(state.entries.get(input.rid)?.s).toBe('HELD');
    await expectAgreement(dropId);
  });

  it('refuses a reserve that reaches Postgres with the old generation after the fence', async () => {
    const { dropId } = await testDrop({ total: 5 });
    await syncDropFromPostgres(deps, dropId);
    const user = await createTestUser(pgc.db);
    const input = reserveInput(dropId, user, 1);
    expect(await fdReserve(redis, input)).toEqual({ kind: 'RESERVED', gen: 1 });

    // A rebuild lands between Lua and the Postgres transaction.
    expect(await syncDropFromPostgres(deps, dropId)).toMatchObject({ kind: 'REBUILT', gen: 2, orders: 0 });
    // Rolled back: the api answers 503 RETRY and the client retries with the same key.
    expect(await recordHold(pgc.db, input, 1)).toEqual({ kind: 'refused', reason: 'STALE_GEN' });

    // The rebuild dropped the hold it never counted; nothing leaked and nothing needs releasing.
    expect((await readDropState(redis, dropId)).entries.has(input.rid)).toBe(false);
    await expectAgreement(dropId);

    // The retry with the same key starts clean under the new generation.
    expect(await fdReserve(redis, input)).toEqual({ kind: 'RESERVED', gen: 2 });
    expect((await recordHold(pgc.db, input, 2)).kind).toBe('created');
    await expectAgreement(dropId);
  });

  it('knows nothing of DRAFT and unknown drops, and leaves Redis alone for them', async () => {
    const { dropId } = await testDrop({ status: 'DRAFT' });

    expect(await syncDropFromPostgres(deps, dropId)).toEqual({ kind: 'NOT_ARMED' });
    expect(await syncDropFromPostgres(deps, randomUUID())).toEqual({ kind: 'UNKNOWN_DROP' });
    expect(await readStock(redis, dropId)).toBeNull();
  });
});

describe('rebuild vs rebuild (§13 race matrix)', () => {
  it('refuses the late fd_rebuild of a sync whose lock session died, and keeps the newer generation', async () => {
    const { dropId } = await testDrop({ total: 5 });
    await syncDropFromPostgres(deps, dropId);
    const user = await createTestUser(pgc.db);
    await reserve(dropId, user, 1);

    // The zombie fences gen 2, takes its snapshot, and stalls right before fd_rebuild.
    const release = Promise.withResolvers<void>();
    const stalled = Promise.withResolvers<void>();
    const zombie = syncDropFromPostgres(
      { ...deps, redis: stallingRebuild(release.promise, () => stalled.resolve()) },
      dropId,
    );
    await reached(stalled.promise, zombie);
    // Its lock session dies while its process runs on, so a newer sync takes the lock and finishes.
    expect(await killLockHolder(dropId)).toBeGreaterThan(0);
    expect(await syncDropFromPostgres(deps, dropId)).toMatchObject({ kind: 'REBUILT', gen: 3, orders: 1 });
    const after = await reserve(dropId, user, 1);

    release.resolve();
    expect(await zombie).toEqual({ kind: 'STALE', gen: 2 });
    const state = await readDropState(redis, dropId);
    expect(state.inv).toMatchObject({ gen: 3, status: 'LIVE' });
    expect(state.entries.get(after.rid)?.s).toBe('HELD'); // the stale snapshot did not wipe a newer hold
    await expectAgreement(dropId);
  });

  it('rebuilds with the generation its snapshot reads when a zombie bumped it after this sync’s fence', async () => {
    const { dropId } = await testDrop({ total: 5 });
    await syncDropFromPostgres(deps, dropId);
    const warnings: string[] = [];
    const logger = {
      info: () => undefined,
      warn: (...args: unknown[]) => void warnings.push(String(args[1])),
    };

    // This sync fences gen 2 and stalls before its snapshot; a zombie's fence lands meanwhile (gen 3).
    const release = Promise.withResolvers<void>();
    const stalled = Promise.withResolvers<void>();
    const holder = syncDropFromPostgres(
      { ...deps, logger, db: stallingSnapshot(release.promise, () => stalled.resolve()) },
      dropId,
    );
    await reached(stalled.promise, holder);
    expect((await inventoryOf(pgc.db, dropId)).redis_gen).toBe(2);
    expect(await fenceRedisGeneration(pgc.db, dropId)).toBe(3);

    release.resolve();
    expect(await holder).toMatchObject({ kind: 'REBUILT', gen: 3 });
    expect(warnings).toContain('redis_gen moved during a rebuild');
    expect(await readStock(redis, dropId)).toMatchObject({ gen: 3, status: 'LIVE' });
    await expectAgreement(dropId);
  });
});

describe('the drop lock', () => {
  it('lets one holder in at a time: loops skip a busy drop, admins wait, then get DROP_BUSY', async () => {
    const dropId = randomUUID();
    const release = Promise.withResolvers<void>();
    const holding = Promise.withResolvers<void>();
    const holder = withDropLock(deps.lock, dropId, async (lock) => {
      expect(lock.held).toBe(true);
      holding.resolve();
      await release.promise;
    });
    await reached(holding.promise, holder);

    expect(await tryWithDropLock(deps.lock, dropId, async () => 'ran')).toEqual({ acquired: false });
    // The key comes from the canonical id: an uppercase spelling is the same drop and the same lock.
    expect(await tryWithDropLock(deps.lock, dropId.toUpperCase(), async () => 'ran')).toEqual({
      acquired: false,
    });
    const started = Date.now();
    const busy = await withDropLock(deps.lock, dropId, async () => 'ran', { timeoutMs: 300 }).catch(
      (error: unknown) => error,
    );
    expect(busy).toBeInstanceOf(DomainError);
    expect(busy).toMatchObject({ code: 'DROP_BUSY', status: 409 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);

    release.resolve();
    await holder;
    expect(await tryWithDropLock(deps.lock, dropId, async () => 'ran')).toEqual({
      acquired: true,
      value: 'ran',
    });
  });

  it('refuses a rebuild with a lock that is no longer held', async () => {
    const { dropId } = await testDrop();
    let stale: Parameters<typeof rebuildDrop>[1] | undefined;
    await withDropLock(deps.lock, dropId, async (lock) => {
      stale = lock;
    });
    if (stale === undefined) throw new Error('the lock callback did not run');

    await expect(rebuildDrop(deps, stale)).rejects.toBeInstanceOf(RetryError);
    expect(await readStock(redis, dropId)).toBeNull();
  });

  it('frees the lock when its session dies, so the next holder can rebuild', async () => {
    const dropId = randomUUID();
    let pid = 0;
    // Awaited directly: it settles when the callback does, and carries the callback's error if it fails.
    await withDropLock(deps.lock, dropId, async (lock) => {
      pid = await killLockHolder(dropId);
      await expect.poll(() => lock.held).toBe(false);
    });

    expect(pid).toBeGreaterThan(0);
    expect(await tryWithDropLock(deps.lock, dropId, async () => 'next')).toEqual({
      acquired: true,
      value: 'next',
    });
  });
});

describe('settleRedis', () => {
  it('applies terminal outcomes once, after Postgres, and records them', async () => {
    const { dropId } = await testDrop({ total: 5, limit: 4 });
    await syncDropFromPostgres(deps, dropId);
    const user = await createTestUser(pgc.db);
    const settle = { db: pgc.db, redis, nudger: createSyncNudger({ db: pgc.db, logger: quiet }) };
    const expiring = await reserve(dropId, user, 2);
    const paying = await reserve(dropId, user, 1);

    expect(await settleRedis(settle, expiring.rid)).toEqual({ kind: 'SKIPPED', reason: 'NOT_TERMINAL' });
    await closeOrder(pgc.db, expiring.rid, 'EXPIRED');
    await closeOrder(pgc.db, paying.rid, 'PAID');

    expect(await settleRedis(settle, expiring.rid)).toEqual({ kind: 'SETTLED', via: 'OK' });
    expect(await settleRedis(settle, paying.rid)).toEqual({ kind: 'SETTLED', via: 'OK' });
    expect(await settleRedis(settle, expiring.rid)).toEqual({ kind: 'SKIPPED', reason: 'ALREADY_SETTLED' });
    expect(await settleRedis(settle, expiring.rid, { force: true })).toEqual({
      kind: 'SETTLED',
      via: 'NOOP',
    });
    expect(await settleRedis(settle, randomUUID())).toEqual({ kind: 'UNKNOWN_ORDER' });
    await expectAgreement(dropId);
    expect((await readDropState(redis, dropId)).quotas).toEqual(new Map([[user, 1]]));
  });

  it('releases the hold of a REJECTED tombstone, which Postgres never counted', async () => {
    const { dropId } = await testDrop({ total: 5 });
    await syncDropFromPostgres(deps, dropId);
    const user = await createTestUser(pgc.db);
    const settle = { db: pgc.db, redis, nudger: createSyncNudger({ db: pgc.db, logger: quiet }) };
    const input = reserveInput(dropId, user, 1);
    await fdReserve(redis, input);
    expect(await rejectHold(pgc.db, input)).toBe(true);

    expect(await settleRedis(settle, input.rid)).toEqual({ kind: 'SETTLED', via: 'OK' });
    await expectAgreement(dropId);
  });

  it('reports RETRY while the drop rebuilds and CONFLICT when Redis contradicts Postgres', async () => {
    const { dropId } = await testDrop({ total: 5 });
    await syncDropFromPostgres(deps, dropId);
    const user = await createTestUser(pgc.db);
    const settle = { db: pgc.db, redis, nudger: createSyncNudger({ db: pgc.db, logger: quiet }) };
    const input = await reserve(dropId, user, 1);
    await closeOrder(pgc.db, input.rid, 'PAID');

    await fdSetStatus(redis, dropId, 'RECONCILING');
    expect(await settleRedis(settle, input.rid)).toEqual({ kind: 'RETRY', reason: 'RECONCILING' });
    await syncDropFromPostgres(deps, dropId);
    // The rebuild already counted the payment, so settling is a NOOP now.
    expect(await settleRedis(settle, input.rid)).toEqual({ kind: 'SETTLED', via: 'NOOP' });

    const other = await reserve(dropId, user, 1);
    await closeOrder(pgc.db, other.rid, 'PAID');
    expect(await fdRelease(redis, dropId, other.rid)).toEqual({ kind: 'OK' }); // a buggy early release
    expect(await settleRedis(settle, other.rid)).toEqual({ kind: 'CONFLICT', status: 'PAID' });
  });

  it('nudges the reconciler when a tracked drop is missing from Redis', async () => {
    const { dropId } = await testDrop({ total: 5 });
    await syncDropFromPostgres(deps, dropId);
    const user = await createTestUser(pgc.db);
    const settle = { db: pgc.db, redis, nudger: createSyncNudger({ db: pgc.db, logger: quiet }) };
    const input = await reserve(dropId, user, 1);
    await closeOrder(pgc.db, input.rid, 'CANCELLED');

    const listener = await pgc.pool.connect();
    onTestFinished(async () => {
      await listener.query(`UNLISTEN ${SYNC_CHANNEL}`);
      listener.release();
    });
    const nudged: string[] = [];
    listener.on('notification', (n) => {
      if (n.channel === SYNC_CHANNEL && n.payload !== undefined) nudged.push(n.payload);
    });
    await listener.query(`LISTEN ${SYNC_CHANNEL}`);

    await deleteDropKeys(redis, dropId); // a wipe the reconciler has not repaired yet
    expect(await settleRedis(settle, input.rid)).toEqual({ kind: 'RETRY', reason: 'NO_DROP' });
    await expect.poll(() => nudged.includes(dropId)).toBe(true);

    await syncDropFromPostgres(deps, dropId); // what the nudged reconciler does
    expect(await settleRedis(settle, input.rid)).toEqual({ kind: 'SETTLED', via: 'NOOP' });
  });

  it('settles without Redis once the drop is past its retention', async () => {
    const now = Date.now();
    const { dropId } = await testDrop({
      status: 'ENDED',
      startsAt: new Date(now - 50 * 3_600_000),
      endsAt: new Date(now - 25 * 3_600_000),
    });
    const user = await createTestUser(pgc.db);
    const settle = { db: pgc.db, redis, nudger: createSyncNudger({ db: pgc.db, logger: quiet }) };
    const tombstone = reserveInput(dropId, user, 1);
    expect(await rejectHold(pgc.db, tombstone)).toBe(true);

    expect(await settleRedis(settle, tombstone.rid)).toEqual({ kind: 'SETTLED', via: 'PAST_RETENTION' });
    expect(await settleRedis(settle, tombstone.rid)).toEqual({ kind: 'SKIPPED', reason: 'ALREADY_SETTLED' });
  });
});

describe('the reconciler identity helpers', () => {
  it('read Redis and record a full rebuild so that no loss is reported until the next one', async () => {
    // An epoch key of the test's own, and this file's database for system_state: the running stack's
    // identity is never read or written, so it never sees a wipe because of this test.
    const epochKey = `fd:test:epoch:${randomUUID()}`;
    onTestFinished(async () => {
      await redis.del(epochKey);
    });
    const before = await readLiveRedisIdentity(redis, { epochKey });
    expect(before).toMatchObject({ epoch: null, libraryLoaded: true, libraryOutdated: false });
    expect(before.runId).toMatch(/^[0-9a-f]{40}$/);
    expect(keyspaceLoss(before, await readStoredRedisIdentity(pgc.db))).toBe('restart');

    const epoch = await commitRedisIdentity({ redis, db: pgc.db }, before.runId, { epochKey });

    const [live, stored] = await Promise.all([
      readLiveRedisIdentity(redis, { epochKey }),
      readStoredRedisIdentity(pgc.db),
    ]);
    expect(live.epoch).toBe(epoch);
    expect(stored).toEqual({ epoch, runId: before.runId });
    expect(keyspaceLoss(live, stored)).toBeNull();
  });
});

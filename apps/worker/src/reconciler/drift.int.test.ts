import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { getOrder, sql } from '@flashdrop/db';
import { DomainError, type ErrorCode, RetryError } from '@flashdrop/domain';
import { reservationId } from '@flashdrop/domain/identity';
import {
  checkDrop,
  dropKeys,
  readDropState,
  redisDropViolations,
  sampleDrop,
  settleRedis,
} from '@flashdrop/inventory';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registry } from '../metrics';
import {
  alertsNamed,
  apiReservations,
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
import { createReconciler, type Reconciler } from './reconcile';

/*
 * The reconciler's drift checks and refusal trigger (design §4.7) against the Compose Postgres (a database of
 * this file's own) and the tests' Redis. Drift is injected by hand into a drop's `inv` or `uq` hash, the way
 * a lost AOF tail or a bug would leave it.
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

/** A reconciler that samples drift on every tick, so a test controls the rounds. */
function sampling(): Reconciler {
  return createReconciler(env.deps, identity, { driftEveryMs: 0 });
}

/** The current value of a series of this process's registry, 0 while it has none. */
async function metric(name: string, labels: Readonly<Record<string, string>>): Promise<number> {
  const found = registry.getSingleMetric(name);
  if (found === undefined) return 0;
  const { values } = await found.get();
  const match = values.find((v) => Object.entries(labels).every(([key, value]) => v.labels[key] === value));
  return match?.value ?? 0;
}

/** Redis holds exactly Postgres's state of the drop, under Postgres's generation. */
async function expectRebuilt(dropId: string) {
  const [state, inventory] = await Promise.all([readDropState(env.redis, dropId), inventoryOf(env, dropId)]);
  expect(state.inv).toMatchObject({
    status: 'LIVE',
    gen: inventory.redis_gen,
    avail: inventory.total - inventory.sold - inventory.reserved,
    held: inventory.reserved,
    sold: inventory.sold,
  });
  expect(redisDropViolations(state)).toEqual([]);
}

const rebuildsOf = (dropId: string, reason: string) =>
  env.logs.filter((line) => line.msg === 'drop rebuilt' && line.dropId === dropId && line.reason === reason);

type Outcome = 'reserved' | 'refused' | 'SOLD_OUT' | 'LIMIT' | 'NOT_LIVE';

/** Refusals Lua answers alone, by the code the api answers them with. */
const LUA_REFUSALS: Readonly<Partial<Record<ErrorCode, Outcome>>> = {
  SOLD_OUT: 'SOLD_OUT',
  LIMIT_REACHED: 'LIMIT',
  DROP_NOT_LIVE: 'NOT_LIVE',
};

/**
 * One unit reserved by the api's own reservation service (§5.2): Lua, then the Postgres transaction under
 * Lua's generation; a Postgres refusal is tombstoned and, for SOLD_OUT and LIMIT, alerted and nudged. A 503
 * (the drop rebuilding, or a stale generation) is retried with the same key, as a client does. 'refused' is
 * a Postgres refusal, told from Lua's own by the REJECTED tombstone it leaves.
 */
async function apiReserve(dropId: string, userId: string): Promise<Outcome> {
  const reservations = apiReservations(env);
  const idempotencyKey = `key_${randomUUID().replaceAll('-', '')}`;
  const request = { userId, dropId, idempotencyKey, qty: 1, traceId: randomUUID() };
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await reservations.reserve(request, env.deps.logger);
      return 'reserved';
    } catch (error) {
      if (error instanceof RetryError) {
        await sleep(50);
        continue;
      }
      if (!(error instanceof DomainError)) throw error;
      const order = await getOrder(env.db, reservationId({ userId, dropId, idempotencyKey }));
      if (order?.status === 'REJECTED') return 'refused';
      const outcome = LUA_REFUSALS[error.code];
      if (outcome === undefined) throw error;
      return outcome;
    }
  }
  throw new Error('the drop kept answering 503');
}

async function rejectedOrders(dropId: string): Promise<string[]> {
  const { rows } = await env.db.execute<{ id: string }>(
    sql`SELECT id FROM orders WHERE drop_id = ${dropId} AND status = 'REJECTED' ORDER BY id`,
  );
  return rows.map((row) => row.id);
}

describe('optimistic Redis (INV-7)', () => {
  it('is rebuilt on the second stable sample, never on one, with an alert and the drift gauge', async () => {
    const reconciler = sampling();
    const dropId = await createDrop(env, { total: 10 });
    await armDrop(env, dropId);
    const [ada = ''] = await createUsers(env.db, 1);
    await reserve(env, dropId, ada, 2);
    const { redis_gen: gen } = await inventoryOf(env, dropId);
    const drifts = await metric('fd_rebuilds_total', { reason: 'drift' });
    await env.redis.hIncrBy(dropKeys(dropId).inv, 'avail', 10);

    await reconciler.tick(running);
    expect((await inventoryOf(env, dropId)).redis_gen).toBe(gen);
    expect(await metric('fd_redis_drift_units', { drop: dropId })).toBe(10);
    expect(alertsNamed(env, 'redis_drift').filter((line) => line.dropId === dropId)).toEqual([]);

    await reconciler.tick(running);
    expect((await inventoryOf(env, dropId)).redis_gen).toBe(gen + 1);
    await expectRebuilt(dropId);
    expect(alertsNamed(env, 'redis_drift')).toContainEqual(
      expect.objectContaining({ dropId, driftUnits: 10, level: 'error' }),
    );
    expect(rebuildsOf(dropId, 'drift')).toHaveLength(1);
    expect(await metric('fd_rebuilds_total', { reason: 'drift' })).toBe(drifts + 1);

    await reconciler.tick(running);
    expect(await metric('fd_redis_drift_units', { drop: dropId })).toBe(0);
    expect((await inventoryOf(env, dropId)).redis_gen).toBe(gen + 1);
  });

  // Design §13 drift injection: Redis avail +10, a burst, Postgres refuses, tombstones, the fd_sync rebuild.
  it('a burst Postgres refuses is tombstoned and rebuilt at once through the fd_sync nudge; invariants hold', async () => {
    // Drift sampling is off past the role's first tick, so only the refusal can trigger the rebuild.
    const role = startReconciler(env.deps, {
      databaseUrl: env.url,
      identity,
      everyMs: 60_000,
      driftEveryMs: 3_600_000,
    });
    const dropId = await createDrop(env, { total: 10, limit: 2 });
    const users = await createUsers(env.db, 30);
    const refusals = await metric('fd_rebuilds_total', { reason: 'refusal' });
    try {
      await armDrop(env, dropId);
      await eventually(async () => {
        const { rows } = await env.db.execute(sql`
          SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND application_name = 'worker:reconciler:listen'
            AND query LIKE 'LISTEN%'`);
        return rows.length === 1;
      }, 5_000);
      // Let the tick LISTEN's success asked for finish: the role is leading, and idle until nudged.
      await sleep(1_000);
      const { redis_gen: gen } = await inventoryOf(env, dropId);
      await env.redis.hIncrBy(dropKeys(dropId).inv, 'avail', 10);

      const outcomes = await Promise.all(users.map((userId) => apiReserve(dropId, userId)));

      expect(outcomes.filter((o) => o === 'reserved')).toHaveLength(10);
      expect(outcomes.filter((o) => o === 'refused').length).toBeGreaterThan(0);
      expect(outcomes.filter((o) => o !== 'reserved' && o !== 'refused' && o !== 'SOLD_OUT')).toEqual([]);
      await eventually(async () => rebuildsOf(dropId, 'refusal').length > 0, 5_000);
      expect((await inventoryOf(env, dropId)).redis_gen).toBeGreaterThan(gen);
      expect(await metric('fd_rebuilds_total', { reason: 'refusal' })).toBeGreaterThan(refusals);
    } finally {
      await role.stop();
    }

    // The tombstones' holds go back the way the settlement consumer gives them back.
    const rejected = await rejectedOrders(dropId);
    expect(rejected.length).toBeGreaterThan(0);
    for (const orderId of rejected) {
      expect(await settleRedis(env.deps, orderId)).toMatchObject({ kind: 'SETTLED' });
    }
    expect(await inventoryOf(env, dropId)).toMatchObject({ total: 10, reserved: 10, sold: 0 });
    await expectRebuilt(dropId);
    const sample = await sampleDrop(env.deps, dropId);
    if (sample === undefined) throw new Error('no sample');
    expect(checkDrop(sample)).toEqual([]);
  });
});

describe('the refusal trigger', () => {
  it('rebuilds a nudged drop once per new refusal, and not again for refusals a rebuild accounted for', async () => {
    const reconciler = createReconciler(env.deps, identity, { driftEveryMs: 3_600_000 });
    await reconciler.tick(running); // the one drift round this reconciler samples
    const dropId = await createDrop(env, { total: 2 });
    await armDrop(env, dropId);
    const users = await createUsers(env.db, 4);
    await env.redis.hIncrBy(dropKeys(dropId).inv, 'avail', 2);
    for (const userId of users) await apiReserve(dropId, userId);
    expect(await rejectedOrders(dropId)).toHaveLength(2);
    const { redis_gen: gen } = await inventoryOf(env, dropId);

    reconciler.nudged(dropId);
    await reconciler.tick(running);
    expect((await inventoryOf(env, dropId)).redis_gen).toBe(gen + 1);
    expect(rebuildsOf(dropId, 'refusal')).toHaveLength(1);

    // The same refusals again (a late nudge, an uppercase id): nothing new, no rebuild.
    reconciler.nudged(dropId.toUpperCase());
    await reconciler.tick(running);
    expect((await inventoryOf(env, dropId)).redis_gen).toBe(gen + 1);

    // Wiped and nudged (NO_DROP): the structural rebuild accounts for the refusals; no second rebuild.
    await deleteDropKeys(env.redis, dropId);
    reconciler.nudged(dropId);
    await reconciler.tick(running);
    expect((await inventoryOf(env, dropId)).redis_gen).toBe(gen + 2);
    expect(rebuildsOf(dropId, 'refusal')).toHaveLength(1);
    await expectRebuilt(dropId);

    // Garbage on the channel is dropped with a warning.
    reconciler.nudged('not-a-drop');
    await reconciler.tick(running);
    expect(env.logs).toContainEqual(expect.objectContaining({ payload: 'not-a-drop', level: 'warn' }));
  });
});

describe('conservative mismatch (a leak)', () => {
  it('is rebuilt on the third quiescent sample, and only then', async () => {
    const reconciler = sampling();
    const dropId = await createDrop(env, { total: 10 });
    await armDrop(env, dropId);
    const { redis_gen: gen } = await inventoryOf(env, dropId);
    // Three units Redis keeps away from buyers that Postgres never granted.
    await env.redis.hIncrBy(dropKeys(dropId).inv, 'avail', -3);
    await env.redis.hIncrBy(dropKeys(dropId).inv, 'held', 3);

    await reconciler.tick(running);
    await reconciler.tick(running);
    expect((await inventoryOf(env, dropId)).redis_gen).toBe(gen);
    expect(await metric('fd_redis_drift_units', { drop: dropId })).toBe(-3);

    await reconciler.tick(running);
    expect((await inventoryOf(env, dropId)).redis_gen).toBe(gen + 1);
    expect(rebuildsOf(dropId, 'leak')).toHaveLength(1);
    await expectRebuilt(dropId);
  });

  it('counts Σuq ≠ Σclaimed, and starts counting over when the drop moves', async () => {
    const reconciler = sampling();
    const dropId = await createDrop(env, { total: 10, limit: 2 });
    await armDrop(env, dropId);
    const [ada = '', ben = ''] = await createUsers(env.db, 2);
    await reserve(env, dropId, ada);
    const { redis_gen: gen } = await inventoryOf(env, dropId);
    // Redis counts a unit against Ada that Postgres does not: her second unit would be refused.
    await env.redis.hIncrBy(dropKeys(dropId).uq, ada, 1);

    await reconciler.tick(running);
    await reconciler.tick(running);
    // A reservation lands: both stores move, so the mismatch is no longer known to be quiescent.
    await reserve(env, dropId, ben);
    await reconciler.tick(running);
    await reconciler.tick(running);
    expect((await inventoryOf(env, dropId)).redis_gen).toBe(gen);

    await reconciler.tick(running);
    expect((await inventoryOf(env, dropId)).redis_gen).toBe(gen + 1);
    expect(rebuildsOf(dropId, 'leak')).toHaveLength(1);
    await expectRebuilt(dropId);
    expect(Object.fromEntries((await readDropState(env.redis, dropId)).quotas)).toEqual({
      [ada]: 1,
      [ben]: 1,
    });
  });

  it('leaves a healthy drop alone, however often it is sampled', async () => {
    const reconciler = sampling();
    const dropId = await createDrop(env, { total: 10 });
    await armDrop(env, dropId);
    const [ada = ''] = await createUsers(env.db, 1);
    await reserve(env, dropId, ada);
    const { redis_gen: gen } = await inventoryOf(env, dropId);

    for (let i = 0; i < 5; i++) await reconciler.tick(running);

    expect((await inventoryOf(env, dropId)).redis_gen).toBe(gen);
    expect(await metric('fd_redis_drift_units', { drop: dropId })).toBe(0);
  });
});

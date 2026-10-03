import { readDropState, readStock, redisDropViolations } from '@flashdrop/inventory';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { healthReport } from './health';
import { createLoop, type Loop } from './loop';
import { type ReconcilerRole, startReconciler } from './reconciler';
import { sweeperLoops } from './sweeper';
import {
  armDrop,
  createDrop,
  createUsers,
  createWorkerTestEnv,
  deleteDropKeys,
  eventually,
  inventoryOf,
  lapse,
  reserve,
  testIdentityStore,
  type WorkerTestEnv,
} from './test/harness';

/*
 * The M2 demo claims (design §16), with the sweeper and reconciler roles running at their production
 * cadence against a database of this file's own: abandoned holds expire and their stock is back in Redis
 * within about 15 s through the safety net, and a wiped drop is rebuilt within seconds.
 */

let env: WorkerTestEnv;
let identity: ReturnType<typeof testIdentityStore>;
let sweeper: Loop[];
let reconciler: ReconcilerRole;

beforeAll(async () => {
  env = await createWorkerTestEnv();
  identity = testIdentityStore(env);
  sweeper = sweeperLoops(env.deps).map((spec) => createLoop(spec, env.deps.logger));
  for (const loop of sweeper) loop.start();
  reconciler = startReconciler(env.deps, { databaseUrl: env.url, identity });
});

afterAll(async () => {
  await Promise.all([...(sweeper ?? []).map((loop) => loop.stop()), reconciler?.stop()]);
  await env?.redis.del(identity.epochKey);
  await env?.close();
});

describe('the worker roles together', () => {
  it('report healthy once every loop has ticked', async () => {
    const loops = () => [...sweeper, ...reconciler.loops].map((loop) => loop.health());
    await eventually(
      async () => healthReport({ roles: ['sweeper', 'reconciler'], loops }).status === 'ok',
      5_000,
    );
  });

  it('give an abandoned hold’s stock back to Redis within about 15 s', async () => {
    const dropId = await createDrop(env, { total: 10, limit: 2 });
    await armDrop(env, dropId);
    const [ada = '', ben = ''] = await createUsers(env.db, 2);
    const holds = [await reserve(env, dropId, ada, 2), await reserve(env, dropId, ben)];
    expect(await readStock(env.redis, dropId)).toMatchObject({ avail: 7, held: 3 });

    for (const rid of holds) await lapse(env, rid);
    // Expiry within 1 s, then 10 s for the settlement consumer, then the 5 s safety net.
    const tookMs = await eventually(async () => (await readStock(env.redis, dropId))?.avail === 10, 25_000);

    expect(tookMs).toBeLessThan(17_000);
    expect(await inventoryOf(env, dropId)).toMatchObject({ reserved: 0, sold: 0 });
    const state = await readDropState(env.redis, dropId);
    expect(state.inv).toMatchObject({ avail: 10, held: 0, sold: 0 });
    expect(state.quotas.size).toBe(0);
    expect(redisDropViolations(state)).toEqual([]);
  }, 40_000);

  it('rebuild a wiped drop within seconds', async () => {
    const dropId = await createDrop(env, { total: 10 });
    await armDrop(env, dropId);
    const [user = ''] = await createUsers(env.db, 1);
    await reserve(env, dropId, user, 2);

    // FLUSHALL, as far as this drop and the reconciler's epoch go.
    await deleteDropKeys(env.redis, dropId);
    await env.redis.del(identity.epochKey);
    const tookMs = await eventually(async () => {
      const stock = await readStock(env.redis, dropId);
      return stock !== null && stock.status !== 'RECONCILING';
    }, 10_000);

    expect(tookMs).toBeLessThan(5_000);
    const state = await readDropState(env.redis, dropId);
    expect(state.inv).toMatchObject({ avail: 8, held: 2, gen: (await inventoryOf(env, dropId)).redis_gen });
    expect(redisDropViolations(state)).toEqual([]);
    // Recorded once every tracked drop is rebuilt; a drop the scheduler held a moment ago follows a tick later.
    await eventually(async () => (await env.redis.get(identity.epochKey)) !== null, 5_000);
  });
});

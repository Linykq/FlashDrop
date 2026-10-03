import { randomUUID } from 'node:crypto';
import { createLogger, loadEnv, PostgresEnv, RedisEnv } from '@flashdrop/config';
import {
  createDb,
  createPool,
  type Db,
  dropInventory,
  drops,
  migrateDatabase,
  POOL_PROFILES,
  products,
  recordReservation,
  sql,
  systemState,
  users,
} from '@flashdrop/db';
import type { DropStatus } from '@flashdrop/domain';
import { requestFingerprint, reservationId } from '@flashdrop/domain/identity';
import {
  connectCommandClient,
  createSyncNudger,
  DROP_LOCK_POOL_PROFILE,
  dropKeys,
  type FlashdropRedis,
  fdReserve,
  readLiveRedisIdentity,
  readStoredRedisIdentity,
  syncDropFromPostgres,
} from '@flashdrop/inventory';
import type pg from 'pg';
import type { WorkerDeps } from '../deps';
import { WORKER_POOL_PROFILE } from '../postgres';
import type { RedisIdentityStore } from '../reconciler/identity';

/*
 * Integration-test harness (design §13). Each test file gets a throwaway database on the shared Compose
 * Postgres, so the loops' tracked set, quarantine and loop locks see only that file's drops, while Redis is
 * the shared one: every drop has fresh ids, its keys are deleted afterwards, and nothing here ever flushes
 * Redis or touches the stack's `fd:epoch` (see `testIdentityStore`).
 */

export interface LogLine {
  readonly level: string;
  readonly msg: string;
  readonly [field: string]: unknown;
}

export interface WorkerTestEnv {
  readonly url: string;
  readonly db: Db;
  readonly pool: pg.Pool;
  readonly redis: FlashdropRedis;
  readonly deps: WorkerDeps;
  /** Every line the worker code logged, parsed. */
  readonly logs: LogLine[];
  /** Keys of the drops this file created, deleted by `close`. */
  readonly dropIds: string[];
  close(): Promise<void>;
}

const quiet = { warn: () => undefined, info: () => undefined };

export async function createWorkerTestEnv(): Promise<WorkerTestEnv> {
  const { DATABASE_URL, REDIS_URL } = loadEnv([PostgresEnv, RedisEnv]);
  const name = `fd_test_worker_${randomUUID().replaceAll('-', '')}`;
  const server = createPool({
    connectionString: DATABASE_URL,
    logger: quiet,
    ...POOL_PROFILES.maintenance,
    max: 1,
  });
  await server.query(`CREATE DATABASE ${name}`);
  const url = new URL(DATABASE_URL);
  url.pathname = `/${name}`;

  const maintenance = createPool({ connectionString: url.href, logger: quiet, ...POOL_PROFILES.maintenance });
  await migrateDatabase(maintenance);
  await maintenance.end();

  const logs: LogLine[] = [];
  const logger = createLogger(
    { name: 'worker-test', level: 'debug' },
    { write: (line: string) => void logs.push(JSON.parse(line) as LogLine) },
  );
  const pool = createPool({ connectionString: url.href, logger, ...WORKER_POOL_PROFILE, max: 10 });
  const lockPool = createPool({ connectionString: url.href, logger, ...DROP_LOCK_POOL_PROFILE, max: 6 });
  const db = createDb(pool);
  // The tests' own Redis (vitest.config.ts), so this tree's library replaces any other copy of its version.
  const redis = await connectCommandClient({
    url: REDIS_URL,
    name: 'worker-test',
    logger,
    library: { replaceSameVersion: true },
  });
  const dropIds: string[] = [];

  return {
    url: url.href,
    db,
    pool,
    redis,
    deps: {
      db,
      redis,
      lock: { pool: lockPool, logger },
      nudger: createSyncNudger({ db, logger, debounceMs: 0 }),
      logger,
    },
    logs,
    dropIds,
    async close() {
      for (const dropId of dropIds) await deleteDropKeys(redis, dropId);
      await redis.close();
      await Promise.all([pool.end(), lockPool.end()]);
      await server.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await server.end();
    },
  };
}

export async function deleteDropKeys(redis: FlashdropRedis, dropId: string): Promise<void> {
  const k = dropKeys(dropId);
  await redis.del([k.inv, k.rsv, k.uq, k.exp]);
}

export async function createUsers(db: Db, count: number): Promise<string[]> {
  const ids = Array.from({ length: count }, () => randomUUID());
  await db
    .insert(users)
    .values(ids.map((id) => ({ id, email: `${id}@worker.test`, displayName: 'Worker test' })));
  return ids;
}

export interface DropOptions {
  readonly total?: number;
  readonly limit?: number;
  readonly status?: DropStatus;
  /** Seconds from now. Default: started a minute ago, ends in an hour. */
  readonly startsIn?: number;
  readonly endsIn?: number;
  readonly holdSeconds?: number;
}

/** A product, a drop of it (LIVE inside its window by default) and its inventory. Not armed yet. */
export async function createDrop(env: WorkerTestEnv, options: DropOptions = {}): Promise<string> {
  const productId = randomUUID();
  const dropId = randomUUID();
  await env.db.insert(products).values({
    id: productId,
    slug: `worker-test-${productId}`,
    title: 'Worker test product',
    description: 'Created by a worker integration test.',
    imageKeys: [],
    status: 'PUBLISHED',
  });
  await env.db.insert(drops).values({
    id: dropId,
    productId,
    startsAt: sql`now() + make_interval(secs => ${options.startsIn ?? -60})`,
    endsAt: sql`now() + make_interval(secs => ${options.endsIn ?? 3_600})`,
    priceCents: 1_999,
    perUserLimit: options.limit ?? 2,
    holdSeconds: options.holdSeconds ?? 120,
    status: options.status ?? 'LIVE',
  });
  await env.db.insert(dropInventory).values({ dropId, total: options.total ?? 10 });
  env.dropIds.push(dropId);
  return dropId;
}

/** Arms (or re-syncs) a drop exactly as admin `arm` and the seed do. */
export async function armDrop(env: WorkerTestEnv, dropId: string): Promise<void> {
  const outcome = await syncDropFromPostgres(env.deps, dropId);
  if (outcome.kind !== 'REBUILT') throw new Error(`arming ${dropId} answered ${outcome.kind}`);
}

/** A reservation as the API makes it (§5.2): `fd_reserve`, then the Postgres transaction under its gen. */
export async function reserve(env: WorkerTestEnv, dropId: string, userId: string, qty = 1): Promise<string> {
  const hold = await admit(env, dropId, userId, qty);
  const outcome = await recordReservation(env.db, {
    id: hold.rid,
    userId,
    dropId,
    qty,
    idempotencyKey: hold.idempotencyKey,
    requestHash: requestFingerprint({ dropId, qty }),
    gen: hold.gen,
  });
  if (outcome.kind !== 'created') throw new Error(`recordReservation answered ${JSON.stringify(outcome)}`);
  return hold.rid;
}

/** Only the Redis half of a reservation: what an API that crashed after Lua leaves behind (an orphan). */
export async function holdOnly(env: WorkerTestEnv, dropId: string, userId: string, qty = 1): Promise<string> {
  return (await admit(env, dropId, userId, qty)).rid;
}

async function admit(env: WorkerTestEnv, dropId: string, userId: string, qty: number) {
  const idempotencyKey = `key_${randomUUID().replaceAll('-', '')}`;
  const rid = reservationId({ userId, dropId, idempotencyKey });
  const admitted = await fdReserve(env.redis, {
    dropId,
    rid,
    userId,
    qty,
    fingerprint: requestFingerprint({ dropId, qty }),
    idempotencyKey,
  });
  if (admitted.kind !== 'RESERVED') throw new Error(`fd_reserve answered ${admitted.kind}`);
  return { rid, idempotencyKey, gen: admitted.gen };
}

/** Makes Redis treat the hold as past its grace now, as if `holdMs + 30 s` had elapsed. */
export async function ageHold(env: WorkerTestEnv, dropId: string, rid: string): Promise<void> {
  await env.redis.zAdd(dropKeys(dropId).exp, { score: 1, value: rid }, { condition: 'XX' });
}

/** Moves the order's Postgres deadline into the past, as if its hold had run out. */
export async function lapse(env: WorkerTestEnv, rid: string): Promise<void> {
  await env.db.execute(sql`UPDATE orders SET expires_at = now() - interval '1 second' WHERE id = ${rid}`);
}

/** Postgres's stock of record. */
export async function inventoryOf(env: WorkerTestEnv, dropId: string) {
  const { rows } = await env.db.execute<{ total: number; reserved: number; sold: number; redis_gen: number }>(
    sql`SELECT total, reserved, sold, redis_gen FROM drop_inventory WHERE drop_id = ${dropId}`,
  );
  const [row] = rows;
  if (row === undefined) throw new Error(`no inventory for ${dropId}`);
  return row;
}

export async function claimedBy(env: WorkerTestEnv, dropId: string, userId: string): Promise<number> {
  const { rows } = await env.db.execute<{ claimed: number }>(
    sql`SELECT claimed FROM user_drop_quota WHERE drop_id = ${dropId} AND user_id = ${userId}`,
  );
  return rows[0]?.claimed ?? 0;
}

export async function eventTypesOf(env: WorkerTestEnv, orderId: string): Promise<string[]> {
  const { rows } = await env.db.execute<{ type: string }>(
    sql`SELECT event_type AS type FROM outbox WHERE payload->>'orderId' = ${orderId} ORDER BY id`,
  );
  return rows.map((row) => row.type);
}

/** Lines logged with `alert: true` and the given name. */
export function alertsNamed(env: WorkerTestEnv, name: string): LogLine[] {
  return env.logs.filter((line) => line.alert === true && line.alertName === name);
}

/**
 * The reconciler's identity store, with an epoch key of the test's own and the file's own database for
 * `system_state`: the stack's `fd:epoch` is never read or written, so the running stack never sees a wipe.
 * `libraryLoaded` can be forced to false once, to simulate FUNCTION FLUSH without flushing.
 */
export function testIdentityStore(env: WorkerTestEnv): RedisIdentityStore & {
  readonly epochKey: string;
  forgetLibraryOnce(): void;
} {
  const epochKey = `fd:test:epoch:${randomUUID()}`;
  let libraryLost = false;
  return {
    epochKey,
    forgetLibraryOnce() {
      libraryLost = true;
    },
    async readLive() {
      const live = await readLiveRedisIdentity(env.redis);
      const libraryLoaded = live.libraryLoaded && !libraryLost;
      libraryLost = false;
      return { ...live, epoch: await env.redis.get(epochKey), libraryLoaded };
    },
    readStored: () => readStoredRedisIdentity(env.db),
    async commit(runId) {
      const epoch = randomUUID();
      await env.redis.set(epochKey, epoch, { expiration: { type: 'PX', value: 600_000 } });
      await env.db
        .insert(systemState)
        .values([
          { key: 'redis_epoch', value: epoch },
          { key: 'redis_run_id', value: runId },
        ])
        .onConflictDoUpdate({ target: systemState.key, set: { value: sql`excluded.value` } });
    },
  };
}

/** Polls `check` until it returns true, failing after `timeoutMs`. Returns the time it took. */
export async function eventually(check: () => Promise<boolean>, timeoutMs: number): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return Date.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`condition not met within ${timeoutMs} ms`);
}

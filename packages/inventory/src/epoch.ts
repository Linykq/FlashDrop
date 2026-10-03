import { randomUUID } from 'node:crypto';
import { type Db, inArray, sql, systemState } from '@flashdrop/db';
import { z } from 'zod';
import type { FlashdropRedis } from './client';
import { REDIS_DEADLINE_MS, withDeadline } from './deadline';
import { EPOCH_KEY } from './keys';
import { libraryState } from './library';

/*
 * Keyspace-loss detection for the reconciler (design §4.7, checked every 2 s):
 *   - `fd:epoch` differs from `system_state.redis_epoch`: a FLUSHALL or a fresh volume (same process);
 *   - INFO `run_id` differs from `system_state.redis_run_id`: a restart, which may have lost the AOF tail;
 *   - the `flashdrop` library is missing: FUNCTION FLUSH or a fresh Redis.
 * Any of them means: reload the library, rebuild every tracked drop (ENDED ones inside `retainAt`
 * included), then `commitRedisIdentity`.
 */

const STATE_KEYS = { epoch: 'redis_epoch', runId: 'redis_run_id' } as const;

/** What Redis says about itself now. */
export interface LiveRedisIdentity {
  readonly epoch: string | null;
  readonly runId: string;
  readonly libraryLoaded: boolean;
  /**
   * An older version of the library is loaded (an older image or working tree loaded it): reload it. Not
   * a keyspace loss, since the data is intact.
   */
  readonly libraryOutdated: boolean;
  /**
   * This version with other code is loaded (a working tree edited without a version bump loaded it). It is
   * kept (`loadLibrary`), so only a warning: the data is intact.
   */
  readonly libraryDiffers: boolean;
}

/** What the last full rebuild recorded in `system_state`; null before the first one. */
export interface StoredRedisIdentity {
  readonly epoch: string | null;
  readonly runId: string | null;
}

export type KeyspaceLoss = 'restart' | 'wipe' | 'library';

/** For tests, which must never read or write the `fd:epoch` of the stack sharing their Redis. */
export interface EpochOptions {
  readonly epochKey?: string;
}

/** Bounded by `REDIS_DEADLINE_MS`, like every Redis read of the reconciler. */
export async function readLiveRedisIdentity(
  redis: FlashdropRedis,
  options: EpochOptions = {},
): Promise<LiveRedisIdentity> {
  const [epoch, info, library] = await withDeadline('identity read', REDIS_DEADLINE_MS, () =>
    Promise.all([redis.get(options.epochKey ?? EPOCH_KEY), redis.info('server'), libraryState(redis)]),
  );
  const runId = /^run_id:([0-9a-f]+)\r?$/m.exec(String(info))?.[1];
  if (runId === undefined) throw new Error('INFO server has no run_id');
  return {
    epoch,
    runId,
    libraryLoaded: library !== 'MISSING',
    libraryOutdated: library === 'OLDER',
    libraryDiffers: library === 'CURRENT_DIFFERS',
  };
}

export async function readStoredRedisIdentity(db: Db): Promise<StoredRedisIdentity> {
  const rows = await db
    .select({ key: systemState.key, value: systemState.value })
    .from(systemState)
    .where(inArray(systemState.key, Object.values(STATE_KEYS)));
  const value = (key: string) =>
    z
      .string()
      .nullable()
      .parse(rows.find((row) => row.key === key)?.value ?? null);
  return { epoch: value(STATE_KEYS.epoch), runId: value(STATE_KEYS.runId) };
}

/**
 * Why Redis must be rebuilt from Postgres, or null if nothing was lost. A restart is reported first: it is
 * the case where acknowledged writes may be gone even though the keys look intact.
 */
export function keyspaceLoss(live: LiveRedisIdentity, stored: StoredRedisIdentity): KeyspaceLoss | null {
  if (live.runId !== stored.runId) return 'restart';
  if (live.epoch === null || live.epoch !== stored.epoch) return 'wipe';
  if (!live.libraryLoaded) return 'library';
  return null;
}

/**
 * Records a completed full rebuild: a new epoch in Redis, then the epoch and `runId` in Postgres. Pass the
 * `runId` read *before* the rebuild started, so a restart during the rebuild still differs next time. A
 * crash between the two writes leaves them different, which only causes one more full rebuild.
 */
export async function commitRedisIdentity(
  deps: { readonly redis: FlashdropRedis; readonly db: Db },
  runId: string,
  options: EpochOptions = {},
): Promise<string> {
  const epoch = randomUUID();
  await withDeadline('epoch write', REDIS_DEADLINE_MS, () =>
    deps.redis.set(options.epochKey ?? EPOCH_KEY, epoch),
  );
  await deps.db
    .insert(systemState)
    .values([
      { key: STATE_KEYS.epoch, value: epoch },
      { key: STATE_KEYS.runId, value: runId },
    ])
    .onConflictDoUpdate({ target: systemState.key, set: { value: sql`excluded.value` } });
  return epoch;
}

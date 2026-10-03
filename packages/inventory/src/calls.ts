import type { RebuildSnapshot } from '@flashdrop/db';
import type { FlashdropRedis } from './client';
import { BULK_DEADLINE_MS, REDIS_DEADLINE_MS, withDeadline } from './deadline';
import type { ReserveInput } from './functions';
import { withLibrary } from './library';
import type {
  RateLimitHit,
  RebuildResult,
  RedisDropStatus,
  ReserveResult,
  SetStatusResult,
  SettleResult,
} from './replies';

/*
 * One typed call per Function of the library (design §4.2), each reloading the library if Redis lost it
 * and bounded by a deadline (`RedisDeadlineError`, a transient error: 503 `RETRY` in the api, retry next
 * tick in the worker). Results are discriminated unions on `kind`; transport failures reject (see
 * `isTransientRedisError`). A call that loses the race to its deadline may still run in Redis later; the
 * Functions are idempotent by their identity (rid, order id, snapshot gen), so the caller's retry, or the
 * next tick, converges.
 */

function fcall<T>(redis: FlashdropRedis, name: string, ms: number, call: () => Promise<T>): Promise<T> {
  return withDeadline(name, ms, () => withLibrary(redis, call));
}

/** Admission: checks window, limit and stock and takes a hold, atomically with its idempotency record. */
export function fdReserve(redis: FlashdropRedis, input: ReserveInput): Promise<ReserveResult> {
  return fcall(redis, 'fd_reserve', REDIS_DEADLINE_MS, () => redis.flashdrop.fd_reserve(input));
}

/** HELD → COMMITTED, after Postgres committed PAID. */
export function fdConfirm(redis: FlashdropRedis, dropId: string, rid: string): Promise<SettleResult> {
  return fcall(redis, 'fd_confirm', REDIS_DEADLINE_MS, () => redis.flashdrop.fd_confirm(dropId, rid));
}

/** HELD → RELEASED, stock and quota back, after Postgres committed an unpaid terminal status. */
export function fdRelease(redis: FlashdropRedis, dropId: string, rid: string): Promise<SettleResult> {
  return fcall(redis, 'fd_release', REDIS_DEADLINE_MS, () => redis.flashdrop.fd_release(dropId, rid));
}

/**
 * Atomically replaces the drop's Redis state with `snapshot` (`readRebuildSnapshot`); `STALE` unless its gen
 * is newer than Redis's.
 */
export function fdRebuild(
  redis: FlashdropRedis,
  dropId: string,
  snapshot: RebuildSnapshot,
): Promise<RebuildResult> {
  return fcall(redis, 'fd_rebuild', BULK_DEADLINE_MS, () => redis.flashdrop.fd_rebuild(dropId, snapshot));
}

/**
 * Writes the drop status. RECONCILING always succeeds and, if the keys are gone, creates a complete
 * fail-closed hash; any other status answers `NO_DROP` for a missing hash and `RETRY` while RECONCILING.
 * Callers hold the drop lock (§4.7).
 */
export function fdSetStatus(
  redis: FlashdropRedis,
  dropId: string,
  status: RedisDropStatus,
): Promise<SetStatusResult> {
  return fcall(redis, 'fd_set_status', REDIS_DEADLINE_MS, () =>
    redis.flashdrop.fd_set_status(dropId, status),
  );
}

/** One hit on a fixed-window counter (`rateLimitKey`), for the custom `@fastify/rate-limit` store (§11). */
export function fdRateLimitHit(redis: FlashdropRedis, key: string, windowMs: number): Promise<RateLimitHit> {
  return fcall(redis, 'fd_rl_hit', REDIS_DEADLINE_MS, () => redis.flashdrop.fd_rl_hit(key, windowMs));
}

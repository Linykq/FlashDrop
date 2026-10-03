import type { Logger } from '@flashdrop/config';
import { type Db, drops, eq, fenceRedisGeneration, readRebuildSnapshot } from '@flashdrop/db';
import { BugError, type PublicDropStatus } from '@flashdrop/domain';
import { fdRebuild, fdSetStatus } from './calls';
import type { FlashdropRedis } from './client';
import { assertDropLockHeld, type DropLockDeps, type HeldDropLock, withDropLock } from './drop-lock';

/*
 * `syncDropFromPostgres` (design §4.7): the single code path that arms a drop and recovers it. Under the drop
 * lock:
 *   1. fd_set_status RECONCILING. Every Function on the drop now answers RETRY (the API's 503, the
 *      consumers' pause). On a first arm or after a wipe this creates a complete fail-closed hash (gen -1,
 *      no stock). `inv` is never deleted, so the guard cannot vanish mid-rebuild.
 *   2. The fence (`fenceRedisGeneration`): redis_gen + 1, committed. Its row lock waits for reserve
 *      transactions that already passed `redis_gen = $gen`; any later one carries the old gen and is refused
 *      (STALE_GEN, 503, retry with the same key). The rebuild never counted it, and fd_rebuild replaces the
 *      whole rsv hash, so nothing has to be released and the retry starts clean.
 *   3. One REPEATABLE READ snapshot of the drop, its inventory, quotas and every order
 *      (`readRebuildSnapshot`, already in the shape fd_rebuild validates).
 *   4. One atomic fd_rebuild, which refuses (STALE) a generation that is not newer than Redis's, so a
 *      zombie whose lock session died cannot overwrite a newer rebuild.
 *   5. Unlock (withDropLock).
 * Settlement during a rebuild cannot double-apply: an order settled before the snapshot is rebuilt terminal
 * and the later call is a NOOP; one settled after it is rebuilt HELD and the later call applies it.
 */

export interface SyncDeps {
  /** The caller's own pool. The fence and the snapshot are short transactions on it. */
  readonly db: Db;
  readonly redis: FlashdropRedis;
  readonly logger: Pick<Logger, 'info' | 'warn'>;
}

export type SyncOutcome =
  | {
      readonly kind: 'REBUILT';
      readonly gen: number;
      readonly status: PublicDropStatus;
      /** Orders written as `rsv` entries. */
      readonly orders: number;
    }
  /** Redis already holds a generation at least as new; only a zombie sync can lose this race. */
  | { readonly kind: 'STALE'; readonly gen: number }
  | { readonly kind: 'UNKNOWN_DROP' }
  /** DRAFT drops are not in Redis; arming moves them to SCHEDULED first. */
  | { readonly kind: 'NOT_ARMED' };

/**
 * Arms or rebuilds a drop, waiting up to `timeoutMs` for its lock (`DomainError('DROP_BUSY')` after).
 * For admin arm and reconcile, the seed, and `POST /test/drops`.
 */
export function syncDropFromPostgres(
  deps: SyncDeps & { readonly lock: DropLockDeps },
  dropId: string,
  options: { readonly timeoutMs?: number } = {},
): Promise<SyncOutcome> {
  return withDropLock(deps.lock, dropId, (lock) => rebuildDrop(deps, lock), options);
}

/**
 * Steps 1–4 for a caller that already holds the drop lock: the reconciler after its structural check, and
 * an admin status change that met RETRY or NO_DROP. If the run fails midway the drop stays RECONCILING
 * (fail closed) until the next sync; the reconciler finds it within seconds.
 */
export async function rebuildDrop(deps: SyncDeps, lock: HeldDropLock): Promise<SyncOutcome> {
  assertDropLockHeld(lock);
  const { dropId } = lock;
  // Every status change takes this lock, so the status read here holds for the whole rebuild.
  const [drop] = await deps.db.select({ status: drops.status }).from(drops).where(eq(drops.id, dropId));
  if (drop === undefined) return { kind: 'UNKNOWN_DROP' };
  if (drop.status === 'DRAFT') return { kind: 'NOT_ARMED' };

  const reconciling = await fdSetStatus(deps.redis, dropId, 'RECONCILING');
  if (reconciling.kind !== 'OK') throw new BugError(`fd_set_status RECONCILING answered ${reconciling.kind}`);

  const fenced = await fenceRedisGeneration(deps.db, dropId);
  if (fenced === undefined) throw new BugError(`armed drop ${dropId} has no drop_inventory row`);
  const snapshot = await readRebuildSnapshot(deps.db, dropId);
  if (snapshot === undefined) throw new BugError(`drop ${dropId} vanished or went DRAFT under its lock`);
  // A different gen means another session bumped it after this one did: a zombie sync whose lock session
  // died while its process ran on. The snapshot's own gen is consistent with the snapshot (every reserve
  // that passed an older gen committed before that bump), so it is the one to rebuild with.
  if (snapshot.gen !== fenced) {
    deps.logger.warn({ dropId, fenced, gen: snapshot.gen }, 'redis_gen moved during a rebuild');
  }

  assertDropLockHeld(lock);
  const result = await fdRebuild(deps.redis, dropId, snapshot);
  const { gen, meta } = snapshot;
  switch (result.kind) {
    case 'OK':
      deps.logger.info({ dropId, gen, status: meta.status }, 'drop rebuilt in redis');
      return { kind: 'REBUILT', gen, status: meta.status, orders: snapshot.entries.length };
    case 'STALE':
      deps.logger.warn({ dropId, gen }, 'stale rebuild refused by redis');
      return { kind: 'STALE', gen };
    case 'BAD_SNAPSHOT':
      throw new BugError(`fd_rebuild refused the snapshot of drop ${dropId}`);
  }
}

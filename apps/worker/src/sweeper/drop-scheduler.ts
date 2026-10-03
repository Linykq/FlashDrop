import {
  applyDueDropTransition,
  type DropSchedule,
  drops,
  eq,
  listDropSchedule,
  pgErrorOf,
} from '@flashdrop/db';
import { BugError, PUBLIC_DROP_STATUSES } from '@flashdrop/domain';
import {
  assertDropLockHeld,
  dropKeys,
  type FlashdropRedis,
  fdSetStatus,
  type HeldDropLock,
  REDIS_DEADLINE_MS,
  REDIS_DROP_STATUSES,
  type RedisDropStatus,
  readStock,
  tryWithDropLock,
  withDeadline,
} from '@flashdrop/inventory';
import { z } from 'zod';
import type { WorkerDeps } from '../deps';
import { isTransientError } from '../loop';
import { withLoopLock } from '../postgres';

/*
 * `drop-scheduler` (design §4.6, every second), level-triggered: it acts on what is true now, so a missed
 * tick, a crash or a lost status write is repaired by the next tick. Per tracked drop:
 *   1. apply the transition that is due in Postgres: SCHEDULED -> LIVE at `starts_at`, LIVE or PAUSED ->
 *      ENDED at `ends_at`;
 *   2. compare the Redis status with Postgres and write it (`fd_set_status`) if they differ, unless the drop
 *      is RECONCILING: only `fd_rebuild` ends that, with the status from its own snapshot.
 *
 * Both are first checked without any lock: one read of the tracked set with a "due" flag computed by
 * Postgres, and one pipelined round trip for every Redis status. Only a drop with work takes its drop lock
 * (a busy drop is skipped this tick) and re-checks under it. An idle tick therefore writes nothing and
 * locks nothing, whatever the number of tracked drops, and never queues behind the reserve transactions of
 * a hot drop (§3).
 *
 * Lua admits on time alone once a drop is SCHEDULED or LIVE and inside its window, so an armed drop opens
 * to the millisecond whatever this loop does; the flip to LIVE matters only to Postgres and the UI.
 *
 * Lock order: the drop lock is taken while this tick holds nothing but its loop lock (an advisory lock that
 * never waits), and the transition's row lock on `drops` is taken under it, as every writer of a drop's
 * status does (§4.7).
 */

const DropStatusRow = z.object({ status: z.enum(PUBLIC_DROP_STATUSES) });
const RedisStatus = z.enum(REDIS_DROP_STATUSES);

/** What Redis holds as the drop's status; `MALFORMED` is left to the locked path, which reports it. */
type RedisStatusRead = RedisDropStatus | 'MISSING' | 'MALFORMED';

async function readRedisStatus(redis: FlashdropRedis, dropId: string): Promise<RedisStatusRead> {
  // The same "no drop" test as the Functions' gate: no status or no gen.
  const [status, gen] = await withDeadline('status read', REDIS_DEADLINE_MS, () =>
    redis.hmGet(dropKeys(dropId).inv, ['status', 'gen']),
  );
  if (status == null || gen == null) return 'MISSING';
  const parsed = RedisStatus.safeParse(status);
  return parsed.success ? parsed.data : 'MALFORMED';
}

/** Whether the drop needs its lock this tick: a due transition, or a Redis status to repair. */
function hasWork(drop: DropSchedule, redis: RedisStatusRead): boolean {
  return drop.transitionDue || (redis !== drop.status && redis !== 'RECONCILING' && redis !== 'MISSING');
}

export async function dropScheduler(deps: WorkerDeps, signal: AbortSignal): Promise<void> {
  await withLoopLock(deps.db, 'drop-scheduler', async () => {
    const schedule = await listDropSchedule(deps.db);
    // node-redis pipelines concurrent commands: one round trip for all of them.
    const statuses = await Promise.all(schedule.map((drop) => readRedisStatus(deps.redis, drop.id)));
    for (const [i, drop] of schedule.entries()) {
      if (signal.aborted) return;
      const redisStatus = statuses[i] ?? 'MISSING';
      if (!hasWork(drop, redisStatus)) {
        // Redis has lost the drop: the reconciler rebuilds it, with the Postgres status, from Postgres.
        if (redisStatus === 'MISSING') await deps.nudger.nudge(drop.id);
        continue;
      }
      try {
        await tryWithDropLock(deps.lock, drop.id, (lock) => scheduleDrop(deps, lock));
      } catch (err) {
        // Another writer holds the drops row (lock_timeout): skip the drop, the next tick retries it.
        if (pgErrorOf(err)?.code === '55P03') {
          deps.logger.warn({ err, dropId: drop.id }, 'drop row busy; scheduling it next tick');
          continue;
        }
        // One broken drop must not starve the others; an outage ends the tick for all of them.
        if (isTransientError(err)) throw err;
        deps.logger.error({ err, dropId: drop.id }, 'drop scheduling failed');
      }
    }
  });
}

async function scheduleDrop(deps: WorkerDeps, lock: HeldDropLock): Promise<void> {
  const { dropId } = lock;
  const log = deps.logger.child({ dropId });
  const change = await applyDueDropTransition(deps.db, dropId);
  if (change !== undefined) {
    log.info({ from: change.from, to: change.to }, 'drop status changed');
    // TODO(M5): publish fd:ch:room:<roomId> (the WebSocket protocol lands in M5) and POST
    // WEB_INTERNAL_URL/_internal/revalidate for tag `drops` once web serves that route (§4.6, §8.1).
  }

  // Re-read under the lock: the unlocked pre-check is stale, and an admin action may have run in between.
  const [row] = await deps.db.select({ status: drops.status }).from(drops).where(eq(drops.id, dropId));
  const parsed = DropStatusRow.safeParse(row);
  if (!parsed.success) throw new BugError(`tracked drop ${dropId} is no longer armed`);
  const { status } = parsed.data;

  const stock = await readStock(deps.redis, dropId);
  if (stock === null) {
    // Redis has lost the drop: the reconciler rebuilds it, with this status, from Postgres.
    await deps.nudger.nudge(dropId);
    return;
  }
  if (stock.status === status || stock.status === 'RECONCILING') return;

  // A lock lost with its session may already have a new holder rebuilding the drop: stop writing.
  assertDropLockHeld(lock);
  const written = await fdSetStatus(deps.redis, dropId, status);
  switch (written.kind) {
    case 'OK':
    case 'NOOP':
      log.info({ from: stock.status, to: status }, 'redis drop status set from postgres');
      return;
    // The hash vanished or went RECONCILING since the read: only a rebuild can fix it now.
    case 'NO_DROP':
    case 'RETRY':
      await deps.nudger.nudge(dropId);
      return;
    case 'BAD_STATUS':
      throw new BugError(`fd_set_status refused ${status}`);
  }
}

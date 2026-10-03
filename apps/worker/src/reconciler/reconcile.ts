import type { Logger } from '@flashdrop/config';
import { dropInventory, eq, listTrackedDrops, type TrackedDrop } from '@flashdrop/db';
import { type AlertName, alert, BugError } from '@flashdrop/domain';
import {
  BULK_DEADLINE_MS,
  dropKeys,
  type HeldDropLock,
  keyspaceLoss,
  loadLibrary,
  REDIS_DEADLINE_MS,
  readStock,
  rebuildDrop,
  type StructuralIssue,
  type SyncOutcome,
  structuralIssue,
  tryWithDropLock,
  withDeadline,
} from '@flashdrop/inventory';
import { z } from 'zod';
import type { WorkerDeps } from '../deps';
import { isTransientError } from '../loop';
import type { RedisIdentityStore } from './identity';

/*
 * The reconciler's checks (design §4.7), run by the leader every 2 s and at once on `NOTIFY fd_sync`. Every
 * check reads the tracked set from Postgres, never from Redis, so a wipe cannot hide a drop from the loop
 * that repairs it.
 *
 *   1. Keyspace loss: `fd:epoch` differs from `system_state` (FLUSHALL, a fresh volume), INFO `run_id`
 *      differs (a restart, which may have lost the AOF tail), or the library is gone. Reload the library,
 *      rebuild every tracked drop (ENDED ones inside `retainAt` too: their idempotency records and last
 *      settlements must come back), then record the new identity. Open drops come first, so a LIVE drop is
 *      selling again before the ENDED ones are restored. An older library version (an older image or
 *      working tree loaded it) is only reloaded: the data is intact.
 *   2. Structure, per tracked drop, under its drop lock (skipped if busy): `inv` missing, RECONCILING (we hold
 *      the lock, so no live rebuild exists and its holder died), or a generation other than Postgres's.
 *      Holding the lock also keeps the Redis and Postgres reads consistent: no sync can start or finish
 *      between them.
 *
 * A drop RECONCILING for more than 30 s raises an alert (§12): `slow_rebuild` when another session holds
 * its lock (that holder is alive, or the lock would have vanished with it), `rebuild_failed` when this one
 * holds it and the rebuild keeps failing. Either way every reserve on the drop answers 503 meanwhile.
 *
 * Rebuild logs carry `reason` (restart, wipe, library, structural): the `fd_rebuilds_total{reason}` series.
 */

/** RECONCILING for longer than this is an alert (§4.7, §12). */
const RECONCILING_ALERT_MS = 30_000;
/** At most one such alert per drop and name this often (the design's 10 s check). */
const RECONCILING_ALERT_EVERY_MS = 10_000;

const ReconcilingFields = z.tuple([z.string().nullable(), z.string().nullable()]);

export interface Reconciler {
  tick(signal: AbortSignal): Promise<void>;
}

/** ENDED drops last; otherwise the tracked set's order (by `starts_at`). */
function openDropsFirst(tracked: readonly TrackedDrop[]): TrackedDrop[] {
  return [...tracked].sort((a, b) => Number(a.status === 'ENDED') - Number(b.status === 'ENDED'));
}

export function createReconciler(deps: WorkerDeps, identity: RedisIdentityStore): Reconciler {
  const lastReconcilingAlert = new Map<string, number>();
  let warnedLibraryDiffers = false;
  /**
   * The full rebuild in progress: one loss of one Redis (reason, run_id, epoch) and the drops already
   * rebuilt for it. A busy or failing drop is retried on the next tick without rebuilding the others again
   * (each rebuild costs its drop 1–3 s of 503s), and the identity is recorded only once every tracked drop
   * has been rebuilt.
   */
  let recovery: { readonly loss: string; readonly rebuilt: Set<string> } | undefined;

  const reloadLibrary = () => withDeadline('library load', BULK_DEADLINE_MS, () => loadLibrary(deps.redis));

  async function recoverKeyspace(signal: AbortSignal): Promise<void> {
    const [live, stored] = await Promise.all([identity.readLive(), identity.readStored()]);
    if (live.libraryOutdated) {
      // An older image or working tree loaded its library over ours. The data is intact: reload only.
      deps.logger.warn('an older flashdrop library is loaded; replacing it');
      await reloadLibrary();
    }
    // Same version, other code: kept, never replaced under the processes that loaded it (`loadLibrary`).
    if (live.libraryDiffers !== warnedLibraryDiffers) {
      warnedLibraryDiffers = live.libraryDiffers;
      if (live.libraryDiffers) {
        deps.logger.warn('redis holds other code under this flashdrop library version; keeping it');
      }
    }
    const reason = keyspaceLoss(live, stored);
    if (reason === null) {
      recovery = undefined;
      return;
    }
    const loss = `${reason}:${live.runId}:${live.epoch ?? ''}`;
    if (recovery?.loss !== loss) {
      recovery = { loss, rebuilt: new Set() };
      deps.logger.warn(
        { reason, runId: live.runId, storedRunId: stored.runId, libraryLoaded: live.libraryLoaded },
        'redis keyspace loss; rebuilding every tracked drop',
      );
    }
    if (!live.libraryLoaded) await reloadLibrary();

    const tracked = await listTrackedDrops(deps.db);
    let pending = 0;
    for (const drop of openDropsFirst(tracked)) {
      // Stopping halfway leaves the identity unrecorded: the next leader starts the rebuild over.
      if (signal.aborted) return;
      if (recovery.rebuilt.has(drop.id)) continue;
      const log = deps.logger.child({ dropId: drop.id });
      try {
        // A busy drop (an admin sync or the scheduler holds it) is left for the next tick.
        const result = await tryWithDropLock(deps.lock, drop.id, (lock) => rebuildDrop(deps, lock));
        if (result.acquired) {
          logRebuild(log, reason, result.value);
          recovery.rebuilt.add(drop.id);
        } else {
          pending++;
        }
      } catch (err) {
        await alertIfReconcilingTooLong(drop.id, log, 'rebuild_failed');
        if (isTransientError(err)) throw err;
        pending++;
        log.error({ err, reason }, 'rebuild failed');
      }
    }
    if (pending > 0) return;
    await identity.commit(live.runId);
    recovery = undefined;
    deps.logger.info({ reason, drops: tracked.length }, 'redis rebuilt from postgres');
  }

  async function checkStructure(signal: AbortSignal): Promise<void> {
    for (const drop of await listTrackedDrops(deps.db)) {
      if (signal.aborted) return;
      const log = deps.logger.child({ dropId: drop.id });
      try {
        const checked = await tryWithDropLock(deps.lock, drop.id, (lock) => checkDrop(lock, log));
        if (!checked.acquired) await alertIfReconcilingTooLong(drop.id, log, 'slow_rebuild');
      } catch (err) {
        await alertIfReconcilingTooLong(drop.id, log, 'rebuild_failed');
        // One broken drop must not starve the others; an outage ends the tick for all of them.
        if (isTransientError(err)) throw err;
        log.error({ err }, 'structural check failed');
      }
    }
  }

  async function checkDrop(lock: HeldDropLock, log: Logger): Promise<void> {
    const [inventory] = await deps.db
      .select({ redisGen: dropInventory.redisGen })
      .from(dropInventory)
      .where(eq(dropInventory.dropId, lock.dropId));
    if (inventory === undefined) throw new BugError(`tracked drop ${lock.dropId} has no inventory`);

    let issue: StructuralIssue | 'MALFORMED' | null;
    try {
      issue = structuralIssue(await readStock(deps.redis, lock.dropId), inventory.redisGen);
    } catch (err) {
      // A partial `inv` hash; the Functions never write one, but a rebuild repairs it all the same.
      if (!(err instanceof BugError)) throw err;
      issue = 'MALFORMED';
    }
    if (issue === null) return;
    log.warn({ issue }, 'drop structure broken; rebuilding');
    const outcome = await rebuildDrop(deps, lock);
    logRebuild(log, 'structural', outcome);
    // STALE under a lock this process holds: Redis has a generation Postgres never issued (Postgres was
    // restored from an older backup, say). The drop stays RECONCILING and every retry is refused the same
    // way, so it counts as a failing rebuild.
    if (outcome.kind === 'STALE') await alertIfReconcilingTooLong(lock.dropId, log, 'rebuild_failed');
  }

  /**
   * Alerts when the drop has been RECONCILING for more than 30 s, at most once per 10 s per drop and name.
   * Runs on failure paths too, where Redis itself may be the failure: a read that fails here is logged,
   * and the caller still handles its own error.
   */
  async function alertIfReconcilingTooLong(dropId: string, log: Logger, name: AlertName): Promise<void> {
    let fields: z.output<typeof ReconcilingFields>;
    try {
      fields = ReconcilingFields.parse(
        await withDeadline('reconciling read', REDIS_DEADLINE_MS, () =>
          deps.redis.hmGet(dropKeys(dropId).inv, ['status', 'reconcilingSince']),
        ),
      );
    } catch (err) {
      log.warn({ err }, 'could not read how long the drop has been reconciling');
      return;
    }
    const [status, since] = fields;
    if (status !== 'RECONCILING' || since === null) return;
    const now = Date.now();
    const forMs = now - Number(since);
    if (!(forMs > RECONCILING_ALERT_MS)) return;
    const key = `${name}:${dropId}`;
    if (now - (lastReconcilingAlert.get(key) ?? 0) < RECONCILING_ALERT_EVERY_MS) return;
    lastReconcilingAlert.set(key, now);
    alert(
      log,
      name,
      { reconcilingForMs: forMs },
      name === 'slow_rebuild'
        ? 'drop RECONCILING for more than 30 s while another session rebuilds it'
        : 'drop RECONCILING for more than 30 s and its rebuild keeps failing; reserves answer 503',
    );
  }

  return {
    async tick(signal) {
      await recoverKeyspace(signal);
      await checkStructure(signal);
      // TODO(M9): drift checks on stable samples (optimistic Redis, leaks, Σuq) run here (§4.7).
    },
  };
}

function logRebuild(log: Pick<Logger, 'info' | 'warn'>, reason: string, outcome: SyncOutcome): void {
  if (outcome.kind === 'REBUILT') {
    log.info({ reason, gen: outcome.gen, status: outcome.status, orders: outcome.orders }, 'drop rebuilt');
  } else {
    // STALE: a zombie sync lost to a newer generation. UNKNOWN_DROP / NOT_ARMED: it left the tracked set.
    log.warn({ reason, outcome: outcome.kind }, 'drop not rebuilt');
  }
}

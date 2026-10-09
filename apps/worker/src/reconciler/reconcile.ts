import type { Logger } from '@flashdrop/config';
import { dropInventory, eq, inArray, listTrackedDrops, type TrackedDrop } from '@flashdrop/db';
import { type AlertName, alert, BugError } from '@flashdrop/domain';
import {
  BULK_DEADLINE_MS,
  dropKeys,
  type HeldDropLock,
  keyspaceLoss,
  loadLibrary,
  REDIS_DEADLINE_MS,
  type RedisStock,
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
 *      between them. A lock-free first pass picks the drops that look broken; healthy ones take no lock.
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

  /**
   * Structure, per tracked drop (§4.7). A first pass compares every drop's Redis `inv` (one pipelined HMGET
   * each) with Postgres's generations (one query) without any lock, and only a drop that looks broken there
   * is checked again, and rebuilt if need be, under its drop lock. M2 took every tracked drop's lock every
   * 2 s, a connection and an advisory-lock round trip per drop per tick, for drops that were almost always
   * fine.
   *
   * The lock-free pass can only cost a lock attempt, never a missed repair: a broken structure (keys gone,
   * a dead rebuild's RECONCILING, a generation Postgres no longer has) persists until a rebuild repairs it,
   * so both reads see it. A sync running between the two reads can make a healthy drop look broken (Redis
   * RECONCILING, or Postgres's generation already bumped), which sends it to the locked check, or make a
   * broken drop look repaired because it is being repaired. The decision to rebuild is still taken only
   * under the lock, where no sync can start or finish between the Redis and the Postgres read.
   */
  async function checkStructure(signal: AbortSignal): Promise<void> {
    const tracked = await listTrackedDrops(deps.db);
    for (const dropId of await suspectDrops(tracked.map((drop) => drop.id))) {
      if (signal.aborted) return;
      const log = deps.logger.child({ dropId });
      try {
        const checked = await tryWithDropLock(deps.lock, dropId, (lock) => checkDrop(lock, log));
        if (!checked.acquired) await alertIfReconcilingTooLong(dropId, log, 'slow_rebuild');
      } catch (err) {
        await alertIfReconcilingTooLong(dropId, log, 'rebuild_failed');
        // One broken drop must not starve the others; an outage ends the tick for all of them.
        if (isTransientError(err)) throw err;
        log.error({ err }, 'structural check failed');
      }
    }
  }

  /** The drops whose structure looks broken without the lock, in tracked-set order. */
  async function suspectDrops(dropIds: readonly string[]): Promise<string[]> {
    if (dropIds.length === 0) return [];
    const [inventories, issues] = await Promise.all([
      deps.db
        .select({ dropId: dropInventory.dropId, redisGen: dropInventory.redisGen })
        .from(dropInventory)
        .where(inArray(dropInventory.dropId, [...dropIds])),
      // Issued together, so node-redis pipelines them on the one command connection.
      Promise.all(dropIds.map((dropId) => readStructure(dropId))),
    ]);
    const gens = new Map(inventories.map((row) => [row.dropId, row.redisGen]));
    return dropIds.filter((dropId, i) => {
      const gen = gens.get(dropId);
      const read = issues[i];
      // No inventory row is a bug the locked check reports; an unreadable hash is repaired by a rebuild.
      if (gen === undefined || read === undefined || read === 'MALFORMED') return true;
      return structuralIssue(read, gen) !== null;
    });
  }

  /** The drop's stock, null when Redis has no drop, or MALFORMED for a partial `inv` hash. */
  async function readStructure(dropId: string): Promise<RedisStock | null | 'MALFORMED'> {
    try {
      return await readStock(deps.redis, dropId);
    } catch (err) {
      // A partial `inv` hash; the Functions never write one, but a rebuild repairs it all the same.
      if (err instanceof BugError) return 'MALFORMED';
      throw err;
    }
  }

  async function checkDrop(lock: HeldDropLock, log: Logger): Promise<void> {
    const [inventory] = await deps.db
      .select({ redisGen: dropInventory.redisGen })
      .from(dropInventory)
      .where(eq(dropInventory.dropId, lock.dropId));
    if (inventory === undefined) throw new BugError(`tracked drop ${lock.dropId} has no inventory`);

    const read = await readStructure(lock.dropId);
    const issue: StructuralIssue | 'MALFORMED' | null =
      read === 'MALFORMED' ? read : structuralIssue(read, inventory.redisGen);
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

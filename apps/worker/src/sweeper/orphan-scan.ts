import type { Logger } from '@flashdrop/config';
import {
  and,
  eq,
  getOrder,
  inArray,
  insertRejectedTombstone,
  listTrackedDrops,
  type OrderRecord,
  sweeperQuarantine,
} from '@flashdrop/db';
import { alert, isTerminalOrderStatus, MAX_ORDER_QTY, MIN_ORDER_QTY, RSV_STATES } from '@flashdrop/domain';
import {
  deferHoldExpiry,
  dropKeys,
  listExpiredHolds,
  REDIS_DEADLINE_MS,
  rebuildDrop,
  settleRedis,
  tryWithDropLock,
  withDeadline,
} from '@flashdrop/inventory';
import { z } from 'zod';
import type { WorkerDeps } from '../deps';
import { isTransientError } from '../loop';
import { withLoopLock } from '../postgres';
import { oneOrder, recordSettle } from './settle';

/*
 * `orphan-scan` (design §4.6, every 5 s). Per tracked drop, the holds whose `exp` score (hold expiry + 30 s
 * of grace) has passed, by Redis time. A member of `exp` is a HELD entry by construction, and Postgres
 * decides its fate:
 *   - no orders row: an API crashed between Lua and Postgres. Tombstone it REJECTED/ORPHANED (one statement
 *     with its `order.rejected` row), re-read, then settle, which releases the hold.
 *   - live: the deadline moved (checkout gave it the payment window). Re-score it at `expires_at` + grace.
 *   - terminal: settle with `force`, even if `redis_settled_at` is set. A lost AOF tail can resurrect a HELD
 *     entry after Postgres settled it, and only this forced path repairs it; the Lua state machine makes the
 *     repeat a NOOP otherwise.
 *
 * Why the tombstone cannot steal a live reservation: the api pool's `transaction_timeout` (5 s) is far
 * below the grace, so no reserve transaction for the hold is still running; and even if one were, its
 * INSERT and the tombstone's compete for one primary key, exactly one wins, and the re-read follows the
 * winner. Stock is released only once a terminal Postgres row exists (§4.3).
 *
 * A hold Postgres can never record (the tombstone itself is refused, e.g. its user no longer exists, or its
 * `rsv` entry is gone or malformed) cannot be quarantined either, since `sweeper_quarantine` references
 * `orders`; nor can an `exp` member that the Functions no longer remove (its entry is already terminal or
 * missing). Such holds are "stuck": only a rebuild of the drop from Postgres removes them, and the
 * generation fence makes that safe (any reserve still carrying the old generation is refused). So a drop
 * with stuck holds is rebuilt once at the end of its scan, under its drop lock (skipped if busy), and each
 * stuck hold raises one alert per process.
 *
 * Members the scan leaves in place (quarantined, stuck, or waiting for a rebuild to finish) keep their
 * score, so the scan pages past them instead of meeting the same ones at the head of every page.
 */

/** An `rsv` entry, `{u, q, s, fp, k}` (§4.1): everything a tombstone needs to know about an orphan. */
const RsvEntry = z.object({
  u: z.uuid(),
  q: z.int().min(MIN_ORDER_QTY).max(MAX_ORDER_QTY),
  s: z.enum(RSV_STATES),
  fp: z.string().regex(/^[0-9a-f]{64}$/),
  k: z.string().min(1),
});

class UnrecordableHold extends Error {
  override name = 'UnrecordableHold';
}

const PAGE = 200;
/** Holds examined per drop per tick, at most, so one drop's backlog cannot hold up the others for long. */
const MAX_PER_DROP = 2_000;
/** Stuck holds remembered per process, so each alerts once instead of every 5 s. */
const ALERT_MEMORY = 10_000;

/**
 * What became of one candidate: it left the expired range (released, confirmed, or re-scored into the
 * future), it stays for now (quarantined, or its drop is rebuilding), or it is stuck until a rebuild.
 */
type Fate = 'GONE' | 'STAYS' | 'STUCK';

type Log = Pick<Logger, 'info' | 'warn' | 'error'>;

/** The tick of one worker process (it remembers which stuck holds it has alerted on). */
export function createOrphanScan(deps: WorkerDeps): (signal: AbortSignal) => Promise<void> {
  const alerted = new Set<string>();
  const stuckAlert = (log: Log, rid: string, error: unknown) => {
    if (alerted.has(rid)) return;
    if (alerted.size >= ALERT_MEMORY) alerted.clear();
    alerted.add(rid);
    alert(
      log,
      'orphan_unrecordable',
      { err: error },
      'an expired hold Postgres cannot record; rebuilding its drop',
    );
  };

  async function handle(dropId: string, rid: string): Promise<Fate> {
    const log = deps.logger.child({ orderId: rid, dropId });
    let order: OrderRecord;
    try {
      order = (await getOrder(deps.db, rid)) ?? (await tombstone(deps, dropId, rid, log));
    } catch (error) {
      if (isTransientError(error)) throw error;
      stuckAlert(log, rid, error);
      return 'STUCK';
    }
    let fate: Fate = 'STAYS';
    await oneOrder(deps, 'orphan-scan', rid, async () => {
      fate = await settleOrDefer(deps, order, log);
      if (fate === 'STUCK') stuckAlert(log, rid, 'exp member of a settled entry');
    });
    return fate;
  }

  /** Scans one drop's expired holds; returns how many are stuck. */
  async function scanDrop(dropId: string, signal: AbortSignal): Promise<number> {
    const seen = new Set<string>();
    let offset = 0;
    let stuck = 0;
    while (seen.size < MAX_PER_DROP && !signal.aborted) {
      const page = await listExpiredHolds(deps.redis, dropId, { offset, count: PAGE });
      if (page.length === 0) break;
      const quarantined = await quarantinedRids(deps, page);
      // Members left in place stay ahead of the next page's offset; one met again was miscounted as gone.
      let stays = 0;
      for (const rid of page) {
        if (signal.aborted) break;
        if (seen.has(rid) || quarantined.has(rid)) {
          seen.add(rid);
          stays++;
          continue;
        }
        seen.add(rid);
        const fate = await handle(dropId, rid);
        if (fate !== 'GONE') stays++;
        if (fate === 'STUCK') stuck++;
      }
      if (page.length < PAGE) break;
      offset += stays;
    }
    return stuck;
  }

  async function rebuildStuck(dropId: string, stuck: number): Promise<void> {
    const log = deps.logger.child({ dropId });
    try {
      const rebuilt = await tryWithDropLock(deps.lock, dropId, (lock) => rebuildDrop(deps, lock));
      // Busy: an admin action, the scheduler or the reconciler holds the drop; the next tick retries.
      if (rebuilt.acquired)
        log.warn({ stuck, outcome: rebuilt.value.kind }, 'drop rebuilt to drop stuck holds');
    } catch (err) {
      if (isTransientError(err)) throw err;
      log.error({ err, stuck }, 'rebuild for stuck holds failed');
    }
  }

  return async (signal) => {
    await withLoopLock(deps.db, 'orphan-scan', async () => {
      for (const drop of await listTrackedDrops(deps.db)) {
        if (signal.aborted) return;
        const stuck = await scanDrop(drop.id, signal);
        if (stuck > 0 && !signal.aborted) await rebuildStuck(drop.id, stuck);
      }
    });
  };
}

/** Records an orphan as REJECTED/ORPHANED and returns whatever order now owns the rid. */
async function tombstone(deps: WorkerDeps, dropId: string, rid: string, log: Log): Promise<OrderRecord> {
  const entry = await readEntry(deps, dropId, rid);
  const inserted = await insertRejectedTombstone(deps.db, {
    id: rid,
    userId: entry.u,
    dropId,
    qty: entry.q,
    idempotencyKey: entry.k,
    requestHash: Buffer.from(entry.fp, 'hex'),
    reason: 'ORPHANED',
  });
  if (inserted) log.warn('orphaned hold tombstoned');
  else log.info('a late reserve recorded the hold first; following its order');
  const order = await getOrder(deps.db, rid);
  if (order === undefined) throw new UnrecordableHold('the tombstone left no orders row');
  return order;
}

async function settleOrDefer(deps: WorkerDeps, order: OrderRecord, log: Log): Promise<Fate> {
  if (!isTerminalOrderStatus(order.status)) {
    await deferHoldExpiry(deps.redis, order.dropId, order.id, order.expiresAt);
    return 'GONE';
  }
  const outcome = await settleRedis(deps, order.id, { force: true });
  await recordSettle(deps, 'orphan-scan', order.id, outcome, log);
  if (outcome.kind !== 'SETTLED') return 'STAYS';
  if (outcome.via === 'OK' || outcome.via === 'PAST_RETENTION') return 'GONE';
  // NOOP or MISSING: the entry is already terminal or gone, so no Function will remove the member. A
  // concurrent settlement may have just done so; a member still there disagrees with `rsv` for good.
  const score = await withDeadline('exp member read', REDIS_DEADLINE_MS, () =>
    deps.redis.zScore(dropKeys(order.dropId).exp, order.id),
  );
  return score === null ? 'GONE' : 'STUCK';
}

async function readEntry(deps: WorkerDeps, dropId: string, rid: string): Promise<z.output<typeof RsvEntry>> {
  const raw = await withDeadline('rsv entry read', REDIS_DEADLINE_MS, () =>
    deps.redis.hGet(dropKeys(dropId).rsv, rid),
  );
  if (raw === null) throw new UnrecordableHold('exp member without an rsv entry');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UnrecordableHold('rsv entry is not JSON');
  }
  const entry = RsvEntry.safeParse(parsed);
  if (!entry.success) throw new UnrecordableHold(`malformed rsv entry: ${z.prettifyError(entry.error)}`);
  return entry.data;
}

async function quarantinedRids(deps: WorkerDeps, rids: readonly string[]): Promise<Set<string>> {
  const rows = await deps.db
    .select({ orderId: sweeperQuarantine.orderId })
    .from(sweeperQuarantine)
    .where(and(eq(sweeperQuarantine.loop, 'orphan-scan'), inArray(sweeperQuarantine.orderId, [...rids])));
  return new Set(rows.map((row) => row.orderId));
}

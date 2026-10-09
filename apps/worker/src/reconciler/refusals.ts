import type { Logger } from '@flashdrop/config';
import { type Db, PgUuid, parseRows, sql } from '@flashdrop/db';
import { z } from 'zod';
import type { RebuildUnlessBusy } from './drift-checks';

/*
 * The refusal trigger (design §4.7). Postgres refusing a Redis admission with SOLD_OUT or LIMIT can only
 * happen when Redis was optimistic, so it is the definitive drift signal: the API tombstones the reservation
 * and sends `NOTIFY fd_sync` with the drop id, and the reconciler rebuilds the drop at once (`refusal`). It
 * does not wait for two stable samples, which a burst on the drop may never give it.
 *
 * The nudge names the drop, not the reason (NO_DROP nudges for a wiped drop share the channel), so the
 * evidence is read from Postgres: the drop's refusal tombstones, counted. Orders are never deleted, so the
 * count only grows. A nudged drop is rebuilt when it has more than this process last saw at a rebuild of it;
 * a drop already rebuilt for another reason since the last pass (a wipe, its structure, drift) only records
 * its count, since that rebuild took Postgres's word for every refusal before it.
 *
 * The counts live in this process. A new leader rebuilds a nudged drop that has refusals once, since it
 * cannot tell whether its predecessor already did: an extra rebuild costs the drop a moment of 503s, while a
 * missed one would leave Redis admitting units Postgres refuses until the periodic check caught it.
 */

const Refusals = z.object({ refusals: z.int() });

/** SOLD_OUT and LIMIT tombstones of the drop: Redis admissions Postgres refused (NOT_LIVE is the window). */
async function countRefusals(db: Db, dropId: string): Promise<number> {
  const { rows } = await db.execute(sql`
    SELECT count(*)::int AS refusals FROM orders
    WHERE drop_id = ${dropId} AND status = 'REJECTED' AND close_reason IN ('SOLD_OUT', 'LIMIT')`);
  return parseRows(Refusals, rows, 'countRefusals')[0]?.refusals ?? 0;
}

export interface RefusalWatch {
  /** A `NOTIFY fd_sync` payload, the drop id; anything else is logged and dropped. */
  nudged(payload: string): void;
  /** Handles every drop nudged since the last pass. */
  run(pass: {
    readonly tracked: ReadonlySet<string>;
    /** Drops this process rebuilt since the last pass, for any reason. */
    readonly rebuilt: ReadonlySet<string>;
    readonly signal: AbortSignal;
  }): Promise<void>;
}

export function createRefusalWatch(
  deps: { readonly db: Db; readonly logger: Logger },
  rebuild: RebuildUnlessBusy,
): RefusalWatch {
  const nudged = new Set<string>();
  /** Refusals counted before this process's last rebuild of the drop, which accounted for them. */
  const accounted = new Map<string, number>();

  return {
    nudged(payload) {
      const dropId = PgUuid.safeParse(payload.toLowerCase());
      if (dropId.success) nudged.add(dropId.data);
      else deps.logger.warn({ payload }, 'fd_sync nudge without a drop id; ignored');
    },

    async run({ tracked, rebuilt, signal }) {
      for (const dropId of accounted.keys()) if (!tracked.has(dropId)) accounted.delete(dropId);
      for (const dropId of [...nudged]) {
        if (signal.aborted) return;
        if (!tracked.has(dropId)) {
          nudged.delete(dropId);
          continue;
        }
        const refusals = await countRefusals(deps.db, dropId);
        if (rebuilt.has(dropId)) {
          accounted.set(dropId, refusals);
        } else if (refusals > (accounted.get(dropId) ?? 0)) {
          const log = deps.logger.child({ dropId });
          log.warn(
            { refusals, accounted: accounted.get(dropId) ?? 0 },
            'postgres refused redis admissions; rebuilding the drop',
          );
          // Counted before the rebuild's fence, so the rebuild covers at least these. One written meanwhile
          // makes the next nudge rebuild again: at worst a spare rebuild, never a missed one.
          const outcome = await rebuild(dropId, 'refusal', log);
          if (outcome === 'busy') continue; // still nudged: the next tick tries again
          if (outcome === 'rebuilt') accounted.set(dropId, refusals);
        }
        nudged.delete(dropId);
      }
    },
  };
}

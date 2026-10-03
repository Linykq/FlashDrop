import type { Logger } from '@flashdrop/config';
import { type Db, sql } from '@flashdrop/db';

/*
 * `NOTIFY fd_sync` (design §4.7): the nudge that makes the reconciler check a drop at once instead of on its
 * next 2 s tick. Sent when Lua answers NO_DROP for a tracked drop, when Postgres refuses a Redis admission,
 * and by `settleRedis` on NO_DROP. These are rare paths, so they add nothing to the commit-time NOTIFY cost
 * of the hot paths (§5.4); the debounce keeps a burst of them to one per drop per second per process.
 */

export const SYNC_CHANNEL = 'fd_sync';

export interface SyncNudger {
  /**
   * Asks the reconciler to check `dropId`. Never rejects: a lost nudge only delays a repair until the
   * periodic check, so a failure is logged rather than failing the caller's request.
   */
  nudge(dropId: string): Promise<void>;
}

export function createSyncNudger(deps: {
  readonly db: Db;
  readonly logger: Pick<Logger, 'warn'>;
  readonly debounceMs?: number;
}): SyncNudger {
  const debounceMs = deps.debounceMs ?? 1_000;
  const lastSent = new Map<string, number>();
  return {
    async nudge(dropId) {
      const now = Date.now();
      if (now - (lastSent.get(dropId) ?? Number.NEGATIVE_INFINITY) < debounceMs) return;
      lastSent.set(dropId, now);
      if (lastSent.size > 1_000) {
        for (const [id, at] of lastSent) if (now - at >= debounceMs) lastSent.delete(id);
      }
      try {
        await deps.db.execute(sql`SELECT pg_notify(${SYNC_CHANNEL}, ${dropId})`);
      } catch (err) {
        deps.logger.warn({ err, dropId }, 'fd_sync nudge failed; the periodic check will repair the drop');
      }
    },
  };
}

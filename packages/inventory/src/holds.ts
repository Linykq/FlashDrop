import type { FlashdropRedis } from './client';
import { REDIS_DEADLINE_MS, withDeadline } from './deadline';
import { canonicalUuid, dropKeys } from './keys';
import type { RedisStock } from './state';

/*
 * Helpers for the sweeper's orphan-scan and the reconciler's structural check (design §4.6, §4.7).
 */

/** Must equal GRACE_MS in lua/flashdrop.lua (a unit test checks it). */
export const HOLD_GRACE_MS = 30_000;

/**
 * Up to `count` rids whose hold expired more than the grace ago, by Redis time (`TIME` picks sweep
 * candidates, §1 assumptions), lowest score first, skipping the first `offset`. Every `exp` member is a
 * HELD entry by construction; Postgres decides each one's fate (orphan-scan: no row → tombstone, live →
 * `deferHoldExpiry`, terminal → forced settle). A member the scan has to leave in place keeps its score, so
 * the scan pages past those with `offset` rather than seeing them again at the head of every page.
 * Bounded by `REDIS_DEADLINE_MS`, as is `deferHoldExpiry`.
 */
export function listExpiredHolds(
  redis: FlashdropRedis,
  dropId: string,
  page: { readonly offset?: number; readonly count?: number } = {},
): Promise<string[]> {
  return withDeadline('expired holds read', REDIS_DEADLINE_MS, async () => {
    const [seconds, micros] = await redis.time();
    const nowMs = Number(seconds) * 1000 + Math.floor(Number(micros) / 1000);
    return redis.zRange(dropKeys(dropId).exp, '-inf', nowMs, {
      BY: 'SCORE',
      LIMIT: { offset: page.offset ?? 0, count: page.count ?? 200 },
    });
  });
}

/**
 * Re-scores a live order's hold at its Postgres deadline plus the grace (`ZADD XX`: an entry a settlement
 * or a rebuild removed meanwhile is not resurrected).
 */
export async function deferHoldExpiry(
  redis: FlashdropRedis,
  dropId: string,
  rid: string,
  expiresAt: Date,
): Promise<void> {
  await withDeadline('hold expiry deferral', REDIS_DEADLINE_MS, () =>
    redis.zAdd(
      dropKeys(dropId).exp,
      { score: expiresAt.getTime() + HOLD_GRACE_MS, value: canonicalUuid('rid', rid) },
      { condition: 'XX' },
    ),
  );
}

export type StructuralIssue = 'MISSING' | 'RECONCILING' | 'GEN_MISMATCH';

/**
 * The reconciler's per-drop structural check, made while holding the drop lock (so no sync can start or
 * finish between the Redis and the Postgres read): `inv` missing, RECONCILING (with the lock held, no live
 * rebuild exists, so its holder died), or a generation other than `drop_inventory.redis_gen`. Any issue
 * means: rebuild now.
 */
export function structuralIssue(stock: RedisStock | null, redisGen: number): StructuralIssue | null {
  if (stock === null) return 'MISSING';
  if (stock.status === 'RECONCILING') return 'RECONCILING';
  if (stock.gen !== redisGen) return 'GEN_MISMATCH';
  return null;
}

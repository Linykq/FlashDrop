import { randomUUID } from 'node:crypto';
import { loadEnv, RedisEnv } from '@flashdrop/config';
import type { RebuildSnapshot } from '@flashdrop/db';
import { requestFingerprint } from '@flashdrop/domain/identity';
import { fdRebuild, fdSetStatus } from '../calls';
import { connectCommandClient, type FlashdropRedis } from '../client';
import { dropKeys } from '../keys';

/*
 * Integration-test helpers for Redis-only scenarios (not exported from the package). Every test works on a
 * fresh drop id and deletes that drop's keys afterwards; the shared Redis is never flushed.
 */

const quiet = { warn: () => undefined };

export function connectTestRedis(name = 'inventory-test'): Promise<FlashdropRedis> {
  // The tests' own Redis (vitest.config.ts), so this tree's library replaces any other copy of its version.
  return connectCommandClient({
    url: loadEnv([RedisEnv]).REDIS_URL,
    name,
    logger: quiet,
    library: { replaceSameVersion: true },
  });
}

export async function deleteDropKeys(redis: FlashdropRedis, dropId: string): Promise<void> {
  const k = dropKeys(dropId);
  await redis.del([k.inv, k.rsv, k.uq, k.exp]);
}

export interface TestDropOptions {
  readonly total?: number;
  readonly limit?: number;
  readonly status?: RebuildSnapshot['meta']['status'];
  readonly gen?: number;
  /** Offsets from now, in ms. The default window is open: [-1 h, +1 h). */
  readonly startsInMs?: number;
  readonly endsInMs?: number;
  readonly holdMs?: number;
}

/** A snapshot of an empty drop, as Postgres would give it right after arming. */
export function emptySnapshot(options: TestDropOptions = {}): RebuildSnapshot {
  const now = Date.now();
  const endsAt = now + (options.endsInMs ?? 3_600_000);
  return {
    gen: options.gen ?? 1,
    total: options.total ?? 100,
    reserved: 0,
    sold: 0,
    meta: {
      status: options.status ?? 'LIVE',
      startsAt: now + (options.startsInMs ?? -3_600_000),
      endsAt,
      holdMs: options.holdMs ?? 120_000,
      limit: options.limit ?? 2,
      // Short-lived on purpose: keys a failed test leaves behind expire on their own.
      retainAt: now + 600_000,
      productId: randomUUID(),
    },
    entries: [],
    quotas: {},
  };
}

/** Puts a fresh drop into Redis the way `syncDropFromPostgres` does: RECONCILING, then one rebuild. */
export async function armTestDrop(
  redis: FlashdropRedis,
  options: TestDropOptions = {},
): Promise<{ dropId: string; snapshot: RebuildSnapshot }> {
  const dropId = randomUUID();
  const snapshot = emptySnapshot(options);
  await fdSetStatus(redis, dropId, 'RECONCILING');
  const result = await fdRebuild(redis, dropId, snapshot);
  if (result.kind !== 'OK') throw new Error(`test drop rebuild answered ${result.kind}`);
  return { dropId, snapshot };
}

/** Arguments for `fdReserve`: a fresh rid unless one is given, the fingerprint of (drop, qty). */
export function reserveInput(dropId: string, userId: string, qty = 1, rid: string = randomUUID()) {
  return {
    dropId,
    rid,
    userId,
    qty,
    fingerprint: requestFingerprint({ dropId, qty }),
    idempotencyKey: `key_${rid.slice(0, 8)}`,
  };
}

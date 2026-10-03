import { randomUUID } from 'node:crypto';
import { loadEnv, RedisEnv } from '@flashdrop/config';
import { afterEach, describe, expect, it } from 'vitest';
import { fdReserve } from './calls';
import { connectCommandClient, type FlashdropRedis, isTransientRedisError } from './client';
import { BULK_DEADLINE_MS, REDIS_DEADLINE_MS, RedisDeadlineError } from './deadline';
import { readLiveRedisIdentity } from './epoch';
import { deferHoldExpiry, listExpiredHolds } from './holds';
import { readDropState, readStock } from './state';
import { reserveInput } from './test/redis';
import { type StallingProxy, startStallingProxy } from './test/stalling-proxy';

/*
 * A Redis that stops answering without closing the socket (a paused container, a blackholed network): no
 * error ever arrives, and node-redis applies no timeout to a written command. Every call a request or a
 * loop makes must still end within its deadline, as a transient error, so the catalog falls back to
 * Postgres, a reserve answers 503 and a worker tick ends (and with it, a shutdown) instead of hanging.
 */

const quiet = { warn: () => undefined };
let proxy: StallingProxy | undefined;
let redis: FlashdropRedis | undefined;

afterEach(async () => {
  // close() would wait for a QUIT the frozen proxy never delivers.
  redis?.destroy();
  await proxy?.close();
});

async function frozenRedis(): Promise<FlashdropRedis> {
  proxy = await startStallingProxy(loadEnv([RedisEnv]).REDIS_URL);
  redis = await connectCommandClient({
    url: proxy.url,
    name: 'inventory-frozen-test',
    logger: quiet,
    library: { replaceSameVersion: true },
  });
  proxy.freeze();
  return redis;
}

/** How a call settles, and after how long. */
async function settle(call: () => Promise<unknown>): Promise<{ error: unknown; ms: number }> {
  const started = performance.now();
  try {
    await call();
    return { error: undefined, ms: performance.now() - started };
  } catch (error) {
    return { error, ms: performance.now() - started };
  }
}

describe('a frozen Redis', () => {
  it('ends every request and loop read within its deadline, as a transient error', async () => {
    const client = await frozenRedis();
    const dropId = randomUUID();
    const calls: Record<string, readonly [() => Promise<unknown>, number]> = {
      readStock: [() => readStock(client, dropId), REDIS_DEADLINE_MS],
      listExpiredHolds: [() => listExpiredHolds(client, dropId), REDIS_DEADLINE_MS],
      deferHoldExpiry: [() => deferHoldExpiry(client, dropId, randomUUID(), new Date()), REDIS_DEADLINE_MS],
      readLiveRedisIdentity: [() => readLiveRedisIdentity(client), REDIS_DEADLINE_MS],
      fdReserve: [() => fdReserve(client, reserveInput(dropId, randomUUID())), REDIS_DEADLINE_MS],
      readDropState: [() => readDropState(client, dropId), BULK_DEADLINE_MS],
    };

    const outcomes = await Promise.all(
      Object.entries(calls).map(async ([name, [call, deadlineMs]]) => ({
        name,
        deadlineMs,
        ...(await settle(call)),
      })),
    );

    for (const { name, deadlineMs, error, ms } of outcomes) {
      expect(error, name).toBeInstanceOf(RedisDeadlineError);
      expect(isTransientRedisError(error), name).toBe(true);
      expect(ms, name).toBeGreaterThanOrEqual(deadlineMs - 50);
      expect(ms, name).toBeLessThan(deadlineMs + 1_000);
    }
  }, 20_000);
});

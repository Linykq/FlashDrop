import { randomUUID } from 'node:crypto';
import type { StockLevel } from '@flashdrop/contracts';
import type { Db } from '@flashdrop/db';
import {
  type FlashdropRedis,
  isTransientRedisError,
  REDIS_DEADLINE_MS,
  RedisDeadlineError,
} from '@flashdrop/inventory';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRedisStockReader, type StockReader } from './stock';

const LEVEL: StockLevel = { avail: 7, held: 2, sold: 1, status: 'LIVE', gen: 3, seq: 0 };

/** A command client whose reads never answer: a paused container or a blackholed network. */
const frozen = { hmGet: () => new Promise<never>(() => undefined) } as unknown as FlashdropRedis;

const postgres: StockReader = {
  read: async (dropIds) => new Map(dropIds.map((dropId) => [dropId, LEVEL])),
  snapshot: async () => LEVEL,
};

function reader() {
  return createRedisStockReader({
    redis: frozen,
    // Never reached: the frozen read fails first.
    db: {} as Db,
    postgres,
    nudger: { nudge: async () => undefined },
    logger: { warn: () => undefined },
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createRedisStockReader on a Redis that stopped answering', () => {
  // Regression: only Function calls had a deadline, so the catalog's stock read hung forever on a frozen
  // Redis instead of falling back to Postgres, and so did GET /drops/:id/stock.
  it('serves the catalog from Postgres once the read passes its deadline', async () => {
    vi.useFakeTimers();
    const dropId = randomUUID();
    const levels = reader().read([dropId]);
    await vi.advanceTimersByTimeAsync(REDIS_DEADLINE_MS);
    expect(await levels).toEqual(new Map([[dropId, LEVEL]]));
  });

  it('fails a stock snapshot with a transient error (503 RETRY) at the deadline', async () => {
    vi.useFakeTimers();
    const snapshot = reader().snapshot(randomUUID());
    const outcome = snapshot.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(REDIS_DEADLINE_MS);
    const error = await outcome;
    expect(error).toBeInstanceOf(RedisDeadlineError);
    expect(isTransientRedisError(error)).toBe(true);
  });
});

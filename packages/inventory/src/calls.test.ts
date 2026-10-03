import { randomUUID } from 'node:crypto';
import { requestFingerprint } from '@flashdrop/domain/identity';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fdRelease, fdReserve } from './calls';
import { type FlashdropRedis, isTransientRedisError } from './client';
import { REDIS_DEADLINE_MS, RedisDeadlineError } from './deadline';

/** A command client whose Functions never answer: a paused container or a blackholed network. */
function frozenRedis(): FlashdropRedis {
  const never = () => new Promise<never>(() => undefined);
  // Only the Functions namespace is reached by these calls.
  return { flashdrop: { fd_reserve: never, fd_release: never } } as unknown as FlashdropRedis;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Function calls', () => {
  // Regression: node-redis stops applying a command's timeout once it is written, so a frozen Redis held
  // every reserve (and every worker tick) until TCP keepalive gave up, minutes later.
  it('reject a call Redis never answers after the deadline, with a transient error (503 RETRY)', async () => {
    vi.useFakeTimers();
    const dropId = randomUUID();
    const redis = frozenRedis();
    const reserve = fdReserve(redis, {
      dropId,
      rid: randomUUID(),
      userId: randomUUID(),
      qty: 1,
      fingerprint: requestFingerprint({ dropId, qty: 1 }),
      idempotencyKey: 'key_12345678',
    });
    const release = fdRelease(redis, dropId, randomUUID());
    const outcomes = Promise.allSettled([reserve, release]);

    await vi.advanceTimersByTimeAsync(REDIS_DEADLINE_MS - 1);
    let settled = false;
    void outcomes.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    for (const outcome of await outcomes) {
      expect(outcome.status).toBe('rejected');
      const reason = outcome.status === 'rejected' ? outcome.reason : undefined;
      expect(reason).toBeInstanceOf(RedisDeadlineError);
      expect(isTransientRedisError(reason)).toBe(true);
    }
  });
});

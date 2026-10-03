import { describe, expect, it } from 'vitest';
import { redisRateLimitStore } from './rate-limit';

function incr(store: InstanceType<ReturnType<typeof redisRateLimitStore>>, key: string) {
  return new Promise<{ current: number; ttl: number } | undefined>((resolve, reject) => {
    store.incr(key, (error, result) => (error === null ? resolve(result) : reject(error)), 1_000);
  });
}

describe('redisRateLimitStore', () => {
  it('reports the counter’s hits and time to reset, per key and window', async () => {
    const calls: [string, number][] = [];
    const Store = redisRateLimitStore(async (key, windowMs) => {
      calls.push([key, windowMs]);
      return { count: calls.length, ttlMs: 750 };
    });
    const store = new Store();
    expect(await incr(store, 'fd:rl:reserve-ip:1.2.3.4')).toEqual({ current: 1, ttl: 750 });
    expect(await incr(store.child(), 'fd:rl:reserve-ip:1.2.3.4')).toEqual({ current: 2, ttl: 750 });
    expect(calls).toEqual([
      ['fd:rl:reserve-ip:1.2.3.4', 1_000],
      ['fd:rl:reserve-ip:1.2.3.4', 1_000],
    ]);
  });

  it('passes a Redis failure to the plugin', async () => {
    const offline = new Error('The client is offline');
    const Store = redisRateLimitStore(() => Promise.reject(offline));
    await expect(incr(new Store(), 'fd:rl:x:y')).rejects.toBe(offline);
  });
});

import { describe, expect, it } from 'vitest';
import { settleWithLimit } from './concurrency';

describe('settleWithLimit', () => {
  it('keeps at most `limit` calls in flight and returns every outcome in input order', async () => {
    let inFlight = 0;
    let peak = 0;
    const outcomes = await settleWithLimit([5, 1, 4, 2, 3, 0, 6], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, n * 2));
      inFlight--;
      if (n === 4) throw new Error('four');
      return n * 10;
    });

    expect(peak).toBe(3);
    expect(outcomes.map((o) => (o.status === 'fulfilled' ? o.value : (o.reason as Error).message))).toEqual([
      50,
      10,
      'four',
      20,
      30,
      0,
      60,
    ]);
  });

  it('settles an empty batch at once', async () => {
    expect(await settleWithLimit([], 16, async () => 1)).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { backoffCeilingMs, CONSUMER_BACKOFF, fullJitterDelayMs, RELAY_BACKOFF } from './backoff';

describe('backoffCeilingMs', () => {
  it('doubles from the base and stops at the cap', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((retry) => backoffCeilingMs(RELAY_BACKOFF, retry))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ]);
    expect(backoffCeilingMs(CONSUMER_BACKOFF, 0)).toBe(100);
    expect(backoffCeilingMs(CONSUMER_BACKOFF, 8)).toBe(25_600);
    expect(backoffCeilingMs(CONSUMER_BACKOFF, 9)).toBe(30_000);
  });

  it('stays at the cap for any number of retries', () => {
    expect(backoffCeilingMs(CONSUMER_BACKOFF, 10_000)).toBe(30_000);
    expect(backoffCeilingMs(CONSUMER_BACKOFF, -1)).toBe(100);
  });
});

describe('fullJitterDelayMs', () => {
  it('is uniform in [0, ceiling)', () => {
    expect(fullJitterDelayMs(RELAY_BACKOFF, 2, () => 0)).toBe(0);
    expect(fullJitterDelayMs(RELAY_BACKOFF, 2, () => 0.5)).toBe(2_000);
    expect(fullJitterDelayMs(RELAY_BACKOFF, 2, () => 0.999_999)).toBe(3_999);
  });

  it('never exceeds the cap with real randomness', () => {
    for (let retry = 0; retry < 50; retry++) {
      const delay = fullJitterDelayMs(CONSUMER_BACKOFF, retry);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(backoffCeilingMs(CONSUMER_BACKOFF, retry));
    }
  });
});

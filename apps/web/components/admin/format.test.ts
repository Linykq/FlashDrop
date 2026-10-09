import { describe, expect, it } from 'vitest';
import {
  formatLagSeconds,
  formatLatency,
  formatPercent,
  formatShortDuration,
  formatTileCount,
  formatTileMoney,
  formatWindow,
} from './format';

describe('admin formats', () => {
  it('goes compact from 10,000 in tiles', () => {
    expect(formatTileCount(9_999)).toBe('9,999');
    expect(formatTileCount(12_900)).toBe('12.9K');
    expect(formatTileMoney(130_000, 'USD')).toBe('$1,300');
    expect(formatTileMoney(999_949, 'USD')).toBe('$9,999');
    expect(formatTileMoney(6_217_800, 'USD')).toBe('$62.2K');
  });

  it('formats percentages and refuses to divide by nothing', () => {
    expect(formatPercent(482, 500)).toBe('96.4%');
    expect(formatPercent(0, 0)).toBeNull();
  });

  it('formats durations in short units', () => {
    expect(formatShortDuration(45)).toBe('45s');
    expect(formatShortDuration(252)).toBe('4m 12s');
    expect(formatShortDuration(300)).toBe('5m');
    expect(formatShortDuration(3_900)).toBe('1h 05m');
    expect(formatShortDuration(7_200)).toBe('2h');
    expect(formatLagSeconds(0.42)).toBe('0.4 s');
    expect(formatLagSeconds(42.4)).toBe('42 s');
    expect(formatLagSeconds(252)).toBe('4m 12s');
  });

  it('writes a window as one range, dropping what both ends share', () => {
    const utc = { timeZone: 'UTC' };
    expect(formatWindow('2026-10-06T19:00:00.000Z', '2026-10-06T19:30:00.000Z', utc)).toBe(
      'Oct 6, 7:00–7:30\u00a0PM',
    );
    expect(formatWindow('2026-10-06T23:00:00.000Z', '2026-10-07T01:00:00.000Z', utc)).toBe(
      'Oct 6, 11:00\u00a0PM – Oct 7, 1:00\u00a0AM',
    );
  });

  it('says a latency under a tenth of a second as such, never as 0.0 s', () => {
    expect(formatLatency(9_800)).toBe('9.8 s');
    expect(formatLatency(100)).toBe('0.1 s');
    expect(formatLatency(40)).toBe('<0.1 s');
    expect(formatLatency(0)).toBe('<0.1 s');
  });
});

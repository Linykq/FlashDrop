import { describe, expect, it } from 'vitest';
import { compareStockVersions, parseStockMessage } from './stock-message';

describe('parseStockMessage', () => {
  it('reads the seven fields publish() writes', () => {
    expect(parseStockMessage('3:41:58:30:12:LIVE:1790000000123')).toEqual({
      gen: 3,
      seq: 41,
      avail: 58,
      held: 30,
      sold: 12,
      status: 'LIVE',
      ts: 1790000000123,
    });
  });

  it('accepts the fail-closed level of a drop being armed', () => {
    expect(parseStockMessage('-1:1:0:0:0:RECONCILING:1790000000123')).toMatchObject({
      gen: -1,
      status: 'RECONCILING',
    });
  });

  it('returns null for incomplete or malformed levels', () => {
    for (const message of [
      '::::::1790000000123', // publish() on a hash with missing fields
      '3:41:58:30:12:LIVE', // six fields
      '3:41:58:30:12:LIVE:1:extra',
      '3:41:-1:30:12:LIVE:1', // negative stock
      '3:41:58:30:12:DRAFT:1', // never a Redis status
      '3.5:41:58:30:12:LIVE:1',
    ]) {
      expect(parseStockMessage(message), message).toBeNull();
    }
  });
});

describe('compareStockVersions', () => {
  it('orders by gen first, then seq', () => {
    expect(compareStockVersions({ gen: 2, seq: 0 }, { gen: 1, seq: 900 })).toBeGreaterThan(0);
    expect(compareStockVersions({ gen: 2, seq: 4 }, { gen: 2, seq: 5 })).toBeLessThan(0);
    expect(compareStockVersions({ gen: 2, seq: 5 }, { gen: 2, seq: 5 })).toBe(0);
  });
});

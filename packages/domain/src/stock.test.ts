import { describe, expect, it } from 'vitest';
import { stockFromCounters } from './stock';

describe('stockFromCounters', () => {
  it('derives buyer-facing stock like the Redis rebuild', () => {
    expect(stockFromCounters({ total: 100, reserved: 7, sold: 30 })).toEqual({
      avail: 63,
      held: 7,
      sold: 30,
    });
  });

  it('conserves units (INV-9)', () => {
    const { avail, held, sold } = stockFromCounters({ total: 50, reserved: 0, sold: 50 });

    expect(avail + held + sold).toBe(50);
    expect(avail).toBe(0);
  });
});

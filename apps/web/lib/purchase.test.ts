import { describe, expect, it } from 'vitest';
import { buyAction, maxQuantity } from './purchase';
import type { StockState } from './stock';

const stock = (status: StockState['status'], avail: number, held = 0): StockState => ({
  status,
  avail,
  held,
  sold: 100 - avail - held,
});

describe('buyAction', () => {
  it('offers Buy only while a live drop has units left', () => {
    expect(buyAction(stock('LIVE', 12), true)).toEqual({ kind: 'buy' });
    expect(buyAction(stock('LIVE', 12), false)).toEqual({ kind: 'sign-in' });
  });

  it('explains why nothing can be reserved, signed in or not', () => {
    for (const signedIn of [true, false]) {
      expect(buyAction(stock('SCHEDULED', 100), signedIn)).toEqual({ kind: 'closed', reason: 'opens' });
      expect(buyAction(stock('PAUSED', 20), signedIn)).toEqual({ kind: 'closed', reason: 'paused' });
      expect(buyAction(stock('LIVE', 0, 3), signedIn)).toEqual({ kind: 'closed', reason: 'all-reserved' });
      expect(buyAction(stock('LIVE', 0), signedIn)).toEqual({ kind: 'closed', reason: 'sold-out' });
    }
  });

  it('removes the button once the drop ended', () => {
    expect(buyAction(stock('ENDED', 8), true)).toEqual({ kind: 'hidden' });
  });
});

describe('maxQuantity', () => {
  it('is the per-person limit, capped by what is left', () => {
    expect(maxQuantity(stock('LIVE', 50), 2)).toBe(2);
    expect(maxQuantity(stock('LIVE', 1), 3)).toBe(1);
    expect(maxQuantity(stock('LIVE', 0), 3)).toBe(1);
  });
});

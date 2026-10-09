import { describe, expect, it } from 'vitest';
import { NO_CLAIM } from './hold';
import { buyAction, maxQuantity, purchaseRow } from './purchase';
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

describe('purchaseRow', () => {
  const held = {
    id: 'held',
    qty: 1,
    createdAt: '2026-10-02T19:00:00.000Z',
    expiresAt: '2026-10-02T19:02:00.000Z',
  };

  it('leads every live hold to its checkout, with what the limit still leaves to add', () => {
    expect(purchaseRow({ ...NO_CLAIM, held }, 2, false)).toEqual({ kind: 'checkout', held, room: 1 });
    expect(purchaseRow({ ...NO_CLAIM, held }, 1, false)).toEqual({ kind: 'checkout', held, room: 0 });
    expect(purchaseRow({ held, placedQty: 1, lastPlacedId: 'paid' }, 3, false)).toEqual({
      kind: 'checkout',
      held,
      room: 1,
    });
  });

  it('says the buyer has their units once placed orders take the limit, instead of offering Buy', () => {
    expect(purchaseRow({ held: null, placedQty: 1, lastPlacedId: 'paid' }, 1, false)).toEqual({
      kind: 'have-limit',
      lastPlacedId: 'paid',
    });
    expect(purchaseRow({ held: null, placedQty: 2, lastPlacedId: 'paid' }, 2, false).kind).toBe('have-limit');
  });

  it('says so at once after api refused a press at the limit, before the page knows why', () => {
    expect(purchaseRow(NO_CLAIM, 2, true)).toEqual({ kind: 'have-limit', lastPlacedId: null });
  });

  it('offers Buy for what the limit leaves after placed orders', () => {
    expect(purchaseRow(NO_CLAIM, 3, false)).toEqual({ kind: 'buy', room: 3 });
    expect(purchaseRow({ held: null, placedQty: 1, lastPlacedId: 'paid' }, 3, false)).toEqual({
      kind: 'buy',
      room: 2,
    });
  });
});

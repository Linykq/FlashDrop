import { describe, expect, it } from 'vitest';
import { reserveNote } from './reserve-copy';
import type { StockState } from './stock';

const live = (avail: number, held: number, sold = 0): StockState => ({ status: 'LIVE', avail, held, sold });
const context = { perUserLimit: 2, stock: live(5, 0) };

describe('reserveNote', () => {
  it('states final refusals calmly, in the copy of design-system §12.2', () => {
    expect(reserveNote({ kind: 'refused', code: 'LIMIT_REACHED', qty: 1 }, context).text).toBe(
      "You've reached the limit of 2 for this drop.",
    );
    expect(reserveNote({ kind: 'refused', code: 'DROP_NOT_LIVE', qty: 1 }, context).text).toBe(
      "This drop isn't live right now.",
    );
    expect(reserveNote({ kind: 'refused', code: 'RESERVATION_EXPIRED', qty: 1 }, context)).toMatchObject({
      tone: 'neutral',
      text: 'That reservation expired. Try again if any are left.',
    });
  });

  describe('SOLD_OUT, worded from the stock refreshed after the refusal', () => {
    const soldOut = (qty: number, stock: StockState) =>
      reserveNote({ kind: 'refused', code: 'SOLD_OUT', qty }, { perUserLimit: 2, stock });

    it('says sold out only when every unit is sold', () => {
      expect(soldOut(1, live(0, 0, 10))).toEqual({
        tone: 'neutral',
        glyph: 'not-reserved',
        text: 'Sold out. Every unit has been claimed.',
      });
    });

    it('says the last units are in carts when they may still free up', () => {
      expect(soldOut(1, live(0, 1, 9))).toEqual({
        tone: 'neutral',
        glyph: 'not-reserved',
        text: 'All reserved right now. Some may free up.',
      });
    });

    it('offers what is left when a press asked for more', () => {
      expect(soldOut(2, live(1, 1, 8))).toEqual({
        tone: 'neutral',
        glyph: 'info',
        text: 'Only 1 left now. We set your quantity to 1.',
      });
    });

    it('says the stock changed when enough came back before the refresh', () => {
      expect(soldOut(2, live(2, 0, 8)).text).toBe('Stock just changed. Try again.');
      expect(soldOut(1, live(3, 0, 7)).text).toBe('Stock just changed. Try again.');
    });
  });

  it('asks to slow down after the rate limit, and to try again when the request failed', () => {
    expect(reserveNote({ kind: 'unavailable', cause: 'rate-limited' }, context)).toMatchObject({
      tone: 'warning',
      text: 'Too many tries. Wait a moment, then try again.',
    });
    expect(reserveNote({ kind: 'unavailable', cause: 'busy' }, context)).toMatchObject({
      tone: 'danger',
      text: "We couldn't reserve right now. Try again.",
    });
    expect(reserveNote({ kind: 'unavailable', cause: 'offline' }, context).text).toBe(
      "You're offline. Check your connection and try again.",
    );
    expect(reserveNote({ kind: 'failed' }, context).tone).toBe('danger');
    expect(reserveNote({ kind: 'refused', code: 'IDEMPOTENCY_KEY_REUSED', qty: 1 }, context).text).toBe(
      "Something didn't match. Refresh the page and try again.",
    );
  });
});

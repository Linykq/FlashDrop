import { describe, expect, it } from 'vitest';
import { describeStock, isUrgent, type StockState } from './stock';

// 500 units in total.
const live = (avail: number, held: number): StockState => ({
  status: 'LIVE',
  avail,
  held,
  sold: 500 - avail - held,
});

describe('isUrgent', () => {
  it('uses the larger of 5 units and 10% of the total', () => {
    expect(isUrgent(50, 500)).toBe(true);
    expect(isUrgent(51, 500)).toBe(false);
    expect(isUrgent(5, 20)).toBe(true);
    expect(isUrgent(6, 20)).toBe(false);
    expect(isUrgent(11, 101)).toBe(true);
    expect(isUrgent(0, 500)).toBe(false);
  });
});

describe('describeStock', () => {
  it('says "{N} left" above the urgent threshold and "Only {N} left" at it', () => {
    expect(describeStock(live(488, 0))).toEqual({
      primary: '488 left',
      secondary: '12 of 500 claimed',
      urgent: false,
      showMeter: true,
    });
    expect(describeStock(live(12, 3))).toMatchObject({
      primary: 'Only 12 left',
      secondary: '488 of 500 claimed',
      urgent: true,
    });
  });

  it('separates all reserved from sold out', () => {
    expect(describeStock(live(0, 1))).toMatchObject({
      primary: 'All reserved',
      secondary: '1 in a cart, may free up',
      urgent: false,
    });
    expect(describeStock(live(0, 3))).toMatchObject({ secondary: '3 in carts, may free up' });
    expect(describeStock(live(0, 0))).toMatchObject({ primary: 'Sold out', secondary: 'All 500 sold' });
  });

  it('leaves the primary line to the countdown before the drop opens and hides the meter', () => {
    expect(describeStock({ status: 'SCHEDULED', avail: 500, held: 0, sold: 0 })).toEqual({
      primary: null,
      secondary: '500 available',
      urgent: false,
      showMeter: false,
    });
  });

  it('describes paused and ended drops', () => {
    expect(describeStock({ ...live(20, 2), status: 'PAUSED' }).primary).toBe('Paused');
    expect(describeStock({ ...live(18, 0), status: 'ENDED' })).toMatchObject({
      primary: 'Drop ended',
      secondary: '482 of 500 sold',
    });
  });
});

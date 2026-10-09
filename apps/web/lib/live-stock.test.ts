import { describe, expect, it } from 'vitest';
import { parseSnapshot, stockAnnouncement } from './live-stock';
import type { StockState } from './stock';

describe('parseSnapshot', () => {
  const body = {
    avail: 12,
    held: 3,
    sold: 485,
    status: 'LIVE',
    gen: 2,
    seq: 41,
    serverNow: '2026-10-02T19:00:00.000Z',
  };

  it('reads a stock snapshot', () => {
    expect(parseSnapshot(body)).toEqual({ avail: 12, held: 3, sold: 485, status: 'LIVE', gen: 2, seq: 41 });
    expect(parseSnapshot({ ...body, status: 'RECONCILING', gen: -1 })).toMatchObject({
      status: 'RECONCILING',
      gen: -1,
    });
  });

  it.each([
    ['null', null],
    ['a problem body', { code: 'RETRY', status: 503 }],
    ['an unknown status', { ...body, status: 'DRAFT' }],
    ['a negative count', { ...body, avail: -1 }],
    ['a fractional count', { ...body, held: 1.5 }],
    ['a numeric string', { ...body, sold: '485' }],
    ['a gen below -1', { ...body, gen: -2 }],
    ['a missing seq', { ...body, seq: undefined }],
  ])('refuses %s', (_name, value) => {
    expect(parseSnapshot(value)).toBeNull();
  });
});

describe('stockAnnouncement', () => {
  const live = (avail: number, held = 0): StockState => ({ status: 'LIVE', avail, held, sold: 50 });

  it('announces threshold crossings with the actual number, and nothing in between', () => {
    expect(stockAnnouncement(live(12), live(11))).toBeNull();
    expect(stockAnnouncement(live(11), live(10))).toBe('10 left.');
    expect(stockAnnouncement(live(12), live(8))).toBe('8 left.');
    expect(stockAnnouncement(live(8), live(6))).toBeNull();
    expect(stockAnnouncement(live(6), live(5))).toBe('5 left.');
    expect(stockAnnouncement(live(2), live(1))).toBe('1 left.');
    expect(stockAnnouncement(live(4), live(6))).toBeNull();
  });

  it('announces all reserved, sold out and availability returning', () => {
    expect(stockAnnouncement(live(1), live(0, 3))).toBe('All reserved. Some may free up.');
    expect(stockAnnouncement(live(1), live(0, 0))).toBe('Sold out.');
    expect(stockAnnouncement(live(0, 2), live(0, 0))).toBe('Sold out.');
    expect(stockAnnouncement(live(0, 2), live(0, 1))).toBeNull();
    expect(stockAnnouncement(live(0, 2), live(2, 0))).toBe('Available again. 2 left.');
  });

  it('stays quiet outside a live drop', () => {
    expect(stockAnnouncement({ ...live(5), status: 'SCHEDULED' }, live(5))).toBeNull();
    expect(stockAnnouncement(live(5), { ...live(0), status: 'ENDED' })).toBeNull();
  });
});

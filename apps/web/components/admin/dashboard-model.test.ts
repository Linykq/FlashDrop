import type { DashboardTotals, SalesMinute } from '@flashdrop/contracts';
import { describe, expect, it } from 'vitest';
import {
  funnel,
  MAX_POINTS,
  minutePace,
  niceTicks,
  peakMinute,
  sellOutSeconds,
  stockLeftLine,
  unitsPerMinute,
  unsoldTile,
} from './dashboard-model';

const ZERO = {
  reserved: 0,
  placed: 0,
  paid: 0,
  failed: 0,
  expired: 0,
  cancelled: 0,
  rejected: 0,
  unitsSold: 0,
  revenueCents: 0,
};

const minute = (iso: string, unitsSold: number): SalesMinute => ({ ...ZERO, minute: iso, unitsSold });
const label = (iso: string) => iso.slice(11, 16);

describe('dashboard model', () => {
  it('fills the minutes without sales and runs to now while the drop sells', () => {
    const spec = unitsPerMinute(
      [minute('2026-10-06T19:00:00.000Z', 40), minute('2026-10-06T19:02:00.000Z', 12)],
      Date.parse('2026-10-06T19:03:30.000Z'),
      label,
    );
    expect(spec.points.map((point) => [point.label, point.value, point.partial, point.pace])).toEqual([
      ['19:00', 40, false, null],
      ['19:01', 0, false, null],
      ['19:02', 12, false, null],
      // Still counting: drawn apart at its pace, so half a minute doesn't read as a fall in sales.
      ['19:03', 0, true, 0],
    ]);
    expect(peakMinute(spec)).toMatchObject({ label: '19:00', value: 40 });
    expect(spec.ticks).toEqual([0, 10, 20, 30, 40]);
  });

  it('marks no minute partial once the drop stopped selling', () => {
    const spec = unitsPerMinute([minute('2026-10-06T19:00:00.000Z', 3)], null, label);
    expect(spec.points.map((point) => point.partial)).toEqual([false]);
  });

  it('puts round ticks on the value axis, up to the first one at or above the peak', () => {
    expect(niceTicks(140)).toEqual([0, 50, 100, 150]);
    expect(niceTicks(150)).toEqual([0, 50, 100, 150]);
    expect(niceTicks(7)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(3)).toEqual([0, 1, 2, 3]);
    // Whole units only, and an axis even when nothing sold.
    expect(niceTicks(1)).toEqual([0, 1]);
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(1_234)).toEqual([0, 500, 1_000, 1_500]);
  });

  it('words what is left before a sell-out, without "0 left" while units sit in carts', () => {
    expect(stockLeftLine(12, 6)).toBe('12 left');
    expect(stockLeftLine(0, 3)).toBe('All reserved · 3 in carts');
    expect(stockLeftLine(0, 0)).toBe('0 left');
  });

  it('labels the sell-out tile by its state before a sell-out, never a duration under "Time to sell-out"', () => {
    const drop = { startsAt: '2026-10-06T19:00:00.000Z', endsAt: '2026-10-06T19:30:00.000Z' };
    const at = Date.parse('2026-10-06T19:13:42.000Z');
    expect(unsoldTile({ ...drop, status: 'LIVE' }, at, { avail: 8, held: 2 })).toEqual({
      label: 'Selling for',
      value: '13m',
      sub: 'Not sold out · 8 left',
    });
    expect(
      unsoldTile({ ...drop, status: 'LIVE' }, Date.parse('2026-10-06T19:00:42.000Z'), { avail: 0, held: 4 }),
    ).toEqual({ label: 'Selling for', value: '42s', sub: 'All reserved · 4 in carts' });
    expect(unsoldTile({ ...drop, status: 'ENDED' }, at, { avail: 8, held: 0 })).toEqual({
      label: 'Ran for',
      value: '30m',
      sub: 'Not sold out · 8 left',
    });
    expect(unsoldTile({ ...drop, status: 'SCHEDULED' }, at, { avail: 12, held: 0 })).toEqual({
      label: 'Time to sell-out',
      value: 'Not open',
      sub: '12 left',
    });
  });

  it('plots the running minute at its pace, starting from the minute before', () => {
    // At the minute's start the pace is the last closed minute's: no dive at the boundary.
    expect(minutePace(0, 118, 0)).toBe(118);
    // A few seconds in, a burst still at 120 a minute stays near 120, rather than the 2 sold so far.
    expect(minutePace(2, 120, 1_000)).toBe(120);
    // From 15 s the minute stands alone: 30 in 15 s is a pace of 120; 3 in 30 s, after a burst, is 6.
    expect(minutePace(30, 0, 15_000)).toBe(120);
    expect(minutePace(3, 118, 30_000)).toBe(6);
    // Never below what it sold, and a clock a little ahead or behind stays within the minute.
    expect(minutePace(50, 0, 60_000)).toBe(50);
    expect(minutePace(50, 0, 75_000)).toBe(50);
    expect(minutePace(0, 10, -2_000)).toBe(10);

    const spec = unitsPerMinute(
      [minute('2026-10-06T19:00:00.000Z', 118), minute('2026-10-06T19:01:00.000Z', 15)],
      Date.parse('2026-10-06T19:01:07.500Z'),
      label,
    );
    expect(spec.points.map((point) => [point.value, point.partial, point.pace])).toEqual([
      [118, false, null],
      [15, true, 119],
    ]);
    // The axis has room for the pace.
    expect(spec.ticks.at(-1)).toBeGreaterThanOrEqual(119);
  });

  it('keeps the last three hours of a long series, and nothing before the first event', () => {
    const spec = unitsPerMinute(
      [minute('2026-10-06T10:00:00.000Z', 1), minute('2026-10-06T19:00:00.000Z', 2)],
      null,
      label,
    );
    expect(spec.points).toHaveLength(MAX_POINTS);
    expect(spec.points.at(-1)?.label).toBe('19:00');
    expect(unitsPerMinute([], Date.now(), label).points).toEqual([]);
    expect(peakMinute(unitsPerMinute([minute('2026-10-06T19:00:00.000Z', 0)], null, label))).toBeNull();
  });

  it('lays out the funnel in order, flow first', () => {
    const totals: DashboardTotals = {
      ...ZERO,
      reserved: 646,
      placed: 512,
      paid: 470,
      expired: 111,
      cancelled: 44,
      failed: 15,
      rejected: 9,
      lastEventAt: null,
    };
    expect(funnel(totals).bars.map((bar) => `${bar.label}:${bar.value}:${bar.kind}`)).toEqual([
      'Reserved:646:flow',
      'Placed:512:flow',
      'Paid:470:flow',
      'Expired:111:outcome',
      'Cancelled:44:outcome',
      'Failed:15:outcome',
      'Rejected:9:outcome',
    ]);
  });

  it('measures time to sell-out to the end of the sold-out minute', () => {
    expect(sellOutSeconds('2026-10-06T19:00:00.000Z', null)).toBeNull();
    expect(sellOutSeconds('2026-10-06T19:00:00.000Z', '2026-10-06T19:04:00.000Z')).toBe(300);
  });
});

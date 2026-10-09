import { describe, expect, it } from 'vitest';
import { DashboardTotalsMessage, isNewerTotals, SALES_COUNTERS, type SalesCounters } from './dashboard';

const ZERO: SalesCounters = {
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

const message = (version: number, paid: number): DashboardTotalsMessage => ({
  version,
  totals: { ...ZERO, paid, unitsSold: paid, revenueCents: paid * 1_999, lastEventAt: null },
});

/** What a client or the gateway keeps after `frames` arrive in that order (§9: only strictly newer wins). */
function keep(frames: readonly DashboardTotalsMessage[]): DashboardTotalsMessage | null {
  let current: DashboardTotalsMessage | null = null;
  for (const frame of frames) if (isNewerTotals(current, frame)) current = frame;
  return current;
}

describe('dashboard version ordering (§9)', () => {
  it('ignores a late publish of older totals, as from a zombie consumer after a rebalance', () => {
    expect(keep([message(3, 30), message(5, 50), message(4, 40)])).toEqual(message(5, 50));
  });

  it('treats a duplicate publish as nothing new', () => {
    const latest = message(7, 70);
    expect(isNewerTotals(latest, message(7, 70))).toBe(false);
    expect(keep([latest, message(7, 70)])).toBe(latest);
  });

  it('accepts the zeroed totals of a dash:rebuild, whose version is higher, then the replay', () => {
    expect(keep([message(9, 90), message(10, 0), message(11, 25)])).toEqual(message(11, 25));
  });

  it('takes the first frame of any version, 0 included', () => {
    expect(isNewerTotals(null, message(0, 0))).toBe(true);
  });
});

describe('DashboardTotalsMessage', () => {
  it('round-trips what the projection publishes', () => {
    const published = {
      version: 12,
      totals: {
        ...ZERO,
        reserved: 4,
        placed: 3,
        paid: 2,
        unitsSold: 3,
        revenueCents: 5_997,
        lastEventAt: null,
      },
    };
    expect(DashboardTotalsMessage.parse(JSON.parse(JSON.stringify(published)))).toEqual(published);
  });

  it('refuses negative counters and fractional versions', () => {
    expect(DashboardTotalsMessage.safeParse(message(1.5, 1)).success).toBe(false);
    expect(
      DashboardTotalsMessage.safeParse({ version: 1, totals: { ...message(1, 1).totals, paid: -1 } }).success,
    ).toBe(false);
  });

  it('lists every counter once', () => {
    expect([...SALES_COUNTERS].sort()).toEqual(Object.keys(ZERO).sort());
  });
});

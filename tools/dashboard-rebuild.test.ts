import type { DashboardTotalsMessage, SalesCounters } from '@flashdrop/contracts';
import type { DashboardCheck } from '@flashdrop/db';
import { describe, expect, it } from 'vitest';
import { judgeReplay, totalsDifferences } from './dashboard-rebuild';

const A = '0192a3b4-0000-4000-8000-00000000d001';
const B = '0192a3b4-0000-4000-8000-00000000d002';
const C = '0192a3b4-0000-4000-8000-00000000d003';

const counters = (paid: number): SalesCounters => ({
  reserved: paid,
  placed: paid,
  paid,
  failed: 0,
  expired: 0,
  cancelled: 0,
  rejected: 0,
  unitsSold: paid,
  revenueCents: paid * 1_999,
});

const totals = (version: number, paid: number): DashboardTotalsMessage => ({
  version,
  totals: { ...counters(paid), lastEventAt: null },
});

const check = (projected: number, orders: number, eventlessPastRetention = 0): DashboardCheck => ({
  totals: counters(projected),
  minutes: counters(projected),
  truth: counters(orders),
  eventless: eventlessPastRetention,
  eventlessPastRetention,
});

describe('totalsDifferences', () => {
  it('ignores versions: a replay counts again from a higher version', () => {
    expect(totalsDifferences(new Map([[A, totals(40, 7)]]), new Map([[A, totals(53, 7)]]))).toEqual([]);
  });

  it('names each counter that changed, and drops that appeared or vanished', () => {
    const before = new Map([[A, totals(4, 3)]]);
    const after = new Map([
      [A, totals(9, 2)],
      [B, totals(1, 1)],
    ]);

    expect(totalsDifferences(before, after)).toEqual([
      {
        dropId: A,
        detail: 'reserved 3 -> 2, placed 3 -> 2, paid 3 -> 2, unitsSold 3 -> 2, revenueCents 5997 -> 3998',
      },
      {
        dropId: B,
        detail: 'reserved 0 -> 1, placed 0 -> 1, paid 0 -> 1, unitsSold 0 -> 1, revenueCents 0 -> 1999',
      },
    ]);
  });
});

describe('judgeReplay', () => {
  // The rebuild's regression: totals that grew because orders were placed (or events were still lagging)
  // across the rebuild are not a failed replay when the projection equals the drop's orders.
  it('accepts a drop that changed across the rebuild when its replay equals its orders', () => {
    expect(judgeReplay(new Map([[A, check(5, 5)]]))).toEqual({
      agree: [A],
      disagree: new Map(),
      skipped: new Map(),
    });
  });

  it('rejects a replay that disagrees with the orders, and reports a drop INV-5 cannot judge', () => {
    const judgement = judgeReplay(
      new Map([
        [A, check(4, 5)],
        [B, check(5, 5)],
        [C, check(1, 2, 3)],
      ]),
    );

    expect(judgement.agree).toEqual([B]);
    expect([...judgement.disagree.keys()]).toEqual([A]);
    expect(judgement.disagree.get(A)).toContain('dashboard paid 4 != 5 from its orders');
    expect(judgement.skipped).toEqual(
      new Map([[C, "3 orders older than the outbox's retention have no events left"]]),
    );
  });
});

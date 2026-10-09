import type { DashboardTotalsMessage, SalesCounters } from '@flashdrop/contracts';
import type { DashboardCheck } from '@flashdrop/db';
import { describe, expect, it } from 'vitest';
import { judgeReplay, ordersMissing, totalsDifferences } from './dashboard-rebuild';

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

/** `projected` orders on the dashboard; `orders` with their events in the outbox, `pastRetention` without. */
const check = (projected: number, orders: number, pastRetention = 0): DashboardCheck => ({
  totals: counters(projected),
  minutes: counters(projected),
  truth: counters(orders),
  eventless: pastRetention,
  eventlessPastRetention: pastRetention,
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
      lost: new Map(),
      disagree: new Map(),
      skipped: new Map(),
    });
  });

  it('rejects a replay that counts every order but not as its orders say', () => {
    const wrong: DashboardCheck = { ...check(5, 5), totals: { ...counters(5), paid: 4, failed: 1 } };
    const judgement = judgeReplay(new Map([[A, wrong]]));

    expect(judgement.lost).toEqual(new Map());
    expect(judgement.disagree.get(A)).toContain('dashboard paid 4 != 5 from its orders');
  });

  // The review's regression: a topic recreated after the seed published its sales replays without them,
  // and the projection came back identical (zero), so the rebuild reported every drop identical while the
  // sold-out drop's dashboard showed no orders at all. Its orders are past the outbox's retention, where
  // INV-5 cannot compare, but they are still orders the dashboard must count.
  it('reports a dashboard short of orders the topic no longer holds, even where INV-5 cannot compare', () => {
    const judgement = judgeReplay(
      new Map([
        [A, check(0, 0, 5)],
        [B, check(3, 5)],
      ]),
    );

    expect(judgement.lost).toEqual(
      new Map([
        [A, 5],
        [B, 2],
      ]),
    );
    expect(judgement.agree).toEqual([]);
    expect(judgement.disagree).toEqual(new Map());
  });

  it('accepts a drop past retention that counts every order, but cannot compare it counter by counter', () => {
    const counted: DashboardCheck = { ...check(5, 0, 5), totals: counters(5) };
    const judgement = judgeReplay(new Map([[C, counted]]));

    expect(judgement.lost).toEqual(new Map());
    expect(judgement.skipped).toEqual(
      new Map([[C, "5 orders older than the outbox's retention have no events left"]]),
    );
  });
});

describe('ordersMissing', () => {
  // 3 reserved and 2 rejected orders with their events, and 1 past retention: 6 orders.
  const sixOrders: DashboardCheck = { ...check(0, 3, 1), truth: { ...counters(3), rejected: 2 } };

  it('counts every order once, reserved or rejected, with its events or without', () => {
    expect(ordersMissing({ ...sixOrders, totals: { ...counters(4), rejected: 2 } })).toBe(0);
    expect(ordersMissing({ ...sixOrders, totals: { ...counters(3), rejected: 2 } })).toBe(1);
    expect(ordersMissing(sixOrders)).toBe(6);
  });

  it('never goes below zero: orders placed after the read are counted already', () => {
    expect(ordersMissing(check(6, 5))).toBe(0);
  });
});

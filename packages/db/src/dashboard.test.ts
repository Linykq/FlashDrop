import { randomUUID } from 'node:crypto';
import type { OrderEvent, SalesCounters } from '@flashdrop/contracts';
import { describe, expect, it } from 'vitest';
import { foldSalesEvents, minuteOf } from './dashboard';

const DROP = '0192a3b4-0000-4000-8000-00000000d001';
const OTHER_DROP = '0192a3b4-0000-4000-8000-00000000d002';
const PRODUCT = '0192a3b4-0000-4000-8000-00000000f001';
const USER = '0192a3b4-0000-4000-8000-00000000a001';

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

function base(occurredAt: string, dropId = DROP) {
  return {
    eventId: randomUUID(),
    schemaVersion: 1 as const,
    occurredAt,
    orderId: randomUUID(),
    orderVersion: 1,
    productId: PRODUCT,
    dropId,
    userId: USER,
  };
}

/** One order's whole happy path: reserved, placed, paid, with `qty` units at 19.99. */
function purchase(at: string, qty = 1, dropId = DROP): OrderEvent[] {
  const order = base(at, dropId);
  const later = (seconds: number) => new Date(Date.parse(at) + seconds * 1000).toISOString();
  return [
    {
      ...order,
      type: 'order.reserved',
      data: { qty, unitPriceCents: 1_999, expiresAt: later(120) },
    },
    {
      ...order,
      eventId: randomUUID(),
      occurredAt: later(30),
      orderVersion: 2,
      type: 'order.placed',
      data: { qty, totalCents: qty * 1_999, currency: 'USD', paymentMethod: 'pm_ok', expiresAt: later(330) },
    },
    {
      ...order,
      eventId: randomUUID(),
      occurredAt: later(32),
      orderVersion: 3,
      type: 'order.paid',
      data: { qty, totalCents: qty * 1_999, pspChargeId: `ch_${order.orderId}` },
    },
  ];
}

describe('minuteOf', () => {
  it('buckets by the event’s own minute, in UTC', () => {
    expect(minuteOf('2026-10-09T18:04:59.999Z')).toBe('2026-10-09T18:04:00.000Z');
    expect(minuteOf('2026-10-09T18:05:00.000Z')).toBe('2026-10-09T18:05:00.000Z');
    expect(minuteOf('2026-10-09T20:05:30.000+02:00')).toBe('2026-10-09T18:05:00.000Z');
  });
});

describe('foldSalesEvents (§9)', () => {
  it('counts each event once in its stage, and units and revenue only on payment', () => {
    const order = base('2026-10-09T18:00:10.000Z');
    const events: OrderEvent[] = [
      ...purchase('2026-10-09T18:00:00.000Z', 2),
      {
        ...order,
        type: 'order.reserved',
        data: { qty: 1, unitPriceCents: 1_999, expiresAt: order.occurredAt },
      },
      { ...order, eventId: randomUUID(), type: 'order.expired', data: { qty: 1, fromStatus: 'RESERVED' } },
      { ...base('2026-10-09T18:00:20.000Z'), type: 'order.rejected', data: { qty: 1, reason: 'SOLD_OUT' } },
      {
        ...base('2026-10-09T18:00:30.000Z'),
        type: 'order.payment_failed',
        data: { qty: 1, declineCode: 'card_declined' },
      },
      {
        ...base('2026-10-09T18:00:40.000Z'),
        type: 'order.cancelled',
        data: { qty: 1, fromStatus: 'PENDING_PAYMENT' },
      },
    ];

    const delta = foldSalesEvents(events).get(DROP);

    expect(delta?.totals).toEqual({
      reserved: 2,
      placed: 1,
      paid: 1,
      failed: 1,
      expired: 1,
      cancelled: 1,
      rejected: 1,
      unitsSold: 2,
      revenueCents: 3_998,
    });
    expect(delta?.lastEventAt).toBe('2026-10-09T18:00:40.000Z');
  });

  it('buckets by event time, so an order that spans minutes lands in each of them', () => {
    const delta = foldSalesEvents(purchase('2026-10-09T18:00:45.000Z')).get(DROP);

    expect(Object.fromEntries(delta?.minutes ?? [])).toEqual({
      '2026-10-09T18:00:00.000Z': { ...ZERO, reserved: 1 },
      '2026-10-09T18:01:00.000Z': { ...ZERO, placed: 1, paid: 1, unitsSold: 1, revenueCents: 1_999 },
    });
  });

  it('keeps drops apart, whatever case their ids arrive in', () => {
    const folded = foldSalesEvents([
      ...purchase('2026-10-09T18:00:00.000Z', 1, DROP),
      ...purchase('2026-10-09T18:00:00.000Z', 3, OTHER_DROP.toUpperCase()),
    ]);

    expect([...folded.keys()]).toEqual([DROP, OTHER_DROP]);
    expect(folded.get(OTHER_DROP)?.totals.unitsSold).toBe(3);
  });

  it('gives the same deltas for any order of the same events: a replay folds identically', () => {
    const events = Array.from({ length: 20 }, (_, i) =>
      purchase(new Date(Date.parse('2026-10-09T18:00:00.000Z') + i * 17_000).toISOString(), (i % 3) + 1),
    ).flat();
    const shuffled = [...events].sort(() => Math.random() - 0.5);
    const asPlain = (folded: ReturnType<typeof foldSalesEvents>) =>
      [...folded.values()].map((delta) => ({
        ...delta,
        minutes: [...delta.minutes].sort(([a], [b]) => a.localeCompare(b)),
      }));

    expect(asPlain(foldSalesEvents(shuffled))).toEqual(asPlain(foldSalesEvents(events)));
    expect(foldSalesEvents(events).get(DROP)?.totals).toMatchObject({ paid: 20, unitsSold: 39 });
  });

  it('folds nothing into nothing', () => {
    expect(foldSalesEvents([]).size).toBe(0);
  });
});

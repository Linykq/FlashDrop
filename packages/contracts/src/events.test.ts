import { describe, expect, it } from 'vitest';
import { ORDER_EVENT_TYPES, OrderEvent, type OrderEventType } from './events';

const base = {
  eventId: '0198a3c4-1f2e-7a10-8b2c-3d4e5f607182',
  schemaVersion: 1,
  occurredAt: '2026-10-02T12:00:00.123456Z',
  orderId: '1b4e28ba-2fa1-5ed2-883f-0e8a9b3c4d5e',
  orderVersion: 1,
  productId: '5eed0003-0000-4000-8000-000000000002',
  dropId: '5eed0004-0000-4000-8000-000000000001',
  userId: '5eed0001-0000-4000-8000-000000000002',
} as const;

const DATA: Record<OrderEventType, Record<string, unknown>> = {
  'order.reserved': { qty: 2, unitPriceCents: 14900, expiresAt: '2026-10-02T12:02:00.000Z' },
  'order.placed': {
    qty: 2,
    totalCents: 29800,
    currency: 'USD',
    paymentMethod: 'pm_ok',
    expiresAt: '2026-10-02T12:07:00.000Z',
  },
  'order.paid': { qty: 2, totalCents: 29800, pspChargeId: 'ch_123' },
  'order.payment_failed': { qty: 2, declineCode: 'card_declined' },
  'order.expired': { qty: 2, fromStatus: 'RESERVED' },
  'order.cancelled': { qty: 2, fromStatus: 'PENDING_PAYMENT' },
  'order.rejected': { qty: 2, reason: 'SOLD_OUT' },
};

describe('OrderEvent (§6.2)', () => {
  it('lists every type of the union, in lifecycle order', () => {
    expect(OrderEvent.options.map((option) => option.shape.type.value)).toEqual(ORDER_EVENT_TYPES);
  });

  it.each(ORDER_EVENT_TYPES)('round-trips %s through JSON', (type) => {
    const event = { ...base, type, traceId: 'trace-1', data: DATA[type] };

    const parsed = OrderEvent.parse(JSON.parse(JSON.stringify(event)));

    expect(parsed).toEqual(event);
    expect(OrderEvent.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it('carries every reason a REJECTED order can have, NOT_LIVE included', () => {
    for (const reason of ['SOLD_OUT', 'LIMIT', 'NOT_LIVE', 'ORPHANED']) {
      expect(
        OrderEvent.safeParse({ ...base, type: 'order.rejected', data: { qty: 1, reason } }).success,
      ).toBe(true);
    }
    expect(
      OrderEvent.safeParse({ ...base, type: 'order.rejected', data: { qty: 1, reason: 'TIMEOUT' } }).success,
    ).toBe(false);
  });

  it.each([
    ['an unknown type', { ...base, type: 'order.shipped', data: {} }],
    ['another schema version', { ...base, schemaVersion: 2, type: 'order.paid', data: DATA['order.paid'] }],
    ['a qty out of range', { ...base, type: 'order.expired', data: { qty: 11, fromStatus: 'RESERVED' } }],
    ['a terminal fromStatus', { ...base, type: 'order.cancelled', data: { qty: 1, fromStatus: 'PAID' } }],
    ['a zero version', { ...base, orderVersion: 0, type: 'order.paid', data: DATA['order.paid'] }],
    [
      'an offset timestamp',
      { ...base, occurredAt: '2026-10-02T12:00:00+02:00', type: 'order.paid', data: DATA['order.paid'] },
    ],
    ['a missing id', { ...base, productId: undefined, type: 'order.paid', data: DATA['order.paid'] }],
  ])('refuses %s', (_case, event) => {
    expect(OrderEvent.safeParse(event).success).toBe(false);
  });
});

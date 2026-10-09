import { checkoutFingerprint } from '@flashdrop/domain/identity';
import { describe, expect, it } from 'vitest';
import { CheckoutBody, OrderDetail, ShippingAddress } from './checkout';
import { PspChargeResponse, PspCloseResponse, PspIdempotencyKey } from './psp';
import { OrderStatusMessage } from './realtime';

const ORDER_ID = '1b4e28ba-2fa1-5ed2-883f-0e8a9b3c4d5e';
/** The shape the seed stores on its PAID orders (packages/db seed plan). */
const SEEDED = {
  name: 'Mira Chen',
  line1: '1 Market Street',
  city: 'San Francisco',
  postalCode: '94105',
  country: 'US',
};

describe('ShippingAddress (§5.2)', () => {
  it("parses the seeded orders' shipping unchanged, so their checkout hash still matches", () => {
    expect(ShippingAddress.parse(SEEDED)).toEqual(SEEDED);
    expect(
      checkoutFingerprint({
        orderId: ORDER_ID,
        shipping: ShippingAddress.parse(SEEDED),
        paymentMethod: 'pm_ok',
      }),
    ).toEqual(checkoutFingerprint({ orderId: ORDER_ID, shipping: SEEDED, paymentMethod: 'pm_ok' }));
  });

  it('normalizes what a retry may spell differently, so the fingerprint does not change', () => {
    const typed = {
      name: '  Mira Chen ',
      line1: '1 Market Street',
      line2: '   ',
      city: 'San Francisco',
      state: '',
      postalCode: ' 94105',
      country: 'us',
      note: 'unknown fields are dropped',
    };

    const parsed = CheckoutBody.parse({ shipping: typed, paymentMethod: 'pm_ok' });

    expect(parsed.shipping).toEqual(SEEDED);
    expect(checkoutFingerprint({ orderId: ORDER_ID, ...parsed })).toEqual(
      checkoutFingerprint({ orderId: ORDER_ID, shipping: SEEDED, paymentMethod: 'pm_ok' }),
    );
  });

  it('keeps the optional lines when they are filled in', () => {
    expect(ShippingAddress.parse({ ...SEEDED, line2: 'Suite 400', state: 'CA' })).toEqual({
      ...SEEDED,
      line2: 'Suite 400',
      state: 'CA',
    });
  });

  it('reports each missing or malformed field by its path', () => {
    const result = ShippingAddress.safeParse({
      name: ' ',
      line1: 'x',
      city: '',
      postalCode: '#1',
      country: 'USA',
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.')).sort()).toEqual(
      ['city', 'country', 'name', 'postalCode'].sort(),
    );
  });

  it('accepts the four test payment methods only', () => {
    for (const paymentMethod of ['pm_ok', 'pm_decline', 'pm_slow', 'pm_flaky']) {
      expect(CheckoutBody.safeParse({ shipping: SEEDED, paymentMethod }).success).toBe(true);
    }
    expect(CheckoutBody.safeParse({ shipping: SEEDED, paymentMethod: 'visa' }).success).toBe(false);
  });
});

describe('OrderDetail', () => {
  it('describes an order before checkout with null checkout details', () => {
    const detail = {
      id: ORDER_ID,
      status: 'EXPIRED',
      closeReason: 'TIMEOUT',
      dropId: '5eed0004-0000-4000-8000-000000000001',
      product: { id: '5eed0003-0000-4000-8000-000000000002', slug: 'sage', title: 'Sage', imageKeys: [] },
      qty: 1,
      unitPriceCents: 14900,
      totalCents: 14900,
      currency: 'USD',
      expiresAt: '2026-10-02T12:02:00.000Z',
      extensions: 0,
      createdAt: '2026-10-02T12:00:00.000Z',
      serverNow: '2026-10-02T12:03:00.000Z',
      shipping: null,
      paymentMethod: null,
      declineCode: null,
    };

    expect(OrderDetail.parse(detail)).toEqual(detail);
  });
});

describe('PSP mock API (§6.5)', () => {
  it('accepts the consumer idempotency keys, which the order API key format would refuse', () => {
    expect(PspIdempotencyKey.safeParse(`charge:${ORDER_ID}`).success).toBe(true);
    expect(PspIdempotencyKey.safeParse('with space').success).toBe(false);
    expect(PspIdempotencyKey.safeParse('').success).toBe(false);
  });

  it('tells the three charge outcomes apart, and a closed reference has no charge id', () => {
    expect(PspChargeResponse.parse({ status: 'succeeded', id: 'ch_1' })).toEqual({
      status: 'succeeded',
      id: 'ch_1',
    });
    expect(
      PspChargeResponse.parse({ status: 'declined', id: 'ch_2', declineCode: 'card_declined' }).status,
    ).toBe('declined');
    expect(PspChargeResponse.parse({ status: 'reference_closed', declineCode: 'reference_closed' })).toEqual({
      status: 'reference_closed',
      declineCode: 'reference_closed',
    });
    expect(PspChargeResponse.safeParse({ status: 'declined', id: 'ch_2' }).success).toBe(false);
  });

  it('returns a refund as a charge id and an amount together, or neither', () => {
    expect(PspCloseResponse.parse({})).toEqual({});
    expect(PspCloseResponse.parse({ refundedChargeId: 'ch_1', amountCents: 2998 })).toEqual({
      refundedChargeId: 'ch_1',
      amountCents: 2998,
    });
    expect(PspCloseResponse.safeParse({ refundedChargeId: 'ch_1' }).success).toBe(false);
  });
});

describe('OrderStatusMessage (§7)', () => {
  it('round-trips through JSON', () => {
    const message = { type: 'order', orderId: ORDER_ID, status: 'PAID', version: 3 };
    expect(OrderStatusMessage.parse(JSON.parse(JSON.stringify(message)))).toEqual(message);
  });
});

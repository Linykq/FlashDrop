import { describe, expect, it } from 'vitest';
import { CreateDropBody, PatchDropBody } from './admin';
import { IdempotencyKey, OrderListQuery, OrderView, ReserveBody } from './reservations';
import { TestDropBody, TestSessionsBody } from './test-routes';

describe('reservation DTOs', () => {
  it('validate the Idempotency-Key format', () => {
    expect(IdempotencyKey.safeParse('0198a3c4-1f2e-7a10-8b2c-3d4e5f607182').success).toBe(true);
    expect(IdempotencyKey.safeParse('short').success).toBe(false);
    expect(IdempotencyKey.safeParse('with space here').success).toBe(false);
  });

  it('accept a qty of 1 to 10 and drop unknown fields, so they cannot change the fingerprint', () => {
    expect(ReserveBody.parse({ qty: 2, note: 'x' })).toEqual({ qty: 2 });
    for (const qty of [0, 11, 1.5, '2']) expect(ReserveBody.safeParse({ qty }).success).toBe(false);
  });

  it('describe an order with its product and the server clock', () => {
    const view = {
      id: '1b4e28ba-2fa1-5ed2-883f-0e8a9b3c4d5e',
      status: 'RESERVED',
      closeReason: null,
      dropId: '5eed0004-0000-4000-8000-000000000001',
      product: {
        id: '5eed0003-0000-4000-8000-000000000002',
        slug: 'sage-wireless-headphones',
        title: 'Sage Wireless Over-Ear Headphones',
        imageKeys: [],
      },
      qty: 2,
      unitPriceCents: 14900,
      totalCents: 29800,
      currency: 'USD',
      expiresAt: '2026-10-02T12:02:00.000Z',
      extensions: 0,
      createdAt: '2026-10-02T12:00:00.000Z',
      serverNow: '2026-10-02T12:00:00.010Z',
    };

    expect(OrderView.parse(view)).toEqual(view);
    expect(OrderView.safeParse({ ...view, status: 'HELD' }).success).toBe(false);
  });

  it('page my orders 50 at a time by default, 100 at most', () => {
    expect(OrderListQuery.parse({})).toEqual({ limit: 50 });
    expect(OrderListQuery.parse({ limit: '7' })).toEqual({ limit: 7 });
    for (const limit of ['0', '101', 'all']) expect(OrderListQuery.safeParse({ limit }).success).toBe(false);
  });
});

describe('admin drop DTOs', () => {
  const create = {
    productId: '5eed0003-0000-4000-8000-000000000002',
    startsAt: '2026-10-02T12:00:00.000Z',
    endsAt: '2026-10-02T13:00:00.000Z',
    priceCents: 14900,
    stock: 100,
  };

  it('default the product choices of §19', () => {
    expect(CreateDropBody.parse(create)).toEqual({
      ...create,
      roomId: null,
      currency: 'USD',
      perUserLimit: 2,
      holdSeconds: 120,
      paymentSeconds: 300,
    });
  });

  it('refuse a window that ends before it starts, and an empty patch', () => {
    expect(CreateDropBody.safeParse({ ...create, endsAt: create.startsAt }).success).toBe(false);
    expect(PatchDropBody.safeParse({}).success).toBe(false);
    expect(PatchDropBody.safeParse({ endsAt: create.startsAt, startsAt: create.endsAt }).success).toBe(false);
    expect(PatchDropBody.parse({ endsAt: create.endsAt })).toEqual({ endsAt: create.endsAt });
  });
});

describe('test route DTOs', () => {
  it('bound session minting and default a test drop to one hour at 25.00', () => {
    expect(TestSessionsBody.safeParse({ count: 10_001 }).success).toBe(false);
    expect(TestDropBody.parse({ stock: 100, perUserLimit: 2, holdSeconds: 10, paymentSeconds: 30 })).toEqual({
      stock: 100,
      perUserLimit: 2,
      holdSeconds: 10,
      paymentSeconds: 30,
      durationSeconds: 3600,
      priceCents: 2500,
    });
  });
});

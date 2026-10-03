import { randomUUID } from 'node:crypto';
import { SESSION_COOKIE } from '@flashdrop/config/constants';
import { OrderListResponse, OrderResponse } from '@flashdrop/contracts';
import { requestFingerprint } from '@flashdrop/domain/identity';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Api } from '../http/api';
import {
  ADMIN,
  BUYER,
  buildTestApp,
  type FakeState,
  fakeOrder,
  fakeState,
  LIVE_DROP,
  NOW,
  sessionToken,
} from '../test/fakes';

let app: Api;
let state: FakeState;

beforeEach(async () => {
  state = fakeState();
  app = await buildTestApp({}, state);
});
afterEach(() => app.close());

function addOrder(userId: string, overrides: Parameters<typeof fakeOrder>[1] = {}) {
  const order = fakeOrder(
    {
      id: randomUUID(),
      userId,
      dropId: LIVE_DROP.id,
      qty: 1,
      idempotencyKey: `key_${randomUUID()}`,
      requestHash: requestFingerprint({ dropId: LIVE_DROP.id, qty: 1 }),
    },
    overrides,
  );
  state.orders.set(order.id, order);
  return order;
}

const get = async (url: string, user = BUYER) =>
  app.inject({ url, cookies: { [SESSION_COOKIE]: await sessionToken(user) } });

describe('GET /api/v1/orders/:orderId', () => {
  it('returns the owner’s order, uncached', async () => {
    const order = addOrder(BUYER.id);
    const response = await get(`/api/v1/orders/${order.id}`);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(OrderResponse.parse(response.json()).order).toMatchObject({
      id: order.id,
      status: 'RESERVED',
      product: LIVE_DROP.product,
      serverNow: NOW.toISOString(),
    });
  });

  it('answers 404, never 403, for another user’s order, and 404 for an unknown one', async () => {
    const order = addOrder(BUYER.id);
    const other = await get(`/api/v1/orders/${order.id}`, ADMIN);
    expect(other.statusCode).toBe(404);
    expect(other.json()).toMatchObject({ code: 'NOT_FOUND', detail: 'Order not found' });
    expect((await get(`/api/v1/orders/${randomUUID()}`)).statusCode).toBe(404);
  });

  it('answers 401 without a session and 400 for an id that is not a uuid', async () => {
    expect((await app.inject({ url: `/api/v1/orders/${randomUUID()}` })).statusCode).toBe(401);
    expect((await get('/api/v1/orders/42')).statusCode).toBe(400);
  });
});

describe('GET /api/v1/me/orders', () => {
  it('lists the caller’s own orders without REJECTED tombstones', async () => {
    const mine = addOrder(BUYER.id);
    const paid = addOrder(BUYER.id, { status: 'PAID', paidAt: NOW });
    addOrder(BUYER.id, { status: 'REJECTED', closeReason: 'SOLD_OUT', closedAt: NOW });
    addOrder(ADMIN.id);

    const response = await get('/api/v1/me/orders');
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    const { orders } = OrderListResponse.parse(response.json());
    expect(orders.map((order) => order.id)).toEqual([mine.id, paid.id]);
  });

  it('takes ?limit= up to 100', async () => {
    for (let i = 0; i < 3; i++) addOrder(BUYER.id);
    const { orders } = OrderListResponse.parse((await get('/api/v1/me/orders?limit=2')).json());
    expect(orders).toHaveLength(2);
    expect((await get('/api/v1/me/orders?limit=101')).statusCode).toBe(400);
  });

  it('answers 401 without a session', async () => {
    expect((await app.inject({ url: '/api/v1/me/orders' })).statusCode).toBe(401);
  });
});

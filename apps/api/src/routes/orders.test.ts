import { randomUUID } from 'node:crypto';
import { SESSION_COOKIE } from '@flashdrop/config/constants';
import type { SessionUser } from '@flashdrop/contracts';
import { OrderDetailResponse, OrderListResponse, OrderResponse } from '@flashdrop/contracts';
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
  ORIGIN,
  PAYMENT_SECONDS,
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

const SHIPPING = {
  name: 'Ada Lindqvist',
  line1: '1 Infinite Loop',
  city: 'Cupertino',
  state: 'CA',
  postalCode: '95014',
  country: 'US',
};
const BODY = { shipping: SHIPPING, paymentMethod: 'pm_ok' };
const KEY = 'checkout_key_0001';

interface Call {
  readonly user?: SessionUser | null;
  readonly key?: string | null;
  readonly origin?: string | null;
  readonly payload?: object;
}

async function post(path: string, { user = BUYER, key = null, origin = ORIGIN, payload }: Call = {}) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/orders/${path}`,
    headers: {
      ...(origin === null ? {} : { origin }),
      ...(key === null ? {} : { 'idempotency-key': key }),
    },
    cookies: user === null ? {} : { [SESSION_COOKIE]: await sessionToken(user) },
    ...(payload === undefined ? {} : { payload }),
  });
}

const checkout = (orderId: string, call: Call = {}) =>
  post(`${orderId}/checkout`, { key: KEY, payload: BODY, ...call });

describe('GET /api/v1/orders/:orderId', () => {
  it('returns the owner’s order with its checkout details, uncached', async () => {
    const order = addOrder(BUYER.id);
    const response = await get(`/api/v1/orders/${order.id}`);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(OrderDetailResponse.parse(response.json()).order).toMatchObject({
      id: order.id,
      status: 'RESERVED',
      product: LIVE_DROP.product,
      serverNow: NOW.toISOString(),
      shipping: null,
      paymentMethod: null,
      declineCode: null,
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

describe('POST /api/v1/orders/:orderId/checkout', () => {
  it('submits a live hold: 202 PENDING_PAYMENT with the payment deadline, uncached', async () => {
    const order = addOrder(BUYER.id);
    const response = await checkout(order.id);
    expect(response.statusCode, response.body).toBe(202);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['idempotency-replayed']).toBeUndefined();
    expect(OrderResponse.parse(response.json()).order).toMatchObject({
      id: order.id,
      status: 'PENDING_PAYMENT',
      expiresAt: new Date(NOW.getTime() + PAYMENT_SECONDS * 1000).toISOString(),
    });
    // The detail page shows what was submitted; lists and this answer never carry it.
    expect(response.json().order).not.toHaveProperty('shipping');
    const detail = OrderDetailResponse.parse((await get(`/api/v1/orders/${order.id}`)).json()).order;
    expect(detail).toMatchObject({ shipping: SHIPPING, paymentMethod: 'pm_ok' });
  });

  it('replays the same key and body with 200, also spelled differently, as the order is now', async () => {
    const order = addOrder(BUYER.id);
    expect((await checkout(order.id)).statusCode).toBe(202);

    const respelled = {
      shipping: { ...SHIPPING, name: '  Ada Lindqvist ', country: 'us', line2: '', nickname: 'ignored' },
      paymentMethod: 'pm_ok',
    };
    for (const call of [{}, { payload: respelled }]) {
      const replay = await checkout(order.id.toUpperCase(), call);
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.headers['idempotency-replayed']).toBe('true');
      expect(OrderResponse.parse(replay.json()).order).toMatchObject({
        id: order.id,
        status: 'PENDING_PAYMENT',
      });
    }

    // Paid since: the replay answers with the paid order, not with a refusal.
    state.orders.set(order.id, { ...(state.orders.get(order.id) ?? order), status: 'PAID', paidAt: NOW });
    const paid = await checkout(order.id);
    expect(paid.statusCode).toBe(200);
    expect(paid.json()).toMatchObject({ order: { status: 'PAID' } });
  });

  it('classifies a refused submit: 422 for another body, 409 for another key', async () => {
    const order = addOrder(BUYER.id);
    expect((await checkout(order.id)).statusCode).toBe(202);

    const otherBody = await checkout(order.id, { payload: { ...BODY, paymentMethod: 'pm_decline' } });
    expect(otherBody.statusCode).toBe(422);
    expect(otherBody.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });

    const otherKey = await checkout(order.id, { key: 'checkout_key_0002' });
    expect(otherKey.statusCode).toBe(409);
    expect(otherKey.json()).toMatchObject({ code: 'ALREADY_SUBMITTED' });
  });

  it('answers 410 for an expired hold and 409 CONFLICT for a cancelled or rejected order', async () => {
    const lapsed = addOrder(BUYER.id, { expiresAt: NOW });
    expect((await checkout(lapsed.id)).json()).toMatchObject({ status: 410, code: 'RESERVATION_EXPIRED' });
    const expired = addOrder(BUYER.id, { status: 'EXPIRED', closeReason: 'TIMEOUT', closedAt: NOW });
    expect((await checkout(expired.id)).statusCode).toBe(410);

    const cancelled = addOrder(BUYER.id, { status: 'CANCELLED', closeReason: 'USER', closedAt: NOW });
    expect((await checkout(cancelled.id)).json()).toMatchObject({ status: 409, code: 'CONFLICT' });
    const rejected = addOrder(BUYER.id, { status: 'REJECTED', closeReason: 'SOLD_OUT', closedAt: NOW });
    expect((await checkout(rejected.id)).statusCode).toBe(409);
  });

  it('answers 404 for another user’s order, which stays untouched, and for an unknown one', async () => {
    const order = addOrder(BUYER.id);
    const other = await checkout(order.id, { user: ADMIN });
    expect(other.statusCode).toBe(404);
    expect(other.json()).toMatchObject({ code: 'NOT_FOUND' });
    expect(state.orders.get(order.id)?.status).toBe('RESERVED');
    expect((await checkout(randomUUID())).statusCode).toBe(404);
  });

  it('checks the session first, then the Origin, the key and the body', async () => {
    const order = addOrder(BUYER.id);
    // Anonymous: 401 even with nothing else right.
    expect((await checkout(order.id, { user: null, key: null, payload: {} })).statusCode).toBe(401);
    expect((await checkout(order.id, { origin: null })).statusCode).toBe(403);
    expect((await checkout(order.id, { origin: 'https://evil.example' })).statusCode).toBe(403);
    for (const key of [null, 'short', 'has spaces in it', 'x'.repeat(65)]) {
      const response = await checkout(order.id, { key });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'Invalid headers' });
    }

    const invalid = await checkout(order.id, {
      payload: { shipping: { ...SHIPPING, postalCode: '!', city: ' ' }, paymentMethod: 'visa' },
    });
    expect(invalid.statusCode).toBe(400);
    const paths = (invalid.json().errors as { path: string }[]).map((issue) => issue.path).sort();
    expect(paths).toEqual(['paymentMethod', 'shipping.city', 'shipping.postalCode']);
    expect(state.orders.get(order.id)?.status).toBe('RESERVED');
  });
});

describe('POST /api/v1/orders/:orderId/cancel', () => {
  it('cancels a held or submitted order, and answers a repeated cancel the same way', async () => {
    for (const status of ['RESERVED', 'PENDING_PAYMENT'] as const) {
      const order = addOrder(BUYER.id, { status });
      for (let i = 0; i < 2; i++) {
        const response = await post(`${order.id}/cancel`);
        expect(response.statusCode, response.body).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(OrderResponse.parse(response.json()).order).toMatchObject({
          id: order.id,
          status: 'CANCELLED',
          closeReason: 'USER',
        });
      }
    }
  });

  it('answers 409 CONFLICT when the order was paid, failed or expired first', async () => {
    for (const status of ['PAID', 'PAYMENT_FAILED', 'EXPIRED'] as const) {
      const order = addOrder(BUYER.id, { status, closedAt: NOW });
      const response = await post(`${order.id}/cancel`);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: 'CONFLICT',
        detail: 'This order can no longer be cancelled',
      });
      expect(state.orders.get(order.id)?.status).toBe(status);
    }
  });

  it('with ?from=RESERVED cancels only a hold: a stale checkout tab cannot cancel a placed order', async () => {
    const placed = addOrder(BUYER.id, { status: 'PENDING_PAYMENT' });
    const refused = await post(`${placed.id}/cancel?from=RESERVED`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'CONFLICT' });
    expect(state.orders.get(placed.id)?.status).toBe('PENDING_PAYMENT');

    const held = addOrder(BUYER.id, { status: 'RESERVED' });
    for (let i = 0; i < 2; i++) {
      const response = await post(`${held.id}/cancel?from=RESERVED`);
      expect(response.statusCode, response.body).toBe(200);
      expect(OrderResponse.parse(response.json()).order.status).toBe('CANCELLED');
    }
    expect((await post(`${held.id}/cancel?from=PAID`)).statusCode).toBe(400);
  });

  it('answers 404 for another user’s order, 401 without a session and 403 from another origin', async () => {
    const order = addOrder(BUYER.id);
    expect((await post(`${order.id}/cancel`, { user: ADMIN })).statusCode).toBe(404);
    expect((await post(`${order.id}/cancel`, { user: null })).statusCode).toBe(401);
    expect((await post(`${order.id}/cancel`, { origin: null })).statusCode).toBe(403);
    expect(state.orders.get(order.id)?.status).toBe('RESERVED');
  });
});

describe('POST /api/v1/orders/:orderId/extend', () => {
  it('adds 60 s to a live hold once; a second extension is 409', async () => {
    const order = addOrder(BUYER.id);
    const response = await post(`${order.id}/extend`);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(OrderResponse.parse(response.json()).order).toMatchObject({
      status: 'RESERVED',
      extensions: 1,
      expiresAt: new Date(order.expiresAt.getTime() + 60_000).toISOString(),
    });

    const again = await post(`${order.id}/extend`);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'CONFLICT', detail: 'This hold can no longer be extended' });
  });

  it('refuses a submitted order and a lapsed hold, and hides other users’ orders', async () => {
    const submitted = addOrder(BUYER.id, { status: 'PENDING_PAYMENT' });
    expect((await post(`${submitted.id}/extend`)).statusCode).toBe(409);
    const lapsed = addOrder(BUYER.id, { expiresAt: new Date(NOW.getTime() - 1) });
    expect((await post(`${lapsed.id}/extend`)).statusCode).toBe(409);
    const mine = addOrder(BUYER.id);
    expect((await post(`${mine.id}/extend`, { user: ADMIN })).statusCode).toBe(404);
    expect((await post(`${mine.id}/extend`, { user: null })).statusCode).toBe(401);
    expect(state.orders.get(mine.id)?.extensions).toBe(0);
  });
});

import { SESSION_COOKIE } from '@flashdrop/config/constants';
import {
  OrderDetailResponse,
  OrderResponse,
  type OrderView,
  type TestDropBody,
  TestDropResponse,
  TestSessionsResponse,
} from '@flashdrop/contracts';
import { markPaid, OUTBOX_CHANNEL, sql } from '@flashdrop/db';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Api } from './http/api';
import { ORIGIN } from './test/fakes';
import { createTestStack, TEST_ROUTES_SECRET, type TestStack } from './test/stack';

/*
 * Checkout submit, cancel and the hold extension end to end inside the api (design §4.4, §5.1, §5.2, §5.4):
 * the real reserve path into the shared Compose Redis, the real CASes in a throwaway Postgres database. Every
 * test makes its own drop and buyers through the test routes. No consumer runs here, so Redis keeps its holds
 * after a cancel; that is the settlement consumer's job (§6.5) and is asserted where it runs.
 */

let stack: TestStack;
let app: Api;

beforeAll(async () => {
  stack = await createTestStack();
  app = await stack.build();
});
afterAll(async () => {
  await stack?.close();
});

const db = () => stack.database.db;

const PAYMENT_SECONDS = 300;

async function newDrop(body: Partial<TestDropBody> = {}) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/test/drops',
    headers: { origin: ORIGIN, 'x-test-secret': TEST_ROUTES_SECRET },
    payload: { stock: 10, perUserLimit: 3, holdSeconds: 120, paymentSeconds: PAYMENT_SECONDS, ...body },
  });
  expect(response.statusCode, response.body).toBe(201);
  return TestDropResponse.parse(response.json());
}

interface Buyer {
  readonly id: string;
  readonly token: string;
}

async function newBuyers(count: number): Promise<Buyer[]> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/test/sessions',
    headers: { origin: ORIGIN, 'x-test-secret': TEST_ROUTES_SECRET },
    payload: { count },
  });
  expect(response.statusCode).toBe(200);
  return TestSessionsResponse.parse(response.json()).sessions.map((s) => ({ id: s.userId, token: s.token }));
}

let keys = 0;
const newKey = (prefix: string) => `${prefix}_${Date.now()}_${++keys}`;

/** A RESERVED order of `qty` units for `buyer`, through the real reserve route. */
async function hold(buyer: Buyer, dropId: string, qty = 1): Promise<OrderView> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/drops/${dropId}/reservations`,
    headers: { origin: ORIGIN, 'idempotency-key': newKey('reserve') },
    cookies: { [SESSION_COOKIE]: buyer.token },
    payload: { qty },
  });
  expect(response.statusCode, response.body).toBe(201);
  return OrderResponse.parse(response.json()).order;
}

const SHIPPING = {
  name: 'Ada Lindqvist',
  line1: '1 Infinite Loop',
  line2: 'Suite 4',
  city: 'Cupertino',
  state: 'CA',
  postalCode: '95014',
  country: 'US',
};
const BODY = { shipping: SHIPPING, paymentMethod: 'pm_ok' };

function checkout(buyer: Buyer | null, orderId: string, key: string, payload: object = BODY) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/orders/${orderId}/checkout`,
    headers: { origin: ORIGIN, 'idempotency-key': key },
    cookies: buyer === null ? {} : { [SESSION_COOKIE]: buyer.token },
    payload,
  });
}

function change(buyer: Buyer | null, orderId: string, action: 'cancel' | 'extend') {
  return app.inject({
    method: 'POST',
    url: `/api/v1/orders/${orderId}/${action}`,
    headers: { origin: ORIGIN },
    cookies: buyer === null ? {} : { [SESSION_COOKIE]: buyer.token },
  });
}

function read(buyer: Buyer, orderId: string) {
  return app.inject({ url: `/api/v1/orders/${orderId}`, cookies: { [SESSION_COOKIE]: buyer.token } });
}

/** How many responses answered each status. */
function tally(responses: readonly LightMyRequestResponse[]): Record<number, number> {
  const counts: Record<number, number> = {};
  for (const { statusCode } of responses) counts[statusCode] = (counts[statusCode] ?? 0) + 1;
  return counts;
}

function expectCode(response: LightMyRequestResponse, status: number, code: string) {
  expect(response.statusCode, response.body).toBe(status);
  expect(response.json()).toMatchObject({ code });
}

async function orderRow(orderId: string) {
  const { rows } = await db().execute<{
    status: string;
    close_reason: string | null;
    checkout_key: string | null;
    payment_method: string | null;
    extensions: number;
    version: number;
    /** `expires_at - updated_at`, in seconds: the window the last transition set, by Postgres time. */
    window_seconds: number;
  }>(sql`
    SELECT status, close_reason, checkout_key, payment_method, extensions, version,
           extract(epoch FROM expires_at - updated_at)::float8 AS window_seconds
    FROM orders WHERE id = ${orderId}`);
  const [row] = rows;
  if (row === undefined) throw new Error(`no order ${orderId}`);
  return row;
}

async function events(orderId: string) {
  const { rows } = await db().execute<{
    event_type: string;
    topic: string;
    partition_key: string;
    from_status: string | null;
  }>(sql`
    SELECT event_type, topic, partition_key, payload->'data'->>'fromStatus' AS from_status
    FROM outbox WHERE payload->>'orderId' = ${orderId} ORDER BY id`);
  return rows;
}

const eventTypes = async (orderId: string) => (await events(orderId)).map((event) => event.event_type);

async function counters(dropId: string, userId: string) {
  const { rows } = await db().execute<{ reserved: number; sold: number; claimed: number | null }>(sql`
    SELECT di.reserved, di.sold,
           (SELECT claimed FROM user_drop_quota WHERE drop_id = di.drop_id AND user_id = ${userId}) AS claimed
    FROM drop_inventory di WHERE di.drop_id = ${dropId}`);
  const [row] = rows;
  if (row === undefined) throw new Error(`no inventory for ${dropId}`);
  return row;
}

/** Counts relay wake-ups (`NOTIFY outbox`, §5.4) on a dedicated connection. */
async function listenOutbox() {
  const client = await stack.database.pool.connect();
  let count = 0;
  client.on('notification', (message) => {
    if (message.channel === OUTBOX_CHANNEL) count++;
  });
  await client.query(`LISTEN ${OUTBOX_CHANNEL}`);
  return {
    count: () => count,
    /** Notifications arrive asynchronously after the notifying commit; a round trip on this client flushes them. */
    settle: async () => {
      await client.query('SELECT 1');
      return count;
    },
    close: async () => {
      await client.query(`UNLISTEN ${OUTBOX_CHANNEL}`);
      client.release();
    },
  };
}

describe('checkout submit', () => {
  it('moves a hold to PENDING_PAYMENT: 202, the drop’s payment window, order.placed by product, a relay wake-up', async () => {
    const drop = await newDrop();
    const [buyer] = await newBuyers(1);
    if (buyer === undefined) throw new Error('no buyer');
    const held = await hold(buyer, drop.dropId);
    const before = OrderDetailResponse.parse((await read(buyer, held.id)).json()).order;
    expect(before).toMatchObject({
      status: 'RESERVED',
      shipping: null,
      paymentMethod: null,
      declineCode: null,
    });

    const listener = await listenOutbox();
    try {
      const response = await checkout(buyer, held.id, newKey('checkout'));
      expect(response.statusCode, response.body).toBe(202);
      expect(response.headers['idempotency-replayed']).toBeUndefined();
      const placed = OrderResponse.parse(response.json()).order;
      expect(placed).toMatchObject({ id: held.id, status: 'PENDING_PAYMENT', extensions: 0 });
      expect(Date.parse(placed.expiresAt)).toBeGreaterThan(Date.parse(held.expiresAt));
      expect(await listener.settle()).toBe(1);
    } finally {
      await listener.close();
    }

    const row = await orderRow(held.id);
    expect(row).toMatchObject({ status: 'PENDING_PAYMENT', payment_method: 'pm_ok' });
    expect(row.window_seconds).toBeCloseTo(PAYMENT_SECONDS, 3);
    expect(await events(held.id)).toEqual([
      { event_type: 'order.reserved', topic: 'orders.v1', partition_key: drop.productId, from_status: null },
      { event_type: 'order.placed', topic: 'orders.v1', partition_key: drop.productId, from_status: null },
    ]);
    // Submit changes no counter: the units stay reserved and claimed until the order is paid or ends.
    expect(await counters(drop.dropId, buyer.id)).toEqual({ reserved: 1, sold: 0, claimed: 1 });

    const after = OrderDetailResponse.parse((await read(buyer, held.id)).json()).order;
    expect(after).toMatchObject({ status: 'PENDING_PAYMENT', shipping: SHIPPING, paymentMethod: 'pm_ok' });
  });

  it('replays a same-key retry, however the body is spelled, and classifies other keys and bodies', async () => {
    const drop = await newDrop();
    const [buyer] = await newBuyers(1);
    if (buyer === undefined) throw new Error('no buyer');
    const held = await hold(buyer, drop.dropId);
    const key = newKey('checkout');
    expect((await checkout(buyer, held.id, key)).statusCode).toBe(202);
    const version = (await orderRow(held.id)).version;

    const respelled = {
      paymentMethod: 'pm_ok',
      shipping: { ...SHIPPING, city: ' Cupertino ', country: 'us', postalCode: '95014 ', extra: 'dropped' },
    };
    for (const [orderId, body] of [
      [held.id, BODY],
      [held.id.toUpperCase(), respelled],
    ] as const) {
      const replay = await checkout(buyer, orderId, key, body);
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.headers['idempotency-replayed']).toBe('true');
      expect(OrderResponse.parse(replay.json()).order).toMatchObject({
        id: held.id,
        status: 'PENDING_PAYMENT',
      });
    }

    expectCode(
      await checkout(buyer, held.id, key, { ...BODY, paymentMethod: 'pm_decline' }),
      422,
      'IDEMPOTENCY_KEY_REUSED',
    );
    expectCode(await checkout(buyer, held.id, newKey('other-tab')), 409, 'ALREADY_SUBMITTED');

    // Nothing but the first submit wrote anything.
    expect((await orderRow(held.id)).version).toBe(version);
    expect(await eventTypes(held.id)).toEqual(['order.reserved', 'order.placed']);

    // A replay after payment answers with the paid order (§4.5: the current representation).
    const paid = await markPaid(db(), { orderId: held.id, pspChargeId: `ch_${held.id}` });
    expect(paid.kind).toBe('won');
    const late = await checkout(buyer, held.id, key);
    expect(late.statusCode).toBe(200);
    expect(late.json()).toMatchObject({ order: { status: 'PAID' } });
  });

  it('answers 410 to a lapsed hold, swept or not, and 409 CONFLICT to an order cancelled first', async () => {
    const drop = await newDrop();
    const [buyer] = await newBuyers(1);
    if (buyer === undefined) throw new Error('no buyer');

    // Past its deadline by Postgres time, before the sweeper got to it: the CAS refuses it all the same.
    const lapsed = await hold(buyer, drop.dropId);
    await db().execute(
      sql`UPDATE orders SET expires_at = now() - interval '1 second' WHERE id = ${lapsed.id}`,
    );
    expectCode(await checkout(buyer, lapsed.id, newKey('checkout')), 410, 'RESERVATION_EXPIRED');
    expect((await orderRow(lapsed.id)).status).toBe('RESERVED');

    const cancelled = await hold(buyer, drop.dropId);
    expect((await change(buyer, cancelled.id, 'cancel')).statusCode).toBe(200);
    expectCode(await checkout(buyer, cancelled.id, newKey('checkout')), 409, 'CONFLICT');
  });

  it('serializes copies on the order row: one 202, same-key copies replay it, other tabs get 409', async () => {
    const drop = await newDrop({ stock: 20 });
    const [buyer] = await newBuyers(1);
    if (buyer === undefined) throw new Error('no buyer');

    // The idempotency storm's checkout half (§13): 20 identical submits in flight together.
    const storm = await hold(buyer, drop.dropId);
    const key = newKey('storm');
    const copies = await Promise.all(Array.from({ length: 20 }, () => checkout(buyer, storm.id, key)));
    expect(tally(copies)).toEqual({ 200: 19, 202: 1 });
    expect(await eventTypes(storm.id)).toEqual(['order.reserved', 'order.placed']);

    // Ten tabs, each with its own key: one places the order, the rest are told it was placed.
    const tabs = await hold(buyer, drop.dropId);
    const answers = await Promise.all(
      Array.from({ length: 10 }, (_, i) => checkout(buyer, tabs.id, newKey(`tab${i}`))),
    );
    expect(tally(answers)).toEqual({ 202: 1, 409: 9 });
    for (const answer of answers.filter((r) => r.statusCode === 409)) {
      expect(answer.json()).toMatchObject({ code: 'ALREADY_SUBMITTED' });
    }
    expect(await eventTypes(tabs.id)).toEqual(['order.reserved', 'order.placed']);
  });
});

describe('cancel', () => {
  it('releases quota and stock with order.cancelled and no relay wake-up; a repeat answers the same', async () => {
    const drop = await newDrop();
    const [buyer] = await newBuyers(1);
    if (buyer === undefined) throw new Error('no buyer');
    const held = await hold(buyer, drop.dropId, 2);
    expect(await counters(drop.dropId, buyer.id)).toEqual({ reserved: 2, sold: 0, claimed: 2 });

    const listener = await listenOutbox();
    try {
      for (let i = 0; i < 2; i++) {
        const response = await change(buyer, held.id, 'cancel');
        expect(response.statusCode, response.body).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(OrderResponse.parse(response.json()).order).toMatchObject({
          id: held.id,
          status: 'CANCELLED',
          closeReason: 'USER',
        });
      }
      // The event waits for the relay's poll: a notifying commit would hold the hot row in the queue of
      // every other notifying commit (§5.4).
      expect(await listener.settle()).toBe(0);
    } finally {
      await listener.close();
    }

    expect(await counters(drop.dropId, buyer.id)).toEqual({ reserved: 0, sold: 0, claimed: 0 });
    expect(await events(held.id)).toMatchObject([
      { event_type: 'order.reserved' },
      { event_type: 'order.cancelled', partition_key: drop.productId, from_status: 'RESERVED' },
    ]);
  });

  it('cancels a submitted order, and answers 409 to one that was paid first', async () => {
    const drop = await newDrop();
    const [buyer] = await newBuyers(1);
    if (buyer === undefined) throw new Error('no buyer');

    const submitted = await hold(buyer, drop.dropId);
    expect((await checkout(buyer, submitted.id, newKey('checkout'))).statusCode).toBe(202);
    const cancelled = await change(buyer, submitted.id, 'cancel');
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json()).toMatchObject({ order: { status: 'CANCELLED' } });
    expect(await events(submitted.id)).toMatchObject([
      { event_type: 'order.reserved' },
      { event_type: 'order.placed' },
      { event_type: 'order.cancelled', from_status: 'PENDING_PAYMENT' },
    ]);

    const paid = await hold(buyer, drop.dropId);
    expect((await checkout(buyer, paid.id, newKey('checkout'))).statusCode).toBe(202);
    expect((await markPaid(db(), { orderId: paid.id, pspChargeId: `ch_${paid.id}` })).kind).toBe('won');
    const refused = await change(buyer, paid.id, 'cancel');
    expectCode(refused, 409, 'CONFLICT');
    expect((await orderRow(paid.id)).status).toBe('PAID');
    // One unit cancelled (released), one sold; quota keeps the bought unit (INV-3).
    expect(await counters(drop.dropId, buyer.id)).toEqual({ reserved: 0, sold: 1, claimed: 1 });
  });

  it('decides a submit racing a cancel exactly once: the order always ends CANCELLED', async () => {
    const drop = await newDrop({ stock: 20, perUserLimit: 10 });
    const [buyer] = await newBuyers(1);
    if (buyer === undefined) throw new Error('no buyer');
    for (let i = 0; i < 5; i++) {
      const held = await hold(buyer, drop.dropId);
      const [submit, cancel] = await Promise.all([
        checkout(buyer, held.id, newKey('race')),
        change(buyer, held.id, 'cancel'),
      ]);
      expect(cancel.statusCode, cancel.body).toBe(200);
      // Submit first: 202, then the cancel ends the PENDING_PAYMENT order. Cancel first: the submit is 409.
      expect([202, 409]).toContain(submit.statusCode);
      if (submit.statusCode === 409) expect(submit.json()).toMatchObject({ code: 'CONFLICT' });
      expect((await orderRow(held.id)).status).toBe('CANCELLED');
      const types = await eventTypes(held.id);
      expect(types.at(-1)).toBe('order.cancelled');
      expect(types.filter((type) => type === 'order.cancelled')).toHaveLength(1);
    }
    expect(await counters(drop.dropId, buyer.id)).toEqual({ reserved: 0, sold: 0, claimed: 0 });
  });
});

describe('hold extension', () => {
  it('adds 60 s once, by Postgres time, without an event or a relay wake-up', async () => {
    const drop = await newDrop();
    const [buyer] = await newBuyers(1);
    if (buyer === undefined) throw new Error('no buyer');
    const held = await hold(buyer, drop.dropId);

    const listener = await listenOutbox();
    try {
      const response = await change(buyer, held.id, 'extend');
      expect(response.statusCode, response.body).toBe(200);
      const extended = OrderResponse.parse(response.json()).order;
      expect(extended).toMatchObject({ status: 'RESERVED', extensions: 1 });
      expect(Date.parse(extended.expiresAt) - Date.parse(held.expiresAt)).toBe(60_000);

      expectCode(await change(buyer, held.id, 'extend'), 409, 'CONFLICT');
      expect(await listener.settle()).toBe(0);
    } finally {
      await listener.close();
    }
    expect(await eventTypes(held.id)).toEqual(['order.reserved']);

    // A submitted order has a payment window, not a hold: nothing to extend.
    const submitted = await hold(buyer, drop.dropId);
    expect((await checkout(buyer, submitted.id, newKey('checkout'))).statusCode).toBe(202);
    expectCode(await change(buyer, submitted.id, 'extend'), 409, 'CONFLICT');
  });
});

describe('ownership', () => {
  it('hides a buyer’s order from everyone else (404) and refuses anonymous callers (401)', async () => {
    const drop = await newDrop();
    const [owner, other] = await newBuyers(2);
    if (owner === undefined || other === undefined) throw new Error('no buyers');
    const held = await hold(owner, drop.dropId);
    const version = (await orderRow(held.id)).version;

    expectCode(await read(other, held.id), 404, 'NOT_FOUND');
    expectCode(await checkout(other, held.id, newKey('checkout')), 404, 'NOT_FOUND');
    expectCode(await change(other, held.id, 'cancel'), 404, 'NOT_FOUND');
    expectCode(await change(other, held.id, 'extend'), 404, 'NOT_FOUND');
    expectCode(await checkout(null, held.id, newKey('checkout')), 401, 'UNAUTHENTICATED');
    expectCode(await change(null, held.id, 'cancel'), 401, 'UNAUTHENTICATED');
    expectCode(await change(null, held.id, 'extend'), 401, 'UNAUTHENTICATED');

    expect(await orderRow(held.id)).toMatchObject({ status: 'RESERVED', extensions: 0, version });
    expect(await eventTypes(held.id)).toEqual(['order.reserved']);
  });
});

describe('test drops', () => {
  it('end 30 minutes after they start unless the caller asks for longer', async () => {
    const short = await newDrop();
    expect(Date.parse(short.endsAt) - Date.parse(short.startsAt)).toBe(30 * 60_000);
    const long = await newDrop({ durationSeconds: 7_200 });
    expect(Date.parse(long.endsAt) - Date.parse(long.startsAt)).toBe(7_200_000);
  });
});

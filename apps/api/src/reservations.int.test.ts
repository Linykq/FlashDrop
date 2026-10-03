import { randomUUID } from 'node:crypto';
import { SESSION_COOKIE } from '@flashdrop/config/constants';
import {
  AdminDropResponse,
  DropListResponse,
  MeResponse,
  OrderListResponse,
  OrderResponse,
  StockSnapshot,
  type TestDropBody,
  TestDropResponse,
  TestSessionsResponse,
} from '@flashdrop/contracts';
import { sql } from '@flashdrop/db';
import { dropKeys, fdSetStatus, readDropState, readStock, redisDropViolations } from '@flashdrop/inventory';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Api } from './http/api';
import { ADMIN, ORIGIN, sessionToken } from './test/fakes';
import { createTestStack, TEST_ROUTES_SECRET, type TestStack } from './test/stack';

/*
 * Reservations end to end inside the api (design §4.5, §5.2): the real Functions library in the shared
 * Compose Redis, the real reserve transaction in a throwaway Postgres database, the real admin and test
 * routes. Every test makes its own drop through `POST /test/drops`, so tests never share stock, and the
 * stack deletes those drops' Redis keys afterwards.
 *
 * Where a test needs Redis and Postgres to disagree (drift, a fenced generation, a wipe), it edits one side
 * directly: that is exactly the state a lost AOF tail or a zombie rebuild would leave behind.
 */

let stack: TestStack;
let app: Api;
let adminToken: string;

beforeAll(async () => {
  stack = await createTestStack(new Date(), { lockTimeoutMs: 300 });
  app = await stack.build();
  adminToken = await sessionToken(ADMIN);
});
afterAll(async () => {
  await stack?.close();
});

const db = () => stack.database.db;

async function newDrop(body: Partial<TestDropBody> = {}): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/test/drops',
    headers: { origin: ORIGIN, 'x-test-secret': TEST_ROUTES_SECRET },
    payload: { stock: 10, perUserLimit: 2, holdSeconds: 120, paymentSeconds: 300, ...body },
  });
  expect(response.statusCode, response.body).toBe(201);
  const { dropId } = TestDropResponse.parse(response.json());
  return dropId;
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

async function newBuyer(): Promise<Buyer> {
  const [buyer] = await newBuyers(1);
  if (buyer === undefined) throw new Error('no buyer minted');
  return buyer;
}

const newKey = () => `key_${randomUUID()}`;

function reserve(buyer: Buyer, dropId: string, key: string, qty = 1, on: Api = app) {
  return on.inject({
    method: 'POST',
    url: `/api/v1/drops/${dropId}/reservations`,
    headers: { origin: ORIGIN, 'idempotency-key': key },
    cookies: { [SESSION_COOKIE]: buyer.token },
    payload: { qty },
  });
}

function admin(action: string, dropId: string) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/admin/drops/${dropId}/${action}`,
    headers: { origin: ORIGIN },
    cookies: { [SESSION_COOKIE]: adminToken },
  });
}

function expectCode(response: LightMyRequestResponse, status: number, code: string) {
  expect(response.statusCode, response.body).toBe(status);
  expect(response.json()).toMatchObject({ code });
}

const stock = (dropId: string) => app.inject({ url: `/api/v1/drops/${dropId}/stock` });

async function orderRows(dropId: string) {
  const { rows } = await db().execute<{
    id: string;
    status: string;
    close_reason: string | null;
    qty: number;
  }>(sql`SELECT id, status, close_reason, qty FROM orders WHERE drop_id = ${dropId} ORDER BY created_at`);
  return rows;
}

async function eventTypes(orderId: string): Promise<string[]> {
  const { rows } = await db().execute<{ event_type: string }>(
    sql`SELECT event_type FROM outbox WHERE payload->>'orderId' = ${orderId} ORDER BY id`,
  );
  return rows.map((row) => row.event_type);
}

async function inventory(dropId: string) {
  const { rows } = await db().execute<{ total: number; reserved: number; sold: number; redis_gen: number }>(
    sql`SELECT total, reserved, sold, redis_gen FROM drop_inventory WHERE drop_id = ${dropId}`,
  );
  const [row] = rows;
  if (row === undefined) throw new Error(`no inventory for ${dropId}`);
  return row;
}

/** Collects `NOTIFY fd_sync` payloads, the reconciler's nudge channel (§4.7). */
async function listenForNudges() {
  const client = await stack.database.pool.connect();
  const payloads: string[] = [];
  client.on('notification', (message) => {
    if (message.channel === 'fd_sync' && message.payload !== undefined) payloads.push(message.payload);
  });
  await client.query('LISTEN fd_sync');
  return {
    payloads,
    close: async () => {
      await client.query('UNLISTEN *');
      client.release();
    },
  };
}

async function deleteRedisKeys(dropId: string) {
  const k = dropKeys(dropId);
  await stack.redis.del([k.inv, k.rsv, k.uq, k.exp]);
}

describe('reserve', () => {
  it('holds stock in Redis, records the order in Postgres, and replays the same key', async () => {
    const dropId = await newDrop({ stock: 10 });
    const buyer = await newBuyer();
    const key = newKey();

    const created = await reserve(buyer, dropId, key, 2);
    expect(created.statusCode, created.body).toBe(201);
    const { order } = OrderResponse.parse(created.json());
    expect(order).toMatchObject({ status: 'RESERVED', dropId, qty: 2, closeReason: null });

    // Redis took the stock first, Postgres recorded the same rid with its quota and event.
    expect(await readStock(stack.redis, dropId)).toMatchObject({ avail: 8, held: 2, sold: 0, gen: 1 });
    expect(await inventory(dropId)).toMatchObject({ total: 10, reserved: 2, sold: 0, redis_gen: 1 });
    const state = await readDropState(stack.redis, dropId);
    expect(state.entries.get(order.id)).toMatchObject({ u: buyer.id, q: 2, s: 'HELD', k: key });
    expect(redisDropViolations(state)).toEqual([]);
    expect(await eventTypes(order.id)).toEqual(['order.reserved']);

    const replay = await reserve(buyer, dropId, key, 2);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(OrderResponse.parse(replay.json()).order.id).toBe(order.id);
    // The 201 built its product summary from the insert statement; a read of the order shows the same one.
    expect(OrderResponse.parse(replay.json()).order.product).toEqual(order.product);
    expectCode(await reserve(buyer, dropId, key, 1), 422, 'IDEMPOTENCY_KEY_REUSED');
    expect(await readStock(stack.redis, dropId)).toMatchObject({ avail: 8, held: 2 });

    const snapshot = await stock(dropId);
    expect(snapshot.statusCode).toBe(200);
    expect(StockSnapshot.parse(snapshot.json())).toMatchObject({ avail: 8, held: 2, sold: 0, gen: 1 });
    expect(StockSnapshot.parse(snapshot.json()).seq).toBeGreaterThan(0);
  });

  // Regression: the order's user foreign key refused the insert and the api answered 500.
  it('answers 401 to a session whose account no longer exists', async () => {
    const dropId = await newDrop({ stock: 5 });
    const ghost = {
      id: randomUUID(),
      token: await sessionToken({
        id: randomUUID(),
        email: 'ghost@example.test',
        displayName: 'Ghost',
        role: 'buyer',
      }),
    };

    expectCode(await reserve(ghost, dropId, newKey()), 401, 'UNAUTHENTICATED');
    expect(await orderRows(dropId)).toEqual([]);
    expect(await inventory(dropId)).toMatchObject({ reserved: 0 });
  });

  it('answers the owner’s order reads and hides them from everyone else', async () => {
    const dropId = await newDrop();
    const [owner, other] = await newBuyers(2);
    if (owner === undefined || other === undefined) throw new Error('no buyers');
    const { order } = OrderResponse.parse((await reserve(owner, dropId, newKey())).json());

    const read = (buyer: Buyer, url: string) =>
      app.inject({ url, cookies: { [SESSION_COOKIE]: buyer.token } });
    expect(OrderResponse.parse((await read(owner, `/api/v1/orders/${order.id}`)).json()).order.id).toBe(
      order.id,
    );
    expect((await read(other, `/api/v1/orders/${order.id}`)).statusCode).toBe(404);
    const mine = OrderListResponse.parse((await read(owner, '/api/v1/me/orders')).json());
    expect(mine.orders.map((o) => o.id)).toEqual([order.id]);
    expect(OrderListResponse.parse((await read(other, '/api/v1/me/orders')).json()).orders).toEqual([]);
  });

  it('refuses in Lua, read-only: sold out, over the limit, outside the window', async () => {
    const dropId = await newDrop({ stock: 3, perUserLimit: 2 });
    const [a, b, c] = await newBuyers(3);
    if (a === undefined || b === undefined || c === undefined) throw new Error('no buyers');

    expect((await reserve(a, dropId, newKey(), 2)).statusCode).toBe(201);
    expectCode(await reserve(a, dropId, newKey(), 1), 409, 'LIMIT_REACHED');
    expect((await reserve(b, dropId, newKey(), 1)).statusCode).toBe(201);
    expectCode(await reserve(c, dropId, newKey(), 1), 409, 'SOLD_OUT');

    const later = await newDrop({ startsAt: new Date(Date.now() + 3_600_000).toISOString() });
    expectCode(await reserve(a, later, newKey()), 409, 'DROP_NOT_LIVE');

    // Only the winners reached Postgres: no tombstones for refusals Lua decided.
    expect((await orderRows(dropId)).map((row) => row.status)).toEqual(['RESERVED', 'RESERVED']);
    expect(await orderRows(later)).toEqual([]);
    expect(redisDropViolations(await readDropState(stack.redis, dropId))).toEqual([]);
  });

  it('answers 409 DROP_NOT_LIVE for unknown and DRAFT drops, which are not tracked', async () => {
    const buyer = await newBuyer();
    expectCode(await reserve(buyer, randomUUID(), newKey()), 409, 'DROP_NOT_LIVE');

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/drops',
      headers: { origin: ORIGIN },
      cookies: { [SESSION_COOKIE]: adminToken },
      payload: {
        productId: await productOf(await newDrop()),
        startsAt: new Date(Date.now() - 60_000).toISOString(),
        endsAt: new Date(Date.now() + 3_600_000).toISOString(),
        priceCents: 1_000,
        stock: 5,
      },
    });
    // The product already has an open drop, which is fine for a DRAFT: only arming checks that.
    expect(created.statusCode, created.body).toBe(201);
    const draft = AdminDropResponse.parse(created.json()).drop;
    expectCode(await reserve(buyer, draft.id, newKey()), 409, 'DROP_NOT_LIVE');
    expect((await stock(draft.id)).statusCode).toBe(404);
  });
});

async function productOf(dropId: string): Promise<string> {
  const { rows } = await db().execute<{ product_id: string }>(
    sql`SELECT product_id FROM drops WHERE id = ${dropId}`,
  );
  const [row] = rows;
  if (row === undefined) throw new Error(`no drop ${dropId}`);
  return row.product_id;
}

describe('Postgres refusals of what Redis admitted', () => {
  it('SOLD_OUT: one-statement tombstone with its event, a nudge, and a replay of the refusal', async () => {
    const dropId = await newDrop({ stock: 5 });
    const buyer = await newBuyer();
    // Redis optimistic: Postgres has no stock left, Redis still shows 5.
    await db().execute(sql`UPDATE drop_inventory SET reserved = total WHERE drop_id = ${dropId}`);
    const nudges = await listenForNudges();
    try {
      const key = newKey();
      expectCode(await reserve(buyer, dropId, key), 409, 'SOLD_OUT');
      const [tombstone] = await orderRows(dropId);
      expect(tombstone).toMatchObject({ status: 'REJECTED', close_reason: 'SOLD_OUT' });
      expect(await eventTypes(tombstone?.id ?? '')).toEqual(['order.rejected']);
      await expect.poll(() => nudges.payloads).toEqual([dropId]);

      // The hold stays until the settle safety net sees the terminal row (ordering rule, §4.3).
      expect(await readStock(stack.redis, dropId)).toMatchObject({ avail: 4, held: 1 });
      expectCode(await reserve(buyer, dropId, key), 409, 'SOLD_OUT');
      expect(await eventTypes(tombstone?.id ?? '')).toEqual(['order.rejected']);
    } finally {
      await nudges.close();
    }
  });

  it('LIMIT: the quota backstop refuses, tombstones and nudges', async () => {
    const dropId = await newDrop({ stock: 5, perUserLimit: 2 });
    const buyer = await newBuyer();
    await db().execute(sql`
      INSERT INTO user_drop_quota (user_id, drop_id, claimed, limit_qty) VALUES (${buyer.id}, ${dropId}, 2, 2)`);
    const nudges = await listenForNudges();
    try {
      expectCode(await reserve(buyer, dropId, newKey()), 409, 'LIMIT_REACHED');
      expect(await orderRows(dropId)).toMatchObject([{ status: 'REJECTED', close_reason: 'LIMIT' }]);
      await expect.poll(() => nudges.payloads).toEqual([dropId]);
    } finally {
      await nudges.close();
    }
  });

  it('NOT_LIVE: the window backstop refuses a stale Redis status, without a nudge', async () => {
    const dropId = await newDrop();
    const buyer = await newBuyer();
    await db().execute(sql`UPDATE drops SET status = 'PAUSED' WHERE id = ${dropId}`);
    expectCode(await reserve(buyer, dropId, newKey()), 409, 'DROP_NOT_LIVE');
    expect(await orderRows(dropId)).toMatchObject([{ status: 'REJECTED', close_reason: 'NOT_LIVE' }]);
    expect(await inventory(dropId)).toMatchObject({ reserved: 0 });
  });

  it('STALE_GEN: a fenced generation answers 503, and the same key succeeds after the rebuild', async () => {
    const dropId = await newDrop();
    const buyer = await newBuyer();
    const key = newKey();
    // A rebuild's fence committed, but Redis still runs the old generation.
    await db().execute(sql`UPDATE drop_inventory SET redis_gen = redis_gen + 1 WHERE drop_id = ${dropId}`);
    const refused = await reserve(buyer, dropId, key);
    expectCode(refused, 503, 'RETRY');
    expect(refused.headers['retry-after']).toBe('1');
    expect(await orderRows(dropId)).toEqual([]);

    expect((await admin('reconcile', dropId)).statusCode).toBe(200);
    const retried = await reserve(buyer, dropId, key);
    expect(retried.statusCode, retried.body).toBe(201);
    expect(await readStock(stack.redis, dropId)).toMatchObject({ avail: 9, held: 1, gen: 3 });
  });
});

describe('Redis without the drop', () => {
  it('a wiped, tracked drop answers 503 and nudges until the rebuild, then reserves again', async () => {
    const dropId = await newDrop();
    const buyer = await newBuyer();
    await deleteRedisKeys(dropId);
    const nudges = await listenForNudges();
    try {
      expectCode(await reserve(buyer, dropId, newKey()), 503, 'RETRY');
      expectCode(await stock(dropId), 503, 'RETRY');
      await expect.poll(() => nudges.payloads).toEqual([dropId]);
    } finally {
      await nudges.close();
    }
    expect((await admin('reconcile', dropId)).statusCode).toBe(200);
    expect((await reserve(buyer, dropId, newKey())).statusCode).toBe(201);
  });

  it('the catalog shows Redis levels, and Postgres levels for a drop being rebuilt instead of failing', async () => {
    const dropId = await newDrop({ stock: 7 });
    // Test products are never listed; this one stands in for a catalog product.
    await db().execute(sql`
      UPDATE products SET source = 'manual' WHERE id = (SELECT product_id FROM drops WHERE id = ${dropId})`);
    await reserve(await newBuyer(), dropId, newKey());
    const listed = async () => {
      const response = await app.inject({ url: '/api/v1/drops?status=live,scheduled&limit=50' });
      return DropListResponse.parse(response.json()).drops.find((drop) => drop.id === dropId)?.stock;
    };
    const fromRedis = await listed();
    expect(fromRedis).toMatchObject({ avail: 6, held: 1, gen: 1 });
    expect(fromRedis?.seq).toBeGreaterThan(0);

    await fdSetStatus(stack.redis, dropId, 'RECONCILING');
    // Postgres's view, mapped like a rebuild maps it: seq 0 under the current generation.
    expect(await listed()).toEqual({ avail: 6, held: 1, sold: 0, status: 'SCHEDULED', gen: 1, seq: 0 });
    expect((await admin('reconcile', dropId)).statusCode).toBe(200);
  });

  it('a RECONCILING drop answers 503 to reserves and stock reads', async () => {
    const dropId = await newDrop();
    const buyer = await newBuyer();
    await fdSetStatus(stack.redis, dropId, 'RECONCILING');
    expectCode(await reserve(buyer, dropId, newKey()), 503, 'RETRY');
    expectCode(await stock(dropId), 503, 'RETRY');
    expect((await admin('reconcile', dropId)).statusCode).toBe(200);
    expect((await stock(dropId)).statusCode).toBe(200);
  });

  it('past its retention, a drop replays orders from Postgres and shows its final stock', async () => {
    const dropId = await newDrop({ stock: 4 });
    const buyer = await newBuyer();
    const key = newKey();
    const { order } = OrderResponse.parse((await reserve(buyer, dropId, key)).json());
    // Ended more than 24 h ago: untracked, and its keys are gone for good.
    await db().execute(sql`
      UPDATE drops SET status = 'ENDED', starts_at = now() - interval '50 hours',
                       ends_at = now() - interval '25 hours'
      WHERE id = ${dropId}`);
    await deleteRedisKeys(dropId);

    const replay = await reserve(buyer, dropId, key);
    expect(replay.statusCode).toBe(200);
    expect(OrderResponse.parse(replay.json()).order.id).toBe(order.id);
    expectCode(await reserve(buyer, dropId, key, 2), 422, 'IDEMPOTENCY_KEY_REUSED');
    expectCode(await reserve(buyer, dropId, newKey()), 409, 'DROP_NOT_LIVE');
    expect(StockSnapshot.parse((await stock(dropId)).json())).toMatchObject({
      status: 'ENDED',
      avail: 3,
      held: 1,
    });
  });
});

describe('rate limits on fd_rl_hit', () => {
  it('lets RATE_LIMIT_USER_PER_SEC through per user and answers the rest 429', async () => {
    const limited = await stack.build({ rateLimits: { userPerSecond: 3, ipPerSecond: 100_000 } });
    const dropId = await newDrop({ stock: 100, perUserLimit: 10 });
    const buyer = await newBuyer();
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => reserve(buyer, dropId, newKey(), 1, limited)),
    );
    const statuses = responses.map((response) => response.statusCode).sort();
    expect(statuses).toEqual([201, 201, 201, 429, 429, 429]);
    for (const response of responses.filter((r) => r.statusCode === 429)) {
      expect(response.headers['retry-after']).toBe('1');
      expect(response.json()).toMatchObject({ code: 'RATE_LIMITED' });
    }
    const ttl = await stack.redis.pTTL(`fd:rl:reserve-user:${buyer.id}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(1_000);
  });
});

describe('admin drops', () => {
  async function send(method: 'POST' | 'PATCH', url: string, payload?: object, token = adminToken) {
    return app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { origin: ORIGIN },
      cookies: { [SESSION_COOKIE]: token },
      ...(payload === undefined ? {} : { payload }),
    });
  }

  it('create, edit, arm, pause, resume, end and reconcile, with Redis following Postgres', async () => {
    const productId = await productOf(await newDrop());
    // End the product's open test drop first: one open drop per product.
    const [openDrop] = (
      await db().execute<{ id: string }>(sql`SELECT id FROM drops WHERE product_id = ${productId}`)
    ).rows;
    expect((await admin('end', openDrop?.id ?? '')).statusCode).toBe(200);

    const created = await send('POST', '/admin/drops', {
      productId,
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 3_600_000).toISOString(),
      priceCents: 1_500,
      stock: 20,
    });
    expect(created.statusCode, created.body).toBe(201);
    const { drop } = AdminDropResponse.parse(created.json());
    expect(drop).toMatchObject({ status: 'DRAFT', inventory: { total: 20, redisGen: 0 } });
    expect(await readStock(stack.redis, drop.id)).toBeNull();

    const patched = await send('PATCH', `/admin/drops/${drop.id}`, { stock: 30, perUserLimit: 3 });
    expect(AdminDropResponse.parse(patched.json()).drop).toMatchObject({
      perUserLimit: 3,
      inventory: { total: 30 },
    });

    const armed = AdminDropResponse.parse((await admin('arm', drop.id)).json()).drop;
    expect(armed).toMatchObject({ status: 'SCHEDULED', inventory: { redisGen: 1 } });
    expect(await readStock(stack.redis, drop.id)).toMatchObject({ status: 'SCHEDULED', avail: 30, gen: 1 });
    expectCode(await send('PATCH', `/admin/drops/${drop.id}`, { stock: 5 }), 409, 'DROP_ARMED');
    expectCode(await admin('arm', drop.id), 409, 'DROP_ARMED');

    const buyer = await newBuyer();
    expect((await reserve(buyer, drop.id, newKey())).statusCode).toBe(201);
    expect(AdminDropResponse.parse((await admin('pause', drop.id)).json()).drop.status).toBe('PAUSED');
    expect(await readStock(stack.redis, drop.id)).toMatchObject({ status: 'PAUSED' });
    expectCode(await reserve(buyer, drop.id, newKey()), 409, 'DROP_NOT_LIVE');
    expectCode(await admin('pause', drop.id), 409, 'CONFLICT');

    // Resume lands on what the clock says: inside the window, LIVE.
    expect(AdminDropResponse.parse((await admin('resume', drop.id)).json()).drop.status).toBe('LIVE');
    expect((await reserve(buyer, drop.id, newKey())).statusCode).toBe(201);

    expect(AdminDropResponse.parse((await admin('end', drop.id)).json()).drop.status).toBe('ENDED');
    expect(await readStock(stack.redis, drop.id)).toMatchObject({ status: 'ENDED', held: 2, avail: 28 });
    expectCode(await reserve(buyer, drop.id, newKey()), 409, 'DROP_NOT_LIVE');

    const reconciled = AdminDropResponse.parse((await admin('reconcile', drop.id)).json()).drop;
    expect(reconciled.inventory).toMatchObject({ reserved: 2, redisGen: 2 });
    const state = await readDropState(stack.redis, drop.id);
    expect(state.inv).toMatchObject({ status: 'ENDED', gen: 2, seq: 0, avail: 28, held: 2 });
    expect(redisDropViolations(state)).toEqual([]);
  });

  it('repairs a drop a dead rebuild left RECONCILING when its status changes', async () => {
    const dropId = await newDrop();
    await fdSetStatus(stack.redis, dropId, 'RECONCILING');
    expect(AdminDropResponse.parse((await admin('pause', dropId)).json()).drop.status).toBe('PAUSED');
    expect(await readStock(stack.redis, dropId)).toMatchObject({ status: 'PAUSED', gen: 2, avail: 10 });
  });

  it('answers 409 DROP_BUSY while another session holds the drop lock', async () => {
    const dropId = await newDrop();
    const holder = await stack.infra.lockPool.connect();
    try {
      await holder.query(`SELECT pg_advisory_lock(hashtextextended('fd.sync:' || $1::text, 0))`, [dropId]);
      expectCode(await admin('pause', dropId), 409, 'DROP_BUSY');
      await holder.query(`SELECT pg_advisory_unlock(hashtextextended('fd.sync:' || $1::text, 0))`, [dropId]);
      expect((await admin('pause', dropId)).statusCode).toBe(200);
    } finally {
      holder.release();
    }
  });

  it('refuses buyers, and unknown products are a 400', async () => {
    const buyer = await newBuyer();
    const body = {
      productId: randomUUID(),
      startsAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + 60_000).toISOString(),
      priceCents: 100,
      stock: 1,
    };
    expectCode(await send('POST', '/admin/drops', body, buyer.token), 403, 'FORBIDDEN');
    const unknown = await send('POST', '/admin/drops', body);
    expectCode(unknown, 400, 'VALIDATION_FAILED');
    expect(unknown.json().errors).toEqual([{ path: 'productId', message: 'does not exist' }]);
  });
});

describe('test routes', () => {
  it('mint working sessions for fresh buyers and refuse calls without the secret', async () => {
    const buyer = await newBuyer();
    const me = await app.inject({ url: '/api/v1/me', cookies: { [SESSION_COOKIE]: buyer.token } });
    expect(MeResponse.parse(me.json()).user).toMatchObject({ id: buyer.id, role: 'buyer' });
    const refused = await app.inject({
      method: 'POST',
      url: '/api/v1/test/sessions',
      headers: { origin: ORIGIN, 'x-test-secret': 'wrong-secret-value' },
      payload: { count: 1 },
    });
    expect(refused.statusCode).toBe(403);
  });

  it('create drops whose product pages work but which the storefront never lists', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/test/drops',
      headers: { origin: ORIGIN, 'x-test-secret': TEST_ROUTES_SECRET },
      payload: { stock: 3, perUserLimit: 1, holdSeconds: 10, paymentSeconds: 300 },
    });
    expect(response.statusCode, response.body).toBe(201);
    const { dropId, productSlug } = TestDropResponse.parse(response.json());

    const page = await app.inject({ url: `/api/v1/products/${productSlug}` });
    expect(page.statusCode).toBe(200);
    expect(page.json()).toMatchObject({ drop: { id: dropId, holdSeconds: 10 } });
    const list = await app.inject({ url: '/api/v1/drops?status=live,paused,scheduled&limit=50' });
    expect(DropListResponse.parse(list.json()).drops.map((drop) => drop.id)).not.toContain(dropId);
  });
});

describe('under load (the M2 demo, in process)', () => {
  it('2,000 concurrent reserves from 300 users on 100 units: exactly 100 reservations, nobody over 2', async () => {
    const dropId = await newDrop({ stock: 100, perUserLimit: 2 });
    const buyers = await newBuyers(300);
    // 1,400 distinct requests, plus 600 same-key retries of them (30%), all in flight together.
    const requests = Array.from({ length: 1_400 }, (_, i) => ({
      buyer: i % buyers.length,
      key: newKey(),
    })).flatMap(({ buyer, key }) => {
      const owner = buyers[buyer];
      return owner === undefined ? [] : [{ buyer: owner, key }];
    });
    const all = [...requests, ...requests.slice(0, 600)];
    const responses = await Promise.all(all.map(({ buyer, key }) => reserve(buyer, dropId, key)));

    const counts = new Map<string, number>();
    for (const response of responses) {
      const outcome = response.statusCode < 400 ? String(response.statusCode) : response.json().code;
      counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
    }
    expect(counts.get('201')).toBe(100);
    expect([...counts.keys()].every((k) => ['201', '200', 'SOLD_OUT', 'LIMIT_REACHED'].includes(k))).toBe(
      true,
    );

    const rows = await orderRows(dropId);
    expect(rows.length).toBe(100);
    expect(rows.every((row) => row.status === 'RESERVED')).toBe(true);
    expect(await inventory(dropId)).toMatchObject({ total: 100, reserved: 100, sold: 0 });
    const { rows: overLimit } = await db().execute(sql`
      SELECT user_id FROM orders WHERE drop_id = ${dropId} GROUP BY user_id HAVING sum(qty) > 2`);
    expect(overLimit).toEqual([]);

    const state = await readDropState(stack.redis, dropId);
    expect(state.inv).toMatchObject({ avail: 0, held: 100, sold: 0, total: 100 });
    expect(redisDropViolations(state)).toEqual([]);
    expect([...state.quotas.values()].every((units) => units <= 2)).toBe(true);
  });

  it('50 identical requests in flight together give one hold and one order (the idempotency storm)', async () => {
    const dropId = await newDrop({ stock: 10, perUserLimit: 10 });
    const buyer = await newBuyer();
    // Several storms, because the race they guard against (two same-key inserts meeting on the key index
    // before the primary key) shows up in only some of them.
    for (let storm = 1; storm <= 8; storm++) {
      const key = newKey();
      const responses = await Promise.all(Array.from({ length: 50 }, () => reserve(buyer, dropId, key)));
      const statuses = responses.map((response) => response.statusCode);
      expect(statuses.filter((status) => status === 201)).toHaveLength(1);
      expect(statuses.filter((status) => status === 200)).toHaveLength(49);
      expect(new Set(responses.map((r) => OrderResponse.parse(r.json()).order.id)).size).toBe(1);
      expect(await orderRows(dropId)).toHaveLength(storm);
      expect(await readStock(stack.redis, dropId)).toMatchObject({ avail: 10 - storm, held: storm });
    }
  });
});

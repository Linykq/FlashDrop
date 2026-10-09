import { createLogger } from '@flashdrop/config';
import { SESSION_COOKIE } from '@flashdrop/config/constants';
import {
  AdminDashboardResponse,
  AdminHealthResponse,
  OrderEvent,
  OrderResponse,
  type OrderView,
  TestDropResponse,
  TestSessionsResponse,
} from '@flashdrop/contracts';
import { cancelOrder, projectSalesEvents, seedId, sql, submitCheckout } from '@flashdrop/db';
import { RedisDeadlineError } from '@flashdrop/inventory';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Api } from './http/api';
import { createAdminDashboard } from './services/admin-dashboard';
import { createAdminHealth } from './services/admin-health';
import type { KafkaProbe } from './services/kafka-probe';
import { ADMIN, ORIGIN, sessionToken } from './test/fakes';
import { createTestStack, TEST_ROUTES_SECRET, type TestStack } from './test/stack';

/*
 * The admin dashboard and health routes (design §9, §12) over a throwaway, seeded Postgres and the tests'
 * Redis. No consumer runs here: the test folds each drop's outbox rows into the projection itself, as the
 * sales-dashboard group would. Kafka is absent, or stands in as a quiet fake where a check needs a quiet
 * pipeline.
 */

let stack: TestStack;
let app: Api;
let adminCookie: string;

beforeAll(async () => {
  stack = await createTestStack();
  app = await stack.build();
  adminCookie = await sessionToken(ADMIN);
});
afterAll(async () => {
  await stack?.close();
});

const db = () => stack.database.db;
const logger = createLogger({ name: 'admin-insights-test', level: 'silent' });

async function newDrop() {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/test/drops',
    headers: { origin: ORIGIN, 'x-test-secret': TEST_ROUTES_SECRET },
    payload: { stock: 10, perUserLimit: 3, holdSeconds: 120, paymentSeconds: 300 },
  });
  expect(response.statusCode, response.body).toBe(201);
  return TestDropResponse.parse(response.json());
}

async function newBuyer() {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/test/sessions',
    headers: { origin: ORIGIN, 'x-test-secret': TEST_ROUTES_SECRET },
    payload: { count: 1 },
  });
  const [session] = TestSessionsResponse.parse(response.json()).sessions;
  if (session === undefined) throw new Error('no session minted');
  return { id: session.userId, token: session.token };
}

let keys = 0;
async function hold(buyer: { token: string }, dropId: string, qty: number): Promise<OrderView> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/drops/${dropId}/reservations`,
    headers: { origin: ORIGIN, 'idempotency-key': `insights_${Date.now()}_${++keys}` },
    cookies: { [SESSION_COOKIE]: buyer.token },
    payload: { qty },
  });
  expect(response.statusCode, response.body).toBe(201);
  return OrderResponse.parse(response.json()).order;
}

/** What the sales-dashboard group would do with the drop's events. */
async function project(dropId: string) {
  const { rows } = await db().execute<{ payload: unknown }>(
    sql`SELECT payload FROM outbox WHERE payload->>'dropId' = ${dropId} ORDER BY id`,
  );
  await projectSalesEvents(
    db(),
    rows.map((row) => OrderEvent.parse(row.payload)),
  );
}

const get = (url: string) =>
  app.inject({ method: 'GET', url: `/api/v1${url}`, cookies: { [SESSION_COOKIE]: adminCookie } });

/** Kafka with every group at the log end and no dead letters. */
const quietKafka: KafkaProbe = {
  groupLag: async () => [{ partition: 0, committed: '3', end: '3', lag: 0 }],
  deadLetters: async () => ({ unreplayed: 0, retained: 0 }),
  close: async () => undefined,
};

describe('GET /admin/dashboard/drops/:dropId', () => {
  it('serves the projected totals, minutes adding up to them, live Redis stock and the tiles', async () => {
    const drop = await newDrop();
    const buyer = await newBuyer();
    const placed = await hold(buyer, drop.dropId, 2);
    const outcome = await submitCheckout(db(), {
      orderId: placed.id,
      userId: buyer.id,
      checkoutKey: `checkout_${placed.id}`,
      shipping: {
        name: 'Ada',
        line1: '1 Market Street',
        city: 'San Francisco',
        postalCode: '94105',
        country: 'US',
      },
      paymentMethod: 'pm_ok',
    });
    expect(outcome.kind).toBe('submitted');
    await cancelOrder(db(), { orderId: placed.id, userId: buyer.id });
    await hold(buyer, drop.dropId, 1);
    await project(drop.dropId);

    const response = await get(`/admin/dashboard/drops/${drop.dropId}`);
    expect(response.statusCode, response.body).toBe(200);
    const body = AdminDashboardResponse.parse(response.json());

    expect(body.drop).toMatchObject({ id: drop.dropId, total: 10 });
    expect(body.projection.totals).toMatchObject({
      reserved: 2,
      placed: 1,
      cancelled: 1,
      paid: 0,
      unitsSold: 0,
    });
    expect(body.projection.version).toBeGreaterThan(0);
    const summed = body.series.reduce((sum, minute) => sum + minute.reserved, 0);
    expect(summed).toBe(2);
    expect(body.soldOutMinute).toBeNull();
    // No settlement consumer here: Redis still holds the cancelled order's units.
    expect(body.stock).toMatchObject({ avail: 7, held: 3, sold: 0 });
    expect(body.health).toMatchObject({ consumers: null, deadLetters: null });
  });

  it('still answers while Redis is away: no stock tile and no drift, the projection as usual', async () => {
    const drop = await newDrop();
    await hold(await newBuyer(), drop.dropId, 1);
    await project(drop.dropId);
    const away = () => Promise.reject(new RedisDeadlineError('redis did not answer within 1500 ms'));
    const dashboard = createAdminDashboard({
      db: db(),
      stock: { read: away, snapshot: away },
      health: {
        events: createAdminHealth({ db: db(), redis: stack.redis, logger }).events,
        drift: async () => null,
      },
    });

    const body = AdminDashboardResponse.parse(await dashboard.read(drop.dropId));

    expect(body.stock).toBeNull();
    expect(body.health.redisDriftUnits).toBeNull();
    expect(body.projection.totals).toMatchObject({ reserved: 1 });
  });

  it('is 404 for a drop that does not exist', async () => {
    expect((await get('/admin/dashboard/drops/0192a3b4-0000-4000-8000-0000000000ff')).statusCode).toBe(404);
  });
});

describe('GET /admin/health', () => {
  it('lists the nine invariants, with INV-5 unchecked while Kafka cannot be read', async () => {
    const response = await get('/admin/health');
    expect(response.statusCode, response.body).toBe(200);
    const body = AdminHealthResponse.parse(response.json());

    expect(body.invariants.map((check) => `${check.id} ${check.status}`)).toEqual([
      'INV-1 holds',
      'INV-2 holds',
      'INV-3 holds',
      'INV-4 holds',
      'INV-5 unchecked',
      'INV-6 holds',
      'INV-7 holds',
      'INV-8 holds',
      'INV-9 holds',
    ]);
    expect(body.unavailable).toEqual(['kafka']);
    // Without a quiet pipeline nothing counts as idle, so no equality check ran.
    expect(body.drops.length).toBeGreaterThan(0);
    expect(body.drops.every((drop) => !drop.idle)).toBe(true);
  });

  it('leaves ended test drops out of the live sample, and says so', async () => {
    const [live, ended] = [await newDrop(), await newDrop()];
    await db().execute(sql`UPDATE drops SET status = 'ENDED', ends_at = now() WHERE id = ${ended.dropId}`);

    const health = await createAdminHealth({ db: db(), redis: stack.redis, logger }).read();

    const ids = health.drops.map((drop) => drop.dropId);
    expect(ids).toContain(live.dropId);
    expect(ids).not.toContain(ended.dropId);
    expect(health.invariants.find((check) => check.id === 'INV-1')?.detail).toMatch(
      /ended test drops? not sampled/,
    );
  });

  it('compares an idle drop’s dashboard with its orders, and flags one that drifted (INV-5)', async () => {
    const drop = await newDrop();
    await hold(await newBuyer(), drop.dropId, 1);
    await project(drop.dropId);
    // The seed's sold-out drop carries its history through the outbox too, and is compared as well.
    await project(seedId(4, 4));
    // The relay's work, done: the pipeline is quiet once the outbox is published and every group caught up.
    await db().execute(sql`UPDATE outbox SET published_at = now() WHERE published_at IS NULL`);
    const service = () => createAdminHealth({ db: db(), redis: stack.redis, kafka: quietKafka, logger });

    const healthy = await service().read();
    const ours = healthy.drops.find((candidate) => candidate.dropId === drop.dropId);
    expect(ours).toMatchObject({ idle: true, pending: [], redisDriftUnits: 0 });
    expect(healthy.invariants.find((check) => check.id === 'INV-5')).toMatchObject({ status: 'holds' });

    await db().execute(
      sql`UPDATE drop_sales_totals SET reserved = reserved + 1 WHERE drop_id = ${drop.dropId}`,
    );
    const drifted = await service().read();

    expect(drifted.invariants.find((check) => check.id === 'INV-5')).toMatchObject({
      status: 'breached',
      violations: expect.arrayContaining([
        { dropId: drop.dropId, message: 'dashboard reserved 2 != 1 from its orders' },
        { dropId: drop.dropId, message: 'dashboard minutes add up to reserved 1, its totals say 2' },
      ]),
    });
  });
});

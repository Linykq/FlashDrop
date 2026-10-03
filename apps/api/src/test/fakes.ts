import { createLogger } from '@flashdrop/config';
import type { AdminDrop, DropListQuery, ProductDetail, SessionUser, StockLevel } from '@flashdrop/contracts';
import { type NewReservation, type OrderRecord, type RejectedTombstone, toOrderView } from '@flashdrop/db';
import type { PostgresRefusal } from '@flashdrop/domain';
import type { ReserveInput, ReserveResult } from '@flashdrop/inventory';
import { type AppOptions, type AppServices, buildApp } from '../app';
import type { Api } from '../http/api';
import { createSessionCodec } from '../http/session';
import type { DropListing } from '../services/catalog';
import { createReservationService, type ReservePorts } from '../services/reserve';

/*
 * In-memory services for `inject()` tests: the routes, plugins and DTO validation run for real, without
 * Postgres. The integration tests (`*.int.test.ts`) cover the Postgres implementations.
 */

export const SECRET = 'test-session-secret-at-least-32-chars';
export const ORIGIN = 'http://127.0.0.1:3000';
export const NOW = new Date('2026-10-02T12:00:00.000Z');

export const ADMIN: SessionUser = {
  id: '5eed0001-0000-4000-8000-000000000001',
  email: 'mira@example.test',
  displayName: 'Mira Chen',
  role: 'admin',
};
export const BUYER: SessionUser = {
  id: '5eed0001-0000-4000-8000-000000000002',
  email: 'ada@example.test',
  displayName: 'Ada Lindqvist',
  role: 'buyer',
};

export const IMAGE_KEY = `${'ab'.repeat(32)}.jpg`;

export const LIVE_DROP: DropListing = {
  id: '5eed0004-0000-4000-8000-000000000001',
  status: 'LIVE',
  startsAt: '2026-10-02T11:40:00.000Z',
  endsAt: '2026-10-02T15:00:00.000Z',
  priceCents: 14_900,
  currency: 'USD',
  perUserLimit: 2,
  holdSeconds: 120,
  room: { slug: 'studio', title: 'FlashDrop Studio' },
  product: {
    id: '5eed0003-0000-4000-8000-000000000002',
    slug: 'sage-wireless-headphones',
    title: 'Sage Wireless Over-Ear Headphones',
    imageKeys: [IMAGE_KEY],
  },
};

export const LIVE_STOCK: StockLevel = { avail: 240, held: 6, sold: 4, status: 'LIVE', gen: 0, seq: 0 };

export const PRODUCT: ProductDetail = {
  product: {
    ...LIVE_DROP.product,
    description: 'Closed-back over-ear headphones with a soft memory-foam band.',
    attributes: {
      category: 'audio',
      condition: 'new',
      brand: null,
      color: 'Sage',
      material: null,
      size: null,
      highlights: [],
      tags: [],
      photoCredits: [],
    },
  },
  drop: {
    id: LIVE_DROP.id,
    status: LIVE_DROP.status,
    startsAt: LIVE_DROP.startsAt,
    endsAt: LIVE_DROP.endsAt,
    priceCents: LIVE_DROP.priceCents,
    currency: LIVE_DROP.currency,
    perUserLimit: LIVE_DROP.perUserLimit,
    holdSeconds: LIVE_DROP.holdSeconds,
    room: LIVE_DROP.room,
  },
};

export const ADMIN_DROP: AdminDrop = {
  id: '5eed0004-0000-4000-8000-000000000009',
  productId: LIVE_DROP.product.id,
  roomId: null,
  status: 'DRAFT',
  startsAt: '2026-10-03T12:00:00.000Z',
  endsAt: '2026-10-03T13:00:00.000Z',
  priceCents: 2_500,
  currency: 'USD',
  perUserLimit: 2,
  holdSeconds: 120,
  paymentSeconds: 300,
  inventory: { total: 100, reserved: 0, sold: 0, redisGen: 0 },
};

/** The fake Redis and Postgres behind the real reserve logic (`createReservationService`). */
export interface FakeReserve {
  /** The Postgres breaker. */
  healthy: boolean;
  /** What `fd_reserve` answers. Default: a new hold under generation 1. */
  admit: (input: ReserveInput) => ReserveResult;
  /** What the reserve transaction decides when the rid has no order yet. Default: created. */
  decide: () => 'created' | PostgresRefusal;
  readonly tracked: Set<string>;
  readonly admitted: ReserveInput[];
  readonly recordedGens: number[];
  readonly tombstones: RejectedTombstone[];
  readonly nudged: string[];
}

export interface FakeState {
  readonly drops: DropListing[];
  readonly stock: Map<string, StockLevel>;
  /** Drops whose Redis state is RECONCILING or missing: their stock snapshot is `RETRY`. */
  readonly rebuilding: Set<string>;
  readonly products: Map<string, ProductDetail>;
  readonly users: Map<string, SessionUser>;
  /** Every query `listDrops` received, to assert on parsed query strings. */
  readonly listQueries: DropListQuery[];
  /** Postgres orders by id. */
  readonly orders: Map<string, OrderRecord>;
  readonly reserve: FakeReserve;
  /** Admin calls as `<method> <dropId?>`, and an error the next call throws. */
  readonly admin: { readonly calls: string[]; fail: Error | undefined };
  /** Rate-limit counters by Redis key; a test clears them to start a new window. */
  readonly rateLimitHits: Map<string, number>;
}

export function fakeState(): FakeState {
  return {
    drops: [LIVE_DROP],
    stock: new Map([[LIVE_DROP.id, LIVE_STOCK]]),
    rebuilding: new Set(),
    products: new Map([[PRODUCT.product.slug, PRODUCT]]),
    users: new Map([
      [ADMIN.id, ADMIN],
      [BUYER.id, BUYER],
    ]),
    listQueries: [],
    orders: new Map(),
    reserve: {
      healthy: true,
      admit: () => ({ kind: 'RESERVED', gen: 1 }),
      decide: () => 'created',
      tracked: new Set([LIVE_DROP.id]),
      admitted: [],
      recordedGens: [],
      tombstones: [],
      nudged: [],
    },
    admin: { calls: [], fail: undefined },
    rateLimitHits: new Map(),
  };
}

/** An order row as Postgres would hold it for `reservation`, at the fake clock. */
export function fakeOrder(reservation: NewReservation, overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: reservation.id,
    userId: reservation.userId,
    dropId: reservation.dropId,
    productId: LIVE_DROP.product.id,
    qty: reservation.qty,
    unitPriceCents: LIVE_DROP.priceCents,
    totalCents: reservation.qty * LIVE_DROP.priceCents,
    currency: 'USD',
    status: 'RESERVED',
    closeReason: null,
    idempotencyKey: reservation.idempotencyKey,
    requestHash: reservation.requestHash,
    checkoutKey: null,
    checkoutHash: null,
    shipping: null,
    paymentMethod: null,
    expiresAt: new Date(NOW.getTime() + LIVE_DROP.holdSeconds * 1000),
    extensions: 0,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    paidAt: null,
    closedAt: null,
    redisSettledAt: null,
    ...overrides,
  };
}

function fakeReservePorts(state: FakeState): ReservePorts {
  const { reserve } = state;
  const withProduct = (order: OrderRecord) => ({ order, product: LIVE_DROP.product });
  return {
    postgresHealthy: () => reserve.healthy,
    admit: async (input) => {
      reserve.admitted.push(input);
      return reserve.admit(input);
    },
    record: async ({ gen, traceId: _traceId, ...reservation }) => {
      reserve.recordedGens.push(gen);
      if (state.orders.has(reservation.id)) return { kind: 'replay' };
      const decision = reserve.decide();
      if (decision !== 'created') return { kind: 'refused', reason: decision };
      const order = fakeOrder(reservation);
      state.orders.set(order.id, order);
      return { kind: 'created', ...withProduct(order) };
    },
    tombstone: async (tombstone) => {
      reserve.tombstones.push(tombstone);
      if (state.orders.has(tombstone.id)) return false;
      const { reason, traceId: _traceId, ...reservation } = tombstone;
      state.orders.set(
        tombstone.id,
        fakeOrder(reservation, { status: 'REJECTED', closeReason: reason, closedAt: NOW }),
      );
      return true;
    },
    findOrder: async (orderId, userId) => {
      const order = state.orders.get(orderId);
      return order?.userId === userId ? withProduct(order) : undefined;
    },
    isTracked: async (dropId) => reserve.tracked.has(dropId),
    nudge: async (dropId) => {
      reserve.nudged.push(dropId);
    },
  };
}

export function fakeServices(state: FakeState): AppServices {
  const adminCall = async (call: string): Promise<AdminDrop> => {
    state.admin.calls.push(call);
    const { fail } = state.admin;
    state.admin.fail = undefined;
    if (fail !== undefined) throw fail;
    return ADMIN_DROP;
  };
  const view = (order: OrderRecord) => toOrderView(order, LIVE_DROP.product, NOW);
  return {
    catalog: {
      listDrops: async (query) => {
        state.listQueries.push(query);
        return state.drops;
      },
      productBySlug: async (slug) => state.products.get(slug),
    },
    stock: {
      read: async (ids) => {
        const levels = new Map<string, StockLevel>();
        for (const id of ids) {
          const level = state.stock.get(id);
          if (level !== undefined) levels.set(id, level);
        }
        return levels;
      },
      snapshot: async (id) => (state.rebuilding.has(id) ? 'RETRY' : state.stock.get(id)),
    },
    users: {
      listDevUsers: async () => [...state.users.values()],
      findDevUser: async (id) => state.users.get(id),
      findById: async (id) => state.users.get(id),
    },
    reservations: createReservationService(fakeReservePorts(state), () => NOW),
    orders: {
      get: async (orderId, userId) => {
        const order = state.orders.get(orderId);
        return order?.userId === userId ? view(order) : undefined;
      },
      listForUser: async (userId, limit) =>
        [...state.orders.values()]
          .filter((order) => order.userId === userId && order.status !== 'REJECTED')
          .slice(0, limit)
          .map(view),
    },
    adminDrops: {
      create: () => adminCall('create'),
      patch: (dropId) => adminCall(`patch ${dropId}`),
      act: (dropId, action) => adminCall(`${action} ${dropId}`),
    },
    rateLimitCounter: async (key) => {
      const count = (state.rateLimitHits.get(key) ?? 0) + 1;
      state.rateLimitHits.set(key, count);
      return { count, ttlMs: 400 };
    },
    checks: { postgres: async () => undefined },
  };
}

/** The app over fake services, with a silent logger. Close it in `afterEach`/`afterAll`. */
export async function buildTestApp(overrides: Partial<AppOptions> = {}, state = fakeState()): Promise<Api> {
  return buildApp({
    logger: createLogger({ name: 'api-test', level: 'silent' }),
    roles: ['http', 'ws'],
    allowedOrigins: [ORIGIN],
    sessionSecret: SECRET,
    uploadDir: 'unused',
    services: fakeServices(state),
    rateLimits: { userPerSecond: 10, ipPerSecond: 100 },
    now: () => NOW,
    ...overrides,
  });
}

/** A signed `fd_session` token for `user`, as dev login would set it. */
export function sessionToken(user: SessionUser): Promise<string> {
  return createSessionCodec(SECRET).issue(user);
}

import { createLogger } from '@flashdrop/config';
import type { DropListQuery, ProductDetail, SessionUser, StockLevel } from '@flashdrop/contracts';
import { type AppOptions, type AppServices, buildApp } from '../app';
import type { Api } from '../http/api';
import type { DropListing } from '../services/catalog';

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

export interface FakeState {
  readonly drops: DropListing[];
  readonly stock: Map<string, StockLevel>;
  readonly products: Map<string, ProductDetail>;
  readonly users: Map<string, SessionUser>;
  /** Every query `listDrops` received, to assert on parsed query strings. */
  readonly listQueries: DropListQuery[];
}

export function fakeState(): FakeState {
  return {
    drops: [LIVE_DROP],
    stock: new Map([[LIVE_DROP.id, LIVE_STOCK]]),
    products: new Map([[PRODUCT.product.slug, PRODUCT]]),
    users: new Map([
      [ADMIN.id, ADMIN],
      [BUYER.id, BUYER],
    ]),
    listQueries: [],
  };
}

export function fakeServices(state: FakeState): AppServices {
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
    },
    users: {
      listDevUsers: async () => [...state.users.values()],
      findDevUser: async (id) => state.users.get(id),
      findById: async (id) => state.users.get(id),
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
    now: () => NOW,
    ...overrides,
  });
}

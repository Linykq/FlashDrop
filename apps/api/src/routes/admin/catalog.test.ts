import { SESSION_COOKIE } from '@flashdrop/config/constants';
import {
  AdminDropDetailResponse,
  type AdminDropListing,
  AdminDropListResponse,
  AdminProductListResponse,
  AdminRoomListResponse,
  ProblemDetails,
} from '@flashdrop/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppServices } from '../../app';
import type { Api } from '../../http/api';
import { createFakeAdminCatalog, type FakeAdminCatalog } from '../../test/catalog-fake';
import {
  ADMIN,
  ADMIN_DROP,
  BUYER,
  buildTestApp,
  fakeServices,
  fakeState,
  LIVE_DROP,
  sessionToken,
} from '../../test/fakes';

/*
 * The admin catalog reads over an in-memory store: admin-only access, query validation and the response
 * contracts. The Postgres queries are covered by admin-catalog.int.test.ts.
 */

let app: Api;
let catalog: FakeAdminCatalog;

const ROOM = { id: '5eed0002-0000-4000-8000-000000000001', slug: 'studio', title: 'FlashDrop Studio' };
const DRAFT: AdminDropListing = { ...ADMIN_DROP, product: LIVE_DROP.product, room: null };
const LIVE: AdminDropListing = {
  ...ADMIN_DROP,
  id: LIVE_DROP.id,
  status: 'LIVE',
  product: LIVE_DROP.product,
  room: ROOM,
};

beforeEach(async () => {
  catalog = createFakeAdminCatalog();
  catalog.drops.push(LIVE, DRAFT);
  catalog.products.push({ ...LIVE_DROP.product, openDropId: LIVE_DROP.id });
  catalog.rooms.push(ROOM);
  const services: AppServices = { ...fakeServices(fakeState()), adminCatalog: catalog };
  app = await buildTestApp({ services });
});
afterEach(() => app.close());

async function get(url: string, user: typeof ADMIN | null = ADMIN) {
  return app.inject({
    method: 'GET',
    url: `/api/v1${url}`,
    cookies: user === null ? {} : { [SESSION_COOKIE]: await sessionToken(user) },
  });
}

describe('admin catalog routes', () => {
  it('lists drops in every status by default, never cached', async () => {
    const response = await get('/admin/drops');
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(AdminDropListResponse.parse(response.json()).drops.map((drop) => drop.id)).toEqual([
      LIVE.id,
      DRAFT.id,
    ]);
    expect(catalog.queries).toEqual([
      { status: ['DRAFT', 'SCHEDULED', 'LIVE', 'PAUSED', 'ENDED'], limit: 100 },
    ]);
  });

  it('filters by a comma-separated status list in any case', async () => {
    const response = await get('/admin/drops?status=draft,%20Draft&limit=5');
    expect(AdminDropListResponse.parse(response.json()).drops.map((drop) => drop.id)).toEqual([DRAFT.id]);
    expect(catalog.queries).toEqual([{ status: ['DRAFT'], limit: 5 }]);
  });

  it.each([['status=sold'], ['status='], ['limit=0'], ['limit=201']])(
    'answers 400 for ?%s',
    async (query) => {
      const response = await get(`/admin/drops?${query}`);
      expect(response.statusCode).toBe(400);
      expect(ProblemDetails.parse(response.json()).code).toBe('VALIDATION_FAILED');
    },
  );

  it('reads one drop, and 404 for an unknown or malformed id', async () => {
    const found = await get(`/admin/drops/${DRAFT.id}`);
    expect(AdminDropDetailResponse.parse(found.json())).toEqual({ drop: DRAFT });
    expect((await get('/admin/drops/5eed0004-0000-4000-8000-0000000000ff')).statusCode).toBe(404);
    expect((await get('/admin/drops/not-a-uuid')).statusCode).toBe(400);
  });

  it('lists products with their open drop, and rooms', async () => {
    const products = AdminProductListResponse.parse((await get('/admin/products')).json());
    expect(products.products).toEqual([{ ...LIVE_DROP.product, openDropId: LIVE_DROP.id }]);
    const rooms = AdminRoomListResponse.parse((await get('/admin/rooms')).json());
    expect(rooms.rooms).toEqual([ROOM]);
  });

  it.each([['/admin/drops'], [`/admin/drops/${DRAFT.id}`], ['/admin/products'], ['/admin/rooms']])(
    'GET %s: 401 signed out, 403 for a buyer',
    async (url) => {
      expect((await get(url, null)).statusCode).toBe(401);
      expect((await get(url, BUYER)).statusCode).toBe(403);
    },
  );
});

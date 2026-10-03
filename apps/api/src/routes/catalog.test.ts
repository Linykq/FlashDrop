import { DropListResponse, ProductDetail, StockSnapshot } from '@flashdrop/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Api } from '../http/api';
import { buildTestApp, type FakeState, fakeState, LIVE_DROP, LIVE_STOCK, NOW, PRODUCT } from '../test/fakes';

let app: Api;
let state: FakeState;

beforeEach(async () => {
  state = fakeState();
  app = await buildTestApp({}, state);
});
afterEach(() => app.close());

describe('GET /api/v1/drops', () => {
  it('lists drops with their stock; LIVE and SCHEDULED, 20 at most, by default', async () => {
    const response = await app.inject({ url: '/api/v1/drops' });
    expect(response.statusCode).toBe(200);
    expect(DropListResponse.parse(response.json())).toEqual({ drops: [{ ...LIVE_DROP, stock: LIVE_STOCK }] });
    expect(state.listQueries).toEqual([{ status: ['LIVE', 'SCHEDULED'], limit: 20 }]);
  });

  it('parses ?status= in any case, de-duplicated, and ?limit=', async () => {
    const response = await app.inject({ url: '/api/v1/drops?status=ended,%20Live,ENDED&limit=5' });
    expect(response.statusCode).toBe(200);
    expect(state.listQueries).toEqual([{ status: ['ENDED', 'LIVE'], limit: 5 }]);
  });

  it.each([
    ['status=draft', 'status.0'],
    ['status=', 'status.0'],
    ['limit=0', 'limit'],
    ['limit=51', 'limit'],
    ['limit=ten', 'limit'],
  ])('rejects ?%s', async (query, path) => {
    const response = await app.inject({ url: `/api/v1/drops?${query}` });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'Invalid querystring' });
    expect(response.json().errors.map((error: { path: string }) => error.path)).toContain(path);
  });

  it('leaves out a drop whose stock level is missing instead of failing the page', async () => {
    state.stock.clear();
    const response = await app.inject({ url: '/api/v1/drops' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ drops: [] });
  });
});

describe('GET /api/v1/products/:slug', () => {
  it('returns the product and its current drop', async () => {
    const response = await app.inject({ url: `/api/v1/products/${PRODUCT.product.slug}` });
    expect(response.statusCode).toBe(200);
    expect(ProductDetail.parse(response.json())).toEqual(PRODUCT);
  });

  it('answers 404 for an unknown product', async () => {
    const response = await app.inject({ url: '/api/v1/products/no-such-product' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'NOT_FOUND', detail: 'Product not found' });
  });

  it('answers 400 for a slug that cannot exist', async () => {
    const response = await app.inject({ url: '/api/v1/products/Not_A_Slug' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ detail: 'Invalid params', errors: [{ path: 'slug' }] });
  });

  it('never sends what the contract does not allow: a bad row is a 500, not a leak', async () => {
    const broken = { ...PRODUCT, product: { ...PRODUCT.product, imageKeys: ['../../etc/passwd'] } };
    state.products.set(PRODUCT.product.slug, broken);
    const response = await app.inject({ url: `/api/v1/products/${PRODUCT.product.slug}` });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      code: 'INTERNAL',
      traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
  });
});

describe('GET /api/v1/drops/:dropId/stock', () => {
  it('returns the stock snapshot with the server clock, uncached', async () => {
    const response = await app.inject({ url: `/api/v1/drops/${LIVE_DROP.id}/stock` });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(StockSnapshot.parse(response.json())).toEqual({ ...LIVE_STOCK, serverNow: NOW.toISOString() });
  });

  it('answers 503 RETRY, uncached, while the drop is being rebuilt in Redis', async () => {
    state.rebuilding.add(LIVE_DROP.id);
    const response = await app.inject({ url: `/api/v1/drops/${LIVE_DROP.id}/stock` });
    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('1');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({ code: 'RETRY' });
  });

  it('answers an unknown drop with an uncached 404', async () => {
    const response = await app.inject({ url: '/api/v1/drops/11111111-1111-4111-8111-111111111111/stock' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({ code: 'NOT_FOUND', detail: 'Drop not found' });
  });

  it('answers 400 for a drop id that is not a uuid', async () => {
    const response = await app.inject({ url: '/api/v1/drops/42/stock' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ errors: [{ path: 'dropId', message: 'Invalid UUID' }] });
  });
});

describe('API_ROLES', () => {
  it('serves no REST routes without the http role', async () => {
    const wsOnly = await buildTestApp({ roles: ['ws'] });
    try {
      expect((await wsOnly.inject({ url: '/api/v1/drops' })).statusCode).toBe(404);
      expect((await wsOnly.inject({ url: '/api/v1/health/live' })).statusCode).toBe(200);
    } finally {
      await wsOnly.close();
    }
  });
});

describe('unknown routes', () => {
  it('answer 404 problem details', async () => {
    const response = await app.inject({ url: '/api/v1/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(response.json()).toMatchObject({ code: 'NOT_FOUND', detail: 'No such route' });
  });

  it('carry the caller trace id from traceparent', async () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const response = await app.inject({
      url: '/api/v1/nope',
      headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
    });
    expect(response.json().traceId).toBe(traceId);
  });
});

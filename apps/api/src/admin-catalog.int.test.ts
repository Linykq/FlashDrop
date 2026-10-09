import { SESSION_COOKIE } from '@flashdrop/config/constants';
import {
  AdminDropDetailResponse,
  AdminDropListResponse,
  AdminDropResponse,
  AdminProductListResponse,
  AdminRoomListResponse,
  RoomDetail,
  TestDropResponse,
} from '@flashdrop/contracts';
import { SEED_ROOM, seedProductId } from '@flashdrop/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Api } from './http/api';
import { ADMIN, ORIGIN, sessionToken } from './test/fakes';
import { createTestStack, TEST_ROUTES_SECRET, type TestStack } from './test/stack';

/*
 * The admin catalog reads (design §5.1, design system §10.8) over a throwaway, seeded Postgres: every status
 * including DRAFT, the documented order, products with their open drop, and test products and rooms left out.
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

async function get(url: string) {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1${url}`,
    cookies: { [SESSION_COOKIE]: adminCookie },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

async function createDraft(productId: string) {
  const startsAt = new Date(Date.now() + 48 * 3_600_000);
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/drops',
    headers: { origin: ORIGIN },
    cookies: { [SESSION_COOKIE]: adminCookie },
    payload: {
      productId,
      roomId: SEED_ROOM.id,
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 3_600_000).toISOString(),
      priceCents: 4_200,
      stock: 40,
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  return AdminDropResponse.parse(response.json()).drop;
}

describe('admin catalog over Postgres', () => {
  it('lists every status, DRAFT included, live first and ended last, with product and room', async () => {
    const draft = await createDraft(seedProductId('stone-charcoal-mug-set'));
    const { drops } = AdminDropListResponse.parse(await get('/admin/drops'));

    const statuses = drops.map((drop) => drop.status);
    expect(statuses[0]).toBe('LIVE');
    expect(statuses.at(-1)).toBe('ENDED');
    const listed = drops.find((drop) => drop.id === draft.id);
    expect(listed).toMatchObject({
      status: 'DRAFT',
      priceCents: 4_200,
      inventory: { total: 40, reserved: 0, sold: 0 },
      product: { id: seedProductId('stone-charcoal-mug-set') },
      room: { id: SEED_ROOM.id, slug: SEED_ROOM.slug, title: SEED_ROOM.title },
    });

    const filtered = AdminDropListResponse.parse(await get('/admin/drops?status=draft'));
    expect(filtered.drops.map((drop) => drop.id)).toEqual([draft.id]);
    expect(AdminDropDetailResponse.parse(await get(`/admin/drops/${draft.id}`)).drop).toEqual(listed);
  });

  it('leaves test products and rooms out of the lists, but reads a test drop by id and its room by slug', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/test/drops',
      headers: { origin: ORIGIN, 'x-test-secret': TEST_ROUTES_SECRET },
      payload: { stock: 5, perUserLimit: 1, holdSeconds: 120, paymentSeconds: 300, room: true },
    });
    expect(response.statusCode, response.body).toBe(201);
    const testDrop = TestDropResponse.parse(response.json());

    const { drops } = AdminDropListResponse.parse(await get('/admin/drops'));
    expect(drops.some((drop) => drop.id === testDrop.dropId)).toBe(false);
    const { products } = AdminProductListResponse.parse(await get('/admin/products'));
    expect(products.some((product) => product.slug === testDrop.productSlug)).toBe(false);
    expect(AdminDropDetailResponse.parse(await get(`/admin/drops/${testDrop.dropId}`)).drop.id).toBe(
      testDrop.dropId,
    );

    // The spec's own live room (live-room.spec): pinned to its drop, readable by slug, never listed.
    expect(testDrop.room).not.toBeNull();
    const { rooms } = AdminRoomListResponse.parse(await get('/admin/rooms'));
    expect(rooms.some((room) => room.id === testDrop.room?.id)).toBe(false);
    const detail = RoomDetail.parse(await get(`/rooms/${testDrop.room?.slug}`));
    expect(detail.room).toMatchObject({ id: testDrop.room?.id, hlsUrl: '/hls/live.m3u8' });
    expect(detail.drop?.id).toBe(testDrop.dropId);
  });

  it('lists products with their open drop, and the rooms', async () => {
    const { products } = AdminProductListResponse.parse(await get('/admin/products'));
    const live = products.find((product) => product.id === seedProductId('faceted-eau-de-parfum'));
    const ended = products.find((product) => product.id === seedProductId('amber-jar-candle'));
    expect(live?.openDropId).not.toBeNull();
    expect(ended?.openDropId).toBeNull();
    expect(new Set(products.map((product) => product.id)).size).toBe(products.length);

    const { rooms } = AdminRoomListResponse.parse(await get('/admin/rooms'));
    expect(rooms).toEqual([{ id: SEED_ROOM.id, slug: SEED_ROOM.slug, title: SEED_ROOM.title }]);
  });
});

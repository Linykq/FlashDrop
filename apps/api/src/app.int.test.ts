import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@flashdrop/config';
import { SESSION_COOKIE } from '@flashdrop/config/constants';
import {
  DevUsersResponse,
  DropListResponse,
  MeResponse,
  ProductDetail,
  StockSnapshot,
} from '@flashdrop/contracts';
import {
  createDb,
  createPool,
  dropInventory,
  drops,
  eq,
  POOL_PROFILES,
  products,
  SEED_USERS,
  seedId,
  users,
} from '@flashdrop/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import type { Api } from './http/api';
import { createPostgresCatalog } from './services/catalog';
import { postgresCheck } from './services/health';
import { createPostgresStockReader } from './services/stock';
import { createPostgresUsers } from './services/users';
import { createSeededDatabase, type SeededDatabase } from './test/database';

/*
 * The api against Postgres: a throwaway database with the real migrations and the real seed (drops placed
 * around NOW), so every query runs against the schema and data it serves in development.
 */

const NOW = new Date('2026-10-02T12:34:56.789Z');
const ORIGIN = 'http://127.0.0.1:3000';
const SECRET = 'integration-session-secret-32-chars!';
const logger = createLogger({ name: 'api-int', level: 'silent' });

const LIVE_DROP = seedId(4, 1);
const ENDED_DROP = seedId(4, 4);

let test: SeededDatabase;
let app: Api;

function appOver(pool: ReturnType<typeof createPool>, uploadDir: string): Promise<Api> {
  const db = createDb(pool);
  return buildApp({
    logger,
    roles: ['http'],
    allowedOrigins: [ORIGIN],
    sessionSecret: SECRET,
    uploadDir,
    services: {
      catalog: createPostgresCatalog(db),
      stock: createPostgresStockReader(db),
      users: createPostgresUsers(db),
      checks: { postgres: postgresCheck(pool) },
    },
    now: () => NOW,
  });
}

beforeAll(async () => {
  test = await createSeededDatabase(NOW);
  app = await appOver(test.pool, test.uploadDir);
});
afterAll(async () => {
  await app?.close();
  await test?.drop();
});

/** A product with a drop in the given state, with fresh ids. The drop runs for an hour from `startsAt`. */
async function insertProduct(
  productStatus: 'DRAFT' | 'PUBLISHED',
  dropStatus: 'DRAFT' | 'SCHEDULED' | 'ENDED',
  startsAt = new Date(NOW.getTime() + 3_600_000),
) {
  const productId = randomUUID();
  const dropId = randomUUID();
  const slug = `test-product-${productId.slice(0, 8)}`;
  await test.db.insert(products).values({
    id: productId,
    slug,
    title: 'Integration Test Product',
    description: 'Only exists inside one test database.',
    imageKeys: [],
    status: productStatus,
  });
  await test.db.insert(drops).values({
    id: dropId,
    productId,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 3_600_000),
    priceCents: 1_000,
    perUserLimit: 1,
    status: dropStatus,
  });
  await test.db.insert(dropInventory).values({ dropId, total: 10 });
  return { productId, dropId, slug };
}

describe('catalog', () => {
  it('lists LIVE then SCHEDULED drops by start time, with stock from drop_inventory', async () => {
    const response = await app.inject({ url: '/api/v1/drops' });
    expect(response.statusCode).toBe(200);
    const { drops: listed } = DropListResponse.parse(response.json());
    expect(listed.map((drop) => [drop.product.slug, drop.status])).toEqual([
      ['sage-wireless-headphones', 'LIVE'],
      ['faceted-eau-de-parfum', 'SCHEDULED'],
      ['linen-band-collar-shirt', 'SCHEDULED'],
    ]);
    expect(listed[0]).toMatchObject({
      id: LIVE_DROP,
      startsAt: '2026-10-02T12:14:00.000Z',
      endsAt: '2026-10-02T16:00:00.000Z',
      room: { slug: 'studio', title: 'FlashDrop Studio' },
      stock: { avail: 250, held: 0, sold: 0, status: 'LIVE', gen: 0, seq: 0 },
    });
    expect(listed[1]?.room).toBeNull();
    expect(listed.every((drop) => drop.product.imageKeys.length > 0)).toBe(true);
  });

  it('filters by status and limits', async () => {
    const ended = DropListResponse.parse((await app.inject({ url: '/api/v1/drops?status=ended' })).json());
    expect(ended.drops).toEqual([
      expect.objectContaining({
        id: ENDED_DROP,
        status: 'ENDED',
        stock: { avail: 0, held: 0, sold: 50, status: 'ENDED', gen: 0, seq: 0 },
      }),
    ]);
    const first = DropListResponse.parse((await app.inject({ url: '/api/v1/drops?limit=1' })).json());
    expect(first.drops.map((drop) => drop.id)).toEqual([LIVE_DROP]);
  });

  it('returns a product with its open drop, or its latest ended one, or none', async () => {
    const live = ProductDetail.parse(
      (await app.inject({ url: '/api/v1/products/sage-wireless-headphones' })).json(),
    );
    expect(live.drop).toMatchObject({
      id: LIVE_DROP,
      status: 'LIVE',
      priceCents: 14_900,
      room: { slug: 'studio' },
    });
    expect(live.product.attributes.category).toBe('audio');
    expect(live.product.attributes.photoCredits.length).toBe(live.product.imageKeys.length);

    const ended = ProductDetail.parse(
      (await app.inject({ url: '/api/v1/products/amber-jar-candle' })).json(),
    );
    expect(ended.drop).toMatchObject({ id: ENDED_DROP, status: 'ENDED' });

    const none = ProductDetail.parse(
      (await app.inject({ url: '/api/v1/products/ring-stoneware-vase' })).json(),
    );
    expect(none.drop).toBeNull();
  });

  it('hides DRAFT products and DRAFT drops everywhere', async () => {
    const draftProduct = await insertProduct('DRAFT', 'SCHEDULED');
    const draftDrop = await insertProduct('PUBLISHED', 'DRAFT');

    const all = DropListResponse.parse(
      (await app.inject({ url: '/api/v1/drops?status=live,scheduled,paused,ended&limit=50' })).json(),
    );
    const ids = all.drops.map((drop) => drop.id);
    expect(ids).toHaveLength(4);
    expect(ids).not.toContain(draftProduct.dropId);
    expect(ids).not.toContain(draftDrop.dropId);

    expect((await app.inject({ url: `/api/v1/products/${draftProduct.slug}` })).statusCode).toBe(404);
    const published = ProductDetail.parse(
      (await app.inject({ url: `/api/v1/products/${draftDrop.slug}` })).json(),
    );
    expect(published.drop).toBeNull();
    expect((await app.inject({ url: `/api/v1/drops/${draftDrop.dropId}/stock` })).statusCode).toBe(404);
  });

  it('serves the stock snapshot from drop_inventory, uncached', async () => {
    const { dropId } = await insertProduct('PUBLISHED', 'SCHEDULED');
    await test.db.update(dropInventory).set({ reserved: 3, sold: 2 }).where(eq(dropInventory.dropId, dropId));
    const response = await app.inject({ url: `/api/v1/drops/${dropId}/stock` });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(StockSnapshot.parse(response.json())).toEqual({
      avail: 5,
      held: 3,
      sold: 2,
      status: 'SCHEDULED',
      gen: 0,
      seq: 0,
      serverNow: NOW.toISOString(),
    });
  });

  it('lists ENDED drops most recently ended first, so a limit keeps the latest', async () => {
    // Around the seeded sold-out drop, which ended 45 minutes before NOW.
    const startedHoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);
    const oldest = await insertProduct('PUBLISHED', 'ENDED', startedHoursAgo(50));
    const newest = await insertProduct('PUBLISHED', 'ENDED', startedHoursAgo(1.25));
    const older = await insertProduct('PUBLISHED', 'ENDED', startedHoursAgo(26));

    const ended = DropListResponse.parse(
      (await app.inject({ url: '/api/v1/drops?status=ended&limit=3' })).json(),
    );
    expect(ended.drops.map((drop) => drop.id)).toEqual([newest.dropId, ENDED_DROP, older.dropId]);
    expect(ended.drops.map((drop) => drop.id)).not.toContain(oldest.dropId);

    const mixed = DropListResponse.parse(
      (await app.inject({ url: '/api/v1/drops?status=ended,live&limit=2' })).json(),
    );
    expect(mixed.drops.map((drop) => drop.id)).toEqual([LIVE_DROP, newest.dropId]);
  });
});

describe('dev login', () => {
  it('offers the seeded accounts, admin first', async () => {
    const { users: listed } = DevUsersResponse.parse(
      (await app.inject({ url: '/api/v1/auth/dev-users' })).json(),
    );
    expect(listed.map((user) => user.id)).toEqual(SEED_USERS.map((user) => user.id));
    expect(listed[0]?.role).toBe('admin');
  });

  it('signs a seeded user in and reads them back from Postgres', async () => {
    const admin = SEED_USERS[0];
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/dev-login',
      headers: { origin: ORIGIN },
      payload: { userId: admin.id },
    });
    expect(login.statusCode).toBe(204);
    const token = login.cookies.find((cookie) => cookie.name === SESSION_COOKIE)?.value ?? '';
    const me = await app.inject({ url: '/api/v1/me', cookies: { [SESSION_COOKIE]: token } });
    expect(MeResponse.parse(me.json())).toEqual({
      user: { id: admin.id, email: admin.email, displayName: admin.displayName, role: admin.role },
    });
  });

  it('never signs in a user who is not part of the seed', async () => {
    const id = randomUUID();
    await test.db.insert(users).values({ id, email: `${id}@example.test`, displayName: 'Not Seeded' });
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/dev-login',
      headers: { origin: ORIGIN },
      payload: { userId: id },
    });
    expect(login.statusCode).toBe(404);
    const { users: listed } = DevUsersResponse.parse(
      (await app.inject({ url: '/api/v1/auth/dev-users' })).json(),
    );
    expect(listed.map((user) => user.id)).not.toContain(id);
  });
});

describe('uploads', () => {
  it('serves a seeded photo from UPLOAD_DIR, byte for byte', async () => {
    const detail = ProductDetail.parse(
      (await app.inject({ url: '/api/v1/products/amber-jar-candle' })).json(),
    );
    const key = detail.product.imageKeys[0] ?? '';
    const response = await app.inject({ url: `/uploads/${key}` });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/jpeg');
    expect(response.rawPayload).toEqual(await readFile(join(test.uploadDir, key)));
    expect(`${createHash('sha256').update(response.rawPayload).digest('hex')}.jpg`).toBe(key);
  });
});

describe('health', () => {
  it('is ready while Postgres answers', async () => {
    const response = await app.inject({ url: '/api/v1/health' });
    expect(response.json()).toEqual({ status: 'ok', checks: { postgres: 'ok' } });
  });

  it('answers 503 RETRY, not 500, while Postgres is unreachable', async () => {
    const unreachable = createPool({
      connectionString: 'postgres://flashdrop:flashdrop@127.0.0.1:1/flashdrop',
      logger: { warn: () => undefined },
      ...POOL_PROFILES.api,
    });
    const down = await appOver(unreachable, test.uploadDir);
    try {
      for (const url of ['/api/v1/health', '/api/v1/drops', `/api/v1/drops/${LIVE_DROP}/stock`]) {
        const response = await down.inject({ url });
        expect(response.statusCode, url).toBe(503);
        expect(response.headers['retry-after']).toBe('1');
        expect(response.json()).toMatchObject({ code: 'RETRY' });
      }
      expect((await down.inject({ url: '/api/v1/health/live' })).statusCode).toBe(200);
    } finally {
      await down.close();
      await unreachable.end();
    }
  });

  it('answers 503 RETRY within the connection timeout while every connection is busy', async () => {
    const exhausted = createPool({
      connectionString: test.url,
      logger: { warn: () => undefined },
      ...POOL_PROFILES.api,
      connectionTimeoutMillis: 250,
      max: 1,
    });
    const held = await exhausted.connect();
    const busy = await appOver(exhausted, test.uploadDir);
    try {
      const started = performance.now();
      const response = await busy.inject({ url: '/api/v1/drops' });
      expect(response.statusCode).toBe(503);
      expect(response.headers['retry-after']).toBe('1');
      expect(response.json()).toMatchObject({ code: 'RETRY' });
      expect(performance.now() - started).toBeLessThan(1_500);
    } finally {
      held.release();
      await busy.close();
      await exhausted.end();
    }
  });
});

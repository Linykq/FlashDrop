import type { ImageKey } from '@flashdrop/contracts';
import { describe, expect, it } from 'vitest';
import { loadCatalog, REPO_CATALOG_DIR } from './catalog';
import { planSeed, SEED_ROOM, SEED_USERS, seedId, seedProductId } from './plan';

const catalog = await loadCatalog(REPO_CATALOG_DIR);
const keys = new Map(
  catalog.products
    .flatMap((product) => product.images)
    .map((image, i): [string, ImageKey] => [image.src, `${i.toString(16).padStart(64, '0')}.jpg`]),
);

const HOUR = 3_600_000;

describe('seedId', () => {
  it('builds readable, valid version-4 uuids', () => {
    expect(seedId(1, 1)).toBe('5eed0001-0000-4000-8000-000000000001');
    expect(seedId(4, 255)).toBe('5eed0004-0000-4000-8000-0000000000ff');
  });

  it('gives every seeded user a distinct id', () => {
    expect(new Set(SEED_USERS.map((user) => user.id)).size).toBe(SEED_USERS.length);
    expect(SEED_USERS.filter((user) => user.role === 'admin')).toHaveLength(1);
  });
});

describe('planSeed', () => {
  // Late in the evening: "later today" may cross midnight, the windows must still hold.
  it.each(['2026-10-02T09:00:00.000Z', '2026-10-02T23:59:30.000Z', '2026-10-03T00:00:00.000Z'])(
    'places the drops around %s',
    (iso) => {
      const now = new Date(iso);
      const plan = planSeed(catalog, keys, now);
      const byStatus = (status: string) => plan.drops.filter((planned) => planned.drop.status === status);

      const [live] = byStatus('LIVE');
      expect(live?.drop.startsAt.getTime()).toBeLessThanOrEqual(now.getTime());
      expect(live?.drop.endsAt.getTime()).toBeGreaterThan(now.getTime() + 2 * HOUR);
      expect(live?.drop.roomId).toBe(SEED_ROOM.id);

      const starts = byStatus('SCHEDULED').map((planned) => planned.drop.startsAt.getTime() - now.getTime());
      expect(starts).toHaveLength(2);
      // One counts down (under 24 h), one shows its date (24 h or more).
      expect(starts[0]).toBeGreaterThanOrEqual(HOUR);
      expect(starts[0]).toBeLessThan(2 * HOUR);
      expect(starts[1]).toBeGreaterThanOrEqual(24 * HOUR);

      const [ended] = byStatus('ENDED');
      expect(ended?.drop.endsAt.getTime()).toBeLessThan(now.getTime());

      for (const { drop } of plan.drops)
        expect(drop.endsAt.getTime()).toBeGreaterThan(drop.startsAt.getTime());
    },
  );

  it('sells the ended drop out to the buyers within their limit, inside its window', () => {
    const plan = planSeed(catalog, keys, new Date('2026-10-02T12:00:00.000Z'));
    const ended = plan.drops.find((planned) => planned.drop.status === 'ENDED');

    expect(ended?.inventory).toMatchObject({ total: 50, sold: 50, reserved: 0 });
    expect(ended?.sales).toHaveLength(5);
    for (const sale of ended?.sales ?? []) {
      expect(sale.reserve.status).toBe('RESERVED');
      expect(sale.reserve.qty).toBeLessThanOrEqual(ended?.drop.perUserLimit ?? 0);
      expect(sale.reserve.createdAt?.getTime()).toBeGreaterThanOrEqual(ended?.drop.startsAt.getTime() ?? 0);
      expect(sale.pay.paidAt?.getTime()).toBeLessThan(ended?.drop.endsAt.getTime() ?? 0);
      expect(sale.payment.amountCents).toBe(sale.reserve.qty * sale.reserve.unitPriceCents);
      expect(sale.charge.idempotencyKey).toBe(`charge:${sale.reserve.id}`);
    }
    expect(ended?.quotas.map((quota) => quota.claimed)).toEqual([10, 10, 10, 10, 10]);
  });

  it('publishes every catalog product with its photos, credits and catalog price', () => {
    const plan = planSeed(catalog, keys, new Date());

    expect(plan.products).toHaveLength(catalog.products.length);
    for (const [i, product] of plan.products.entries()) {
      const source = catalog.products[i];
      expect(product).toMatchObject({ slug: source?.slug, status: 'PUBLISHED', source: 'manual' });
      expect(product.imageKeys).toEqual(source?.images.map((image) => keys.get(image.src)));
      expect(product.attributes?.photoCredits?.map((credit) => credit.site)).toEqual(
        source?.images.map(() => 'Pexels'),
      );
    }
    for (const { drop } of plan.drops) {
      const product = catalog.products.find((candidate) => seedProductId(candidate.slug) === drop.productId);
      expect(drop.priceCents).toBe(product?.suggestedPriceCents);
    }
  });

  it('keys products by slug, so inserting or reordering catalog entries keeps every id', () => {
    const now = new Date('2026-10-02T12:00:00.000Z');
    const [first, ...rest] = catalog.products;
    if (first === undefined) throw new Error('catalog.json has no products');
    // A new product at the top, the rest in reverse, the old first one last.
    const edited = { ...catalog, products: [{ ...first, slug: 'a-new-arrival' }, ...rest.reverse(), first] };

    const idsBySlug = (plan: ReturnType<typeof planSeed>) =>
      new Map(plan.products.map((product) => [product.slug, product.id]));
    const before = planSeed(catalog, keys, now);
    const after = planSeed(edited, keys, now);

    for (const [slug, id] of idsBySlug(before)) expect(idsBySlug(after).get(slug)).toBe(id);
    expect(new Set(idsBySlug(after).values()).size).toBe(edited.products.length);
    expect(after.drops.map(({ drop }) => drop.productId)).toEqual(
      before.drops.map(({ drop }) => drop.productId),
    );
  });

  it('refuses a photo that was not stored', () => {
    expect(() => planSeed(catalog, new Map(), new Date())).toThrow(/No stored photo/);
  });
});

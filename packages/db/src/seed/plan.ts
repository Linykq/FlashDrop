import type { ImageKey, ProductAttributesInput } from '@flashdrop/contracts';
import type { DropStatus } from '@flashdrop/domain';
import { checkoutFingerprint, requestFingerprint, uuidv5 } from '@flashdrop/domain/identity';
import type {
  dropInventory,
  drops,
  orders,
  payments,
  products,
  pspCharges,
  rooms,
  userDropQuota,
  users,
} from '../schema';
import type { SeedCatalog } from './catalog';

/*
 * What the seed writes, computed without I/O from the catalog, the stored photo keys and the current time,
 * so it can be unit-tested. The storefront should look alive at any hour: one drop LIVE now in the studio,
 * one opening within two hours, one a day out, and one that sold out earlier.
 */

type NewUser = typeof users.$inferInsert;
type NewRoom = typeof rooms.$inferInsert;
type NewProduct = typeof products.$inferInsert;
type NewDrop = typeof drops.$inferInsert;
type NewOrder = typeof orders.$inferInsert;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Stable, readable ids: `5eed<kind>-0000-4000-8000-<n>`, valid version-4 uuids. Re-running the seed hits the
 * same rows, and tests and scripts can name seeded rows directly.
 */
export function seedId(kind: number, n: number): string {
  return `5eed${kind.toString(16).padStart(4, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

const KIND = { user: 1, room: 2, product: 3, drop: 4, order: 5 } as const;

/**
 * A catalog product's id: uuidv5 of its slug. Never its position in catalog.json: the seed matches rows by
 * id, so a product inserted or moved in the file would otherwise take over another product's id, its
 * insert would be skipped, and drops seeded later would sell the wrong product.
 */
export function seedProductId(slug: string): string {
  return uuidv5(slug, seedId(KIND.product, 0));
}

/** The dev-login accounts (§11): one admin, then five buyers, in the order the login page lists them. */
export const SEED_USERS = [
  { id: seedId(KIND.user, 1), email: 'mira@example.test', displayName: 'Mira Chen', role: 'admin' },
  { id: seedId(KIND.user, 2), email: 'ada@example.test', displayName: 'Ada Lindqvist', role: 'buyer' },
  { id: seedId(KIND.user, 3), email: 'ben@example.test', displayName: 'Ben Okafor', role: 'buyer' },
  { id: seedId(KIND.user, 4), email: 'chloe@example.test', displayName: 'Chloé Martin', role: 'buyer' },
  { id: seedId(KIND.user, 5), email: 'dev@example.test', displayName: 'Dev Patel', role: 'buyer' },
  { id: seedId(KIND.user, 6), email: 'emi@example.test', displayName: 'Emi Tanaka', role: 'buyer' },
] as const satisfies readonly NewUser[];

/** The live room, playing the sample stream committed under `apps/web/public/hls/`. */
export const SEED_ROOM = {
  id: seedId(KIND.room, 1),
  slug: 'studio',
  title: 'FlashDrop Studio',
  hlsUrl: '/hls/live.m3u8',
} as const satisfies NewRoom;

const HOLD_SECONDS = 120;
const PAYMENT_SECONDS = 300;

interface DropSpec {
  readonly n: number;
  readonly slug: string;
  readonly status: DropStatus;
  readonly total: number;
  readonly perUserLimit: number;
  readonly inRoom: boolean;
  readonly window: (now: number) => { readonly startsAt: number; readonly endsAt: number };
  /** Every buyer bought this many units, which sells the drop out. */
  readonly boughtByEachBuyer?: number;
}

const floorTo = (time: number, unit: number) => Math.floor(time / unit) * unit;
const ceilTo = (time: number, unit: number) => Math.ceil(time / unit) * unit;

const DROP_SPECS: readonly DropSpec[] = [
  {
    n: 1,
    slug: 'sage-wireless-headphones',
    status: 'LIVE',
    total: 250,
    perUserLimit: 2,
    inRoom: true,
    window: (now) => ({ startsAt: floorTo(now, MINUTE) - 20 * MINUTE, endsAt: ceilTo(now, HOUR) + 3 * HOUR }),
  },
  {
    n: 2,
    slug: 'faceted-eau-de-parfum',
    status: 'SCHEDULED',
    total: 300,
    perUserLimit: 2,
    inRoom: false,
    // One to two hours out: the UI counts down (under 24 h).
    window: (now) => ({ startsAt: ceilTo(now, HOUR) + HOUR, endsAt: ceilTo(now, HOUR) + 2 * HOUR }),
  },
  {
    n: 3,
    slug: 'linen-band-collar-shirt',
    status: 'SCHEDULED',
    total: 150,
    perUserLimit: 3,
    inRoom: false,
    // At least 24 hours out: the UI shows the date instead of a countdown.
    window: (now) => ({ startsAt: ceilTo(now, HOUR) + 24 * HOUR, endsAt: ceilTo(now, HOUR) + 25 * HOUR }),
  },
  {
    n: 4,
    slug: 'amber-jar-candle',
    status: 'ENDED',
    total: 50,
    perUserLimit: 10,
    inRoom: false,
    window: (now) => ({
      startsAt: floorTo(now, MINUTE) - 105 * MINUTE,
      endsAt: floorTo(now, MINUTE) - 45 * MINUTE,
    }),
    boughtByEachBuyer: 10,
  },
];

/**
 * A completed purchase, written the way the real flow writes it: inserted RESERVED, moved to
 * PENDING_PAYMENT, then PAID, so it passes the `orders_guard` trigger. Its counters, quota, payment and PSP
 * charge keep INV-1 to INV-4 true for seeded history. It has no outbox events: they would make the payment
 * consumer charge it again.
 */
export interface PlannedSale {
  readonly reserve: NewOrder;
  readonly place: Partial<NewOrder>;
  readonly pay: Partial<NewOrder>;
  readonly payment: typeof payments.$inferInsert;
  readonly charge: typeof pspCharges.$inferInsert;
}

export interface PlannedDrop {
  readonly drop: NewDrop & { readonly status: DropStatus };
  readonly inventory: typeof dropInventory.$inferInsert;
  readonly quotas: readonly (typeof userDropQuota.$inferInsert)[];
  readonly sales: readonly PlannedSale[];
}

export interface SeedPlan {
  readonly users: readonly NewUser[];
  readonly room: NewRoom;
  readonly products: readonly NewProduct[];
  readonly drops: readonly PlannedDrop[];
}

export function planSeed(
  catalog: SeedCatalog,
  imageKeys: ReadonlyMap<string, ImageKey>,
  now: Date,
): SeedPlan {
  const keyOf = (src: string): ImageKey => {
    const key = imageKeys.get(src);
    if (key === undefined) throw new Error(`No stored photo for ${src}`);
    return key;
  };

  const productRows = catalog.products.map((product): NewProduct => {
    const attributes: ProductAttributesInput = {
      category: product.category,
      condition: product.condition,
      ...product.attributes,
      highlights: product.highlights,
      tags: product.tags,
      photoCredits: product.images.map(({ src, credit }) => ({
        imageKey: keyOf(src),
        photographer: credit.photographer,
        profileUrl: credit.profile,
        sourceUrl: credit.source,
        site: credit.licence,
      })),
    };
    return {
      id: seedProductId(product.slug),
      slug: product.slug,
      title: product.title,
      description: product.description,
      attributes,
      imageKeys: product.images.map(({ src }) => keyOf(src)),
      status: 'PUBLISHED',
      source: 'manual',
      updatedAt: now,
    };
  });

  const productBySlug = new Map(catalog.products.map((product) => [product.slug, product]));
  const buyers = SEED_USERS.filter((user) => user.role === 'buyer');

  const dropPlans = DROP_SPECS.map((spec): PlannedDrop => {
    const product = productBySlug.get(spec.slug);
    if (product === undefined) throw new Error(`The seed drops need ${spec.slug} in catalog.json`);
    const window = spec.window(now.getTime());
    const drop = {
      id: seedId(KIND.drop, spec.n),
      productId: seedProductId(product.slug),
      roomId: spec.inRoom ? SEED_ROOM.id : null,
      startsAt: new Date(window.startsAt),
      endsAt: new Date(window.endsAt),
      priceCents: product.suggestedPriceCents,
      currency: catalog.currency,
      perUserLimit: spec.perUserLimit,
      holdSeconds: HOLD_SECONDS,
      paymentSeconds: PAYMENT_SECONDS,
      status: spec.status,
    } satisfies NewDrop;

    const qty = spec.boughtByEachBuyer;
    const sales =
      qty === undefined ? [] : buyers.map((buyer, i) => planSale(drop, buyer, qty, spec.n * 100 + i + 1, i));
    const sold = sales.reduce((sum, sale) => sum + sale.reserve.qty, 0);
    return {
      drop,
      inventory: { dropId: drop.id, total: spec.total, reserved: 0, sold },
      quotas: sales.map((sale) => ({
        userId: sale.reserve.userId,
        dropId: drop.id,
        claimed: sale.reserve.qty,
        limitQty: spec.perUserLimit,
      })),
      sales,
    };
  });

  return { users: SEED_USERS, room: SEED_ROOM, products: productRows, drops: dropPlans };
}

/** The drop fields a sale copies. */
interface SaleDrop {
  readonly id: string;
  readonly productId: string;
  readonly startsAt: Date;
  readonly priceCents: number;
  readonly currency: string;
}

function planSale(
  drop: SaleDrop,
  buyer: (typeof SEED_USERS)[number],
  qty: number,
  n: number,
  position: number,
): PlannedSale {
  const id = seedId(KIND.order, n);
  // The drop sold out in its first minutes: one buyer every 47 s, checkout 35 s later, paid 2 s after that.
  const createdAt = new Date(drop.startsAt.getTime() + (position + 1) * 47_000);
  const placedAt = new Date(createdAt.getTime() + 35_000);
  const paidAt = new Date(placedAt.getTime() + 2_000);
  const shipping = {
    name: buyer.displayName,
    line1: '1 Market Street',
    city: 'San Francisco',
    postalCode: '94105',
    country: 'US',
  };
  const paymentMethod = 'pm_ok';
  const chargeId = `ch_seed_${n}`;
  const amountCents = qty * drop.priceCents;
  return {
    reserve: {
      id,
      userId: buyer.id,
      dropId: drop.id,
      productId: drop.productId,
      qty,
      unitPriceCents: drop.priceCents,
      currency: drop.currency,
      status: 'RESERVED',
      idempotencyKey: `seed-reserve-${n}`,
      // Same fingerprints as the live flow (§4.5).
      requestHash: requestFingerprint({ dropId: drop.id, qty }),
      expiresAt: new Date(createdAt.getTime() + HOLD_SECONDS * 1000),
      createdAt,
      updatedAt: createdAt,
    },
    place: {
      status: 'PENDING_PAYMENT',
      checkoutKey: `seed-checkout-${n}`,
      checkoutHash: checkoutFingerprint({ orderId: id, shipping, paymentMethod }),
      shipping,
      paymentMethod,
      expiresAt: new Date(placedAt.getTime() + PAYMENT_SECONDS * 1000),
      version: 2,
      updatedAt: placedAt,
    },
    // Settled: the rebuild that arms the drop writes PAID orders to Redis as COMMITTED (§4.7).
    pay: { status: 'PAID', paidAt, version: 3, updatedAt: paidAt, redisSettledAt: paidAt },
    payment: { orderId: id, pspChargeId: chargeId, amountCents, status: 'SUCCEEDED', updatedAt: paidAt },
    charge: {
      id: chargeId,
      idempotencyKey: `charge:${id}`,
      reference: id,
      amountCents,
      method: paymentMethod,
      status: 'succeeded',
      createdAt: paidAt,
    },
  };
}

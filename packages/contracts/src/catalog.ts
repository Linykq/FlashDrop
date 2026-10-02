import { PUBLIC_DROP_STATUSES } from '@flashdrop/domain';
import { z } from 'zod';
import { Cents, Currency, HttpsUrl, ImageKey, IsoDateTime, Slug, Uuid } from './common';

/*
 * Catalog DTOs for SSR (design §5.1, §8.1): `GET /drops`, `GET /products/:slug` and
 * `GET /drops/:dropId/stock`. Lists and product shells are cached by `web` for minutes or hours, so they
 * carry no `serverNow`; only the uncached stock snapshot does, which is what countdowns correct their
 * clock offset with.
 */

/** The fixed taxonomy of `assets/catalog/catalog.json`, which `ListingWire` constrains the model to (§10). */
export const PRODUCT_CATEGORIES = [
  'apparel',
  'audio',
  'bags',
  'beauty',
  'eyewear',
  'footwear',
  'fragrance',
  'home',
  'tech',
  'watches',
] as const;
export const ProductCategory = z.enum(PRODUCT_CATEGORIES);
export type ProductCategory = z.infer<typeof ProductCategory>;

export const PRODUCT_CONDITIONS = ['new', 'used', 'refurbished'] as const;
export const ProductCondition = z.enum(PRODUCT_CONDITIONS);
export type ProductCondition = z.infer<typeof ProductCondition>;

/** Credit for a stock photo, shown as "Photo: {photographer} on {site}" (design system §11.1). */
export const PhotoCredit = z.object({
  imageKey: ImageKey,
  photographer: z.string().min(1),
  profileUrl: HttpsUrl,
  sourceUrl: HttpsUrl,
  site: z.enum(['Pexels', 'Unsplash']),
});
export type PhotoCredit = z.infer<typeof PhotoCredit>;

const optionalText = z.string().min(1).nullable().default(null);

/**
 * The listing details stored in `products.attributes` (jsonb): everything a `ListingDraft` has beyond
 * title and description (§10), plus photo credits for seeded stock photos. Every field has a default, so
 * the column's `'{}'` default parses to a complete object.
 */
export const ProductAttributes = z.object({
  category: ProductCategory.nullable().default(null),
  condition: ProductCondition.nullable().default(null),
  brand: optionalText,
  color: optionalText,
  material: optionalText,
  size: optionalText,
  highlights: z.array(z.string().min(1)).default([]),
  tags: z.array(z.string().min(1)).default([]),
  /** Empty for photos an admin uploaded through the listing generator, which carry no credit. */
  photoCredits: z.array(PhotoCredit).default([]),
});
export type ProductAttributes = z.output<typeof ProductAttributes>;
export type ProductAttributesInput = z.input<typeof ProductAttributes>;

export const ProductSummary = z.object({
  id: Uuid,
  slug: Slug,
  title: z.string().min(1),
  /** In display order; the first is the tile, hero and thumbnail photo. */
  imageKeys: z.array(ImageKey),
});
export type ProductSummary = z.infer<typeof ProductSummary>;

export const Product = ProductSummary.extend({
  description: z.string(),
  attributes: ProductAttributes,
});
export type Product = z.infer<typeof Product>;

/**
 * The live status of a drop's stock. RECONCILING is transient (a Redis rebuild, §4.7; never produced
 * while stock is served from Postgres, before M2): clients keep showing their last state.
 */
export const StockStatus = z.enum([...PUBLIC_DROP_STATUSES, 'RECONCILING']);
export type StockStatus = z.infer<typeof StockStatus>;

const units = z.int().nonnegative();

/**
 * Versioned stock levels: `total = avail + held + sold`. `(gen, seq)` orders snapshots and WebSocket
 * frames, compared lexicographically; clients apply only strictly newer ones (§4.1, §8.2).
 */
export const StockLevel = z.object({
  avail: units,
  held: units,
  sold: units,
  status: StockStatus,
  /** `drop_inventory.redis_gen`; -1 only in the fail-closed hash of a drop that was never rebuilt. */
  gen: z.int().min(-1),
  /** Restarts at 0 on every rebuild. Always 0 while stock is served from Postgres. */
  seq: units,
});
export type StockLevel = z.infer<typeof StockLevel>;

/** `GET /api/v1/drops/:dropId/stock`, served with `Cache-Control: no-store`. */
export const StockSnapshot = StockLevel.extend({
  /** The server's clock when the snapshot was read; countdowns correct their offset with it. */
  serverNow: IsoDateTime,
});
export type StockSnapshot = z.infer<typeof StockSnapshot>;

export const RoomSummary = z.object({
  slug: Slug,
  title: z.string().min(1),
});
export type RoomSummary = z.infer<typeof RoomSummary>;

/** A drop without its product or stock. Armed drops are immutable (§4.7), apart from `status`. */
export const DropInfo = z.object({
  id: Uuid,
  status: z.enum(PUBLIC_DROP_STATUSES),
  startsAt: IsoDateTime,
  endsAt: IsoDateTime,
  priceCents: Cents,
  currency: Currency,
  perUserLimit: z.int().min(1).max(10),
  /** How long a reservation is held at checkout. */
  holdSeconds: z.int().min(10).max(900),
  /** The live room selling this drop, for "Watch live"; null when it sells without a stream. */
  room: RoomSummary.nullable(),
});
export type DropInfo = z.infer<typeof DropInfo>;

/** One entry of `GET /api/v1/drops`: a tile, the home hero or a live room's drop card. */
export const DropSummary = DropInfo.extend({
  product: ProductSummary,
  stock: StockLevel,
});
export type DropSummary = z.infer<typeof DropSummary>;

/** `?status=live,scheduled` (any case, comma-separated) and `?limit=`. */
export const DropListQuery = z.object({
  status: z
    .string()
    .transform((value) => value.split(',').map((status) => status.trim().toUpperCase()))
    .pipe(z.array(z.enum(PUBLIC_DROP_STATUSES)).min(1))
    .transform((statuses) => [...new Set(statuses)])
    .default(['LIVE', 'SCHEDULED']),
  limit: z.coerce.number().pipe(z.int().min(1).max(50)).default(20),
});
export type DropListQuery = z.output<typeof DropListQuery>;

/**
 * `GET /api/v1/drops`: LIVE drops first, then SCHEDULED and PAUSED ones, each by start time (earliest
 * first); then ENDED drops, most recently ended first. So `?status=ended&limit=12` is the twelve latest.
 */
export const DropListResponse = z.object({ drops: z.array(DropSummary) });
export type DropListResponse = z.infer<typeof DropListResponse>;

/**
 * `GET /api/v1/products/:slug` (PUBLISHED products only). `drop` is the product's current drop: the
 * SCHEDULED, LIVE or PAUSED one (at most one exists), otherwise the most recently ENDED one, otherwise null
 * (design system §10.2). Stock is not included: the page streams it from the uncached stock snapshot.
 */
export const ProductDetail = z.object({
  product: Product,
  drop: DropInfo.nullable(),
});
export type ProductDetail = z.infer<typeof ProductDetail>;

export const ProductSlugParams = z.object({ slug: Slug });
export type ProductSlugParams = z.infer<typeof ProductSlugParams>;

export const DropIdParams = z.object({ dropId: Uuid });
export type DropIdParams = z.infer<typeof DropIdParams>;

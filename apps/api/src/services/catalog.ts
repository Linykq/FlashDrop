import type { Logger } from '@flashdrop/config';
import {
  type DropInfo,
  type DropListQuery,
  type DropSummary,
  ProductAttributes,
  type ProductDetail,
} from '@flashdrop/contracts';
import { and, asc, type Db, desc, drops, eq, inArray, ne, products, rooms, sql } from '@flashdrop/db';
import { alert, type DropStatus, PUBLIC_DROP_STATUSES } from '@flashdrop/domain';
import { publicDropStatus } from './drop-status';
import type { StockReader } from './stock';

/** A catalog entry before its live stock is attached. */
export type DropListing = Omit<DropSummary, 'stock'>;

/**
 * The public catalog: PUBLISHED products and their non-DRAFT drops (design §5.1, §8.1). Test products
 * (`POST /test/drops`) have pages but are never listed, so specs and load runs leave the storefront alone.
 */
export interface CatalogStore {
  /** In the order `DropListResponse` documents. */
  listDrops(query: DropListQuery): Promise<DropListing[]>;
  /** A PUBLISHED product and its current drop; undefined for unknown and DRAFT products. */
  productBySlug(slug: string): Promise<ProductDetail | undefined>;
}

// The columns of DropInfo, shared by both reads.
const dropColumns = {
  id: drops.id,
  status: drops.status,
  startsAt: drops.startsAt,
  endsAt: drops.endsAt,
  priceCents: drops.priceCents,
  currency: drops.currency,
  perUserLimit: drops.perUserLimit,
  holdSeconds: drops.holdSeconds,
  roomSlug: rooms.slug,
  roomTitle: rooms.title,
};

interface DropRow {
  readonly id: string;
  readonly status: DropStatus;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly priceCents: number;
  readonly currency: string;
  readonly perUserLimit: number;
  readonly holdSeconds: number;
  // Left-joined: null for a drop that sells without a live room.
  readonly roomSlug: string | null;
  readonly roomTitle: string | null;
}

function toDropInfo(row: DropRow): DropInfo {
  return {
    id: row.id,
    status: publicDropStatus(row.status),
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    priceCents: row.priceCents,
    currency: row.currency,
    perUserLimit: row.perUserLimit,
    holdSeconds: row.holdSeconds,
    room:
      row.roomSlug === null || row.roomTitle === null ? null : { slug: row.roomSlug, title: row.roomTitle },
  };
}

export function createPostgresCatalog(db: Db): CatalogStore {
  return {
    async listDrops({ status, limit }) {
      const rows = await db
        .select({
          ...dropColumns,
          productId: products.id,
          productSlug: products.slug,
          productTitle: products.title,
          imageKeys: products.imageKeys,
        })
        .from(drops)
        .innerJoin(products, eq(products.id, drops.productId))
        .leftJoin(rooms, eq(rooms.id, drops.roomId))
        .where(
          and(inArray(drops.status, status), eq(products.status, 'PUBLISHED'), ne(products.source, 'test')),
        )
        // ENDED drops newest first, so a limited "recently ended" list gets the latest ones, not the oldest.
        .orderBy(
          sql`CASE ${drops.status} WHEN 'LIVE' THEN 0 WHEN 'ENDED' THEN 2 ELSE 1 END`,
          desc(sql`CASE WHEN ${drops.status} = 'ENDED' THEN ${drops.endsAt} END`),
          asc(drops.startsAt),
          asc(drops.id),
        )
        .limit(limit);
      return rows.map((row) => ({
        ...toDropInfo(row),
        product: {
          id: row.productId,
          slug: row.productSlug,
          title: row.productTitle,
          imageKeys: row.imageKeys,
        },
      }));
    },

    async productBySlug(slug) {
      const [product] = await db
        .select({
          id: products.id,
          slug: products.slug,
          title: products.title,
          imageKeys: products.imageKeys,
          description: products.description,
          attributes: products.attributes,
        })
        .from(products)
        .where(and(eq(products.slug, slug), eq(products.status, 'PUBLISHED')))
        .limit(1);
      if (product === undefined) return undefined;

      // The open drop if there is one (at most one: one_open_drop_per_product), else the latest ENDED one.
      const [drop] = await db
        .select(dropColumns)
        .from(drops)
        .leftJoin(rooms, eq(rooms.id, drops.roomId))
        .where(and(eq(drops.productId, product.id), inArray(drops.status, PUBLIC_DROP_STATUSES)))
        .orderBy(asc(sql`${drops.status} = 'ENDED'`), desc(drops.endsAt))
        .limit(1);

      return {
        // jsonb is a boundary: the stored attributes are parsed, which also fills in their defaults.
        product: { ...product, attributes: ProductAttributes.parse(product.attributes) },
        drop: drop === undefined ? null : toDropInfo(drop),
      };
    },
  };
}

/**
 * Catalog entries with their live stock. A public drop always has an inventory row (they are created
 * together), so a missing level is a data fault: that drop is left out and logged rather than failing
 * the whole storefront.
 */
export async function listDropSummaries(
  catalog: CatalogStore,
  stock: StockReader,
  query: DropListQuery,
  logger: Pick<Logger, 'error'>,
): Promise<DropSummary[]> {
  const listings = await catalog.listDrops(query);
  const levels = await stock.read(listings.map((listing) => listing.id));
  return listings.flatMap((listing) => {
    const level = levels.get(listing.id);
    if (level === undefined) {
      alert(logger, 'stock_missing', { dropId: listing.id }, 'public drop has no stock level');
      return [];
    }
    return [{ ...listing, stock: level }];
  });
}

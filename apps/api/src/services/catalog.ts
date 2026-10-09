import type { Logger } from '@flashdrop/config';
import {
  type DropInfo,
  type DropListQuery,
  type DropSummary,
  ProductAttributes,
  type ProductDetail,
  type Room,
} from '@flashdrop/contracts';
import {
  and,
  asc,
  type Db,
  desc,
  drops,
  eq,
  inArray,
  ne,
  products,
  rooms,
  type SQL,
  sql,
} from '@flashdrop/db';
import { alert, type DropStatus, PUBLIC_DROP_STATUSES } from '@flashdrop/domain';
import { publicDropStatus } from './drop-status';
import { createPostgresRoomReader, pinnedDropOf } from './rooms';
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
  /**
   * A room and the drop it is pinned to (null if none); undefined for an unknown room. The pinned drop is the
   * one the gateway's `room:` topic names (`RoomReader`), so a page and its socket never disagree about it:
   * the page reloads when the topic names another drop, and a disagreement would reload it forever.
   */
  roomBySlug(slug: string): Promise<{ room: Room; drop: DropListing | null } | undefined>;
}

// The columns of DropInfo, shared by every read.
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

interface ListingRow extends DropRow {
  readonly productId: string;
  readonly productSlug: string;
  readonly productTitle: string;
  readonly imageKeys: string[];
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

function toListing(row: ListingRow): DropListing {
  return {
    ...toDropInfo(row),
    product: { id: row.productId, slug: row.productSlug, title: row.productTitle, imageKeys: row.imageKeys },
  };
}

export function createPostgresCatalog(db: Db): CatalogStore {
  const roomReader = createPostgresRoomReader(db);

  function selectListings(where: SQL | undefined) {
    return db
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
      .where(where);
  }

  return {
    async listDrops({ status, limit }) {
      const rows = await selectListings(
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
      return rows.map(toListing);
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

    async roomBySlug(slug) {
      const [room] = await db
        .select({ id: rooms.id, slug: rooms.slug, title: rooms.title, hlsUrl: rooms.hlsUrl })
        .from(rooms)
        .where(eq(rooms.slug, slug))
        .limit(1);
      if (room === undefined) return undefined;
      const pinned = await pinnedDropOf(roomReader, room.id);
      if (pinned === null) return { room, drop: null };
      // Test products included, as on their product pages: a spec's own room sells its own drop.
      const [row] = await selectListings(eq(drops.id, pinned.dropId)).limit(1);
      return { room, drop: row === undefined ? null : toListing(row) };
    },
  };
}

/**
 * Catalog entries with their live stock. A public drop always has an inventory row (they are created
 * together), so a missing level is a data fault: that drop is left out and logged rather than failing
 * the whole storefront.
 */
export async function withStock(
  listings: readonly DropListing[],
  stock: StockReader,
  logger: Pick<Logger, 'error'>,
): Promise<DropSummary[]> {
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

export async function listDropSummaries(
  catalog: CatalogStore,
  stock: StockReader,
  query: DropListQuery,
  logger: Pick<Logger, 'error'>,
): Promise<DropSummary[]> {
  return withStock(await catalog.listDrops(query), stock, logger);
}

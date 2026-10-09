import type {
  AdminDropListing,
  AdminDropListQuery,
  AdminProductOption,
  AdminRoom,
} from '@flashdrop/contracts';
import {
  and,
  asc,
  type Db,
  desc,
  dropInventory,
  drops,
  eq,
  inArray,
  ne,
  products,
  rooms,
  type SQL,
  sql,
  TEST_ROOM_SLUG_PREFIX,
} from '@flashdrop/db';
import { NotFoundError, OPEN_DROP_STATUSES } from '@flashdrop/domain';
import { toAdminDrop } from './admin-drops';

/*
 * What the admin drop pages read (design §5.1, design system §10.8): drops in every status with their stock of
 * record, and the products and rooms a new drop can use. Plain reads through the query builder (CLAUDE.md):
 * nothing here carries a guarantee. Test products and test rooms are left out, as from the storefront
 * (`CatalogStore`).
 */

export interface AdminCatalogService {
  /** In the order `AdminDropListResponse` documents. */
  listDrops(query: AdminDropListQuery): Promise<AdminDropListing[]>;
  /** Any drop by id, test drops included (the health page links them); `NotFoundError` otherwise. */
  getDrop(dropId: string): Promise<AdminDropListing>;
  listProducts(): Promise<AdminProductOption[]>;
  listRooms(): Promise<AdminRoom[]>;
}

/** The columns of one listing: the drop, its inventory, its product and its (left-joined) room. */
const listingColumns = {
  drop: drops,
  inventory: {
    total: dropInventory.total,
    reserved: dropInventory.reserved,
    sold: dropInventory.sold,
    redisGen: dropInventory.redisGen,
  },
  product: {
    id: products.id,
    slug: products.slug,
    title: products.title,
    imageKeys: products.imageKeys,
  },
  roomId: rooms.id,
  roomSlug: rooms.slug,
  roomTitle: rooms.title,
};

function listingsQuery(db: Db, where: SQL | undefined) {
  return db
    .select(listingColumns)
    .from(drops)
    .innerJoin(dropInventory, eq(dropInventory.dropId, drops.id))
    .innerJoin(products, eq(products.id, drops.productId))
    .leftJoin(rooms, eq(rooms.id, drops.roomId))
    .where(where);
}

type ListingRow = Awaited<ReturnType<typeof listingsQuery>>[number];

function toListing(row: ListingRow): AdminDropListing {
  const { roomId, roomSlug, roomTitle } = row;
  return {
    ...toAdminDrop(row),
    product: row.product,
    room:
      roomId === null || roomSlug === null || roomTitle === null
        ? null
        : { id: roomId, slug: roomSlug, title: roomTitle },
  };
}

export function createAdminCatalog(db: Db): AdminCatalogService {
  return {
    async listDrops({ status, limit }) {
      const rows = await listingsQuery(db, and(inArray(drops.status, status), ne(products.source, 'test')))
        .orderBy(
          sql`CASE ${drops.status} WHEN 'LIVE' THEN 0 WHEN 'PAUSED' THEN 0 WHEN 'ENDED' THEN 2 ELSE 1 END`,
          // Ended drops newest first, so a limited list keeps the latest history rather than the oldest.
          desc(sql`CASE WHEN ${drops.status} = 'ENDED' THEN ${drops.endsAt} END`),
          asc(drops.startsAt),
          asc(drops.id),
        )
        .limit(limit);
      return rows.map(toListing);
    },

    async getDrop(dropId) {
      const [row] = await listingsQuery(db, eq(drops.id, dropId));
      if (row === undefined) throw new NotFoundError('Drop');
      return toListing(row);
    },

    async listProducts() {
      // At most one open drop per product (`one_open_drop_per_product`), so the join never repeats a product.
      const rows = await db
        .select({
          id: products.id,
          slug: products.slug,
          title: products.title,
          imageKeys: products.imageKeys,
          openDropId: drops.id,
        })
        .from(products)
        .leftJoin(
          drops,
          and(eq(drops.productId, products.id), inArray(drops.status, [...OPEN_DROP_STATUSES])),
        )
        .where(and(eq(products.status, 'PUBLISHED'), ne(products.source, 'test')))
        .orderBy(desc(products.updatedAt), asc(products.title));
      return rows;
    },

    async listRooms() {
      return db
        .select({ id: rooms.id, slug: rooms.slug, title: rooms.title })
        .from(rooms)
        .where(sql`${rooms.slug} NOT LIKE ${`${TEST_ROOM_SLUG_PREFIX}%`}`)
        .orderBy(asc(rooms.title), asc(rooms.id));
    },
  };
}

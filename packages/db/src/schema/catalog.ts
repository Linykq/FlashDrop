import {
  CURRENCY_PATTERN,
  IMAGE_KEY_PATTERN,
  type ProductAttributesInput,
  SLUG_MAX_LENGTH,
  SLUG_PATTERN,
} from '@flashdrop/contracts';
import { OPEN_DROP_STATUSES, PRODUCT_SOURCES, PRODUCT_STATUSES, USER_ROLES } from '@flashdrop/domain';
import { type SQL, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  char,
  check,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { inList, matchesWhole, timestamptz } from './columns';
import { dropStatus } from './enums';

/*
 * Core catalog tables (design §3). Constraint names are explicit wherever a test or an error mapping refers
 * to them; the others follow Postgres's own `<table>_<column>_<kind>` convention.
 *
 * Columns that the public catalog serves carry the format CHECKs of their contract (slugs, currency, photo
 * keys): the API validates every response, so one malformed row would otherwise fail the whole list it is
 * part of, for every visitor, instead of failing the one write that stored it.
 */

/** A slug of the `Slug` contract: the pattern and its length limit. */
const isSlug = (column: AnyPgColumn): SQL =>
  sql`${matchesWhole(column, SLUG_PATTERN)} AND char_length(${column}) <= ${sql.raw(String(SLUG_MAX_LENGTH))}`;

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    email: text('email').notNull().unique('users_email_key'),
    displayName: text('display_name').notNull(),
    role: text('role', { enum: USER_ROLES }).notNull().default('buyer'),
  },
  (t) => [check('users_role_check', inList(t.role, USER_ROLES))],
);

export const rooms = pgTable(
  'rooms',
  {
    id: uuid('id').primaryKey(),
    slug: text('slug').notNull().unique('rooms_slug_key'),
    title: text('title').notNull(),
    hlsUrl: text('hls_url').notNull(),
  },
  (t) => [check('rooms_slug_check', isSlug(t.slug))],
);

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey(),
    slug: text('slug').notNull().unique('products_slug_key'),
    title: text('title').notNull(),
    description: text('description').notNull(),
    // Validated with ProductAttributes (contracts) wherever it is read: jsonb is a boundary.
    attributes: jsonb('attributes').$type<ProductAttributesInput>().notNull().default({}),
    imageKeys: text('image_keys').array().notNull(),
    status: text('status', { enum: PRODUCT_STATUSES }).notNull(),
    source: text('source', { enum: PRODUCT_SOURCES }).notNull().default('manual'),
    // No foreign key, as in the design: listing_jobs.product_id already points the other way.
    listingJobId: uuid('listing_job_id'),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('products_slug_check', isSlug(t.slug)),
    check('products_title_check', sql`char_length(${t.title}) BETWEEN 10 AND 80`),
    // Every element a photo key. array_to_string turns a NULL element into an empty one, which fails too.
    check(
      'products_image_keys_check',
      sql`cardinality(${t.imageKeys}) = 0 OR ${matchesWhole(
        sql`array_to_string(${t.imageKeys}, ',', '')`,
        `${IMAGE_KEY_PATTERN}(?:,${IMAGE_KEY_PATTERN})*`,
      )}`,
    ),
    check('products_status_check', inList(t.status, PRODUCT_STATUSES)),
    check('products_source_check', inList(t.source, PRODUCT_SOURCES)),
  ],
);

export const drops = pgTable(
  'drops',
  {
    id: uuid('id').primaryKey(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    roomId: uuid('room_id').references(() => rooms.id),
    startsAt: timestamptz('starts_at').notNull(),
    endsAt: timestamptz('ends_at').notNull(),
    // Typed by an admin, never by the LLM.
    priceCents: integer('price_cents').notNull(),
    currency: char('currency', { length: 3 }).notNull().default('USD'),
    perUserLimit: integer('per_user_limit').notNull(),
    holdSeconds: integer('hold_seconds').notNull().default(120),
    paymentSeconds: integer('payment_seconds').notNull().default(300),
    status: dropStatus('status').notNull().default('DRAFT'),
  },
  (t) => [
    check('drops_window', sql`${t.endsAt} > ${t.startsAt}`),
    check('drops_price_cents_check', sql`${t.priceCents} > 0`),
    check('drops_currency_check', matchesWhole(t.currency, CURRENCY_PATTERN)),
    check('drops_per_user_limit_check', sql`${t.perUserLimit} BETWEEN 1 AND 10`),
    check('drops_hold_seconds_check', sql`${t.holdSeconds} BETWEEN 10 AND 900`),
    check('drops_payment_seconds_check', sql`${t.paymentSeconds} BETWEEN 10 AND 1800`),
    // So "the product's current drop" is always well defined.
    uniqueIndex('one_open_drop_per_product').on(t.productId).where(inList(t.status, OPEN_DROP_STATUSES)),
  ],
);

/** Stock of record. The hard oversell backstop. */
export const dropInventory = pgTable(
  'drop_inventory',
  {
    dropId: uuid('drop_id')
      .primaryKey()
      .references(() => drops.id),
    total: integer('total').notNull(),
    /** Units in RESERVED and PENDING_PAYMENT orders. */
    reserved: integer('reserved').notNull().default(0),
    /** Units in PAID orders. */
    sold: integer('sold').notNull().default(0),
    /** Fences Redis rebuilds (§4.7): a reserve carrying an older generation is refused. */
    redisGen: integer('redis_gen').notNull().default(0),
    /**
     * Set by every update, by the `drop_inventory_touch` trigger (custom migration 0003), so no statement can
     * forget it; the reconciler's stable-sample check reads it (§4.7).
     */
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('drop_inventory_total_check', sql`${t.total} > 0`),
    check('drop_inventory_reserved_check', sql`${t.reserved} >= 0`),
    check('drop_inventory_sold_check', sql`${t.sold} >= 0`),
    check('no_oversell', sql`${t.reserved} + ${t.sold} <= ${t.total}`),
  ],
);

import { CLOSE_REASONS, LIVE_ORDER_STATUSES, TERMINAL_ORDER_STATUSES } from '@flashdrop/domain';
import { sql } from 'drizzle-orm';
import {
  bigint,
  char,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { drops, products, users } from './catalog';
import { bytea, inList, timestamptz } from './columns';
import { orderStatus, paymentStatus } from './enums';

/*
 * Orders and their side effects (design §3, §4.4). Lock order is orders → user_drop_quota → drop_inventory,
 * always; the hot inventory row is taken last and held for one statement plus the commit.
 */

/** Per-user limit backstop: a row-locked counter, race-free under READ COMMITTED. */
export const userDropQuota = pgTable(
  'user_drop_quota',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    dropId: uuid('drop_id')
      .notNull()
      .references(() => drops.id),
    /** Units in the user's RESERVED, PENDING_PAYMENT and PAID orders. */
    claimed: integer('claimed').notNull(),
    /** The drop's per-user limit, copied at the user's first claim. Armed drops never change it. */
    limitQty: integer('limit_qty').notNull(),
  },
  (t) => [
    primaryKey({ name: 'user_drop_quota_pkey', columns: [t.userId, t.dropId] }),
    check('within_limit', sql`${t.claimed} BETWEEN 0 AND ${t.limitQty}`),
  ],
);

/**
 * A reservation IS an order in RESERVED; one row per (user, drop, Idempotency-Key). The `orders_guard`
 * trigger (custom migrations 0001 and 0003), which Drizzle does not model, allows only the §4.4 status edges
 * and freezes an order's identity and amounts.
 */
export const orders = pgTable(
  'orders',
  {
    /** rid = uuidv5(NS, userId:dropId:idempotencyKey), shared with the Redis `rsv` field (§4.5). */
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    dropId: uuid('drop_id')
      .notNull()
      .references(() => drops.id),
    /** The Kafka partition key of the order's events. */
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    qty: integer('qty').notNull(),
    unitPriceCents: integer('unit_price_cents').notNull(),
    totalCents: integer('total_cents').generatedAlwaysAs(sql`qty * unit_price_cents`),
    currency: char('currency', { length: 3 }).notNull(),
    status: orderStatus('status').notNull(),
    closeReason: text('close_reason', { enum: CLOSE_REASONS }),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: bytea('request_hash').notNull(),
    checkoutKey: text('checkout_key'),
    checkoutHash: bytea('checkout_hash'),
    shipping: jsonb('shipping').$type<Record<string, unknown>>(),
    paymentMethod: text('payment_method'),
    /** The hold deadline while RESERVED, then the payment deadline. */
    expiresAt: timestamptz('expires_at').notNull(),
    /** One +60 s extension (WCAG 2.2.1). */
    extensions: integer('extensions').notNull().default(0),
    version: integer('version').notNull().default(1),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    paidAt: timestamptz('paid_at'),
    closedAt: timestamptz('closed_at'),
    /** Redis has applied the terminal outcome; the only column a terminal row may still change. */
    redisSettledAt: timestamptz('redis_settled_at'),
  },
  (t) => [
    unique('orders_user_drop_idempotency_key').on(t.userId, t.dropId, t.idempotencyKey),
    check('orders_qty_check', sql`${t.qty} BETWEEN 1 AND 10`),
    check('orders_unit_price_cents_check', sql`${t.unitPriceCents} > 0`),
    check('orders_close_reason_check', inList(t.closeReason, CLOSE_REASONS)),
    check('orders_extensions_check', sql`${t.extensions} BETWEEN 0 AND 1`),
    check('orders_paid_at_matches_status', sql`(${t.status} = 'PAID') = (${t.paidAt} IS NOT NULL)`),
    check(
      'orders_closed_at_matches_status',
      sql`(${inList(t.status, ['RESERVED', 'PENDING_PAYMENT', 'PAID'])}) = (${t.closedAt} IS NULL)`,
    ),
    // The sweeper's expire-orders scan (§4.6).
    index('orders_due').on(t.expiresAt).where(inList(t.status, LIVE_ORDER_STATUSES)),
    // The settle-safety-net scan (§4.6).
    index('orders_unsettled')
      .on(t.updatedAt)
      .where(sql`${t.redisSettledAt} IS NULL AND ${inList(t.status, TERMINAL_ORDER_STATUSES)}`),
  ],
);

/** At most one payment record per order (INV-4). */
export const payments = pgTable(
  'payments',
  {
    orderId: uuid('order_id')
      .primaryKey()
      .references(() => orders.id),
    pspChargeId: text('psp_charge_id').unique('payments_psp_charge_id_key'),
    amountCents: integer('amount_cents').notNull(),
    status: paymentStatus('status').notNull(),
    declineCode: text('decline_code'),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [check('payments_amount_cents_check', sql`${t.amountCents} > 0`)],
);

/** Transactional outbox (§5.4): written in the same transaction as each status change (INV-5). */
export const outbox = pgTable(
  'outbox',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    /** uuidv7; the consumers' dedupe key. */
    eventId: uuid('event_id').notNull().unique('outbox_event_id_key'),
    topic: text('topic').notNull(),
    /** The productId. */
    partitionKey: text('partition_key').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    headers: jsonb('headers').$type<Record<string, string>>().notNull().default({}),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    publishedAt: timestamptz('published_at'),
  },
  (t) => [index('outbox_pending').on(t.id).where(sql`${t.publishedAt} IS NULL`)],
);

/** Exactly-once effects for consumers. Rows are kept 45 days: past Kafka's retention plus a DLQ replay. */
export const processedEvents = pgTable(
  'processed_events',
  {
    consumer: text('consumer').notNull(),
    eventId: uuid('event_id').notNull(),
    processedAt: timestamptz('processed_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: 'processed_events_pkey', columns: [t.consumer, t.eventId] })],
);

/** Orders a sweeper loop could not process. Later ticks skip them; every row raises an alert (§4.6). */
export const sweeperQuarantine = pgTable(
  'sweeper_quarantine',
  {
    loop: text('loop').notNull(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    error: text('error').notNull(),
    firstSeen: timestamptz('first_seen').notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: 'sweeper_quarantine_pkey', columns: [t.loop, t.orderId] })],
);

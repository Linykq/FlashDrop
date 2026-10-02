import { LISTING_JOB_STATUSES } from '@flashdrop/domain';
import { bigint, check, integer, jsonb, numeric, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { products, users } from './catalog';
import { bytea, inList, timestamptz } from './columns';

/*
 * Support tables (design §3): the dashboard projection (§9), listing jobs (§10) and process state (§4.7).
 */

/** The counters the dashboard consumer projects, per minute and per drop. Fresh builders per table. */
const salesCounters = () => ({
  reserved: integer('reserved').notNull().default(0),
  placed: integer('placed').notNull().default(0),
  paid: integer('paid').notNull().default(0),
  failed: integer('failed').notNull().default(0),
  expired: integer('expired').notNull().default(0),
  cancelled: integer('cancelled').notNull().default(0),
  rejected: integer('rejected').notNull().default(0),
  unitsSold: integer('units_sold').notNull().default(0),
  revenueCents: bigint('revenue_cents', { mode: 'number' }).notNull().default(0),
});

export const salesMinute = pgTable(
  'sales_minute',
  {
    dropId: uuid('drop_id').notNull(),
    minute: timestamptz('minute').notNull(),
    ...salesCounters(),
  },
  (t) => [primaryKey({ name: 'sales_minute_pkey', columns: [t.dropId, t.minute] })],
);

export const dropSalesTotals = pgTable('drop_sales_totals', {
  dropId: uuid('drop_id').primaryKey(),
  ...salesCounters(),
  lastEventAt: timestamptz('last_event_at'),
  /** +1 in every upsert; orders the dashboard WebSocket frames (§9). */
  version: bigint('version', { mode: 'number' }).notNull().default(0),
});

export const listingJobs = pgTable(
  'listing_jobs',
  {
    id: uuid('id').primaryKey(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    status: text('status', { enum: LISTING_JOB_STATUSES }).notNull(),
    imageKeys: text('image_keys').array().notNull(),
    hints: text('hints'),
    /** sha256(image hashes + hints + prompt_version): an identical earlier job is reused. */
    inputHash: bytea('input_hash').notNull(),
    provider: text('provider'),
    model: text('model'),
    promptVersion: text('prompt_version').notNull(),
    attempts: integer('attempts').notNull().default(0),
    draft: jsonb('draft'),
    final: jsonb('final'),
    issues: jsonb('issues'),
    usage: jsonb('usage'),
    /** numeric arrives as a string from node-postgres; parse it where it is read. */
    costUsd: numeric('cost_usd', { precision: 10, scale: 5 }),
    latencyMs: integer('latency_ms'),
    productId: uuid('product_id').references(() => products.id),
    /** The worker's lease on a RUNNING job. */
    lockedUntil: timestamptz('locked_until'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [check('listing_jobs_status_check', inList(t.status, LISTING_JOB_STATUSES))],
);

/** Process-wide values such as `redis_run_id` and `redis_epoch` (§4.7). */
export const systemState = pgTable('system_state', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
});

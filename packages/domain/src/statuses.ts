/*
 * The closed value sets of the data model (design §3). `packages/db` builds its enums and CHECK constraints
 * from these arrays and `packages/contracts` its Zod enums, so a value exists in all three places or none.
 */

export const USER_ROLES = ['buyer', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const DROP_STATUSES = ['DRAFT', 'SCHEDULED', 'LIVE', 'PAUSED', 'ENDED'] as const;
export type DropStatus = (typeof DROP_STATUSES)[number];

/**
 * Drops that may still sell. At most one per product (`one_open_drop_per_product`), so "the product's
 * current drop" is well defined.
 */
export const OPEN_DROP_STATUSES = ['SCHEDULED', 'LIVE', 'PAUSED'] as const satisfies readonly DropStatus[];

/** Every status but DRAFT: what buyers may see. A DRAFT drop is not armed and does not exist publicly. */
export const PUBLIC_DROP_STATUSES = [
  'SCHEDULED',
  'LIVE',
  'PAUSED',
  'ENDED',
] as const satisfies readonly DropStatus[];
export type PublicDropStatus = (typeof PUBLIC_DROP_STATUSES)[number];

export const ORDER_STATUSES = [
  'RESERVED',
  'PENDING_PAYMENT',
  'PAID',
  'PAYMENT_FAILED',
  'EXPIRED',
  'CANCELLED',
  'REJECTED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Why an order ended unpaid (`orders.close_reason`). REJECTED orders carry the Postgres refusal reason. */
export const CLOSE_REASONS = [
  'TIMEOUT',
  'USER',
  'DECLINED',
  'SOLD_OUT',
  'LIMIT',
  'NOT_LIVE',
  'ORPHANED',
] as const;
export type CloseReason = (typeof CLOSE_REASONS)[number];

export const PAYMENT_STATUSES = ['SUCCEEDED', 'FAILED', 'REFUNDED'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PRODUCT_STATUSES = ['DRAFT', 'PUBLISHED'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

/**
 * `llm` products were approved from a listing job (§10); `manual` ones were entered or seeded. `test` ones
 * come from `POST /test/drops` (§13): their pages work by URL, but the storefront's drop lists leave them out,
 * so tests and load runs on a shared stack never push the catalog off the home page.
 */
export const PRODUCT_SOURCES = ['manual', 'llm', 'test'] as const;
export type ProductSource = (typeof PRODUCT_SOURCES)[number];

export const LISTING_JOB_STATUSES = [
  'PENDING',
  'RUNNING',
  'READY',
  'NEEDS_REVIEW',
  'FAILED',
  'APPROVED',
] as const;
export type ListingJobStatus = (typeof LISTING_JOB_STATUSES)[number];

import type { OrderView, ProductSummary } from '@flashdrop/contracts';
import { CLOSE_REASONS, ORDER_STATUSES } from '@flashdrop/domain';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Executor } from './client';
import { PgBytea, PgTimestamp, PgUuid, parseRows } from './rows';
import { orders, products } from './schema';

/*
 * Reading orders (design §5.1, §5.2). Owners see their own orders only; another user's order is "not found",
 * never "forbidden" (§11), so `getOrderForUser` filters by owner in the query itself.
 */

/** An `orders` row, as the query builder reads it. */
export type OrderRecord = typeof orders.$inferSelect;

export interface OrderWithProduct {
  readonly order: OrderRecord;
  readonly product: ProductSummary;
}

/** `RETURNING *` of `orders`, from hand-written SQL, mapped to the builder's shape. */
const OrderRow = z
  .object({
    id: PgUuid,
    user_id: PgUuid,
    drop_id: PgUuid,
    product_id: PgUuid,
    qty: z.int(),
    unit_price_cents: z.int(),
    total_cents: z.int().nullable(),
    currency: z.string(),
    status: z.enum(ORDER_STATUSES),
    close_reason: z.enum(CLOSE_REASONS).nullable(),
    idempotency_key: z.string(),
    request_hash: PgBytea,
    checkout_key: z.string().nullable(),
    checkout_hash: PgBytea.nullable(),
    shipping: z.record(z.string(), z.unknown()).nullable(),
    payment_method: z.string().nullable(),
    expires_at: PgTimestamp,
    extensions: z.int(),
    version: z.int(),
    created_at: PgTimestamp,
    updated_at: PgTimestamp,
    paid_at: PgTimestamp.nullable(),
    closed_at: PgTimestamp.nullable(),
    redis_settled_at: PgTimestamp.nullable(),
  })
  .transform(
    (row): OrderRecord => ({
      id: row.id,
      userId: row.user_id,
      dropId: row.drop_id,
      productId: row.product_id,
      qty: row.qty,
      unitPriceCents: row.unit_price_cents,
      totalCents: row.total_cents,
      currency: row.currency,
      status: row.status,
      closeReason: row.close_reason,
      idempotencyKey: row.idempotency_key,
      requestHash: row.request_hash,
      checkoutKey: row.checkout_key,
      checkoutHash: row.checkout_hash,
      shipping: row.shipping,
      paymentMethod: row.payment_method,
      expiresAt: row.expires_at,
      extensions: row.extensions,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      paidAt: row.paid_at,
      closedAt: row.closed_at,
      redisSettledAt: row.redis_settled_at,
    }),
  );

/** Maps the rows of an `orders ... RETURNING *` statement. */
export function parseOrderRows(rows: readonly unknown[], statement: string): OrderRecord[] {
  return parseRows(OrderRow, rows, statement);
}

/** Any order by id. For internal callers (sweeper, consumers); request paths use `getOrderForUser`. */
export async function getOrder(db: Executor, orderId: string): Promise<OrderRecord | undefined> {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  return order;
}

/** The user's own order with its product summary; undefined for unknown ids and other users' orders. */
export async function getOrderForUser(
  db: Executor,
  orderId: string,
  userId: string,
): Promise<OrderWithProduct | undefined> {
  const [row] = await db
    .select({
      order: orders,
      product: { id: products.id, slug: products.slug, title: products.title, imageKeys: products.imageKeys },
    })
    .from(orders)
    .innerJoin(products, eq(products.id, orders.productId))
    .where(and(eq(orders.id, orderId), eq(orders.userId, userId)))
    .limit(1);
  return row;
}

/** The `OrderView` DTO. `serverNow` lets the client correct its countdown for clock offset. */
export function toOrderView(order: OrderRecord, product: ProductSummary, serverNow: Date): OrderView {
  return {
    id: order.id,
    status: order.status,
    closeReason: order.closeReason,
    dropId: order.dropId,
    product,
    qty: order.qty,
    unitPriceCents: order.unitPriceCents,
    // The stored total_cents is generated as exactly this product.
    totalCents: order.qty * order.unitPriceCents,
    currency: order.currency,
    expiresAt: order.expiresAt.toISOString(),
    extensions: order.extensions,
    createdAt: order.createdAt.toISOString(),
    serverNow: serverNow.toISOString(),
  };
}

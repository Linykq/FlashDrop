import type { OrderView } from '@flashdrop/contracts';
import { and, type Db, desc, eq, getOrderForUser, ne, orders, products, toOrderView } from '@flashdrop/db';

/** A buyer's own orders (design §5.1). Another user's order does not exist for the caller (§11: 404). */
export interface OrderReader {
  get(orderId: string, userId: string, now: Date): Promise<OrderView | undefined>;
  /** Newest first, without REJECTED tombstones (`OrderListResponse`). */
  listForUser(userId: string, limit: number, now: Date): Promise<OrderView[]>;
}

export function createPostgresOrders(db: Db): OrderReader {
  return {
    async get(orderId, userId, now) {
      const found = await getOrderForUser(db, orderId, userId);
      return found === undefined ? undefined : toOrderView(found.order, found.product, now);
    },

    async listForUser(userId, limit, now) {
      // Served by the (user_id, drop_id, idempotency_key) unique index; one buyer has a handful of orders.
      const rows = await db
        .select({
          order: orders,
          product: {
            id: products.id,
            slug: products.slug,
            title: products.title,
            imageKeys: products.imageKeys,
          },
        })
        .from(orders)
        .innerJoin(products, eq(products.id, orders.productId))
        .where(and(eq(orders.userId, userId), ne(orders.status, 'REJECTED')))
        .orderBy(desc(orders.createdAt), desc(orders.id))
        .limit(limit);
      return rows.map((row) => toOrderView(row.order, row.product, now));
    },
  };
}

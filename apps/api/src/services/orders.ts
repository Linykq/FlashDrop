import type { CheckoutBody, OrderDetail, OrderView } from '@flashdrop/contracts';
import {
  and,
  type CancelOutcome,
  type CancelRequest,
  type CheckoutOutcome,
  type CheckoutSubmission,
  cancelOrder,
  type Db,
  desc,
  type ExtendOutcome,
  eq,
  extendHold,
  getOrderDetailForUser,
  ne,
  type OrderDetailRecord,
  type OrderRequest,
  type OrderWithProduct,
  orders,
  products,
  submitCheckout,
  toOrderDetail,
  toOrderView,
} from '@flashdrop/db';
import { DomainError, type ErrorCode, NotFoundError } from '@flashdrop/domain';

/*
 * A buyer's own orders (design §4.4, §5.1, §5.2): reads, checkout submit, cancel and the one-time hold
 * extension. Each mutation is one compare-and-set in Postgres (`packages/db/src/checkout.ts`) on the
 * caller's own order, whose row lock linearizes it against expiry, payment and the buyer's other tabs; when
 * the CAS loses, Postgres re-reads the committed order and classifies the request in the same transaction.
 * This module only turns those outcomes into answers. Nothing here touches Redis or the PSP: stock goes back
 * to Redis through the settlement consumer (or the safety net) after Postgres commits, and payment runs
 * asynchronously from `order.placed` (§5.2 "Why payment is asynchronous").
 *
 * Another user's order does not exist for the caller: every port filters by `user_id`, so it is 404, never
 * 403 (§11).
 */

export interface CheckoutRequest {
  readonly orderId: string;
  readonly userId: string;
  /** Created once per order by the checkout form and kept in sessionStorage (§8.2). */
  readonly idempotencyKey: string;
  /** Parsed by `CheckoutBody`, so the fingerprint hashes the normalized value. */
  readonly body: CheckoutBody;
  readonly traceId: string;
}

export interface OrderChange {
  readonly orderId: string;
  readonly userId: string;
  readonly traceId: string;
}

export interface CancelChange extends OrderChange {
  /** `?from=`: cancel only an order still in this status. */
  readonly from?: CancelRequest['from'];
}

export interface Submitted {
  /** False for the submit that placed the order (202); true when this key placed it before (200). */
  readonly replayed: boolean;
  readonly order: OrderView;
}

export interface OrderService {
  /** The order page's view (`OrderDetail`). Throws `NotFoundError` for unknown and other users' orders. */
  get(orderId: string, userId: string): Promise<OrderDetail>;
  /** Newest first, without REJECTED tombstones (`OrderListResponse`). */
  listForUser(userId: string, limit: number): Promise<OrderView[]>;
  /** Throws a `DomainError` for every refusal: 404, 409, 410, 422. */
  checkout(request: CheckoutRequest): Promise<Submitted>;
  /**
   * The CANCELLED order, also for a repeated cancel. Throws 404, or 409 when the order moved on first or is
   * not in `from`.
   */
  cancel(request: CancelChange): Promise<OrderView>;
  /** The order with its hold 60 s longer. Throws 404, or 409 when the hold can't be extended. */
  extend(request: OrderChange): Promise<OrderView>;
}

/** What the service needs from Postgres; the unit tests run it over an in-memory fake. */
export interface OrderPorts {
  submit(submission: CheckoutSubmission): Promise<CheckoutOutcome>;
  cancel(request: CancelRequest): Promise<CancelOutcome>;
  extend(request: OrderRequest): Promise<ExtendOutcome>;
  detail(orderId: string, userId: string): Promise<OrderDetailRecord | undefined>;
  list(userId: string, limit: number): Promise<OrderWithProduct[]>;
}

const MESSAGES = {
  ALREADY_SUBMITTED: 'This order was already submitted',
  RESERVATION_EXPIRED: 'This reservation has expired',
  IDEMPOTENCY_KEY_REUSED: 'This Idempotency-Key was already used for a different request',
} as const satisfies Partial<Record<ErrorCode, string>>;

/** Why each CAS answers 409 `CONFLICT`: the order is no longer in a state the request applies to. */
const CONFLICTS = {
  checkout: 'This order is closed',
  cancel: 'This order can no longer be cancelled',
  extend: 'This hold can no longer be extended',
} as const;

const notFound = () => new NotFoundError('Order');

export function createOrderService(ports: OrderPorts, now: () => Date): OrderService {
  const view = ({ order, product }: OrderWithProduct) => toOrderView(order, product, now());

  return {
    async get(orderId, userId) {
      const found = await ports.detail(orderId, userId);
      if (found === undefined) throw notFound();
      return toOrderDetail(found, now());
    },

    async listForUser(userId, limit) {
      return (await ports.list(userId, limit)).map(view);
    },

    async checkout(request) {
      // One canonical spelling of the id: the checkout fingerprint hashes it, so a retry that spells the uuid
      // in another case must still replay instead of answering 422.
      const orderId = request.orderId.toLowerCase();
      const outcome = await ports.submit({
        orderId,
        userId: request.userId,
        checkoutKey: request.idempotencyKey,
        shipping: request.body.shipping,
        paymentMethod: request.body.paymentMethod,
        traceId: request.traceId,
      });
      switch (outcome.kind) {
        case 'submitted':
          return { replayed: false, order: view(outcome) };
        case 'replay':
          // The order as it is now (§4.5): PENDING_PAYMENT, or already PAID, failed or expired.
          return { replayed: true, order: view(outcome) };
        case 'refused':
          throw new DomainError(
            outcome.code,
            outcome.code === 'CONFLICT' ? CONFLICTS.checkout : MESSAGES[outcome.code],
          );
        case 'not_found':
          throw notFound();
      }
    },

    async cancel(request) {
      const outcome = await ports.cancel({ ...request, orderId: request.orderId.toLowerCase() });
      switch (outcome.kind) {
        case 'cancelled':
        case 'replay':
          return view(outcome);
        case 'refused':
          throw new DomainError(outcome.code, CONFLICTS.cancel);
        case 'not_found':
          throw notFound();
      }
    },

    async extend(request) {
      const outcome = await ports.extend({ ...request, orderId: request.orderId.toLowerCase() });
      switch (outcome.kind) {
        case 'extended':
          return view(outcome);
        case 'refused':
          throw new DomainError(outcome.code, CONFLICTS.extend);
        case 'not_found':
          throw notFound();
      }
    },
  };
}

/** The real ports over the api pool (2 s statements, 5 s transactions). */
export function createPostgresOrderPorts(db: Db): OrderPorts {
  return {
    submit: (submission) => submitCheckout(db, submission),
    cancel: (request) => cancelOrder(db, request),
    extend: (request) => extendHold(db, request),
    detail: (orderId, userId) => getOrderDetailForUser(db, orderId, userId),
    // Served by the (user_id, drop_id, idempotency_key) unique index; one buyer has a handful of orders.
    list: (userId, limit) =>
      db
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
        .limit(limit),
  };
}

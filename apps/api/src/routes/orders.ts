import {
  CancelQuery,
  CancelResponse,
  CheckoutBody,
  CheckoutResponse,
  ExtendResponse,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_REPLAYED_HEADER,
  OrderDetailResponse,
  OrderIdParams,
  OrderListQuery,
  OrderListResponse,
} from '@flashdrop/contracts';
import type { Api } from '../http/api';
import { IdempotencyHeaders } from '../http/idempotency';
import { requireSession, signedIn } from '../http/session';
import type { OrderService } from '../services/orders';

export interface OrderDeps {
  readonly orders: OrderService;
}

/**
 * The caller's own orders (design §5.1): reads, checkout submit, cancel and the one-time hold extension.
 * Another user's order is a 404, never a 403, so ids can't be probed. The mutations check the session before
 * they parse anything, so an anonymous caller always gets 401; none of them is rate limited, because each
 * is one short CAS on the caller's own row and the hot inventory row is touched only by cancel, once.
 */
export function orderRoutes(app: Api, { orders }: OrderDeps): void {
  app.get(
    '/orders/:orderId',
    { schema: { params: OrderIdParams, response: { 200: OrderDetailResponse } } },
    async (request, reply) => {
      const session = requireSession(request);
      reply.header('cache-control', 'private, no-store');
      return { order: await orders.get(request.params.orderId, session.sub) };
    },
  );

  app.get(
    '/me/orders',
    { schema: { querystring: OrderListQuery, response: { 200: OrderListResponse } } },
    async (request, reply) => {
      const session = requireSession(request);
      reply.header('cache-control', 'private, no-store');
      return { orders: await orders.listForUser(session.sub, request.query.limit) };
    },
  );

  // 202: the order is PENDING_PAYMENT and the payment consumer charges it asynchronously from `order.placed`
  // (§5.2). 200 with `Idempotency-Replayed: true`: this key and body submitted it before (a reload, or a retry
  // after a timeout), answered with the order as it is now.
  app.post(
    '/orders/:orderId/checkout',
    {
      onRequest: signedIn,
      schema: {
        params: OrderIdParams,
        headers: IdempotencyHeaders,
        body: CheckoutBody,
        response: { 200: CheckoutResponse, 202: CheckoutResponse },
      },
    },
    async (request, reply) => {
      const session = requireSession(request);
      const result = await orders.checkout({
        orderId: request.params.orderId,
        userId: session.sub,
        idempotencyKey: request.headers[IDEMPOTENCY_KEY_HEADER],
        body: request.body,
        traceId: request.traceId,
      });
      reply.header('cache-control', 'no-store');
      if (result.replayed) reply.code(200).header(IDEMPOTENCY_REPLAYED_HEADER, 'true');
      else reply.code(202);
      return { order: result.order };
    },
  );

  // Both are compare-and-sets that a retry can't apply twice, so they need no Idempotency-Key: a repeated
  // cancel answers 200 with the CANCELLED order, a repeated extend 409. `?from=RESERVED` makes the cancel
  // conditional on the order still being a hold (the checkout page's Leave).
  app.post(
    '/orders/:orderId/cancel',
    {
      onRequest: signedIn,
      schema: { params: OrderIdParams, querystring: CancelQuery, response: { 200: CancelResponse } },
    },
    async (request, reply) => {
      const session = requireSession(request);
      reply.header('cache-control', 'no-store');
      const order = await orders.cancel({
        orderId: request.params.orderId,
        userId: session.sub,
        traceId: request.traceId,
        from: request.query.from,
      });
      return { order };
    },
  );

  app.post(
    '/orders/:orderId/extend',
    { onRequest: signedIn, schema: { params: OrderIdParams, response: { 200: ExtendResponse } } },
    async (request, reply) => {
      const session = requireSession(request);
      reply.header('cache-control', 'no-store');
      const order = await orders.extend({
        orderId: request.params.orderId,
        userId: session.sub,
        traceId: request.traceId,
      });
      return { order };
    },
  );
}

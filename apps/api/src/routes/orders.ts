import { OrderIdParams, OrderListQuery, OrderListResponse, OrderResponse } from '@flashdrop/contracts';
import { NotFoundError } from '@flashdrop/domain';
import type { Api } from '../http/api';
import { requireSession } from '../http/session';
import type { OrderReader } from '../services/orders';

export interface OrderDeps {
  readonly orders: OrderReader;
  readonly now: () => Date;
}

/** The caller's own orders (design §5.1). Another user's order is a 404, never a 403, so ids can't be probed. */
export function orderRoutes(app: Api, { orders, now }: OrderDeps): void {
  app.get(
    '/orders/:orderId',
    { schema: { params: OrderIdParams, response: { 200: OrderResponse } } },
    async (request, reply) => {
      const session = requireSession(request);
      reply.header('cache-control', 'private, no-store');
      const order = await orders.get(request.params.orderId, session.sub, now());
      if (order === undefined) throw new NotFoundError('Order');
      return { order };
    },
  );

  app.get(
    '/me/orders',
    { schema: { querystring: OrderListQuery, response: { 200: OrderListResponse } } },
    async (request, reply) => {
      const session = requireSession(request);
      reply.header('cache-control', 'private, no-store');
      return { orders: await orders.listForUser(session.sub, request.query.limit, now()) };
    },
  );
}

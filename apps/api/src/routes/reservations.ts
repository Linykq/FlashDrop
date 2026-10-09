import {
  DropIdParams,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_REPLAYED_HEADER,
  OrderResponse,
  ReserveBody,
} from '@flashdrop/contracts';
import type { Api } from '../http/api';
import { IdempotencyHeaders } from '../http/idempotency';
import type { ReservationLimits } from '../http/rate-limit';
import { requireSession, signedIn } from '../http/session';
import type { ReservationService } from '../services/reserve';

export interface ReservationDeps {
  readonly reservations: ReservationService;
  readonly limits: ReservationLimits;
}

/**
 * `POST /drops/:dropId/reservations` (design §5.1): 201 for a new hold, 200 with `Idempotency-Replayed: true`
 * for a request whose key already has an order, problem details for every refusal. The limits run first,
 * per IP and then per user (§11), before the body is even parsed.
 */
export function reservationRoutes(app: Api, { reservations, limits }: ReservationDeps): void {
  app.post(
    '/drops/:dropId/reservations',
    {
      onRequest: [limits.byIp, signedIn, limits.byUser],
      schema: {
        params: DropIdParams,
        headers: IdempotencyHeaders,
        body: ReserveBody,
        response: { 200: OrderResponse, 201: OrderResponse },
      },
    },
    async (request, reply) => {
      const session = requireSession(request);
      const result = await reservations.reserve(
        {
          userId: session.sub,
          dropId: request.params.dropId,
          idempotencyKey: request.headers[IDEMPOTENCY_KEY_HEADER],
          qty: request.body.qty,
          traceId: request.traceId,
        },
        request.log,
      );
      reply.header('cache-control', 'no-store');
      if (result.replayed) reply.code(200).header(IDEMPOTENCY_REPLAYED_HEADER, 'true');
      else reply.code(201);
      return { order: result.order };
    },
  );
}

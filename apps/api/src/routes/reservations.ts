import {
  DropIdParams,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_REPLAYED_HEADER,
  IdempotencyKey,
  OrderResponse,
  ReserveBody,
} from '@flashdrop/contracts';
import { z } from 'zod';
import type { Api } from '../http/api';
import type { ReservationLimits } from '../http/rate-limit';
import { requireSession, signedIn } from '../http/session';
import type { ReservationService } from '../services/reserve';

/** Other headers pass through untouched; only the key is required and checked (§4.5: 8–64 of [A-Za-z0-9_-]). */
const ReserveHeaders = z.looseObject({ [IDEMPOTENCY_KEY_HEADER]: IdempotencyKey });

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
        headers: ReserveHeaders,
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

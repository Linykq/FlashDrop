import {
  CLOSE_REASONS,
  type ErrorCode as DomainErrorCode,
  IDEMPOTENCY_KEY_PATTERN,
  MAX_ORDER_QTY,
  MIN_ORDER_QTY,
  ORDER_STATUSES,
} from '@flashdrop/domain';
import { z } from 'zod';
import { ProductSummary } from './catalog';
import { Cents, Currency, IsoDateTime, Uuid } from './common';

/*
 * Reservations and orders (design §4.5, §5.1, §5.2). A reservation IS an order in RESERVED, so reserve,
 * replay and `GET /orders/:orderId` all answer with the same `OrderView`.
 */

/** Required on reserve and checkout. Clients keep the key and resend it on every retry of the same intent. */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
/** `true` on a 200 that replays an existing order instead of creating one. */
export const IDEMPOTENCY_REPLAYED_HEADER = 'idempotency-replayed';

export const IdempotencyKey = z
  .string()
  .regex(new RegExp(`^${IDEMPOTENCY_KEY_PATTERN}$`), 'must be 8 to 64 characters: letters, digits, _ or -');
export type IdempotencyKey = z.infer<typeof IdempotencyKey>;

export const OrderStatus = z.enum(ORDER_STATUSES);
export type OrderStatus = z.infer<typeof OrderStatus>;

export const CloseReason = z.enum(CLOSE_REASONS);
export type CloseReason = z.infer<typeof CloseReason>;

export const OrderQty = z.int().min(MIN_ORDER_QTY).max(MAX_ORDER_QTY);

/**
 * `POST /api/v1/drops/:dropId/reservations`. The per-user limit is the drop's, checked by Lua and Postgres;
 * this only bounds a single order. Unknown fields are dropped, so they never change the fingerprint.
 */
export const ReserveBody = z.object({ qty: OrderQty });
export type ReserveBody = z.infer<typeof ReserveBody>;

/** An order as its owner sees it. Shipping and payment details stay out of reads (§11). */
export const OrderView = z.object({
  id: Uuid,
  status: OrderStatus,
  /** Why an order ended unpaid; null while it is live or once it is PAID. */
  closeReason: CloseReason.nullable(),
  dropId: Uuid,
  product: ProductSummary,
  qty: OrderQty,
  unitPriceCents: Cents,
  totalCents: Cents,
  currency: Currency,
  /** The hold deadline while RESERVED, the payment deadline while PENDING_PAYMENT. Postgres time decides. */
  expiresAt: IsoDateTime,
  /** How many of the one allowed +60 s hold extensions were used (WCAG 2.2.1). */
  extensions: z.int().min(0).max(1),
  createdAt: IsoDateTime,
  /** The server's clock when the view was built; countdowns correct their offset with it. */
  serverNow: IsoDateTime,
});
export type OrderView = z.infer<typeof OrderView>;

/** 201 for a new reservation, 200 for a replay (with `Idempotency-Replayed: true`), and `GET /orders/:id`. */
export const OrderResponse = z.object({ order: OrderView });
export type OrderResponse = z.infer<typeof OrderResponse>;

export const OrderIdParams = z.object({ orderId: Uuid });
export type OrderIdParams = z.infer<typeof OrderIdParams>;

/** `GET /api/v1/me/orders?limit=`: the caller's newest orders first. */
export const OrderListQuery = z.object({
  limit: z.coerce.number().pipe(z.int().min(1).max(100)).default(50),
});
export type OrderListQuery = z.output<typeof OrderListQuery>;

/**
 * `GET /api/v1/me/orders`. REJECTED tombstones are left out: they record a refused attempt (§5.2), not an
 * order the buyer holds, and a replay of that attempt still answers with its refusal.
 */
export const OrderListResponse = z.object({ orders: z.array(OrderView) });
export type OrderListResponse = z.infer<typeof OrderListResponse>;

/**
 * Every `code` a reserve request can fail with besides validation, auth and rate limiting (§5.1):
 * 409 refusals, 410 for a replayed expired hold, 422 for a key reused with another body, 503 to retry with
 * the same key (the drop is being rebuilt, or a dependency is briefly down).
 */
export const RESERVE_ERROR_CODES = [
  'SOLD_OUT',
  'LIMIT_REACHED',
  'DROP_NOT_LIVE',
  'RESERVATION_EXPIRED',
  'IDEMPOTENCY_KEY_REUSED',
  'RETRY',
] as const satisfies readonly DomainErrorCode[];
export const ReserveErrorCode = z.enum(RESERVE_ERROR_CODES);
export type ReserveErrorCode = z.infer<typeof ReserveErrorCode>;

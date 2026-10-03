import { LIVE_ORDER_STATUSES, MAX_ORDER_QTY, MIN_ORDER_QTY, REJECT_REASONS } from '@flashdrop/domain';
import { z } from 'zod';

/*
 * The `orders.v1` event envelope (design §6.2). Producers validate it before the outbox insert, consumers
 * again on consume. Events are "fat" (qty and every id), so no consumer needs a lookup; shipping addresses
 * and other personal data stay out. Evolution is additive within v1; a breaking change is a new topic.
 */

export const ORDER_EVENT_SCHEMA_VERSION = 1;

const Base = z.object({
  /** uuidv7 = `outbox.event_id` = the consumers' dedupe key. */
  eventId: z.uuid(),
  schemaVersion: z.literal(ORDER_EVENT_SCHEMA_VERSION),
  occurredAt: z.iso.datetime(),
  orderId: z.uuid(),
  /** `orders.version` after the change the event reports. */
  orderVersion: z.int().positive(),
  /** The Kafka partition key. */
  productId: z.uuid(),
  dropId: z.uuid(),
  userId: z.uuid(),
  traceId: z.string().optional(),
});

const Qty = z.int().min(MIN_ORDER_QTY).max(MAX_ORDER_QTY);
const FromStatus = z.enum(LIVE_ORDER_STATUSES);

/**
 * `order.rejected` reasons. §6.2 lists SOLD_OUT, LIMIT and ORPHANED, but §4.4 and §5.2 also tombstone with
 * NOT_LIVE (a stale Redis status, or an orphan healed after the window), so the enum is every
 * `close_reason` a REJECTED order can carry; without NOT_LIVE such a tombstone could not emit its event.
 */
const RejectReason = z.enum(REJECT_REASONS);

export const OrderEvent = z.discriminatedUnion('type', [
  Base.extend({
    type: z.literal('order.reserved'),
    data: z.object({ qty: Qty, unitPriceCents: z.int(), expiresAt: z.iso.datetime() }),
  }),
  Base.extend({
    type: z.literal('order.placed'),
    data: z.object({
      qty: Qty,
      totalCents: z.int(),
      currency: z.string().length(3),
      paymentMethod: z.string(),
      expiresAt: z.iso.datetime(),
    }),
  }),
  Base.extend({
    type: z.literal('order.paid'),
    data: z.object({ qty: Qty, totalCents: z.int(), pspChargeId: z.string() }),
  }),
  Base.extend({
    type: z.literal('order.payment_failed'),
    data: z.object({ qty: Qty, declineCode: z.string() }),
  }),
  Base.extend({ type: z.literal('order.expired'), data: z.object({ qty: Qty, fromStatus: FromStatus }) }),
  Base.extend({ type: z.literal('order.cancelled'), data: z.object({ qty: Qty, fromStatus: FromStatus }) }),
  Base.extend({ type: z.literal('order.rejected'), data: z.object({ qty: Qty, reason: RejectReason }) }),
]);
export type OrderEvent = z.infer<typeof OrderEvent>;
export type OrderEventType = OrderEvent['type'];
export type OrderEventOf<T extends OrderEventType> = Extract<OrderEvent, { type: T }>;
export type OrderEventData<T extends OrderEventType> = OrderEventOf<T>['data'];

/** Every event type, in lifecycle order. */
export const ORDER_EVENT_TYPES = [
  'order.reserved',
  'order.placed',
  'order.paid',
  'order.payment_failed',
  'order.expired',
  'order.cancelled',
  'order.rejected',
] as const satisfies readonly OrderEventType[];

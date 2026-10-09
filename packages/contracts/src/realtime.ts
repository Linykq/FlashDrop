import { z } from 'zod';
import { Uuid } from './common';
import { OrderStatus } from './reservations';

/*
 * Real-time messages (design §7). The payment consumer publishes order changes on the owner's channel
 * (`fd:ch:user:<userId>`) and the WebSocket gateway forwards them unchanged on the implicit `user` topic,
 * never coalesced. Delivery is best effort: the order page also polls (design-system §10.5).
 */

/**
 * `order{orderId, status, version}`: the order changed. `version` is `orders.version` after the change,
 * so a client keeps the newest message per order and ignores older ones that arrive late; it then reads the
 * order itself for the details.
 */
export const OrderStatusMessage = z.object({
  type: z.literal('order'),
  orderId: Uuid,
  status: OrderStatus,
  version: z.int().positive(),
});
export type OrderStatusMessage = z.infer<typeof OrderStatusMessage>;

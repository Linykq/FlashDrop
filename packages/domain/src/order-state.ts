import type { OrderStatus } from './statuses';

/*
 * The order state machine (design §4.4). A reservation IS an order in RESERVED. Postgres enforces the same
 * table in the `orders_guard` trigger, and an integration test in `packages/db` checks the trigger against
 * this table edge by edge, so the two cannot drift apart.
 */

/** The only statuses an order row may be inserted with: a granted hold, or a refusal tombstone. */
export const INITIAL_ORDER_STATUSES = ['RESERVED', 'REJECTED'] as const satisfies readonly OrderStatus[];

/** Statuses that still hold stock and quota: counted in `drop_inventory.reserved`. */
export const LIVE_ORDER_STATUSES = ['RESERVED', 'PENDING_PAYMENT'] as const satisfies readonly OrderStatus[];

/** Final statuses. Their rows are immutable apart from `redis_settled_at`. */
export const TERMINAL_ORDER_STATUSES = [
  'PAID',
  'PAYMENT_FAILED',
  'EXPIRED',
  'CANCELLED',
  'REJECTED',
] as const satisfies readonly OrderStatus[];

/** Every legal status change. Anything not listed is illegal, including a terminal status to anything. */
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  RESERVED: ['PENDING_PAYMENT', 'EXPIRED', 'CANCELLED'],
  PENDING_PAYMENT: ['PAID', 'PAYMENT_FAILED', 'EXPIRED', 'CANCELLED'],
  PAID: [],
  PAYMENT_FAILED: [],
  EXPIRED: [],
  CANCELLED: [],
  REJECTED: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

export function isTerminalOrderStatus(status: OrderStatus): boolean {
  return (TERMINAL_ORDER_STATUSES as readonly OrderStatus[]).includes(status);
}

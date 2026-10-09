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

/**
 * Terminal statuses of an order that reached checkout and ended unpaid. A charge may still have raced its
 * end, so the payment consumer closes the PSP reference of such an order (refund plus fence, §6.5), and only
 * such an order may record a REFUNDED payment. A REJECTED order never reaches checkout.
 */
export const TERMINAL_UNPAID_ORDER_STATUSES = [
  'PAYMENT_FAILED',
  'EXPIRED',
  'CANCELLED',
] as const satisfies readonly OrderStatus[];

/**
 * The statuses whose PSP reference is owed a close when the order reached checkout (§6.5): expiry and cancel
 * can overtake a charge in flight, which the close refunds. Not PAYMENT_FAILED: it is decided by the PSP's
 * answer to the order's only charge key, a decline or a closed reference, so nothing was captured.
 */
export const PSP_CLOSE_ORDER_STATUSES = ['EXPIRED', 'CANCELLED'] as const satisfies readonly OrderStatus[];

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

export function isTerminalUnpaidOrderStatus(status: OrderStatus): boolean {
  return (TERMINAL_UNPAID_ORDER_STATUSES as readonly OrderStatus[]).includes(status);
}

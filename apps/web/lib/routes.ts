import type { OrderStatus, RoomSummary } from '@flashdrop/contracts';

/*
 * Links between storefront areas, in one place. Areas that later milestones build are not linked until
 * they exist, so nothing leads to a 404; each switch below is the single place to turn its links on.
 */

// TODO(M5): true once /live/[slug] exists; turns on "Watch live", the bar's "Live" link and the footer's.
const LIVE_ROOM_OPEN = false;
// TODO(M7): true once the admin area exists; turns on "Admin" and "Open admin" for admins.
const ADMIN_OPEN = false;
// TODO(M3): true once /orders/[orderId] exists (design-system §10.5). Until then an order is only ever
// RESERVED, EXPIRED or REJECTED, and checkout shows all three itself.
const ORDER_PAGE_OPEN = false;

export function productHref(slug: string): string {
  return `/p/${slug}`;
}

export function checkoutHref(orderId: string): string {
  return `/checkout/${orderId}`;
}

/** The order status page (§10.5), where checkout sends an order once it is submitted. */
export function orderPageHref(orderId: string): string {
  return `/orders/${orderId}`;
}

/** Where an order opens from a list: checkout while it is held, otherwise its status page. */
export function orderHref(order: { id: string; status: OrderStatus }): string {
  return order.status === 'RESERVED' || !ORDER_PAGE_OPEN ? checkoutHref(order.id) : orderPageHref(order.id);
}

export const ORDERS_HREF = '/orders';

/** The room of a drop that sells on stream, or `null` when there is nothing to link to. */
export function liveRoomHref(room: RoomSummary | null): string | null {
  return LIVE_ROOM_OPEN && room ? `/live/${room.slug}` : null;
}

export function adminHref(role: 'buyer' | 'admin'): string | null {
  return ADMIN_OPEN && role === 'admin' ? '/admin/drops' : null;
}

/** `/login`, returning to `returnTo` afterwards (design-system §9.13, §10.0). */
export function loginHref(returnTo?: string): string {
  return returnTo && returnTo !== '/' ? `/login?${new URLSearchParams({ returnTo })}` : '/login';
}

const PROBE_ORIGIN = 'http://flashdrop.invalid';

/**
 * Where to go after signing in: `value` if it is a path on this origin, otherwise `/` (§10.6). The check
 * resolves the value the way a browser would, so `//host`, `/\host` and `/<tab>/host`, which browsers all
 * send to another origin, fail it.
 */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/')) return '/';
  const url = URL.parse(value, PROBE_ORIGIN);
  if (url?.origin !== PROBE_ORIGIN) return '/';
  return `${url.pathname}${url.search}${url.hash}`;
}

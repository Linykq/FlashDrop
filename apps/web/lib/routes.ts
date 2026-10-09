import type { OrderStatus, RoomSummary } from '@flashdrop/contracts';

/* Links between storefront areas, in one place. */

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

/**
 * Where an order opens from a list: checkout while it is held, otherwise its status page. Each page also
 * sends an order of the other kind to the other one, so a list rendered a moment ago still lands right.
 */
export function orderHref(order: { id: string; status: OrderStatus }): string {
  return order.status === 'RESERVED' ? checkoutHref(order.id) : orderPageHref(order.id);
}

export const ORDERS_HREF = '/orders';

/** The room of a drop that sells on stream, or `null` when there is nothing to link to. */
export function liveRoomHref(room: RoomSummary | null): string | null {
  return room ? `/live/${room.slug}` : null;
}

export function adminHref(role: 'buyer' | 'admin'): string | null {
  return role === 'admin' ? '/admin/drops' : null;
}

/** The admin drops page with its "New drop" sheet open on a product (design-system §10.2, §10.8). */
export function newDropHref(productId: string): string {
  return `/admin/drops?${new URLSearchParams({ new: productId })}`;
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

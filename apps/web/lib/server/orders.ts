import { SESSION_COOKIE } from '@flashdrop/config/constants';
import { OrderListResponse, OrderResponse, type OrderView, Uuid } from '@flashdrop/contracts';
import { cookies } from 'next/headers';
import { cache } from 'react';
import { ApiError, apiGet } from './api';

/*
 * The signed-in buyer's orders, read by Server Components with the buyer's own session (SD §5.1): api answers
 * only the owner, and another user's order is a 404, never a 403 (SD §11). Never cached across requests:
 * every read depends on the session and on a hold that changes by the second.
 */

export type SessionRead<T> = { kind: 'ok'; value: T } | { kind: 'signed-out' } | { kind: 'not-found' };

/** Only the session cookie goes to api: the browser's other cookies are none of its business. */
async function sessionCookie(): Promise<string | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? `${SESSION_COOKIE}=${token}` : null;
}

async function readWithSession<T>(read: (cookie: string) => Promise<T>): Promise<SessionRead<T>> {
  const cookie = await sessionCookie();
  if (cookie === null) return { kind: 'signed-out' };
  try {
    return { kind: 'ok', value: await read(cookie) };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return { kind: 'signed-out' };
    if (error instanceof ApiError && error.status === 404) return { kind: 'not-found' };
    throw error;
  }
}

/**
 * One of the buyer's orders, memoised per request, so the checkout layout and page share one api read. A
 * malformed id never reaches api.
 */
export const readOrder = cache(async (orderId: string): Promise<SessionRead<OrderView>> => {
  if (!Uuid.safeParse(orderId).success) return { kind: 'not-found' };
  return readWithSession(async (cookie) => {
    const { order } = await apiGet(`/api/v1/orders/${orderId}`, OrderResponse, { cookie });
    return order;
  });
});

/**
 * The buyer's latest `limit` orders (at most 100), newest first. REJECTED tombstones are not orders the buyer
 * holds, so api leaves them out. Memoised per request.
 */
export const readMyOrders = cache(
  async (limit: number): Promise<SessionRead<OrderView[]>> =>
    readWithSession(async (cookie) => {
      const query = new URLSearchParams({ limit: String(limit) });
      const { orders } = await apiGet(`/api/v1/me/orders?${query}`, OrderListResponse, { cookie });
      return orders;
    }),
);

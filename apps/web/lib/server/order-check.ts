import { SESSION_COOKIE } from '@flashdrop/config/constants';
import { Uuid } from '@flashdrop/contracts';
import { apiEnv } from './env';
import { log } from './log';

/** The check runs before every order and checkout page, so a slow api fails it open quickly. */
const TIMEOUT_MS = 2_000;

/** What api says of an order for this session: the buyer's own, none of theirs, or no session at all. */
export type OrderCheck = 'found' | 'not-found' | 'signed-out';

/**
 * Whether `orderId` is one of the session's orders, asked before the page renders so an unknown order, or
 * another buyer's (api answers 404 for both, SD §11), gets a real 404 and the not-found page's title: once a
 * Cache Components shell streamed, neither can change (proxy.ts). A HEAD, because only the status matters.
 * Nothing is remembered: the answer depends on the session. When api can't answer, the page renders and shows
 * its own error state.
 */
export async function checkOrder(orderId: string, sessionToken: string): Promise<OrderCheck> {
  if (!Uuid.safeParse(orderId).success) return 'not-found';
  let status: number;
  try {
    const response = await fetch(new URL(`/api/v1/orders/${orderId}`, apiEnv().API_INTERNAL_URL), {
      method: 'HEAD',
      headers: { cookie: `${SESSION_COOKIE}=${sessionToken}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = response.status;
  } catch (error) {
    log().warn({ err: error, orderId }, 'cannot check an order; rendering the page anyway');
    return 'found';
  }
  if (status === 404) return 'not-found';
  if (status === 401) return 'signed-out';
  if (status !== 200)
    log().warn({ orderId, status }, 'unexpected status checking an order; rendering anyway');
  return 'found';
}

import { SESSION_COOKIE } from '@flashdrop/config/constants';
import { type NextRequest, NextResponse } from 'next/server';
import { loginHref } from './lib/routes';
import { productExists } from './lib/server/product-check';

/*
 * Statuses that must be decided before rendering. Under Cache Components a page's static shell is sent with a
 * 200 before its streamed part runs, and a status can't change once streaming started (Next 16.3 docs,
 * notFound "status code"), so:
 *
 * - Unknown products get a real 404 (design-system §10.0). The page keeps its own notFound() as the fallback
 *   for a check that couldn't reach api.
 * - The buyer's own pages (checkout, orders) send a visitor without a session cookie to sign in, with a real
 *   redirect, and back afterwards (§10.0 "Signed out"). Only the cookie's presence is checked here; an expired
 *   session is caught by the page itself, when api answers 401.
 */
export const config = { matcher: ['/p/:slug', '/checkout/:orderId', '/orders'] };

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;
  if (pathname.startsWith('/p/')) {
    // Not decoded: a slug is plain ASCII, so any percent-encoded segment fails the check as it should.
    if (await productExists(pathname.slice('/p/'.length))) return NextResponse.next();
    // The app's not-found route, rendered at the original URL with its 404 status and store chrome.
    return NextResponse.rewrite(new URL('/_not-found', request.url));
  }
  if (request.cookies.has(SESSION_COOKIE)) return NextResponse.next();
  return NextResponse.redirect(new URL(loginHref(`${pathname}${search}`), request.url));
}

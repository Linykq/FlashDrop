import { SESSION_COOKIE } from '@flashdrop/config/constants';
import { type NextRequest, NextResponse } from 'next/server';
import { loginHref } from './lib/routes';
import { checkOrder } from './lib/server/order-check';
import { productExists, roomExists } from './lib/server/product-check';
import { verifySession } from './lib/server/session';

/*
 * Statuses that must be decided before rendering. Under Cache Components a page's static shell is sent with a
 * 200 before its streamed part runs, and a status can't change once streaming started (Next 16.3 docs,
 * notFound "status code"), so:
 *
 * - Unknown products and live rooms get a real 404 (design-system §10.0). The pages keep their own notFound()
 *   as the fallback for a check that couldn't reach api.
 * - The buyer's own pages (checkout, orders) send a visitor without a session cookie to sign in, with a real
 *   redirect, and back afterwards (§10.0 "Signed out"). An order or checkout URL is also asked of api with the
 *   buyer's session: an unknown order, or another buyer's, gets a real 404 and the not-found page's title
 *   (WCAG 2.4.2), and a session api no longer accepts signs in. When api can't answer, the page decides.
 * - Admin pages admit only an admin's session (SD §8.1, §11), verified here with the key api signs it with.
 *   A visitor without a valid session signs in first; a signed-in buyer gets the 404 any unknown URL gets, so
 *   the area doesn't announce itself. api checks the role again on every admin read and write.
 */
export const config = {
  matcher: [
    '/p/:slug',
    '/live/:slug',
    '/checkout/:orderId',
    '/orders',
    '/orders/:orderId',
    // Zero or more segments: /admin itself too.
    '/admin/:path*',
  ],
};

/** The app's not-found route, rendered at the original URL with its 404 status and store chrome. */
function notFound(request: NextRequest): NextResponse {
  return NextResponse.rewrite(new URL('/_not-found', request.url));
}

function signIn(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  return NextResponse.redirect(new URL(loginHref(`${pathname}${search}`), request.url));
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  // Not decoded: a slug is plain ASCII, so any percent-encoded segment fails the check as it should.
  if (pathname.startsWith('/p/')) {
    return (await productExists(pathname.slice('/p/'.length))) ? NextResponse.next() : notFound(request);
  }
  if (pathname.startsWith('/live/')) {
    return (await roomExists(pathname.slice('/live/'.length))) ? NextResponse.next() : notFound(request);
  }
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (pathname === '/admin' || pathname.startsWith('/admin/')) {
    const viewer = token ? await verifySession(token) : null;
    if (viewer === null) return signIn(request);
    return viewer.role === 'admin' ? NextResponse.next() : notFound(request);
  }
  if (!token) return signIn(request);
  const orderId = /^\/(?:checkout|orders)\/([^/]+)$/.exec(pathname)?.[1];
  if (orderId === undefined) return NextResponse.next();
  const order = await checkOrder(orderId, token);
  if (order === 'signed-out') return signIn(request);
  return order === 'found' ? NextResponse.next() : notFound(request);
}

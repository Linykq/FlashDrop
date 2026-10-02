import { type NextRequest, NextResponse } from 'next/server';
import { productExists } from './lib/server/product-check';

/*
 * A real 404 status for unknown products (design-system §10.0). Under Cache Components the product page's
 * static shell is sent with a 200 before its streamed part can call notFound(), and a status can't change
 * once streaming started, so the check must run here, before rendering (Next 16.3 docs, notFound "status
 * code"). The page keeps its own notFound() as the fallback for a check that failed open.
 */
export const config = { matcher: '/p/:slug' };

export async function proxy(request: NextRequest): Promise<NextResponse> {
  // Not decoded: a slug is plain ASCII, so any percent-encoded segment fails the check as it should.
  const slug = request.nextUrl.pathname.slice('/p/'.length);
  if (await productExists(slug)) return NextResponse.next();
  // The app's not-found route, rendered at the original URL with its 404 status and store chrome.
  return NextResponse.rewrite(new URL('/_not-found', request.url));
}

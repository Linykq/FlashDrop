import { ImageKey, uploadPath } from '@flashdrop/contracts';
import { apiEnv } from '../../../lib/server/env';
import { log } from '../../../lib/server/log';

/** Long enough for a full-size photo over the Compose network, short enough not to pin a worker. */
const TIMEOUT_MS = 10_000;

/*
 * Product photos for web's own image optimizer, and for the browser in `pnpm dev`. In the full stack Caddy
 * sends the browser's `/uploads/*` to api before it reaches web, so only the optimizer's same-origin fetches
 * land here. Proxying at request time, rather than through a rewrite, reads API_INTERNAL_URL lazily: a
 * rewrite's destination is fixed into the build, which would tie one image to one api address (§8.1).
 */
export async function GET(request: Request, { params }: RouteContext<'/uploads/[key]'>) {
  const { key } = await params;
  if (!ImageKey.safeParse(key).success) return new Response(null, { status: 404 });

  // Keys are content addresses, so a revalidation with the ETag api sent is answered with a 304.
  const ifNoneMatch = request.headers.get('if-none-match');
  let upstream: Response;
  try {
    upstream = await fetch(new URL(uploadPath(key), apiEnv().API_INTERNAL_URL), {
      headers: ifNoneMatch ? { 'if-none-match': ifNoneMatch } : {},
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    log().warn({ err: error, key }, 'cannot fetch a product photo from api');
    return new Response(null, { status: 502 });
  }
  const headers = new Headers();
  for (const name of ['content-type', 'content-length', 'cache-control', 'etag', 'x-content-type-options']) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

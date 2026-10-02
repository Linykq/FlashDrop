import { headers } from 'next/headers';

/**
 * The public origin of the current request, for the absolute URLs that metadata and JSON-LD need. Behind
 * Caddy the browser's host and scheme arrive as `X-Forwarded-*`, which Caddy overwrites on every request
 * (infra/caddy/Caddyfile), so they can be trusted from that hop. Only the origin is kept, so a crafted
 * host header cannot smuggle a path into the URLs built from it.
 */
export async function requestOrigin(): Promise<string> {
  const list = await headers();
  const host = list.get('x-forwarded-host') ?? list.get('host');
  const proto = list.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
  return URL.parse(`${proto}://${host}`)?.origin ?? 'http://127.0.0.1:3000';
}

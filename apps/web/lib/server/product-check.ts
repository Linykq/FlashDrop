import { Slug } from '@flashdrop/contracts';
import { apiEnv } from './env';
import { log } from './log';

/** The check runs before every product and live room page, so a slow api fails it open quickly. */
const TIMEOUT_MS = 2_000;
/** Bounds each memo below; the catalog is far smaller, so in practice nothing is ever evicted. */
const MAX_KNOWN = 10_000;

type Kind = 'products' | 'rooms';

/*
 * Published products are never unpublished and rooms are never deleted, so a slug api confirmed once stays
 * valid for the life of the process and its page views after the first cost no api round trip. Misses are
 * not remembered: the slug may be published a moment later, and junk slugs must not grow the set.
 */
const known: Record<Kind, Set<string>> = { products: new Set(), rooms: new Set() };

/**
 * Whether `/api/v1/<kind>/<slug>` exists: `false` only when api says it doesn't (or the slug is malformed),
 * and `true` when api can't answer, so an outage leaves the page to render its own error state. A HEAD
 * request, because only the status matters (Fastify answers HEAD for every GET route).
 */
async function exists(kind: Kind, slug: string): Promise<boolean> {
  if (!Slug.safeParse(slug).success) return false;
  const seen = known[kind];
  if (seen.has(slug)) return true;
  let status: number;
  try {
    const response = await fetch(new URL(`/api/v1/${kind}/${slug}`, apiEnv().API_INTERNAL_URL), {
      method: 'HEAD',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = response.status;
  } catch (error) {
    log().warn({ err: error, kind, slug }, 'cannot check a slug; rendering the page anyway');
    return true;
  }
  if (status === 404) return false;
  if (status !== 200) {
    log().warn({ kind, slug, status }, 'unexpected status checking a slug; rendering the page anyway');
    return true;
  }
  if (seen.size >= MAX_KNOWN) {
    const oldest = seen.values().next();
    if (!oldest.done) seen.delete(oldest.value);
  }
  seen.add(slug);
  return true;
}

/** Whether `/p/<slug>` names a published product (see `exists`). */
export function productExists(slug: string): Promise<boolean> {
  return exists('products', slug);
}

/** Whether `/live/<slug>` names a live room (see `exists`). */
export function roomExists(slug: string): Promise<boolean> {
  return exists('rooms', slug);
}

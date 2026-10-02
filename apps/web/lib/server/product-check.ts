import { Slug } from '@flashdrop/contracts';
import { apiEnv } from './env';
import { log } from './log';

/** The check runs before every product page, so a slow api fails it open quickly. */
const TIMEOUT_MS = 2_000;
/** Bounds the memo below; the catalog is far smaller, so in practice nothing is ever evicted. */
const MAX_KNOWN = 10_000;

/*
 * Published products are never unpublished, so a slug api confirmed once stays valid for the life of the
 * process and its page views after the first cost no api round trip. Misses are not remembered: the slug
 * may be published a moment later, and junk slugs must not grow the set.
 */
const known = new Set<string>();

/**
 * Whether `/p/<slug>` names a published product: `false` only when api says it doesn't (or the slug is
 * malformed), and `true` when api can't answer, so an outage leaves the page to render its own error state.
 * A HEAD request, because only the status matters (Fastify answers HEAD for every GET route).
 */
export async function productExists(slug: string): Promise<boolean> {
  if (!Slug.safeParse(slug).success) return false;
  if (known.has(slug)) return true;
  let status: number;
  try {
    const response = await fetch(new URL(`/api/v1/products/${slug}`, apiEnv().API_INTERNAL_URL), {
      method: 'HEAD',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = response.status;
  } catch (error) {
    log().warn({ err: error, slug }, 'cannot check a product slug; rendering the page anyway');
    return true;
  }
  if (status === 404) return false;
  if (status !== 200) {
    log().warn({ slug, status }, 'unexpected status checking a product slug; rendering the page anyway');
    return true;
  }
  if (known.size >= MAX_KNOWN) {
    const oldest = known.values().next();
    if (!oldest.done) known.delete(oldest.value);
  }
  known.add(slug);
  return true;
}

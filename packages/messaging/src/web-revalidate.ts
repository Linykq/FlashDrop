import type { Logger } from '@flashdrop/config';

/*
 * Asks `web` to revalidate a cache tag (design §8.1): `POST /_internal/revalidate {tag}` with the shared
 * `REVALIDATE_SECRET`, reachable only inside the Compose network. Used by the drop scheduler (tag `drops` on
 * a status transition, §4.6) and by listing approval (§10). Best effort: a failure only leaves a cached page
 * to expire on its own schedule (an approving admin's Server Action calls `updateTag` itself for
 * read-your-writes), so nothing is retried and nothing fails the caller.
 */

export type TagRevalidator = (tag: string) => Promise<void>;

const TIMEOUT_MS = 2_000;

export function createWebRevalidator(options: {
  readonly webUrl: string;
  readonly secret: string;
  readonly logger: Pick<Logger, 'warn' | 'debug'>;
  readonly fetch?: typeof fetch;
}): TagRevalidator {
  const send = options.fetch ?? fetch;
  const url = new URL('/_internal/revalidate', options.webUrl);
  return async (tag) => {
    try {
      const response = await send(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-revalidate-secret': options.secret },
        body: JSON.stringify({ tag }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      await response.body?.cancel();
      if (response.ok) options.logger.debug({ tag }, 'web cache tag revalidated');
      else options.logger.warn({ tag, status: response.status }, 'web refused to revalidate a cache tag');
    } catch (err) {
      options.logger.warn({ err, tag }, 'web cache tag revalidation failed');
    }
  };
}

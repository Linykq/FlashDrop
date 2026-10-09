import { timingSafeEqual } from 'node:crypto';
import { revalidateTag } from 'next/cache';
import { z } from 'zod';
import { revalidateEnv } from '../../../lib/server/env';
import { log } from '../../../lib/server/log';

/*
 * `POST /_internal/revalidate {tag}` (SD §8.1): how `worker` (the drop scheduler) and `api` (listing approval)
 * expire web's cached catalog, since only a Server Action can call `updateTag`. Served at `/_internal/...`
 * because the folder is URL-encoded: a folder starting with `_` is private in the App Router and never routed
 * (spike delta 1). Caddy answers 404 for `/_internal/*`, so only the Compose network reaches it; the shared
 * secret is the second lock. `'max'` is stale-while-revalidate: the next visitor gets the cached page and
 * triggers the refetch, so a burst of transitions never stampedes api.
 */

/** The tags web caches under: `drops`, `product:<uuid>`, `dev-users`. Anything else is a caller's bug. */
const Body = z.object({
  tag: z
    .string()
    .regex(/^[a-z][a-z0-9-]*(:[0-9a-f-]{36})?$/)
    .max(64),
});

let secret: Buffer | undefined;

/** Read at request time: route modules are evaluated during `next build`, where no secret exists (delta 13). */
function expectedSecret(): Buffer {
  secret ??= Buffer.from(revalidateEnv().REVALIDATE_SECRET);
  return secret;
}

/** `timingSafeEqual` throws on a length mismatch, so lengths are compared first; the length is not secret. */
function authorized(header: string | null): boolean {
  if (header === null) return false;
  const expected = expectedSecret();
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function POST(request: Request): Promise<Response> {
  if (!authorized(request.headers.get('x-revalidate-secret'))) return new Response(null, { status: 401 });
  const body = Body.safeParse(await request.json().catch(() => undefined));
  if (!body.success) return Response.json({ error: 'invalid body' }, { status: 400 });
  revalidateTag(body.data.tag, 'max');
  log().info({ tag: body.data.tag }, 'cache tag revalidated');
  return Response.json({ revalidated: body.data.tag });
}

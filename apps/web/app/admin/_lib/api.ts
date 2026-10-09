import { SESSION_COOKIE } from '@flashdrop/config/constants';
import { PROBLEM_CONTENT_TYPE, ProblemDetails } from '@flashdrop/contracts';
import { cookies, headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import type { z } from 'zod';
import { loginHref } from '../../../lib/routes';
import { ApiError } from '../../../lib/server/api';
import { apiEnv } from '../../../lib/server/env';
import { log } from '../../../lib/server/log';
import { browserOrigin } from '../../../lib/server/origin';

/*
 * The admin area's server-side api access (SD §8.1 data access): Server Components and Server Actions call api
 * over API_INTERNAL_URL with the admin's own session cookie, so api re-checks the role on every call (SD §11)
 * and web never holds a privilege of its own. Writes forward the browser's own `Origin`: api's CSRF guard
 * admits a mutating request only from an allowed Origin, and it must judge the page the admin acted on, never
 * a value web made up (a forged Host would otherwise vouch for itself).
 */

/**
 * An admin action can wait up to 10 s for a busy drop's lock before api answers 409 `DROP_BUSY`, then arm or
 * rebuild the drop's Redis state (SD §4.7): long enough for both, short enough to free the action's worker.
 */
const WRITE_TIMEOUT_MS = 15_000;

/** A page read waits this long by default, as storefront reads do; slower reads say so (`timeoutMs`). */
const READ_TIMEOUT_MS = 5_000;

/** Only the session cookie goes to api: the browser's other cookies are none of its business. */
async function sessionCookie(): Promise<string | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? `${SESSION_COOKIE}=${token}` : null;
}

/**
 * A read for an admin page, validated against the shared contract like `apiGet`. A session that ended sends
 * the admin to sign in and back to `returnTo`; a role api no longer accepts, or a missing resource, is the
 * not-found page (SD §11 answers 404, never a hint). `timeoutMs` is for the reads that do real work, such as
 * the health check, which runs every invariant query and can take seconds on a busy database.
 */
export async function adminRead<S extends z.ZodType>(
  path: `/api/v1/${string}`,
  schema: S,
  returnTo: string,
  { timeoutMs = READ_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<z.output<S>> {
  const cookie = await sessionCookie();
  if (cookie === null) redirect(loginHref(returnTo));
  const response = await fetch(new URL(path, apiEnv().API_INTERNAL_URL), {
    headers: { accept: 'application/json', cookie },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 401) redirect(loginHref(returnTo));
  if (response.status === 403 || response.status === 404) notFound();
  if (!response.ok) throw new ApiError(path, response.status, await readProblem(response));
  return schema.parse(await response.json());
}

/** A write's outcome, for a Server Action to turn into copy. `status` 0: api could not be reached. */
export type WriteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly status: number; readonly problem: ProblemDetails | undefined };

async function readProblem(response: Response): Promise<ProblemDetails | undefined> {
  if (!response.headers.get('content-type')?.startsWith(PROBLEM_CONTENT_TYPE)) return undefined;
  const parsed = ProblemDetails.safeParse(await response.json().catch(() => undefined));
  return parsed.success ? parsed.data : undefined;
}

/**
 * A JSON write to api as the signed-in admin. Never throws for api's answer: every refusal is a value the
 * caller words (§12.2). A response that breaks the contract does throw, loudly, like `apiGet`.
 */
export async function adminWrite<S extends z.ZodType>(
  method: 'POST' | 'PATCH',
  path: `/api/v1/${string}`,
  body: unknown,
  schema: S,
): Promise<WriteResult<z.output<S>>> {
  const cookie = await sessionCookie();
  if (cookie === null) return { ok: false, status: 401, problem: undefined };
  // A Server Action is a POST, which browsers always send with an Origin: without one it isn't from our pages.
  const origin = browserOrigin(await headers());
  if (origin === null) return { ok: false, status: 403, problem: undefined };
  let response: Response;
  try {
    response = await fetch(new URL(path, apiEnv().API_INTERNAL_URL), {
      method,
      headers: {
        accept: 'application/json',
        cookie,
        origin,
        // A body-less POST must not claim JSON: Fastify refuses an empty body declared as JSON.
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
    });
  } catch (error) {
    log().warn({ err: error, path }, 'admin write could not reach api');
    return { ok: false, status: 0, problem: undefined };
  }
  if (!response.ok) return { ok: false, status: response.status, problem: await readProblem(response) };
  return { ok: true, value: schema.parse(await response.json()) };
}

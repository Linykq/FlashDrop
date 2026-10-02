import type { DevLoginBody } from '@flashdrop/contracts';

/*
 * Session changes, called from the browser same-origin (`/api/*` reaches api through Caddy, or through web's
 * rewrite in `pnpm dev`), so api sets and clears its own HttpOnly `fd_session` cookie and the browser sends
 * the `Origin` header api's CSRF check expects (SD §11). Both send JSON, the only body type api accepts on
 * a mutating request. Bodies are typed by the shared contracts but not parsed here: Zod would weigh on
 * every page's first load, and api validates them anyway.
 */

async function post(path: string, body: unknown): Promise<boolean> {
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return response.ok;
  } catch {
    // Offline or api unreachable: the caller shows its own error and the session is unchanged.
    return false;
  }
}

/** Signs in as a seeded account (`POST /api/v1/auth/dev-login`); `true` once the cookie is set. */
export function signIn(userId: string): Promise<boolean> {
  const body: DevLoginBody = { userId };
  return post('/api/v1/auth/dev-login', body);
}

/** Ends the session (`POST /api/v1/auth/logout`); `true` once the cookie is cleared. */
export function signOut(): Promise<boolean> {
  return post('/api/v1/auth/logout', {});
}

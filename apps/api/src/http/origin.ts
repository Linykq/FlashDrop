import { DomainError } from '@flashdrop/domain';
import type { onRequestAsyncHookHandler } from 'fastify';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF guard (design §11): a mutating request must carry an `Origin` from the allowlist
 * (`WS_ALLOWED_ORIGINS`). Browsers always send `Origin` on POST, so a request without one is not from our
 * pages; k6 and server-side callers send an allowed one explicitly. Together with SameSite=Lax and
 * JSON-only bodies this shuts out form posts from other sites.
 */
export function originGuard(allowedOrigins: readonly string[]): onRequestAsyncHookHandler {
  const allowed = new Set(allowedOrigins);
  return async (request) => {
    if (SAFE_METHODS.has(request.method)) return;
    const { origin } = request.headers;
    if (origin === undefined || !allowed.has(origin)) {
      throw new DomainError('FORBIDDEN', 'Origin not allowed');
    }
  };
}

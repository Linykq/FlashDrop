import type { CookieSerializeOptions } from '@fastify/cookie';
import { SessionClaims, type SessionUser } from '@flashdrop/contracts';
import { DomainError } from '@flashdrop/domain';
import type { FastifyRequest } from 'fastify';
import { errors, jwtVerify, SignJWT } from 'jose';

/*
 * The `fd_session` cookie (design §11): an HS256 JWT signed with `jose` that carries `SessionClaims`.
 * `web` verifies the same token with the same secret (its `proxy.ts` gates /admin on `role`), and from M5
 * so does the WebSocket gateway on upgrade.
 */

export const SESSION_TTL_SECONDS = 12 * 60 * 60;

const ALGORITHM = 'HS256';

export interface SessionCodec {
  issue(user: SessionUser): Promise<string>;
  /** The claims of a valid, unexpired token; null for anything else (forged, expired, malformed). */
  verify(token: string): Promise<SessionClaims | null>;
}

export function createSessionCodec(secret: string): SessionCodec {
  const key = new TextEncoder().encode(secret);
  return {
    issue: (user) =>
      new SignJWT({ role: user.role, name: user.displayName })
        .setProtectedHeader({ alg: ALGORITHM, typ: 'JWT' })
        .setSubject(user.id)
        .setIssuedAt()
        .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
        .sign(key),
    async verify(token) {
      try {
        // Pinning the algorithm rules out `alg: none` and key-confusion tokens.
        const { payload } = await jwtVerify(token, key, { algorithms: [ALGORITHM] });
        const claims = SessionClaims.safeParse(payload);
        return claims.success ? claims.data : null;
      } catch (error) {
        if (error instanceof errors.JOSEError) return null;
        throw error;
      }
    },
  };
}

/**
 * HttpOnly so page scripts never see the token; SameSite=Lax so cross-site POSTs arrive without it (CSRF,
 * with the Origin allowlist). `secure: 'auto'` marks it Secure whenever the request came over https; the
 * local edge serves plain http on 127.0.0.1, where a Secure cookie would be dropped by k6 and older clients.
 */
export const SESSION_COOKIE_OPTIONS = {
  path: '/',
  httpOnly: true,
  sameSite: 'lax',
  secure: 'auto',
} as const satisfies CookieSerializeOptions;

/** The signed-in caller's claims; 401 `UNAUTHENTICATED` without a valid session. */
export function requireSession(request: FastifyRequest): SessionClaims {
  if (request.session === null) throw new DomainError('UNAUTHENTICATED', 'Sign in to continue');
  return request.session;
}

/**
 * An admin's claims: 401 without a session, 403 `FORBIDDEN` for a buyer. `web` gates `/admin` too, but the
 * api checks the role on every admin route itself (§11).
 */
export function requireAdmin(request: FastifyRequest): SessionClaims {
  const session = requireSession(request);
  if (session.role !== 'admin') throw new DomainError('FORBIDDEN', 'Admins only');
  return session;
}

/** `requireSession` as a route hook, so a check that needs the caller (a per-user limit) can follow it. */
export async function signedIn(request: FastifyRequest): Promise<void> {
  requireSession(request);
}

/** `requireAdmin` as a route hook: an admin route refuses before it parses or validates anything. */
export async function adminOnly(request: FastifyRequest): Promise<void> {
  requireAdmin(request);
}

import type { CookieSerializeOptions } from '@fastify/cookie';
import { SESSION_AUDIENCE, SESSION_ISSUER, SESSION_TTL_SECONDS } from '@flashdrop/config/constants';
import { SessionClaims, type SessionUser, type UserRole } from '@flashdrop/contracts';
import { DomainError } from '@flashdrop/domain';
import type { FastifyRequest } from 'fastify';
import { errors, jwtVerify, SignJWT } from 'jose';

/*
 * The `fd_session` cookie (design §11): an HS256 JWT signed with `jose` that carries `SessionClaims`, issued
 * by `flashdrop` for `flashdrop-web`. `web` verifies the same token with the same secret (its `proxy.ts`
 * gates /admin on `role`), and so does the WebSocket gateway on upgrade.
 */

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
        .setIssuer(SESSION_ISSUER)
        .setAudience(SESSION_AUDIENCE)
        .setSubject(user.id)
        .setIssuedAt()
        .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
        .sign(key),
    async verify(token) {
      try {
        // Pinning the algorithm rules out `alg: none` and key-confusion tokens. `maxTokenAge` bounds a token
        // by its `iat` too, so one minted with a far `exp` (by anything that ever held the key) is refused.
        const { payload } = await jwtVerify(token, key, {
          algorithms: [ALGORITHM],
          issuer: SESSION_ISSUER,
          audience: SESSION_AUDIENCE,
          maxTokenAge: `${SESSION_TTL_SECONDS}s`,
          requiredClaims: ['iat', 'exp', 'sub'],
        });
        const claims = SessionClaims.safeParse(payload);
        return claims.success ? claims.data : null;
      } catch (error) {
        if (error instanceof errors.JOSEError) return null;
        throw error;
      }
    },
  };
}

/** The role of an account as Postgres has it now; undefined for an account that does not exist. */
export type RoleLookup = (userId: string) => Promise<UserRole | undefined>;

export interface AdminRoleCheckOptions {
  /** How long a looked-up role is trusted: a demotion or deletion takes effect within this. */
  readonly ttlMs?: number;
  /** Accounts remembered at once; the oldest entry goes first. Only admin tokens are ever looked up. */
  readonly maxEntries?: number;
  readonly now?: () => number;
}

/**
 * A token's `role` is only what was true when it was issued. Admin claims unlock every admin route and the
 * `dash:*` topics, so they are confirmed against `users` (cached for 30 s): a demoted admin becomes a buyer,
 * and a token for an account that does not exist is no session at all. Buyer claims are taken as they are,
 * so the reserve path never pays a lookup.
 */
export function createAdminRoleCheck(
  lookup: RoleLookup,
  options: AdminRoleCheckOptions = {},
): (claims: SessionClaims) => Promise<SessionClaims | null> {
  const ttlMs = options.ttlMs ?? 30_000;
  const maxEntries = options.maxEntries ?? 1_000;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { readonly role: UserRole | undefined; readonly at: number }>();

  async function roleOf(userId: string): Promise<UserRole | undefined> {
    const cached = cache.get(userId);
    if (cached !== undefined && now() - cached.at < ttlMs) return cached.role;
    const role = await lookup(userId);
    // Re-inserted, so the Map's insertion order is least recently refreshed first.
    cache.delete(userId);
    cache.set(userId, { role, at: now() });
    if (cache.size > maxEntries) {
      const [oldest] = cache.keys();
      if (oldest !== undefined) cache.delete(oldest);
    }
    return role;
  }

  return async (claims) => {
    if (claims.role !== 'admin') return claims;
    const role = await roleOf(claims.sub);
    return role === undefined ? null : { ...claims, role };
  };
}

/**
 * HttpOnly so page scripts never see the token; SameSite=Lax so cross-site POSTs arrive without it (CSRF,
 * with the Origin allowlist). Secure follows `COOKIE_SECURE`, never the request: the edge rewrites
 * `X-Forwarded-Proto` with its own scheme, so behind a TLS load balancer the request always looks like
 * plain http. The local edge serves plain http on 127.0.0.1, where a Secure cookie would be dropped by k6
 * and older clients.
 */
export function sessionCookieOptions(secure: boolean) {
  return { path: '/', httpOnly: true, sameSite: 'lax', secure } as const satisfies CookieSerializeOptions;
}

/** The signed-in caller's claims; 401 `UNAUTHENTICATED` without a valid session. */
export function requireSession(request: FastifyRequest): SessionClaims {
  if (request.session === null) throw new DomainError('UNAUTHENTICATED', 'Sign in to continue');
  return request.session;
}

/**
 * An admin's claims: 401 without a session, 403 `FORBIDDEN` for a buyer. `web` gates `/admin` too, but the
 * api checks the role on every admin route itself (§11), as confirmed against `users` for this request.
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

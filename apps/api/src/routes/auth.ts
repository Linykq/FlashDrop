import { normalizeIP } from '@fastify/rate-limit';
import { SESSION_COOKIE, SESSION_TTL_SECONDS } from '@flashdrop/config/constants';
import { DevLoginBody, DevUsersResponse, MeResponse } from '@flashdrop/contracts';
import { DomainError, NotFoundError } from '@flashdrop/domain';
import type { Api } from '../http/api';
import { rateLimitHook } from '../http/rate-limit';
import { requireSession, type SessionCodec, sessionCookieOptions } from '../http/session';
import type { UserStore } from '../services/users';

export interface AuthDeps {
  readonly users: UserStore;
  /** `COOKIE_SECURE`. */
  readonly cookieSecure: boolean;
}

export interface DevLoginDeps extends AuthDeps {
  readonly sessions: SessionCodec;
}

/**
 * Dev logins per client address and minute: a demo and a parallel Playwright run stay well inside it; a
 * script hammering the route does not. A local run signs in about 30 times within a minute (the admin specs
 * and the axe gate's admin pages, in four modes), and behind Caddy every one comes from the edge's address
 * (TRUST_PROXY), so the limit sits at several times that.
 */
export const DEV_LOGIN_PER_MINUTE = 120;

/** The session's user and sign-out (design §5.1, §11). */
export function authRoutes(app: Api, { users, cookieSecure }: AuthDeps): void {
  app.post('/auth/logout', async (_request, reply) =>
    reply.clearCookie(SESSION_COOKIE, sessionCookieOptions(cookieSecure)).code(204).send(),
  );

  app.get('/me', { schema: { response: { 200: MeResponse } } }, async (request, reply) => {
    const session = requireSession(request);
    reply.header('cache-control', 'private, no-store');
    // A token stays valid for 12 h; a user deleted in the meantime (db:reset-dev) is signed out, not served.
    const user = await users.findById(session.sub);
    if (user === undefined) throw new DomainError('UNAUTHENTICATED', 'Sign in to continue');
    return { user };
  });
}

/**
 * The passwordless dev login with the seeded accounts (design §5.1, §11), mounted only with
 * `ENABLE_DEV_LOGIN=true`, which the environment refuses beside any non-loopback origin. Without it both
 * routes are 404, and the web login page says sign-in is unavailable.
 */
export function devLoginRoutes(app: Api, { users, sessions, cookieSecure }: DevLoginDeps): void {
  const perAddress = rateLimitHook(app, {
    route: 'dev-login',
    max: DEV_LOGIN_PER_MINUTE,
    windowMs: 60_000,
    subject: (request) => normalizeIP(request.ip),
  });

  app.get('/auth/dev-users', { schema: { response: { 200: DevUsersResponse } } }, async () => ({
    users: await users.listDevUsers(),
  }));

  app.post(
    '/auth/dev-login',
    { onRequest: perAddress, schema: { body: DevLoginBody } },
    async (request, reply) => {
      const user = await users.findDevUser(request.body.userId);
      if (user === undefined) throw new NotFoundError('User');
      const token = await sessions.issue(user);
      reply.setCookie(SESSION_COOKIE, token, {
        ...sessionCookieOptions(cookieSecure),
        maxAge: SESSION_TTL_SECONDS,
      });
      return reply.code(204).send();
    },
  );
}

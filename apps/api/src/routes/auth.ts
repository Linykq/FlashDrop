import { SESSION_COOKIE } from '@flashdrop/config/constants';
import { DevLoginBody, DevUsersResponse, MeResponse } from '@flashdrop/contracts';
import { DomainError, NotFoundError } from '@flashdrop/domain';
import type { Api } from '../http/api';
import {
  requireSession,
  SESSION_COOKIE_OPTIONS,
  SESSION_TTL_SECONDS,
  type SessionCodec,
} from '../http/session';
import type { UserStore } from '../services/users';

export interface AuthDeps {
  readonly users: UserStore;
  readonly sessions: SessionCodec;
}

/** Dev login with the seeded accounts (design §5.1, §11) and the session's user. */
export function authRoutes(app: Api, { users, sessions }: AuthDeps): void {
  app.get('/auth/dev-users', { schema: { response: { 200: DevUsersResponse } } }, async () => ({
    users: await users.listDevUsers(),
  }));

  app.post('/auth/dev-login', { schema: { body: DevLoginBody } }, async (request, reply) => {
    const user = await users.findDevUser(request.body.userId);
    if (user === undefined) throw new NotFoundError('User');
    const token = await sessions.issue(user);
    reply.setCookie(SESSION_COOKIE, token, { ...SESSION_COOKIE_OPTIONS, maxAge: SESSION_TTL_SECONDS });
    return reply.code(204).send();
  });

  app.post('/auth/logout', async (_request, reply) =>
    reply.clearCookie(SESSION_COOKIE, SESSION_COOKIE_OPTIONS).code(204).send(),
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

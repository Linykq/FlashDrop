import { USER_ROLES } from '@flashdrop/domain';
import { z } from 'zod';
import { Uuid } from './common';

export const UserRole = z.enum(USER_ROLES);
export type UserRole = z.infer<typeof UserRole>;

/** The signed-in user as `api` returns it. */
export const SessionUser = z.object({
  id: Uuid,
  email: z.email(),
  displayName: z.string().min(1),
  role: UserRole,
});
export type SessionUser = z.infer<typeof SessionUser>;

/**
 * Claims of the `fd_session` HS256 JWT (§11). `web`'s `proxy.ts` gates `/admin` on `role`, and `api`
 * checks it again on every admin route. `iat` and `exp` are set and verified by `jose`.
 */
export const SessionClaims = z.object({
  sub: Uuid,
  role: UserRole,
  name: z.string().min(1),
});
export type SessionClaims = z.infer<typeof SessionClaims>;

/** `POST /api/v1/auth/dev-login`: answers 204 with the `fd_session` cookie. */
export const DevLoginBody = z.object({ userId: Uuid });
export type DevLoginBody = z.infer<typeof DevLoginBody>;

/** `GET /api/v1/auth/dev-users`: the seeded accounts the `/login` page offers, admins first. */
export const DevUsersResponse = z.object({ users: z.array(SessionUser) });
export type DevUsersResponse = z.infer<typeof DevUsersResponse>;

/** `GET /api/v1/me`: the session's user; 401 `UNAUTHENTICATED` without a valid session. */
export const MeResponse = z.object({ user: SessionUser });
export type MeResponse = z.infer<typeof MeResponse>;

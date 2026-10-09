import { randomUUID } from 'node:crypto';
import type { SessionClaims, TopicKind } from '@flashdrop/contracts';
import type { UserRole } from '@flashdrop/domain';

/*
 * Who is on a socket and what it may hear (design §7, §11). The identity is fixed at upgrade, from the
 * `fd_session` cookie the app's session hook verified: `stock:` and `room:` are public, `dash:` is admin
 * only, and a signed-in socket gets exactly its own `user` channel, which it never names. A socket outlives
 * the request that opened it, so a signed-in one carries its session's expiry and is closed once past it.
 */

export type Principal =
  | { readonly kind: 'anonymous'; readonly id: string }
  | {
      readonly kind: 'user';
      readonly userId: string;
      readonly role: UserRole;
      /** The session's `exp`, in ms. */
      readonly expiresAt: number;
    };

export function principalOf(session: SessionClaims | null): Principal {
  return session === null
    ? { kind: 'anonymous', id: `anon:${randomUUID()}` }
    : { kind: 'user', userId: session.sub, role: session.role, expiresAt: session.exp * 1000 };
}

export function canSubscribe(principal: Principal, kind: TopicKind): boolean {
  switch (kind) {
    case 'stock':
    case 'room':
      return true;
    case 'dash':
      return principal.kind === 'user' && principal.role === 'admin';
  }
}

/** For log lines: the user id, or the anonymous socket's own id. */
export function principalLabel(principal: Principal): string {
  return principal.kind === 'user' ? principal.userId : principal.id;
}

/**
 * Who a viewer is, for the room's viewer count: a signed-in user counts once however many tabs they open;
 * an anonymous socket counts on its own (the per-address socket cap bounds how many one client opens).
 */
export function viewerKey(principal: Principal): string {
  return principal.kind === 'user' ? `user:${principal.userId}` : principal.id;
}

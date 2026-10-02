import { SESSION_COOKIE } from '@flashdrop/config/constants';
import { SessionClaims, type UserRole } from '@flashdrop/contracts';
import { errors, jwtVerify } from 'jose';
import { cookies } from 'next/headers';
import { cache } from 'react';
import { sessionEnv } from './env';

/** The signed-in user as the storefront needs it: enough for the navigation bar and the Buy button. */
export type Viewer = { id: string; name: string; role: UserRole };

let key: Uint8Array | undefined;

function sessionKey(): Uint8Array {
  key ??= new TextEncoder().encode(sessionEnv().SESSION_SECRET);
  return key;
}

/**
 * The viewer from the `fd_session` cookie, verified locally with the key api signs it with (SD §11), so the
 * chrome of every page costs no api round trip and still renders while api is down. An expired, tampered
 * or malformed token is no session, which is also how api treats it. Memoised per request.
 */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, sessionKey(), { algorithms: ['HS256'] });
    const claims = SessionClaims.safeParse(payload);
    return claims.success ? { id: claims.data.sub, name: claims.data.name, role: claims.data.role } : null;
  } catch (error) {
    if (error instanceof errors.JOSEError) return null;
    throw error;
  }
});

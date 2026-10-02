import { CoreEnv, type Env, loadEnv, SessionEnv, WebEnv } from '@flashdrop/config';

/*
 * web's runtime settings, each group validated on first use at request time and never at module scope:
 * `next build` evaluates route modules and has neither the api nor the secrets (spike delta 13). The groups
 * are separate so that a missing SESSION_SECRET breaks sign-in only, not the catalog.
 */

const apiSchemas = [WebEnv] as const;
const sessionSchemas = [SessionEnv] as const;
const coreSchemas = [CoreEnv] as const;

let api: Env<typeof apiSchemas> | undefined;
let session: Env<typeof sessionSchemas> | undefined;
let core: Env<typeof coreSchemas> | undefined;

/** Where Server Components reach api: `http://api:4000` in Compose, `http://127.0.0.1:4000` in dev. */
export function apiEnv(): Env<typeof apiSchemas> {
  api ??= loadEnv(apiSchemas);
  return api;
}

/** The HS256 key api signs `fd_session` with. */
export function sessionEnv(): Env<typeof sessionSchemas> {
  session ??= loadEnv(sessionSchemas);
  return session;
}

export function coreEnv(): Env<typeof coreSchemas> {
  core ??= loadEnv(coreSchemas);
  return core;
}

import { loadEnv, PublicOriginEnv } from '@flashdrop/config';
import { io } from 'next/cache';

/*
 * The storefront's public origin, for the absolute URLs that metadata and JSON-LD carry (canonical, og:url,
 * images). It is configuration, never the request's Host: Caddy's site answers any Host and forwards it, so a
 * client could otherwise write its own host into those links, and into any cache in front that doesn't key
 * on Host (security review, final M10 pass). `PUBLIC_ORIGIN` (`packages/config`, `.env.example`) sets it.
 */

/** `pnpm dev` serves the storefront on web's own port; everything else behind Caddy's edge (SD §15). */
const DEV_ORIGIN = 'http://127.0.0.1:3000';
const EDGE_ORIGIN = 'http://127.0.0.1:8080';

/** The origin from `env`, or the default of the process's mode. Pure, for the tests. */
export function originFromEnv(env: Readonly<Record<string, string | undefined>>): string {
  const { PUBLIC_ORIGIN } = loadEnv([PublicOriginEnv], env);
  return PUBLIC_ORIGIN ?? (env.NODE_ENV === 'development' ? DEV_ORIGIN : EDGE_ORIGIN);
}

let cached: string | undefined;

/**
 * The public origin, read at request time (`io()`), never during `next build`: one image then serves any
 * host its environment names, as API_INTERNAL_URL does (spike delta 13).
 */
export async function publicOrigin(): Promise<string> {
  await io();
  cached ??= originFromEnv(process.env);
  return cached;
}

/**
 * The browser's own `Origin` of a request, for forwarding to api's CSRF guard, or `null` when it sent none.
 * Browsers always send one with a POST (a Server Action), so a request without it didn't come from our pages.
 * Never a value web makes up: the guard must judge where the request came from, not where web runs.
 */
export function browserOrigin(headers: Pick<Headers, 'get'>): string | null {
  const origin = headers.get('origin');
  return origin === null || origin === '' || origin === 'null' ? null : origin;
}

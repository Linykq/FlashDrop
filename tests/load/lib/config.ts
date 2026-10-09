/*
 * Settings shared by every k6 script (design §13), from `__ENV` (`-e NAME=value` or the container's
 * environment). The defaults reach the full stack from the host; the Compose `k6` service points
 * `BASE_URL` at Caddy inside the Compose network instead.
 */

function env(name: string, fallback: string): string {
  const value = __ENV[name];
  return value === undefined || value === '' ? fallback : value;
}

/** The edge, without a trailing slash: `/api/v1` is appended here. */
export const BASE_URL = env('BASE_URL', 'http://127.0.0.1:8080').replace(/\/+$/, '');
export const API = `${BASE_URL}/api/v1`;

/** Sent on every mutating request: api's CSRF guard accepts only `WS_ALLOWED_ORIGINS` (§11). */
export const ORIGIN = env('ORIGIN', 'http://127.0.0.1:8080');

/**
 * `TEST_ROUTES_SECRET` of the stack; the test routes also need `ENABLE_TEST_ROUTES=true` there. No default:
 * every stack has its own (tools/ensure-env.ts), which the Compose `k6` service passes on.
 */
export const TEST_SECRET = env('TEST_SECRET', '');
if (TEST_SECRET === '') {
  throw new Error("TEST_SECRET is not set: pass the stack's TEST_ROUTES_SECRET (-e TEST_SECRET=...)");
}

/**
 * payment-mock, for the PSP's own record of an order's charges (§6.5). It is not behind Caddy: the Compose
 * k6 service reaches it on the Compose network; a native `pnpm dev` payment-mock listens on 127.0.0.1:4100.
 * Set but empty (`-e PSP_URL=`), the scripts skip their PSP checks and say so.
 */
export const PSP_URL = (__ENV.PSP_URL ?? 'http://payment-mock:4100').replace(/\/+$/, '');

/**
 * payment-mock's API key (§6.5): its `/v1/*` routes, the charge book included, refuse a call without
 * `Authorization: Bearer <key>`. The Compose k6 service passes the stack's own (tools/ensure-env.ts); only
 * the PSP checks need it.
 */
export const PSP_API_KEY = env('PSP_API_KEY', '');

/** Where `handleSummary` writes its JSON; the Compose service mounts `tests/load/results` here. */
export const RESULTS_DIR = env('RESULTS_DIR', 'results').replace(/\/+$/, '');

export function intEnv(name: string, fallback: number): number {
  const raw = env(name, String(fallback));
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a whole number, got ${raw}`);
  return value;
}

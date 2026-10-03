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

/** `TEST_ROUTES_SECRET` of the stack; the test routes also need `ENABLE_TEST_ROUTES=true` there. */
export const TEST_SECRET = env('TEST_SECRET', 'dev-only-test-routes-secret');

/** Where `handleSummary` writes its JSON; the Compose service mounts `tests/load/results` here. */
export const RESULTS_DIR = env('RESULTS_DIR', 'results').replace(/\/+$/, '');

export function intEnv(name: string, fallback: number): number {
  const raw = env(name, String(fallback));
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a whole number, got ${raw}`);
  return value;
}

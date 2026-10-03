/*
 * The `Idempotency-Key` header (design §4.5): required on reserve and checkout, 8–64 characters of
 * `[A-Za-z0-9_-]`. The key is scoped to (user, drop) and is part of the reservation id, so its format is
 * checked before anything is derived from it. Browser-safe: `web` generates keys and validates them too.
 */

export const IDEMPOTENCY_KEY_MIN_LENGTH = 8;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 64;

/** Unanchored, like the other shared patterns, so contracts and SQL can embed it. */
export const IDEMPOTENCY_KEY_PATTERN = `[A-Za-z0-9_-]{${IDEMPOTENCY_KEY_MIN_LENGTH},${IDEMPOTENCY_KEY_MAX_LENGTH}}`;

const WHOLE_KEY = new RegExp(`^${IDEMPOTENCY_KEY_PATTERN}$`);

export function isIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string' && WHOLE_KEY.test(value);
}

/*
 * Exponential backoff with full jitter: the delay before retry `n` is uniform in [0, min(cap, base * 2^n)).
 * Jitter spreads the retries of replicas that failed together (a broker or Postgres restart), so they do not
 * come back in lockstep and fail together again.
 */

export interface BackoffPolicy {
  /** The ceiling of the first retry's delay. */
  readonly baseMs: number;
  /** The largest ceiling, reached after log2(cap / base) retries. */
  readonly capMs: number;
}

/** The relay after a failed batch: 1 s doubling to 30 s (design §5.4). */
export const RELAY_BACKOFF: BackoffPolicy = { baseMs: 1_000, capMs: 30_000 };

/** A consumer partition paused by a transient failure: 100 ms doubling to 30 s (design §6.4). */
export const CONSUMER_BACKOFF: BackoffPolicy = { baseMs: 100, capMs: 30_000 };

/**
 * A consumer partition paused by an unclassified failure: 1 s doubling to 30 s (§6.4). Slower, because such a
 * failure is either a bug, which no retry fixes, or an outage the classifier does not know, which a retry a
 * little later may well get past.
 */
export const UNCLASSIFIED_BACKOFF: BackoffPolicy = { baseMs: 1_000, capMs: 30_000 };

/** Beyond this the ceiling is the cap for any sane policy, and `2 ** retry` cannot overflow. */
const MAX_EXPONENT = 30;

/** The ceiling of retry `retry` (0 for the first retry after a failure). */
export function backoffCeilingMs(policy: BackoffPolicy, retry: number): number {
  return Math.min(policy.capMs, policy.baseMs * 2 ** Math.min(Math.max(retry, 0), MAX_EXPONENT));
}

/** A delay for retry `retry`, uniform in [0, ceiling). `random` is injectable for tests. */
export function fullJitterDelayMs(
  policy: BackoffPolicy,
  retry: number,
  random: () => number = Math.random,
): number {
  return Math.floor(random() * backoffCeilingMs(policy, retry));
}

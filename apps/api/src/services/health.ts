import { RetryError } from '@flashdrop/domain';

/** A dependency check for the health route: resolves when the dependency answers, rejects otherwise. */
export type DependencyCheck = () => Promise<void>;

/**
 * `SELECT 1` within `timeoutMs`. The pool's connection timeout bounds the wait for a connection, but not a
 * query on a pooled connection whose peer vanished without a reset: `statement_timeout` runs on the server,
 * so that query waits minutes for TCP to give up. A probe that hangs is worse than one that says no
 * (Compose's healthcheck gives up after 3 s), so the probe keeps its own, shorter deadline.
 */
export function postgresCheck(
  pool: { query(text: string): Promise<unknown> },
  timeoutMs = 1_500,
): DependencyCheck {
  return () => withDeadline('postgres', () => pool.query('SELECT 1'), timeoutMs);
}

/**
 * `PING` within `timeoutMs`. The command client has no offline queue, so a disconnected Redis fails at once;
 * the deadline covers a connected Redis that stopped answering (a long script, a stalled AOF rewrite).
 */
export function redisCheck(redis: { ping(): Promise<unknown> }, timeoutMs = 1_500): DependencyCheck {
  return () => withDeadline('redis', () => redis.ping(), timeoutMs);
}

async function withDeadline(name: string, call: () => Promise<unknown>, timeoutMs: number): Promise<void> {
  const { promise: timedOut, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(new RetryError(`${name} did not answer in time`)), timeoutMs);
  try {
    await Promise.race([call(), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

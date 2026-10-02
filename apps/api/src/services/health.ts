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
  return async () => {
    const { promise: timedOut, reject } = Promise.withResolvers<never>();
    const timer = setTimeout(() => reject(new RetryError('postgres did not answer in time')), timeoutMs);
    try {
      await Promise.race([pool.query('SELECT 1'), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  };
}

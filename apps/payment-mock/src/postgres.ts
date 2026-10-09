import type { PoolProfile } from '@flashdrop/db';
import type { DependencyCheck } from './app';

/**
 * The ledger's pool. Simulated latency is slept before a transaction starts, so a connection is held only
 * for one short transaction: 20 cover the payment consumers' 2 x 32 concurrent calls, including duplicates
 * queued on one reference's lock. A statement stuck past 2 s answers 503, and the caller retries the key.
 */
export const PSP_POOL_PROFILE = {
  settings: { statement_timeout: '2s', transaction_timeout: '5s' },
  connectionTimeoutMillis: 5_000,
  max: 20,
} as const satisfies PoolProfile;

/**
 * `SELECT 1` within `timeoutMs`: `statement_timeout` runs on the server, so a pooled connection whose peer
 * vanished would otherwise hang the probe until TCP gives up, past Compose's 3 s healthcheck timeout.
 */
export function postgresCheck(
  pool: { query(text: string): Promise<unknown> },
  timeoutMs = 1_500,
): DependencyCheck {
  return async () => {
    const timedOut = Promise.withResolvers<never>();
    const timer = setTimeout(() => timedOut.reject(new Error('postgres did not answer in time')), timeoutMs);
    try {
      await Promise.race([pool.query('SELECT 1'), timedOut.promise]);
    } finally {
      clearTimeout(timer);
    }
  };
}

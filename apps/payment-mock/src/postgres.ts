import type { PoolProfile } from '@flashdrop/db';

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

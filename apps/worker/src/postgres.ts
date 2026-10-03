import { type Db, type PoolProfile, transaction, tryLoopLock } from '@flashdrop/db';

/**
 * The worker's main pool. A loop holds its tick lock in a transaction that stays open, idle, while the tick
 * works on other connections (`withLoopLock`), so the idle and transaction limits bound how long a wedged
 * tick can keep a standby instance out: past them Postgres ends the session and the lock goes with it. A
 * second instance may then run the same loop at once, which is safe, because every loop's writes are CASes
 * or idempotent Functions; the lock only saves duplicate work.
 */
export const WORKER_POOL_PROFILE = {
  settings: {
    statement_timeout: '10s',
    idle_in_transaction_session_timeout: '60s',
    transaction_timeout: '60s',
  },
  connectionTimeoutMillis: 5_000,
} as const satisfies PoolProfile;

/**
 * Runs `fn` under `pg_try_advisory_xact_lock(<loop>)` (design §4.6): one instance runs each tick, a standby
 * skips it. The lock lives in a transaction held open for the tick, so it vanishes with a dead holder's
 * connection; `fn` does its work on the pool, never inside that transaction. False when another instance
 * holds the lock.
 */
export async function withLoopLock(db: Db, loop: string, fn: () => Promise<void>): Promise<boolean> {
  return transaction(db, async (tx) => {
    if (!(await tryLoopLock(tx, loop))) return false;
    await fn();
    return true;
  });
}

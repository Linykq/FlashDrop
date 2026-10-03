import type { Logger } from '@flashdrop/config';
import type pg from 'pg';

/*
 * Leader election (design §2, §4.7): a session-level advisory lock held on a dedicated connection for as
 * long as this process leads. A standby asks again on every tick. The lock vanishes with a dead leader's
 * connection, so a standby takes over within one tick of Postgres ending that session.
 *
 * Leadership saves duplicate work and keeps one writer of the Redis identity (`fd:epoch`); it is not what
 * makes the reconciler safe. Every rebuild and status write still runs under its drop's lock, so two
 * leaders for a moment (a partitioned leader that has not noticed yet) cost an extra rebuild, never a wrong
 * one.
 */

export interface LeaderLease {
  /** True while this process leads; a process that does not lead tries to become leader. */
  check(): Promise<boolean>;
  /** Gives leadership up (shutdown), so a standby takes over on its next tick. */
  release(): Promise<void>;
}

export interface LeaderLeaseDeps {
  /** A pool without `transaction_timeout` or idle limits on plain sessions (`DROP_LOCK_POOL_PROFILE`). */
  readonly pool: pg.Pool;
  readonly logger: Pick<Logger, 'info' | 'warn'>;
}

const LOCK = `hashtextextended('fd.leader.' || $1::text, 0)`;

export function createLeaderLease(deps: LeaderLeaseDeps, role: string): LeaderLease {
  let session: pg.PoolClient | undefined;
  const onError = (err: Error) => {
    if (session !== undefined) lose(session, err);
  };

  const lose = (client: pg.PoolClient, err?: unknown) => {
    if (session !== client) return;
    session = undefined;
    client.off('error', onError);
    client.release(true);
    deps.logger.warn({ err, role }, 'leadership lost');
  };

  return {
    async check() {
      if (session !== undefined) {
        const current = session;
        try {
          // The lock lives as long as this session: a working session means it is still ours.
          await current.query('SELECT 1');
          return true;
        } catch (err) {
          lose(current, err);
        }
      }
      const client = await deps.pool.connect();
      let acquired: boolean;
      try {
        const { rows } = await client.query<{ acquired: boolean }>(
          `SELECT pg_try_advisory_lock(${LOCK}) AS acquired`,
          [role],
        );
        acquired = rows[0]?.acquired === true;
      } catch (err) {
        client.release(true);
        throw err;
      }
      if (!acquired) {
        client.release();
        return false;
      }
      session = client;
      client.on('error', onError);
      deps.logger.info({ role }, 'became leader');
      return true;
    },

    async release() {
      const current = session;
      if (current === undefined) return;
      session = undefined;
      current.off('error', onError);
      try {
        await current.query(`SELECT pg_advisory_unlock(${LOCK})`, [role]);
        current.release();
      } catch {
        // Closing the session releases the lock as well.
        current.release(true);
      }
    },
  };
}

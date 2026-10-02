import type { Logger } from '@flashdrop/config';
import pg from 'pg';

/** Postgres settings sent in each connection's startup packet, so they hold before its first query. */
export type SessionSettings = Readonly<
  Partial<
    Record<
      'statement_timeout' | 'transaction_timeout' | 'idle_in_transaction_session_timeout' | 'lock_timeout',
      string
    >
  >
>;

/** How one role's pool talks to Postgres. */
export interface PoolProfile {
  readonly settings: SessionSettings;
  /**
   * The longest a query waits for a connection: a free one from a full pool, or a new one being opened.
   * `pg` waits forever by default, and no session setting covers this wait, because it happens before the
   * query reaches a session. Past it the query fails with an error `isTransientDbError` recognises, so a
   * burst or a Postgres restart becomes 503 `RETRY` instead of requests that hang.
   */
  readonly connectionTimeoutMillis: number;
}

/**
 * Per-role pool profiles (M0 spike §4.7). `api`: a reserve transaction can never outlive the orphan scan's
 * 30 s grace (§4.6), a stuck statement answers 503 instead of holding a hot row, and a request fails fast
 * rather than queueing behind a saturated pool. `relay`: a stuck publish batch releases its rows; it can
 * afford to wait longer for a connection than a buyer can. `maintenance` (migrations, the seed): no session
 * limits, because DDL on a real table may legitimately run long.
 */
export const POOL_PROFILES = {
  api: { settings: { statement_timeout: '2s', transaction_timeout: '5s' }, connectionTimeoutMillis: 2_000 },
  relay: {
    settings: { idle_in_transaction_session_timeout: '30s', transaction_timeout: '20s' },
    connectionTimeoutMillis: 5_000,
  },
  maintenance: { settings: {}, connectionTimeoutMillis: 10_000 },
} as const satisfies Record<string, PoolProfile>;

export interface PoolOptions extends PoolProfile {
  readonly connectionString: string;
  readonly logger: Pick<Logger, 'warn'>;
  /** Shown in `pg_stat_activity`, e.g. `api` or `worker:relay`. */
  readonly applicationName?: string;
  readonly max?: number;
}

/** `-c key=value` pairs for libpq's `options` startup parameter. */
export function startupOptions(settings: SessionSettings): string | undefined {
  const pairs = Object.entries(settings).map(([key, value]) => `-c ${key}=${value}`);
  return pairs.length > 0 ? pairs.join(' ') : undefined;
}

/**
 * A node-postgres pool with the profile applied to every connection.
 *
 * `transaction_timeout` ends the whole session with a FATAL error, and `pg` then emits `'error'` on the
 * checked-out client, not on the pool; with no listener that is an uncaught exception that kills the process
 * (design delta 6). So every client gets a listener as it connects. The query that was running still
 * rejects with the real error, and the pool discards the dead client.
 */
export function createPool(options: PoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    options: startupOptions(options.settings),
    connectionTimeoutMillis: options.connectionTimeoutMillis,
    application_name: options.applicationName,
    max: options.max,
  });
  pool.on('connect', (client) => {
    client.on('error', (err) => options.logger.warn({ err }, 'postgres connection lost'));
  });
  pool.on('error', (err) => options.logger.warn({ err }, 'idle postgres connection lost'));
  return pool;
}

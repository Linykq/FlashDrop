import pg from 'pg';

/*
 * Reading Postgres errors through Drizzle, which wraps them: a failed query throws `DrizzleQueryError`
 * ("Failed query: ...") with the `pg.DatabaseError` (SQLSTATE `code`, `constraint`) as its `cause`.
 */

const MAX_CAUSE_DEPTH = 8;

function* causeChain(error: unknown): Generator<Error> {
  let current = error;
  for (let depth = 0; current instanceof Error && depth < MAX_CAUSE_DEPTH; depth++) {
    yield current;
    current = current.cause;
  }
}

/** The Postgres error behind `error`, wherever it sits in the `cause` chain. */
export function pgErrorOf(error: unknown): pg.DatabaseError | undefined {
  for (const cause of causeChain(error)) {
    if (cause instanceof pg.DatabaseError) return cause;
  }
  return undefined;
}

/**
 * The constraint (or the `orders_guard` trigger, which raises under that name) that rejected the statement,
 * so callers branch on names such as `no_oversell` rather than on message text.
 */
export function constraintOf(error: unknown): string | undefined {
  return pgErrorOf(error)?.constraint;
}

/** SQLSTATEs where the same request may succeed if it is simply retried. */
const TRANSIENT_SQLSTATES = new Set([
  '25P04', // transaction_timeout (observed in the M0 spike)
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '53300', // too_many_connections
  '57014', // query_canceled, including statement_timeout
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now (starting up)
]);

/**
 * `pg` reports a lost or unobtainable connection with these messages and no SQLSTATE. The first two were
 * observed in the M0 spike; the last two are `pg-pool` giving up after `connectionTimeoutMillis`, waiting for
 * a free connection of a full pool and opening a new one.
 */
const CONNECTION_LOST_MESSAGES = new Set([
  'Connection terminated unexpectedly',
  'Client has encountered a connection error and is not queryable',
  'timeout exceeded when trying to connect',
  'Connection terminated due to connection timeout',
]);

/**
 * Socket and resolver failures. The resolver ones matter in Compose: while the postgres container restarts,
 * Docker's DNS has no record for `postgres`, and the lookup fails with ENOTFOUND or EAI_AGAIN.
 */
const SOCKET_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

/**
 * True when `error` means "Postgres is briefly unavailable or the session died", not "this request is
 * wrong": `api` answers 503 `RETRY` and consumers pause and retry. A lock timeout is deliberately not
 * transient: the drop lock maps it to 409 `DROP_BUSY` (§4.7).
 */
export function isTransientDbError(error: unknown): boolean {
  for (const cause of causeChain(error)) {
    if (cause instanceof pg.DatabaseError) {
      const code = cause.code ?? '';
      return (
        TRANSIENT_SQLSTATES.has(code) ||
        code.startsWith('08') || // connection_exception
        cause.severity === 'FATAL' ||
        cause.severity === 'PANIC'
      );
    }
    if (CONNECTION_LOST_MESSAGES.has(cause.message)) return true;
    if ('code' in cause && typeof cause.code === 'string' && SOCKET_ERROR_CODES.has(cause.code)) return true;
  }
  return false;
}

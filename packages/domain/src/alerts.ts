/*
 * Alerts (design §12) are ERROR log lines with `alert: true`; there is no pager. `alertName` names the
 * condition, so one grep (or one log query) finds every occurrence of it, whichever process raised it.
 */

export type AlertName =
  // worker
  /** An order a sweeper loop could not process; later ticks skip it (§4.6). */
  | 'sweeper_quarantine'
  /** A hold orphan-scan can neither record in Postgres nor quarantine: its drop is rebuilt (§4.6). */
  | 'orphan_unrecordable'
  /** Redis holds the opposite terminal state of an order: an INV-8 breach (`CONFLICT`, §6.5). */
  | 'redis_conflict'
  /** A drop RECONCILING for more than 30 s while its lock holder is alive (§4.7). */
  | 'slow_rebuild'
  /** A drop RECONCILING for more than 30 s while the reconciler holds its lock and its rebuild fails (§4.7). */
  | 'rebuild_failed'
  // api
  /** Postgres refused (SOLD_OUT or LIMIT) what Redis admitted: Redis was optimistic (§4.7, §12). */
  | 'postgres_refusal'
  /** The reserve path's Postgres breaker opened: reservations are refused before Redis (§5.2). */
  | 'pg_breaker_open'
  /** A request ended in a 500: a broken assumption, such as an unvalidated qty reaching Lua (§5.2). */
  | 'request_failed'
  /** A public drop has no stock level in Redis or Postgres. */
  | 'stock_missing';

/** The part of a pino logger an alert needs. */
export interface AlertLogger {
  error(context: Readonly<Record<string, unknown>>, message: string): void;
}

export function alert(
  logger: AlertLogger,
  name: AlertName,
  context: Readonly<Record<string, unknown>>,
  message: string,
): void {
  logger.error({ ...context, alert: true, alertName: name }, message);
}

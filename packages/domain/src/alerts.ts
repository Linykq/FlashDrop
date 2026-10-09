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
  // relay and consumers (packages/messaging)
  /** Any write to the dead-letter topic (§6.4). */
  | 'dlq_write'
  /** A partition has retried the same message for more than 5 minutes (§6.4). */
  | 'partition_stuck'
  /** A group's committed offset is below the log start: retention deleted events it never processed. */
  | 'offset_below_log_start'
  /** The oldest unpublished outbox row is older than 10 s (§5.4). */
  | 'outbox_lag'
  /** Kafka refuses an outbox record itself (unknown topic, too large): the relay is blocked until fixed. */
  | 'relay_rejected'
  /** The listing model declined a product photo; never retried, since a photo should not trip it (§10). */
  | 'listing_refused'
  /** A listing job failed for a reason other than a refusal (a bad key, a bug, a missing photo) (§10). */
  | 'listing_failed'
  /** A listing job has waited more than 10 minutes on a model that stays unavailable (429s, overload) (§10). */
  | 'listing_unavailable'
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

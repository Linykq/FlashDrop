import type { Logger } from '@flashdrop/config';
import { isPostgresUnavailableError } from '@flashdrop/db';
import { alert } from '@flashdrop/domain';

/*
 * The Postgres breaker of the reserve path (design §5.2: `if (!pgBreaker.healthy()) throw http503('RETRY')`).
 * Lua takes a hold before Postgres records it, so while Postgres is failing every admitted request would
 * leave an orphan hold that only the sweeper's orphan scan returns, a hold-time plus 30 s later: stock
 * vanishes for minutes. The breaker refuses before Lua instead.
 *
 * It opens after `failureThreshold` consecutive failures that say Postgres itself is unavailable
 * (`isPostgresUnavailableError`): never the request's own fault, and never this service's own contention
 * (a full pool, the hot-row queue), which a healthy Postgres shows under every burst. While open it lets no
 * request through; one `probe` (a `SELECT 1`, which takes no hold) runs at most every `probeIntervalMs`,
 * and only its success closes the breaker.
 *
 * Calls admitted before a state change say nothing about the state after it: a reserve that started before
 * the breaker opened may still succeed, and one that started before it closed may still fail. So every
 * opening and closing starts a new epoch, and a call's outcome counts only in the epoch it was admitted in:
 * real traffic never closes the breaker, and stale failures never reopen it.
 */

export interface PgBreaker {
  /** False while open: the caller answers 503 `RETRY` without touching Redis. */
  healthy(): boolean;
  /** Runs one Postgres call of the reserve path, counting its outcome. */
  run<T>(call: () => Promise<T>): Promise<T>;
}

export interface PgBreakerOptions {
  /** Resolves when Postgres answers (`postgresCheck(pool)`), rejects otherwise. */
  readonly probe: () => Promise<void>;
  readonly logger: Pick<Logger, 'warn' | 'error' | 'info'>;
  readonly failureThreshold?: number;
  readonly probeIntervalMs?: number;
  /** At most one `pg_breaker_open` alert this often; a reopening within it is logged as a warning. */
  readonly alertIntervalMs?: number;
  readonly now?: () => number;
}

export function createPgBreaker(options: PgBreakerOptions): PgBreaker {
  const threshold = options.failureThreshold ?? 3;
  const probeIntervalMs = options.probeIntervalMs ?? 1_000;
  const alertIntervalMs = options.alertIntervalMs ?? 60_000;
  const now = options.now ?? Date.now;
  let epoch = 0;
  let open = false;
  let failures = 0;
  let probing = false;
  let lastProbeAt = 0;
  let lastAlertAt = Number.NEGATIVE_INFINITY;

  const trip = (error: unknown) => {
    open = true;
    epoch++;
    failures = 0;
    lastProbeAt = now();
    const context = { err: error, threshold };
    if (now() - lastAlertAt >= alertIntervalMs) {
      lastAlertAt = now();
      alert(
        options.logger,
        'pg_breaker_open',
        context,
        'postgres unavailable; reservations refused before Redis until it answers',
      );
    } else {
      options.logger.warn(context, 'postgres unavailable again; reservations refused before Redis');
    }
  };

  const close = () => {
    open = false;
    epoch++;
    failures = 0;
    options.logger.info('postgres answers again; reservations resume');
  };

  const probe = () => {
    probing = true;
    lastProbeAt = now();
    options
      .probe()
      .then(close, (err: unknown) =>
        options.logger.warn({ err }, 'postgres probe failed; breaker stays open'),
      )
      .finally(() => {
        probing = false;
      });
  };

  return {
    healthy() {
      if (!open) return true;
      if (!probing && now() - lastProbeAt >= probeIntervalMs) probe();
      return false;
    },
    async run(call) {
      const admittedIn = epoch;
      const current = () => admittedIn === epoch && !open;
      try {
        const result = await call();
        if (current()) failures = 0;
        return result;
      } catch (error) {
        if (current() && isPostgresUnavailableError(error) && ++failures >= threshold) trip(error);
        throw error;
      }
    },
  };
}

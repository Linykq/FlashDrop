import type { Logger } from 'pino';

/*
 * Process plumbing every FlashDrop service shares (design §12, §15): deadlines on calls that can hang,
 * readiness checks, and the graceful shutdown Compose's stop sequence relies on. One copy, so a fix to
 * shutdown ordering or readiness semantics reaches api, worker and payment-mock alike.
 */

/** Below Compose's 10 s stop grace period, so a stuck shutdown still exits with our own log line. */
export const SHUTDOWN_TIMEOUT_MS = 8_000;

/**
 * `promise`, or a rejection with `onTimeout()` once `ms` have passed. The work itself is not cancelled.
 * Promise.race subscribes to both, so a promise that settles after the deadline is never an unhandled
 * rejection, and the timer is cleared either way, so it never holds the event loop open.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** A readiness check: resolves when the dependency answers, rejects otherwise. */
export type DependencyCheck = () => Promise<void>;

/** `call` as a check that fails once `timeoutMs` pass without an answer. */
export function dependencyCheck(
  name: string,
  call: () => Promise<unknown>,
  timeoutMs = 1_500,
): DependencyCheck {
  return async () => {
    await withTimeout(call(), timeoutMs, () => new Error(`${name} did not answer within ${timeoutMs} ms`));
  };
}

/**
 * `SELECT 1` within `timeoutMs`. The pool's connection timeout bounds the wait for a connection, but not a
 * query on a pooled connection whose peer vanished without a reset: `statement_timeout` runs on the server,
 * so that query would wait minutes for TCP to give up, past Compose's 3 s healthcheck timeout. A probe that
 * hangs is worse than one that says no.
 */
export function postgresCheck(
  pool: { query(text: string): Promise<unknown> },
  timeoutMs?: number,
): DependencyCheck {
  return dependencyCheck('postgres', () => pool.query('SELECT 1'), timeoutMs);
}

/**
 * Runs every check at once and returns the names of those that failed, each logged with its error; empty
 * when the process is ready.
 */
export async function failedChecks(
  checks: Readonly<Record<string, DependencyCheck>>,
  log: Pick<Logger, 'warn'>,
): Promise<string[]> {
  const entries = Object.entries(checks);
  const results = await Promise.allSettled(entries.map(([, check]) => check()));
  const failed: string[] = [];
  results.forEach((result, index) => {
    const name = entries[index]?.[0] ?? `check ${index}`;
    if (result.status === 'rejected') {
      failed.push(name);
      log.warn({ err: result.reason, check: name }, 'readiness check failed');
    }
  });
  return failed;
}

/**
 * Closes every resource at once and logs each one that fails, by name, so a container killed at its grace
 * period still says which close hung or failed. Never rejects; false when anything failed.
 */
export async function closeAll(
  logger: Pick<Logger, 'error'>,
  resources: Readonly<Record<string, () => Promise<unknown>>>,
): Promise<boolean> {
  const entries = Object.entries(resources);
  // Through then(), so a close that throws synchronously is settled like one that rejects.
  const results = await Promise.allSettled(entries.map(([, close]) => Promise.resolve().then(close)));
  let closed = true;
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      closed = false;
      logger.error({ err: result.reason, resource: entries[index]?.[0] }, 'close failed');
    }
  });
  return closed;
}

/** Logged synchronously before Node prints the crash, so it reaches the JSON logs with context. */
export function logUncaughtExceptions(logger: Pick<Logger, 'fatal'>): void {
  process.on('uncaughtExceptionMonitor', (err, origin) =>
    logger.fatal({ err, origin }, 'uncaught exception'),
  );
}

export interface GracefulShutdownOptions {
  readonly logger: Pick<Logger, 'info' | 'error'>;
  /** Stops the work in flight, then closes what the process opened. A rejection sets exit code 1. */
  readonly close: () => Promise<void>;
  readonly timeoutMs?: number;
}

/** Starts the shutdown; every later call returns the same promise. Never rejects. */
export type Shutdown = (reason: string) => Promise<void>;

/**
 * Runs `close` once on SIGTERM or SIGINT, or when the returned function is called (a failed start). If it
 * has not finished within `timeoutMs`, the process exits 1 with a log line instead of being killed silently
 * at Compose's grace period.
 */
export function installGracefulShutdown({
  logger,
  close,
  timeoutMs = SHUTDOWN_TIMEOUT_MS,
}: GracefulShutdownOptions): Shutdown {
  let running: Promise<void> | undefined;

  const shutdown: Shutdown = (reason) => {
    running ??= (async () => {
      logger.info({ reason }, 'shutting down');
      const timer = setTimeout(() => {
        logger.error({ timeoutMs }, 'shutdown timed out');
        process.exit(1);
      }, timeoutMs);
      timer.unref();
      try {
        await close();
      } catch (err) {
        logger.error({ err }, 'shutdown failed');
        process.exitCode = 1;
      } finally {
        clearTimeout(timer);
      }
    })();
    return running;
  };

  process.once('SIGTERM', (signal) => void shutdown(signal));
  process.once('SIGINT', (signal) => void shutdown(signal));
  return shutdown;
}

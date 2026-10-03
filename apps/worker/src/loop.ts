import type { Logger } from '@flashdrop/config';
import { isTransientDbError } from '@flashdrop/db';
import { RetryError } from '@flashdrop/domain';
import { isTransientRedisError } from '@flashdrop/inventory';

/*
 * The periodic loops every worker role is made of (design §4.6, §4.7). A tick never overlaps the previous
 * one: the next is scheduled when one ends, `everyMs` after the last one started. A failing tick is logged
 * and the loop carries on; correctness never depends on any single tick, because every loop is
 * level-triggered and idempotent.
 */

export interface LoopSpec {
  /** For logs and the health endpoint, e.g. `expire-orders`. */
  readonly name: string;
  readonly everyMs: number;
  /**
   * One pass. `signal` aborts on shutdown: a long tick stops between items. A tick that only found another
   * instance holding its lock still completes normally: that instance is doing the work.
   */
  readonly tick: (signal: AbortSignal) => Promise<void>;
}

export interface LoopHealth {
  readonly name: string;
  readonly healthy: boolean;
  /** When a tick last completed, ISO 8601; null before the first one. */
  readonly lastOkAt: string | null;
  readonly consecutiveFailures: number;
  readonly lastError: string | null;
}

export interface Loop {
  readonly name: string;
  /** Runs the first tick now and keeps ticking. */
  start(): void;
  /** Runs the next tick as soon as possible; calls while a tick runs coalesce into one more. */
  wake(): void;
  /** Stops scheduling, aborts the tick in flight and waits for it to finish. */
  stop(): Promise<void>;
  health(now?: number): LoopHealth;
}

/** Failures logged in a row before going quiet; one line every this many after that, then one on recovery. */
const LOG_EVERY_FAILURES = 30;

/** A loop is unhealthy once no tick has completed for this many intervals (and at least 15 s). */
const STALE_INTERVALS = 5;
const MIN_STALE_MS = 15_000;

/**
 * "Postgres or Redis is briefly unavailable" (or a drop lock was lost with its session): warn, not error,
 * and the next tick retries. Never a reason to quarantine anything.
 */
export function isTransientError(error: unknown): boolean {
  return error instanceof RetryError || isTransientDbError(error) || isTransientRedisError(error);
}

export function createLoop(spec: LoopSpec, logger: Logger): Loop {
  const log = logger.child({ loop: spec.name });
  const staleAfterMs = Math.max(spec.everyMs * STALE_INTERVALS, MIN_STALE_MS);
  const abort = new AbortController();
  let stopped = true;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: { readonly startedAt: number; readonly done: Promise<void> } | undefined;
  let again = false;
  let lastOkAt: number | undefined;
  let failures = 0;
  let lastError: string | undefined;

  const schedule = (delayMs: number) => {
    timer = setTimeout(run, delayMs);
  };

  const run = () => {
    timer = undefined;
    if (stopped) return;
    const startedAt = Date.now();
    const done = (async () => {
      try {
        await spec.tick(abort.signal);
        if (failures >= LOG_EVERY_FAILURES) log.info({ failures }, 'loop recovered');
        lastOkAt = Date.now();
        failures = 0;
        lastError = undefined;
      } catch (err) {
        failures++;
        lastError = err instanceof Error ? err.message : String(err);
        if (failures === 1 || failures % LOG_EVERY_FAILURES === 0) {
          if (isTransientError(err)) log.warn({ err, failures }, 'tick failed; retrying next tick');
          else log.error({ err, failures }, 'tick failed');
        }
      }
    })();
    inFlight = { startedAt, done };
    void done.then(() => {
      inFlight = undefined;
      if (stopped) return;
      if (again) {
        again = false;
        schedule(0);
      } else {
        schedule(Math.max(0, spec.everyMs - (Date.now() - startedAt)));
      }
    });
  };

  return {
    name: spec.name,
    start() {
      if (!stopped || abort.signal.aborted) return;
      stopped = false;
      schedule(0);
    },
    wake() {
      if (stopped) return;
      if (inFlight !== undefined) {
        again = true;
      } else if (timer !== undefined) {
        clearTimeout(timer);
        schedule(0);
      }
    },
    async stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      abort.abort();
      await inFlight?.done;
    },
    health(now = Date.now()) {
      // A tick in flight counts while it is young, unless the previous one failed: a long full rebuild is
      // healthy, a loop that fails fast on every tick is not.
      const recentOk = lastOkAt !== undefined && now - lastOkAt <= staleAfterMs;
      const youngTick = inFlight !== undefined && failures === 0 && now - inFlight.startedAt <= staleAfterMs;
      return {
        name: spec.name,
        healthy: !stopped && (recentOk || youngTick),
        lastOkAt: lastOkAt === undefined ? null : new Date(lastOkAt).toISOString(),
        consecutiveFailures: failures,
        lastError: lastError ?? null,
      };
    },
  };
}

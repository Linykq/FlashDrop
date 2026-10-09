import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeAll,
  dependencyCheck,
  failedChecks,
  installGracefulShutdown,
  postgresCheck,
  withTimeout,
} from './runtime';

afterEach(() => {
  vi.useRealTimers();
});

const log = () => ({ warn: vi.fn(), error: vi.fn() });

describe('withTimeout', () => {
  it('passes the answer or the failure of a promise that settles in time', async () => {
    await expect(withTimeout(Promise.resolve(7), 100, () => new Error('late'))).resolves.toBe(7);
    const failure = new Error('refused');
    await expect(withTimeout(Promise.reject(failure), 100, () => new Error('late'))).rejects.toBe(failure);
  });

  it("rejects with the caller's error once the time is up, and a later rejection is not unhandled", async () => {
    vi.useFakeTimers();
    const late = Promise.withResolvers<never>();
    class Late extends Error {}
    const outcome = expect(
      withTimeout(late.promise, 1_000, () => new Late('no answer')),
    ).rejects.toBeInstanceOf(Late);
    await vi.advanceTimersByTimeAsync(1_000);
    await outcome;
    late.reject(new Error('after the deadline'));
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('dependency checks', () => {
  it('runs SELECT 1, passing a failure on and giving up after the timeout instead of hanging the probe', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await expect(postgresCheck({ query })()).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledWith('SELECT 1');
    const refused = new Error('connect ECONNREFUSED');
    await expect(postgresCheck({ query: () => Promise.reject(refused) })()).rejects.toBe(refused);

    vi.useFakeTimers();
    const pending = dependencyCheck('redis', () => new Promise(() => undefined), 1_500)();
    const outcome = expect(pending).rejects.toThrow('redis did not answer within 1500 ms');
    await vi.advanceTimersByTimeAsync(1_500);
    await outcome;
  });

  it('names and logs every check that failed, and nothing when all answer', async () => {
    const logger = log();
    const down = new Error('down');
    const failed = await failedChecks(
      {
        postgres: () => Promise.reject(down),
        redis: async () => undefined,
        kafka: () => Promise.reject(down),
      },
      logger,
    );
    expect(failed).toEqual(['postgres', 'kafka']);
    expect(logger.warn).toHaveBeenCalledWith({ err: down, check: 'postgres' }, 'readiness check failed');
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(await failedChecks({ redis: async () => undefined }, logger)).toEqual([]);
  });
});

describe('closeAll', () => {
  it('closes everything even when one fails, and logs each failure by name', async () => {
    const logger = log();
    const closed: string[] = [];
    const broken = new Error('pool already ended');
    const result = await closeAll(logger, {
      pool: () => Promise.reject(broken),
      redis: async () => {
        closed.push('redis');
      },
      thrower: () => {
        throw new Error('synchronous');
      },
    });
    expect(result).toBe(false);
    expect(closed).toEqual(['redis']);
    expect(logger.error).toHaveBeenCalledWith({ err: broken, resource: 'pool' }, 'close failed');
    expect(logger.error).toHaveBeenCalledWith(
      { err: expect.objectContaining({ message: 'synchronous' }), resource: 'thrower' },
      'close failed',
    );
    expect(await closeAll(logger, { redis: async () => undefined })).toBe(true);
  });
});

describe('installGracefulShutdown', () => {
  /** Signal listeners this test added, removed afterwards so no other test (or Vitest) sees them. */
  function signalListeners() {
    const before = { SIGTERM: process.listeners('SIGTERM'), SIGINT: process.listeners('SIGINT') };
    return () => {
      for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        for (const listener of process.listeners(signal)) {
          if (!before[signal].includes(listener)) process.removeListener(signal, listener);
        }
      }
    };
  }

  it('closes once on a signal or a failed start, whichever comes first, and exits 1 if the close fails', async () => {
    const cleanup = signalListeners();
    const exitCode = process.exitCode;
    try {
      const logger = { info: vi.fn(), error: vi.fn() };
      const failure = new Error('pool would not end');
      const close = vi.fn(async () => {
        throw failure;
      });
      const shutdown = installGracefulShutdown({ logger, close });
      process.emit('SIGTERM', 'SIGTERM');
      await shutdown('startup failed');
      expect(close).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith({ reason: 'SIGTERM' }, 'shutting down');
      expect(logger.error).toHaveBeenCalledWith({ err: failure }, 'shutdown failed');
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = exitCode;
      cleanup();
    }
  });

  it('exits 1 with its own log line when the close outlives the timeout', async () => {
    const cleanup = signalListeners();
    vi.useFakeTimers();
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    try {
      const logger = { info: vi.fn(), error: vi.fn() };
      void installGracefulShutdown({ logger, close: () => new Promise(() => undefined), timeoutMs: 8_000 })(
        'SIGINT',
      );
      await vi.advanceTimersByTimeAsync(8_000);
      expect(logger.error).toHaveBeenCalledWith({ timeoutMs: 8_000 }, 'shutdown timed out');
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      exit.mockRestore();
      cleanup();
    }
  });
});

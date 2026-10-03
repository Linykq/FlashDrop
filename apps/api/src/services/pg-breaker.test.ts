import { HotRowBusyError } from '@flashdrop/db';
import { describe, expect, it, vi } from 'vitest';
import { createPgBreaker } from './pg-breaker';

const lost = () => Promise.reject(new Error('Connection terminated unexpectedly'));

function setup(probe: () => Promise<void> = async () => undefined) {
  let clock = 0;
  const log = () =>
    vi.fn((_context: Readonly<Record<string, unknown>> | string, _message?: string) => undefined);
  const logger = { warn: log(), error: log(), info: log() };
  const probeSpy = vi.fn(probe);
  const breaker = createPgBreaker({
    probe: probeSpy,
    logger,
    failureThreshold: 3,
    probeIntervalMs: 1_000,
    alertIntervalMs: 60_000,
    now: () => clock,
  });
  const fail = () => expect(breaker.run(lost)).rejects.toThrow('Connection terminated');
  const open = async () => {
    for (let i = 0; i < 3; i++) await fail();
    expect(breaker.healthy()).toBe(false);
  };
  /** Opens, then lets one probe close it. */
  const openAndRecover = async () => {
    await open();
    clock += 1_000;
    breaker.healthy();
    await vi.waitFor(() => expect(breaker.healthy()).toBe(true));
  };
  /** A call that settles only when told to. */
  const pending = <T>() => {
    const deferred = Promise.withResolvers<T>();
    return { run: breaker.run(() => deferred.promise), ...deferred };
  };
  return {
    breaker,
    logger,
    probeSpy,
    fail,
    open,
    openAndRecover,
    pending,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

describe('createPgBreaker', () => {
  it('opens after three consecutive failures that say Postgres is unavailable', async () => {
    const { breaker, fail } = setup();
    await fail();
    await fail();
    expect(breaker.healthy()).toBe(true);
    await fail();
    expect(breaker.healthy()).toBe(false);
  });

  it('never counts an error that is the request’s own fault, and a success resets the count', async () => {
    const { breaker, fail } = setup();
    for (let i = 0; i < 5; i++) {
      await expect(breaker.run(() => Promise.reject(new Error('unique violation')))).rejects.toThrow();
    }
    await fail();
    await fail();
    await expect(breaker.run(async () => 'ok')).resolves.toBe('ok');
    await fail();
    await fail();
    expect(breaker.healthy()).toBe(true);
  });

  // Regression: at a burst's opening against a healthy Postgres, the api's own pool ran dry and the hot
  // row queued past its statement timeout; the breaker opened 19 times in 250 ms and refused buyers.
  it('never opens on this service’s own contention: a full pool or the hot-row queue', async () => {
    const { breaker } = setup();
    const contention = [
      new Error('timeout exceeded when trying to connect'),
      new HotRowBusyError('busy', {
        cause: Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
      }),
    ];
    for (let i = 0; i < 10; i++) {
      const error = contention[i % contention.length];
      await expect(breaker.run(() => Promise.reject(error))).rejects.toBe(error);
    }
    expect(breaker.healthy()).toBe(true);
  });

  it('probes at most once per interval while open, and closes when the probe answers', async () => {
    const { promise: answered, resolve } = Promise.withResolvers<void>();
    const { breaker, open, probeSpy, tick } = setup(() => answered);
    await open();

    expect(probeSpy).not.toHaveBeenCalled();
    tick(1_000);
    expect(breaker.healthy()).toBe(false);
    expect(breaker.healthy()).toBe(false);
    expect(probeSpy).toHaveBeenCalledTimes(1);

    resolve();
    await vi.waitFor(() => expect(breaker.healthy()).toBe(true));
  });

  it('stays open while the probe fails, and tries again an interval later', async () => {
    const { breaker, open, probeSpy, tick } = setup(lost);
    await open();
    tick(1_000);
    expect(breaker.healthy()).toBe(false);
    expect(probeSpy).toHaveBeenCalledTimes(1);
    await new Promise((settled) => setTimeout(settled, 0)); // the failed probe settles
    expect(breaker.healthy()).toBe(false);
    expect(probeSpy).toHaveBeenCalledTimes(1);
    tick(1_000);
    breaker.healthy();
    expect(probeSpy).toHaveBeenCalledTimes(2);
  });

  // Regression: run() closed the breaker on any success, so a reserve admitted before it opened closed it
  // again within milliseconds, and real traffic served as the probe.
  it('stays open when a call admitted before it opened succeeds', async () => {
    const { breaker, open, pending, probeSpy } = setup();
    const early = pending<string>();
    await open();

    early.resolve('ok');
    await expect(early.run).resolves.toBe('ok');
    expect(breaker.healthy()).toBe(false);
    expect(probeSpy).not.toHaveBeenCalled();
  });

  it('does not reopen on failures of calls admitted before the probe closed it', async () => {
    const { breaker, openAndRecover, pending } = setup();
    const stale = [pending<never>(), pending<never>(), pending<never>()];
    await openAndRecover();

    for (const call of stale) {
      call.reject(new Error('Connection terminated unexpectedly'));
      await expect(call.run).rejects.toThrow();
    }
    expect(breaker.healthy()).toBe(true);
  });

  it('alerts once per open episode at most once a minute, and only warns about a reopening in between', async () => {
    const { breaker, logger, open, openAndRecover, tick } = setup();
    const alerts = () =>
      logger.error.mock.calls.filter(
        ([context]) => typeof context === 'object' && context.alertName === 'pg_breaker_open',
      );

    await openAndRecover();
    await openAndRecover();
    await open();
    expect(alerts()).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('unavailable again'));

    tick(60_000);
    breaker.healthy(); // starts the probe that closes it
    await vi.waitFor(() => expect(breaker.healthy()).toBe(true));
    await open();
    expect(alerts()).toHaveLength(2);
  });
});

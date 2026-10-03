import { createLogger } from '@flashdrop/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLoop, type LoopSpec } from './loop';

const lines: Record<string, unknown>[] = [];
const logger = createLogger(
  { name: 'loop-test', level: 'debug' },
  { write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) },
);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Node runs a 0 ms timer after 1 ms, so a tick may start a few ms after its slot. */
function expectStarts(starts: readonly number[], expected: readonly number[]) {
  expect(starts).toHaveLength(expected.length);
  starts.forEach((start, i) => {
    expect(start - (expected[i] ?? Number.NaN)).toBeGreaterThanOrEqual(0);
    expect(start - (expected[i] ?? Number.NaN)).toBeLessThanOrEqual(5);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
  lines.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

function recordingLoop(spec: Partial<LoopSpec> & { readonly workMs?: number }) {
  const starts: number[] = [];
  const loop = createLoop(
    {
      name: 'test',
      everyMs: 1_000,
      tick: async () => {
        starts.push(Date.now());
        await sleep(spec.workMs ?? 100);
      },
      ...spec,
    },
    logger,
  );
  return { loop, starts };
}

describe('createLoop', () => {
  it('ticks at once, then every interval measured from each start', async () => {
    const { loop, starts } = recordingLoop({ workMs: 300 });
    loop.start();
    await vi.advanceTimersByTimeAsync(2_500);
    expectStarts(starts, [0, 1_000, 2_000]);
    await loop.stop();
  });

  it('never overlaps a tick that outlasts the interval', async () => {
    const { loop, starts } = recordingLoop({ workMs: 2_500 });
    loop.start();
    await vi.advanceTimersByTimeAsync(6_000);
    expectStarts(starts, [0, 2_500, 5_000]);
    // stop() waits for the tick in flight, which needs the fake clock to finish.
    const stopped = loop.stop();
    await vi.advanceTimersByTimeAsync(2_500);
    await stopped;
  });

  it('runs a woken tick at once, and coalesces wake-ups during a tick into one more', async () => {
    const { loop, starts } = recordingLoop({ everyMs: 10_000, workMs: 500 });
    loop.start();
    await vi.advanceTimersByTimeAsync(1_000);
    loop.wake();
    await vi.advanceTimersByTimeAsync(100);
    loop.wake();
    loop.wake();
    loop.wake();
    await vi.advanceTimersByTimeAsync(2_000);
    expectStarts(starts, [0, 1_000, 1_500]);
    await loop.stop();
  });

  it('stops: aborts the tick in flight, waits for it, and ticks no more', async () => {
    let aborted = false;
    const { loop, starts } = recordingLoop({
      tick: async (signal) => {
        starts.push(Date.now());
        await sleep(400);
        aborted = signal.aborted;
      },
    });
    loop.start();
    await vi.advanceTimersByTimeAsync(100);
    const stopped = loop.stop();
    await vi.advanceTimersByTimeAsync(400);
    await stopped;
    expect(aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(starts).toEqual([0]);
    expect(loop.health().healthy).toBe(false);
  });

  it('is healthy while ticks complete, and unhealthy once they keep failing', async () => {
    let fail = false;
    const loop = createLoop(
      {
        name: 'flaky',
        everyMs: 1_000,
        tick: async () => {
          if (fail) throw new Error('postgres is down');
        },
      },
      logger,
    );
    expect(loop.health().healthy).toBe(false);
    loop.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(loop.health()).toMatchObject({ healthy: true, lastOkAt: new Date(0).toISOString() });

    fail = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(loop.health()).toMatchObject({
      healthy: true,
      consecutiveFailures: 10,
      lastError: 'postgres is down',
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(loop.health().healthy).toBe(false);
    // One line for the first failure, none for the next 18.
    expect(lines.filter((line) => line.msg === 'tick failed')).toHaveLength(1);

    fail = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(loop.health()).toMatchObject({ healthy: true, consecutiveFailures: 0, lastError: null });
    await loop.stop();
  });
});

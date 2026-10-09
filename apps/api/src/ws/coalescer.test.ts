import { topicOf } from '@flashdrop/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCoalescer, type Frame, isNewer, type Level } from './coalescer';

const STOCK = topicOf('stock', '5eed0004-0000-4000-8000-000000000001');
const OTHER = topicOf('stock', '5eed0004-0000-4000-8000-000000000002');

const level = (gen: number, seq: number, avail = 100 - seq): Level => ({
  gen,
  seq,
  ts: 1_000 + seq,
  data: { avail },
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('isNewer', () => {
  it('orders (gen, seq) lexicographically; anything beats nothing', () => {
    expect(isNewer(level(1, 0), undefined)).toBe(true);
    expect(isNewer(level(1, 5), level(1, 4))).toBe(true);
    expect(isNewer(level(2, 0), level(1, 999))).toBe(true);
    expect(isNewer(level(1, 4), level(1, 4))).toBe(false);
    expect(isNewer(level(1, 9), level(2, 0))).toBe(false);
  });
});

describe('createCoalescer (§7 burst coalescing)', () => {
  function setup(deliver: (frame: Frame) => boolean = () => true) {
    const frames: Frame[] = [];
    const coalescer = createCoalescer({
      intervalMs: 100,
      deliver: (frame) => {
        frames.push(frame);
        return deliver(frame);
      },
    });
    coalescer.start();
    return { coalescer, frames };
  }

  it('sends one frame per tick with the newest level of a burst, timed by its oldest change', async () => {
    const { coalescer, frames } = setup();
    for (let seq = 1; seq <= 50; seq += 1) coalescer.offer(STOCK, level(1, seq));

    await vi.advanceTimersByTimeAsync(99);
    expect(frames).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(frames).toHaveLength(1);
    expect(JSON.parse(frames[0]?.json ?? '')).toEqual({
      type: 'delta',
      topic: STOCK,
      gen: 1,
      seq: 50,
      ts: 1_001,
      data: { avail: 50 },
    });

    // Nothing new: no frame.
    await vi.advanceTimersByTimeAsync(500);
    expect(frames).toHaveLength(1);
  });

  it('times each frame by the oldest change it carries, so propagation counts the coalescing wait', async () => {
    let accept = true;
    const { coalescer, frames } = setup(() => accept);
    const ts = () => frames.map((frame) => JSON.parse(frame.json).ts);
    coalescer.offer(STOCK, level(1, 1));
    coalescer.offer(STOCK, level(1, 2));
    await vi.advanceTimersByTimeAsync(100);
    expect(ts()).toEqual([1_001]);

    // Delivered completely: the next frame starts afresh from its own first change.
    coalescer.offer(STOCK, level(1, 3));
    coalescer.offer(STOCK, level(1, 4));
    await vi.advanceTimersByTimeAsync(100);
    expect(ts()).toEqual([1_001, 1_003]);

    // A socket skipped the frame: the topic stays dirty, and its next frame still counts from change 5.
    accept = false;
    coalescer.offer(STOCK, level(1, 5));
    await vi.advanceTimersByTimeAsync(100);
    accept = true;
    coalescer.offer(STOCK, level(1, 6));
    await vi.advanceTimersByTimeAsync(100);
    expect(ts()).toEqual([1_001, 1_003, 1_005, 1_005]);
    expect(frames.at(-1)?.level.seq).toBe(6);
  });

  it('ignores levels that are not strictly newer, a rebuild generation wins over any seq', async () => {
    const { coalescer, frames } = setup();
    expect(coalescer.offer(STOCK, level(2, 7))).toBe(true);
    expect(coalescer.offer(STOCK, level(2, 7))).toBe(false);
    expect(coalescer.offer(STOCK, level(1, 900))).toBe(false);
    expect(coalescer.offer(STOCK, level(3, 0))).toBe(true);

    await vi.advanceTimersByTimeAsync(100);
    expect(frames.map((frame) => [frame.level.gen, frame.level.seq])).toEqual([[3, 0]]);
    expect(coalescer.latest(STOCK)).toEqual(level(3, 0));
  });

  it('serializes each topic once per level, not per delivery attempt', async () => {
    const stringify = vi.spyOn(JSON, 'stringify');
    let accept = false;
    const { coalescer, frames } = setup(() => accept);
    coalescer.offer(STOCK, level(1, 1));
    coalescer.offer(OTHER, level(1, 1));

    // Refused twice (a backpressured socket): offered again on every tick, with the same string.
    await vi.advanceTimersByTimeAsync(200);
    expect(frames).toHaveLength(4);
    expect(stringify).toHaveBeenCalledTimes(2);
    expect(frames[2]?.json).toBe(frames[0]?.json);

    accept = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(frames).toHaveLength(6);
    await vi.advanceTimersByTimeAsync(300);
    expect(frames).toHaveLength(6);
    expect(stringify).toHaveBeenCalledTimes(2);
  });

  it('forgets a topic: its dirty level is dropped and a later level starts afresh', async () => {
    const { coalescer, frames } = setup();
    coalescer.offer(STOCK, level(1, 9));
    coalescer.forget(STOCK);
    await vi.advanceTimersByTimeAsync(100);
    expect(frames).toEqual([]);
    expect(coalescer.offer(STOCK, level(1, 1))).toBe(true);
  });

  it('stops ticking when stopped', async () => {
    const { coalescer, frames } = setup();
    coalescer.offer(STOCK, level(1, 1));
    coalescer.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(frames).toEqual([]);
    coalescer.flush();
    expect(frames).toHaveLength(1);
  });
});

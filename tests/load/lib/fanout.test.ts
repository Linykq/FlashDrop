import { describe, expect, it } from 'vitest';
import {
  changesSince,
  compareVersions,
  createRateMeter,
  FRAME_WINDOW_MS,
  isConserved,
  isPinned,
  isSettled,
  judgeFinal,
  type Level,
  parseFrame,
} from './fanout';

const DROP = '0192f0a1-7c3e-7a10-9b5d-1c2e3f405162';
const TOPIC = `stock:${DROP}`;
const level = (over: Partial<Level> = {}): Level => ({
  gen: 3,
  seq: 10,
  avail: 90,
  held: 10,
  sold: 0,
  status: 'LIVE',
  ...over,
});
const data = { status: 'LIVE', avail: 90, held: 10, sold: 0 };

describe('parseFrame', () => {
  it('reads hello, snapshot, delta and topic errors', () => {
    expect(parseFrame('{"type":"hello","instanceId":"api-1-ab12cd","serverTime":1}', TOPIC)).toEqual({
      kind: 'hello',
      instanceId: 'api-1-ab12cd',
    });
    expect(
      parseFrame(JSON.stringify({ type: 'snapshot', topic: TOPIC, gen: 3, seq: 10, data }), TOPIC),
    ).toEqual({
      kind: 'snapshot',
      level: level(),
    });
    expect(
      parseFrame(
        JSON.stringify({ type: 'delta', topic: TOPIC, gen: 3, seq: 11, ts: 1_700_000_000_123, data }),
        TOPIC,
      ),
    ).toEqual({ kind: 'delta', level: level({ seq: 11 }), ts: 1_700_000_000_123 });
    expect(
      parseFrame(JSON.stringify({ type: 'error', code: 'TOO_MANY_TOPICS', topics: [TOPIC] }), TOPIC),
    ).toEqual({
      kind: 'topic-error',
      code: 'TOO_MANY_TOPICS',
    });
  });

  it('accepts the fail-closed generation -1', () => {
    const frame = parseFrame(
      JSON.stringify({ type: 'snapshot', topic: TOPIC, gen: -1, seq: 0, data }),
      TOPIC,
    );
    expect(frame).toEqual({ kind: 'snapshot', level: level({ gen: -1, seq: 0 }) });
  });

  it.each([
    ['not JSON', 'nope'],
    ['an array', '[1]'],
    ['a hello without an instance', '{"type":"hello"}'],
    ['another topic', JSON.stringify({ type: 'delta', topic: 'stock:other', gen: 3, seq: 1, ts: 1, data })],
    ['a negative seq', JSON.stringify({ type: 'snapshot', topic: TOPIC, gen: 3, seq: -1, data })],
    [
      'a fractional count',
      JSON.stringify({ type: 'snapshot', topic: TOPIC, gen: 3, seq: 1, data: { ...data, avail: 1.5 } }),
    ],
    ['no data', JSON.stringify({ type: 'snapshot', topic: TOPIC, gen: 3, seq: 1 })],
    ['a delta without ts', JSON.stringify({ type: 'delta', topic: TOPIC, gen: 3, seq: 1, data })],
    ['an owner event on an anonymous socket', '{"type":"order","orderId":"x","status":"PAID","version":2}'],
  ])('flags %s as malformed', (_name, text) => {
    expect(parseFrame(text, TOPIC).kind).toBe('malformed');
  });
});

describe('versions and levels', () => {
  it('orders (gen, seq) lexicographically', () => {
    expect(compareVersions(level({ seq: 11 }), level())).toBeGreaterThan(0);
    expect(compareVersions(level({ gen: 4, seq: 0 }), level())).toBeGreaterThan(0);
    expect(compareVersions(level({ gen: 2, seq: 99 }), level())).toBeLessThan(0);
    expect(compareVersions(level(), level())).toBe(0);
  });

  it('checks conservation and settlement against the drop size', () => {
    expect(isConserved(level(), 100)).toBe(true);
    expect(isConserved(level({ held: 11 }), 100)).toBe(false);
    expect(isSettled(level(), 100)).toBe(false);
    expect(isSettled(level({ avail: 97, held: 0, sold: 3 }), 100)).toBe(true);
  });
});

describe('changesSince', () => {
  it('counts the seq advance within a generation, one for a rebuild, none for the first level', () => {
    expect(changesSince(undefined, level())).toBe(0);
    expect(changesSince(level(), level({ seq: 17 }))).toBe(7);
    expect(changesSince(level(), level({ gen: 4, seq: 0 }))).toBe(1);
  });
});

describe('createRateMeter', () => {
  it('counts frames and changes per whole second and keeps the busiest', () => {
    const meter = createRateMeter();
    meter.record(4_950, 3);
    // Ten ticks in second 5, each folding 12 changes, then one that left late crossing in at its end.
    for (let tick = 0; tick < 10; tick += 1) meter.record(5_001 + tick * 100, 12);
    expect(meter.peakFrames()).toBe(10);
    expect(meter.peakChanges()).toBe(120);
    meter.record(5_999, 1);
    expect(meter.peakFrames()).toBe(11);
    expect(meter.peakChanges()).toBe(121);
    meter.record(6_000, 500);
    expect(meter.peakFrames()).toBe(11);
    expect(meter.peakChanges()).toBe(500);
  });

  it('peaks at 0 without frames', () => {
    const meter = createRateMeter();
    expect([meter.peakFrames(), meter.peakChanges(), meter.peakWindowFrames()]).toEqual([0, 0, 0]);
  });

  // The gate's regression: k6 stalling 200 ms at a second's boundary bunches ticks the gateway sent 100 ms
  // apart into the next second (12 in one second, over the old cap of 11), while any 2 s hold 20 ticks and
  // the two a stall of that length moves in: within ws-fanout's cap of 23, far below a writer of every change.
  it('keeps client-side bunching within the 2 s window that a writer of every change exceeds', () => {
    const coalesced = createRateMeter();
    for (let tick = 0; tick < 40; tick += 1) {
      const sent = 10_000 + tick * 100;
      // Ticks 8 and 9 of second 10 reach k6 together with tick 10, at its start.
      coalesced.record(sent >= 10_800 && sent < 11_000 ? 11_000 : sent, 5);
    }
    expect(coalesced.peakFrames()).toBe(12);
    expect(coalesced.peakWindowFrames()).toBe(22);

    // 50 changes a second, one frame each.
    const uncoalesced = createRateMeter();
    for (let change = 0; change < 200; change += 1) uncoalesced.record(10_000 + change * 20, 1);
    expect(uncoalesced.peakWindowFrames()).toBe(100);
  });

  it('counts a frame exactly the window length older as outside it', () => {
    const meter = createRateMeter();
    meter.record(0, 1);
    meter.record(FRAME_WINDOW_MS, 1);
    expect(meter.peakWindowFrames()).toBe(1);
    meter.record(FRAME_WINDOW_MS + 1, 1);
    expect(meter.peakWindowFrames()).toBe(2);
  });
});

describe('judgeFinal', () => {
  it('matches the same version and counts', () => {
    expect(judgeFinal(level(), level())).toBe('match');
  });

  it('is behind without a level or with an older one, ahead with a newer one', () => {
    expect(judgeFinal(undefined, level())).toBe('behind');
    expect(judgeFinal(level({ seq: 9 }), level())).toBe('behind');
    expect(judgeFinal(level({ seq: 11 }), level())).toBe('ahead');
  });

  it('flags the same version with other counts or status', () => {
    expect(judgeFinal(level({ avail: 89, held: 11 }), level())).toBe('differs');
    expect(judgeFinal(level({ status: 'PAUSED' }), level())).toBe('differs');
  });
});

describe('isPinned', () => {
  const hello = (url: string, instanceId: string) => ({ url, instanceId });

  it('holds when each URL met one instance and the URLs met different ones', () => {
    expect(isPinned([hello('/ws/1', 'a'), hello('/ws/2', 'b'), hello('/ws/1', 'a')])).toBe(true);
  });

  it('fails when a URL met two instances or two URLs met the same one', () => {
    expect(isPinned([hello('/ws/1', 'a'), hello('/ws/1', 'b'), hello('/ws/2', 'c')])).toBe(false);
    expect(isPinned([hello('/ws/1', 'a'), hello('/ws/2', 'a')])).toBe(false);
  });
});

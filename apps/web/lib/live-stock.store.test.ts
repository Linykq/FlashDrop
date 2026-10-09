import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  holdStockAnnouncements,
  type LiveLevel,
  liveStockOf,
  refreshLiveStock,
  subscribeLiveStock,
} from './live-stock';
import { REALTIME_TIMING, RealtimeClient, type SocketHandlers } from './realtime/client';
import { topicOf } from './realtime/protocol';

/*
 * The live stock store over a real `RealtimeClient` with a scripted socket: SSR seeding, (gen, seq) gating,
 * the paused fallback to polling, and the quiet levels of the buyer's own press.
 */

let client: RealtimeClient;
vi.mock('./realtime/browser', () => ({ realtime: () => client }));

type Script = { handlers: SocketHandlers; sent: string[] };
let sockets: Script[];
let polls: string[];
let pollAnswer: unknown;

const SEED: LiveLevel = { status: 'LIVE', avail: 12, held: 0, sold: 488, gen: 2, seq: 40 };

function socket(): Script {
  const last = sockets.at(-1);
  if (last === undefined) throw new Error('no socket');
  return last;
}

function frame(dropId: string, seq: number, avail: number, extra: Record<string, unknown> = {}) {
  socket().handlers.onMessage(
    JSON.stringify({
      type: 'delta',
      topic: topicOf('stock', dropId),
      gen: 2,
      seq,
      ts: 1,
      data: { avail, held: 0, sold: 500 - avail, status: 'LIVE', ...extra },
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
  sockets = [];
  polls = [];
  pollAnswer = { ...SEED, seq: 99, avail: 7, sold: 493, serverNow: '2026-10-02T12:00:00.000Z' };
  vi.stubGlobal('document', { hidden: false, addEventListener: () => {}, removeEventListener: () => {} });
  vi.stubGlobal('reportError', () => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      polls.push(url);
      return Response.json(pollAnswer);
    }),
  );
  client = new RealtimeClient({
    url: () => 'ws://test/ws',
    createSocket: (_url, handlers) => {
      const script: Script = { handlers, sent: [] };
      sockets.push(script);
      return { send: (data) => script.sent.push(data), close: () => {} };
    },
    onServerTime: () => {},
    onNetwork: () => () => {},
    report: () => {},
    random: () => 1,
    now: () => Date.now(),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('live stock store', () => {
  it('starts from the SSR seed and applies only strictly newer frames', () => {
    const dropId = randomUUID();
    const stop = subscribeLiveStock(dropId, SEED, () => {});
    socket().handlers.onOpen();
    frame(dropId, 40, 1);
    expect(liveStockOf(dropId)?.level.avail).toBe(12);
    frame(dropId, 41, 11);
    expect(liveStockOf(dropId)?.level).toMatchObject({ avail: 11, seq: 41 });
    frame(dropId, 39, 30);
    expect(liveStockOf(dropId)?.level.avail).toBe(11);
    stop();
  });

  it('keeps the last good level while the drop is being rebuilt', () => {
    const dropId = randomUUID();
    const stop = subscribeLiveStock(dropId, SEED, () => {});
    socket().handlers.onOpen();
    frame(dropId, 50, 0, { status: 'RECONCILING' });
    expect(liveStockOf(dropId)?.level).toMatchObject({ avail: 12, status: 'LIVE' });
    stop();
  });

  it('pauses after 5 s without a socket, polls every 3 s, and stops when the socket is back', async () => {
    const dropId = randomUUID();
    const stop = subscribeLiveStock(dropId, SEED, () => {});
    socket().handlers.onClose(1006);
    // The first poll goes at once: 1 ms, as fake timers schedule a 0 ms timer set while they run.
    await vi.advanceTimersByTimeAsync(REALTIME_TIMING.pausedAfterMs + 1);
    expect(liveStockOf(dropId)?.paused).toBe(true);
    expect(polls).toEqual([`/api/v1/drops/${dropId}/stock`]);
    expect(liveStockOf(dropId)?.level).toMatchObject({ avail: 7, seq: 99 });

    await vi.advanceTimersByTimeAsync(3_500);
    expect(polls).toHaveLength(2);

    socket().handlers.onOpen();
    expect(liveStockOf(dropId)?.paused).toBe(false);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(polls).toHaveLength(2);
    stop();
  });

  it('polls once when the gateway sends no snapshot within 5 s', async () => {
    const dropId = randomUUID();
    const stop = subscribeLiveStock(dropId, SEED, () => {});
    socket().handlers.onOpen();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(polls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(polls).toHaveLength(1);
    stop();
  });

  it("marks the levels of the buyer's own press quiet, and its refresh too", async () => {
    const dropId = randomUUID();
    const stop = subscribeLiveStock(dropId, SEED, () => {});
    socket().handlers.onOpen();
    const release = holdStockAnnouncements(dropId);
    frame(dropId, 41, 11);
    expect(liveStockOf(dropId)).toMatchObject({ quiet: true, level: { avail: 11 } });
    release();
    frame(dropId, 42, 10);
    expect(liveStockOf(dropId)).toMatchObject({ quiet: false, level: { avail: 10 } });

    await refreshLiveStock(dropId);
    expect(liveStockOf(dropId)).toMatchObject({ quiet: true, level: { avail: 7, seq: 99 } });
    stop();
  });

  it('subscribes the topic once for every island showing the drop', () => {
    const dropId = randomUUID();
    const first = subscribeLiveStock(dropId, SEED, () => {});
    const second = subscribeLiveStock(dropId, SEED, () => {});
    socket().handlers.onOpen();
    expect(socket().sent).toEqual([JSON.stringify({ type: 'sub', topics: [topicOf('stock', dropId)] })]);
    first();
    second();
  });
});

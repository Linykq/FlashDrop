import type { ClientMessage, Topic } from '@flashdrop/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type LevelFrame, REALTIME_TIMING, RealtimeClient, type SocketHandlers } from './client';
import { topicOf } from './protocol';

const DROP = '5eed0004-0000-4000-8000-000000000001';
const OTHER = '5eed0004-0000-4000-8000-000000000002';
const STOCK = topicOf('stock', DROP);
const OTHER_STOCK = topicOf('stock', OTHER);

class FakeSocket {
  readonly sent: ClientMessage[] = [];
  readonly url: string;
  readonly handlers: SocketHandlers;
  closed: { code: number; reason: string } | null = null;
  constructor(url: string, handlers: SocketHandlers) {
    this.url = url;
    this.handlers = handlers;
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as ClientMessage);
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
  open(): void {
    this.handlers.onOpen();
  }
  receive(frame: unknown): void {
    this.handlers.onMessage(JSON.stringify(frame));
  }
  drop(code = 1006): void {
    this.handlers.onClose(code);
  }
}

let sockets: FakeSocket[];
let reports: Error[];
let serverTimes: [number, number, number][];
let network: ((online: boolean) => void) | undefined;
let random: number;

function makeClient(): RealtimeClient {
  return new RealtimeClient({
    url: () => `ws://127.0.0.1:8080/ws?n=${sockets.length}`,
    createSocket: (url, handlers) => {
      const socket = new FakeSocket(url, handlers);
      sockets.push(socket);
      return socket;
    },
    onServerTime: (...reading) => serverTimes.push(reading),
    onNetwork: (listener) => {
      network = listener;
      return () => {
        network = undefined;
      };
    },
    report: (error) => reports.push(error),
    random: () => random,
    now: () => Date.now(),
  });
}

function last(): FakeSocket {
  const socket = sockets.at(-1);
  if (socket === undefined) throw new Error('no socket');
  return socket;
}

const snapshot = (topic: Topic, seq: number, avail = 10) => ({
  type: 'snapshot',
  topic,
  gen: 1,
  seq,
  data: { avail, held: 0, sold: 0, status: 'LIVE' },
});

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
  sockets = [];
  reports = [];
  serverTimes = [];
  network = undefined;
  random = 1;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('RealtimeClient', () => {
  it('opens one socket for many topics and subscribes them in one message', async () => {
    const client = makeClient();
    client.subscribe(STOCK, () => {});
    client.subscribe(OTHER_STOCK, () => {});
    expect(sockets).toHaveLength(1);
    last().open();
    expect(last().sent).toEqual([{ type: 'sub', topics: [STOCK, OTHER_STOCK] }]);
    expect(client.status()).toEqual({ connected: true, paused: false, instanceId: null });
  });

  it('records hello: the instance, and the server clock with the connect round trip', () => {
    const client = makeClient();
    client.subscribe(STOCK, () => {});
    vi.advanceTimersByTime(40);
    last().open();
    last().receive({ type: 'hello', instanceId: 'api-1-abc', serverTime: 2_000_000 });
    expect(client.status().instanceId).toBe('api-1-abc');
    expect(serverTimes).toEqual([[2_000_000, 1_000_000, 1_000_040]]);
  });

  it('delivers every frame to listeners, keeps the newest as the latest, and hands it to late subscribers', async () => {
    const client = makeClient();
    const seen: LevelFrame[] = [];
    client.subscribe(STOCK, (frame) => seen.push(frame));
    last().open();
    last().receive(snapshot(STOCK, 5));
    last().receive({ ...snapshot(STOCK, 4), type: 'delta', ts: 999 });
    expect(seen.map((frame) => [frame.kind, frame.seq])).toEqual([
      ['snapshot', 5],
      ['delta', 4],
    ]);
    expect(client.latest(STOCK)?.seq).toBe(5);

    const late: LevelFrame[] = [];
    client.subscribe(STOCK, (frame) => late.push(frame));
    await Promise.resolve();
    expect(late.map((frame) => frame.seq)).toEqual([5]);
  });

  it('ignores frames for topics it does not hold and reports malformed ones', () => {
    const client = makeClient();
    const seen: LevelFrame[] = [];
    client.subscribe(STOCK, (frame) => seen.push(frame));
    last().open();
    last().receive(snapshot(OTHER_STOCK, 1));
    last().handlers.onMessage('not json');
    expect(seen).toEqual([]);
    expect(reports).toHaveLength(1);
  });

  it('batches later changes, and lingers before unsubscribing a topic nobody reads', () => {
    const client = makeClient();
    const stop = client.subscribe(STOCK, () => {});
    last().open();
    client.subscribe(OTHER_STOCK, () => {});
    expect(last().sent).toHaveLength(1);
    vi.advanceTimersByTime(REALTIME_TIMING.syncIntervalMs);
    expect(last().sent.at(-1)).toEqual({ type: 'sub', topics: [OTHER_STOCK] });

    stop();
    vi.advanceTimersByTime(REALTIME_TIMING.lingerMs - 1);
    // Back within the linger: nothing was sent.
    const again = client.subscribe(STOCK, () => {});
    vi.advanceTimersByTime(REALTIME_TIMING.lingerMs * 2);
    expect(last().sent).toHaveLength(2);

    again();
    vi.advanceTimersByTime(REALTIME_TIMING.lingerMs + REALTIME_TIMING.syncIntervalMs);
    expect(last().sent.at(-1)).toEqual({ type: 'unsub', topics: [STOCK] });
  });

  it('reconnects with full-jitter backoff up to 10 s and resubscribes everything', () => {
    const client = makeClient();
    client.subscribe(STOCK, () => {});
    last().open();
    last().drop();
    expect(client.status().connected).toBe(false);

    // random() = 1 takes the whole window: 0.5 s, 1 s, 2 s, ... capped at 10 s.
    const windows: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const before = sockets.length;
      let waited = 0;
      while (sockets.length === before) {
        vi.advanceTimersByTime(100);
        waited += 100;
      }
      windows.push(waited);
      last().drop();
    }
    expect(windows).toEqual([500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000]);

    vi.advanceTimersByTime(10_000);
    last().open();
    expect(last().sent).toEqual([{ type: 'sub', topics: [STOCK] }]);
  });

  it('draws each delay from the whole window (full jitter)', () => {
    const client = makeClient();
    client.subscribe(STOCK, () => {});
    random = 0.25;
    last().drop();
    vi.advanceTimersByTime(124);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
  });

  it('starts the backoff over once a socket stayed open for 5 s', () => {
    const client = makeClient();
    client.subscribe(STOCK, () => {});
    for (let attempt = 0; attempt < 3; attempt += 1) {
      last().drop();
      vi.advanceTimersByTime(10_000);
    }
    last().open();
    vi.advanceTimersByTime(REALTIME_TIMING.stableMs);
    last().drop();
    vi.advanceTimersByTime(499);
    const before = sockets.length;
    vi.advanceTimersByTime(1);
    expect(sockets.length).toBe(before + 1);
  });

  it('reports paused after 5 s without a socket, and resumes when one opens', () => {
    const client = makeClient();
    const changes: boolean[] = [];
    client.onStatus(() => changes.push(client.status().paused));
    client.subscribe(STOCK, () => {});
    vi.advanceTimersByTime(REALTIME_TIMING.pausedAfterMs - 1);
    expect(client.status().paused).toBe(false);
    vi.advanceTimersByTime(1);
    expect(client.status().paused).toBe(true);
    last().open();
    expect(client.status()).toMatchObject({ connected: true, paused: false });
    expect(changes).toEqual([true, false]);
  });

  it('reconnects at once when the browser comes back online', () => {
    const client = makeClient();
    client.subscribe(STOCK, () => {});
    random = 1;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      last().drop();
      vi.advanceTimersByTime(10_000);
    }
    last().drop();
    const before = sockets.length;
    network?.(true);
    expect(sockets.length).toBe(before + 1);
  });

  it('closes the socket when the browser goes offline, says paused after 5 s, and resyncs once back online', () => {
    const client = makeClient();
    const frames: LevelFrame[] = [];
    client.subscribe(STOCK, (frame) => frames.push(frame));
    const lost = last();
    lost.open();
    lost.receive(snapshot(STOCK, 1));

    network?.(false);
    expect(lost.closed).toEqual({ code: 1000, reason: 'offline' });
    expect(client.status().connected).toBe(false);
    // Its own close event comes later and changes nothing.
    lost.drop(1000);
    vi.advanceTimersByTime(REALTIME_TIMING.pausedAfterMs);
    expect(client.status().paused).toBe(true);
    // Attempts made while offline fail at once and back off.
    for (const socket of sockets.slice(1)) socket.drop();

    network?.(true);
    const back = last();
    expect(back).not.toBe(lost);
    back.open();
    expect(back.sent).toEqual([{ type: 'sub', topics: [STOCK] }]);
    back.receive(snapshot(STOCK, 2, 7));
    expect(client.status()).toMatchObject({ connected: true, paused: false });
    expect(frames.map((frame) => frame.seq)).toEqual([1, 2]);
  });

  it('forwards user events and keeps a socket for them alone', () => {
    const client = makeClient();
    const events: unknown[] = [];
    client.onUserEvent((event) => events.push(event));
    expect(sockets).toHaveLength(1);
    last().open();
    expect(last().sent).toEqual([]);
    const order = {
      type: 'order',
      orderId: '0192a9c2-7c1e-7d3a-8f00-3b4c5d6e7f80',
      status: 'PAID',
      version: 3,
    };
    last().receive(order);
    expect(events).toEqual([order]);
  });

  it('closes the socket after 10 s with nothing listening, and stops reconnecting at once when idle', () => {
    const client = makeClient();
    const stop = client.subscribe(STOCK, () => {});
    last().open();
    stop();
    vi.advanceTimersByTime(REALTIME_TIMING.lingerMs + REALTIME_TIMING.idleCloseMs);
    expect(last().closed).toEqual({ code: 1000, reason: 'idle' });
    expect(client.status()).toEqual({ connected: false, paused: false, instanceId: null });

    const next = client.subscribe(STOCK, () => {});
    expect(sockets).toHaveLength(2);
    next();
    last().drop();
    // The topic lingers, so reconnects go on until it is dropped; after that, none.
    vi.advanceTimersByTime(REALTIME_TIMING.lingerMs);
    const count = sockets.length;
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(count);
    expect(last().closed).not.toBeNull();
    expect(network).toBeUndefined();
  });

  it('never lets a replaced socket touch the state', () => {
    const client = makeClient();
    client.subscribe(STOCK, () => {});
    const first = last();
    first.drop();
    vi.advanceTimersByTime(1_000);
    last().open();
    first.handlers.onClose(1006);
    expect(client.status().connected).toBe(true);
  });

  it('replaces the socket at once when the session changes, and subscribes everything again on it', () => {
    const client = makeClient();
    const dash = topicOf('dash', DROP);
    const frames: LevelFrame[] = [];
    client.subscribe(STOCK, (frame) => frames.push(frame));
    client.subscribe(dash, () => {});
    // A backoff that grew: the replacement must not wait it out.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      last().drop();
      vi.advanceTimersByTime(10_000);
    }
    const old = last();
    old.open();
    old.receive({ type: 'error', code: 'FORBIDDEN', topics: [dash] });
    old.receive(snapshot(STOCK, 1));

    client.reconnect();
    expect(old.closed).toEqual({ code: 1000, reason: 'session changed' });
    expect(client.status().connected).toBe(false);
    const next = last();
    expect(next).not.toBe(old);
    // The old socket's own close event comes later and changes nothing.
    old.drop(1000);
    expect(sockets.at(-1)).toBe(next);

    next.open();
    // The refused topic is asked for again: the new session may be allowed it.
    expect(next.sent).toEqual([{ type: 'sub', topics: [STOCK, dash] }]);
    next.receive(snapshot(STOCK, 2));
    expect(frames.map((frame) => frame.seq)).toEqual([1, 2]);
    expect(client.latest(STOCK)?.seq).toBe(2);

    // A drop right after starts the backoff over: 0.5 s at most.
    next.drop();
    vi.advanceTimersByTime(REALTIME_TIMING.backoffBaseMs);
    expect(last()).not.toBe(next);
  });

  it('opens nothing for a session change while nothing listens', () => {
    const client = makeClient();
    client.reconnect();
    expect(sockets).toHaveLength(0);

    const stop = client.subscribe(STOCK, () => {});
    last().open();
    stop();
    vi.advanceTimersByTime(REALTIME_TIMING.lingerMs);
    // Lingering towards its idle close: the session change closes it instead of replacing it.
    client.reconnect();
    expect(last().closed).toEqual({ code: 1000, reason: 'idle' });
    expect(sockets).toHaveLength(1);
  });

  it('keeps refused topics counted, so they are not asked for again on that socket', () => {
    const client = makeClient();
    const dash = topicOf('dash', DROP);
    client.subscribe(dash, () => {});
    last().open();
    last().receive({ type: 'error', code: 'FORBIDDEN', topics: [dash] });
    client.subscribe(STOCK, () => {});
    vi.advanceTimersByTime(REALTIME_TIMING.syncIntervalMs);
    expect(last().sent).toEqual([
      { type: 'sub', topics: [dash] },
      { type: 'sub', topics: [STOCK] },
    ]);
    expect(reports).toHaveLength(1);
  });
});

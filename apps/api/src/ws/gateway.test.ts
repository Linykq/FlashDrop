import { EventEmitter } from 'node:events';
import { createLogger } from '@flashdrop/config';
import {
  type PinnedDrop,
  SALES_COUNTERS,
  ServerMessage,
  type Topic,
  topicOf,
  WS_CLOSE,
} from '@flashdrop/contracts';
import {
  dashboardChannel,
  type RedisStock,
  roomChannel,
  stockChannel,
  userChannel,
} from '@flashdrop/inventory';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { Principal } from './access';
import type { ChannelListener, PubSub } from './channels';
import type { TopicDirectory } from './directory';
import {
  type ClientInfo,
  createGateway,
  GATEWAY_LIMITS,
  type GatewayLimits,
  type GatewaySocket,
} from './gateway';
import type { ViewerStore } from './viewers';

const DROP = '5eed0004-0000-4000-8000-000000000001';
const ROOM = '5eed0002-0000-4000-8000-000000000001';
const BUYER = '5eed0001-0000-4000-8000-000000000002';
const OTHER_BUYER = '5eed0001-0000-4000-8000-000000000003';
const ADMIN = '5eed0001-0000-4000-8000-000000000001';
const ORDER = '1b4e28ba-2fa1-5ed2-883f-0e8a9b3c4d5e';
const STOCK = topicOf('stock', DROP);
const ROOM_TOPIC = topicOf('room', ROOM);
const DASH = topicOf('dash', DROP);

let anonymousSockets = 0;
/** As `principalOf` makes one: every anonymous socket has an id of its own. */
const anonymousPrincipal = (): Principal => ({ kind: 'anonymous', id: `anon:${++anonymousSockets}` });
const anonymous = anonymousPrincipal();
/** Sessions that outlive every test (the fake clock starts on 2026-10-09). */
const LATER = Date.parse('2027-01-01T00:00:00.000Z');
const buyer: Principal = { kind: 'user', userId: BUYER, role: 'buyer', expiresAt: LATER };
const otherBuyer: Principal = { kind: 'user', userId: OTHER_BUYER, role: 'buyer', expiresAt: LATER };
const admin: Principal = { kind: 'user', userId: ADMIN, role: 'admin', expiresAt: LATER };
const CLIENT: ClientInfo = { address: '203.0.113.7', beats: false };

/** A socket as the gateway sees it; every frame written to it must be a valid `ServerMessage`. */
class FakeSocket extends EventEmitter implements GatewaySocket {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  readonly frames: ServerMessage[] = [];
  closedWith: { code: number; reason: string } | undefined;
  pings = 0;
  terminated = false;

  send(data: string): void {
    this.frames.push(ServerMessage.parse(JSON.parse(data)));
  }
  ping(): void {
    this.pings += 1;
  }
  /** Like `ws`: the socket is closing at once and emits 'close' once the client answered, a bit later. */
  close(code: number, reason: string): void {
    this.closedWith = { code, reason };
    this.readyState = WebSocket.CLOSING;
    queueMicrotask(() => this.hangUp());
  }
  terminate(): void {
    this.terminated = true;
    this.hangUp();
  }
  /** The client sends a frame. */
  receive(message: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(message)), false);
  }
  hangUp(): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
  ofType<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.frames.filter((frame): frame is Extract<ServerMessage, { type: T }> => frame.type === type);
  }
}

/** The subscriber connection; SUBSCRIBEs can be held open to probe ordering, or fail. */
class FakePubSub implements PubSub {
  readonly listeners = new Map<string, ChannelListener>();
  readonly commands: string[] = [];
  /** The next SUBSCRIBEs fail, as node-redis fails one in flight when its connection drops. */
  failSubscribes = 0;
  private hold: Promise<void> | undefined;
  private open = () => {};

  async subscribe(channel: string, listener: ChannelListener): Promise<void> {
    this.commands.push(`SUBSCRIBE ${channel}`);
    await this.hold;
    if (this.failSubscribes > 0) {
      this.failSubscribes -= 1;
      throw new Error('Socket closed unexpectedly');
    }
    this.listeners.set(channel, listener);
  }
  async unsubscribe(channel: string): Promise<void> {
    this.commands.push(`UNSUBSCRIBE ${channel}`);
    this.listeners.delete(channel);
  }
  publish(channel: string, message: string): void {
    this.listeners.get(channel)?.(message, channel);
  }
  holdSubscribes(): void {
    this.hold = new Promise((resolve) => {
      this.open = resolve;
    });
  }
  releaseSubscribes(): void {
    this.open();
    this.hold = undefined;
  }
}

const stockMessage = (seq: number, avail: number, ts = 1_000 + seq) =>
  `3:${seq}:${avail}:0:${100 - avail}:LIVE:${ts}`;

function setup(options: { otherViewers?: number; limits?: Partial<GatewayLimits> } = {}) {
  const pubsub = new FakePubSub();
  const stock = new Map<string, RedisStock>([
    [DROP, { status: 'LIVE', gen: 3, seq: 10, avail: 90, held: 0, sold: 10 }],
  ]);
  let pinned: PinnedDrop | null = { dropId: DROP, status: 'LIVE' };
  /** Room reads: the rooms each statement asked for. */
  const roomReads: string[][] = [];
  const reads = { stock: 0 };
  /** Ids the directory says do not exist. */
  const missing = new Set<string>();
  const lookups: string[] = [];
  let stockGate: Promise<void> | undefined;
  let stockFailures = 0;
  let roomGate: Promise<void> | undefined;
  /** Held for the next room read only: later reads pass it. */
  let nextRoomGate: Promise<void> | undefined;
  let roomFailures = 0;
  const viewers = {
    report: vi.fn<ViewerStore['report']>(async (counts) => {
      return new Map([...counts].map(([roomId, n]) => [roomId, n + (options.otherViewers ?? 0)]));
    }),
  };
  const directory: TopicDirectory = {
    async exists(_kind, id) {
      lookups.push(id);
      return !missing.has(id);
    },
  };
  const gateway = createGateway({
    instanceId: 'api-test-1',
    pubsub,
    sources: {
      async stock(dropId) {
        reads.stock += 1;
        await stockGate;
        if (stockFailures > 0) {
          stockFailures -= 1;
          throw new Error('redis did not answer');
        }
        return stock.get(dropId) ?? null;
      },
      rooms: {
        async pinnedDrops(roomIds) {
          roomReads.push([...roomIds]);
          const answer = pinned;
          const own = nextRoomGate;
          nextRoomGate = undefined;
          await Promise.all([roomGate, own]);
          if (roomFailures > 0) {
            roomFailures -= 1;
            throw new Error('canceling statement due to statement timeout');
          }
          return new Map(roomIds.map((roomId) => [roomId, answer]));
        },
      },
    },
    directory,
    viewers,
    logger: createLogger({ name: 'gateway-test', level: 'silent' }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  function connect(
    principal: Principal = anonymousPrincipal(),
    client: Partial<ClientInfo> = {},
  ): FakeSocket {
    const socket = new FakeSocket();
    gateway.attach(socket, principal, { ...CLIENT, ...client });
    return socket;
  }
  /** Holds a source's reads until the returned function is called. */
  function holder(assign: (gate: Promise<void> | undefined) => void): () => void {
    let open = () => {};
    assign(
      new Promise((resolve) => {
        open = resolve;
      }),
    );
    return () => {
      assign(undefined);
      open();
    };
  }
  return {
    gateway,
    pubsub,
    stock,
    reads,
    roomReads,
    missing,
    lookups,
    viewers,
    connect,
    setPinned(next: PinnedDrop | null) {
      pinned = next;
    },
    holdStockReads: () =>
      holder((next) => {
        stockGate = next;
      }),
    holdRoomReads: () =>
      holder((next) => {
        roomGate = next;
      }),
    holdNextRoomRead: () =>
      holder((next) => {
        if (next !== undefined) nextRoomGate = next;
      }),
    failStockReads(n: number) {
      stockFailures = n;
    },
    failRoomReads(n: number) {
      roomFailures = n;
    },
  };
}

/** Lets pending promise chains (subscribe, snapshot) run without moving the fake clock. */
async function settle(): Promise<void> {
  for (let round = 0; round < 10; round += 1) await vi.advanceTimersByTimeAsync(0);
}
const sub = (socket: FakeSocket, ...topics: Topic[]) => socket.receive({ type: 'sub', topics });

let stacks: ReturnType<typeof setup>[] = [];
function start(options?: Parameters<typeof setup>[0]) {
  const stack = setup(options);
  stacks.push(stack);
  return stack;
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-10-09T12:00:00.000Z') });
});
afterEach(async () => {
  await Promise.all(stacks.map((stack) => stack.gateway.close()));
  stacks = [];
  vi.useRealTimers();
});

describe('connection', () => {
  it('greets every socket with the instance id and the server clock', () => {
    const { connect } = start();
    const socket = connect();
    expect(socket.frames).toEqual([{ type: 'hello', instanceId: 'api-test-1', serverTime: Date.now() }]);
  });
});

describe('subscribe-then-snapshot (§7 step 1)', () => {
  it('reads the snapshot only after Redis confirmed the subscription', async () => {
    const { connect, pubsub, reads } = start();
    pubsub.holdSubscribes();
    const socket = connect();
    sub(socket, STOCK);
    await settle();
    expect(pubsub.commands).toEqual([`SUBSCRIBE ${stockChannel(DROP)}`]);
    expect(reads.stock).toBe(0);

    pubsub.releaseSubscribes();
    await settle();
    expect(reads.stock).toBe(1);
    expect(socket.ofType('snapshot')).toEqual([
      {
        type: 'snapshot',
        topic: STOCK,
        gen: 3,
        seq: 10,
        data: { status: 'LIVE', avail: 90, held: 0, sold: 10 },
      },
    ]);
  });

  it('never sends a snapshot older than a delta the socket already got', async () => {
    const { connect, pubsub, holdStockReads } = start();
    const openReads = holdStockReads();
    const socket = connect();
    sub(socket, STOCK);
    await settle();

    // Published after the subscription, flushed while the snapshot read is still out.
    pubsub.publish(stockChannel(DROP), stockMessage(11, 89));
    await vi.advanceTimersByTimeAsync(100);
    openReads();
    await settle();

    expect(socket.frames.map((frame) => frame.type)).toEqual(['hello', 'delta']);
    expect(socket.ofType('delta')[0]).toMatchObject({ gen: 3, seq: 11, data: { avail: 89 } });
  });

  it('subscribes a channel once for all local sockets and unsubscribes after the last leaves', async () => {
    const { connect, pubsub } = start();
    const first = connect();
    const second = connect();
    sub(first, STOCK);
    sub(second, STOCK);
    await settle();
    expect(pubsub.commands).toEqual([`SUBSCRIBE ${stockChannel(DROP)}`]);

    first.receive({ type: 'unsub', topics: [STOCK] });
    await settle();
    expect(pubsub.commands).toHaveLength(1);
    second.hangUp();
    await settle();
    expect(pubsub.commands).toEqual([`SUBSCRIBE ${stockChannel(DROP)}`, `UNSUBSCRIBE ${stockChannel(DROP)}`]);
  });
});

describe('burst coalescing (§7)', () => {
  it('sends each socket at most one frame per topic per 100 ms: the newest level, timed by its oldest change', async () => {
    const { connect, pubsub } = start();
    const sockets = [connect(), connect()];
    for (const socket of sockets) sub(socket, STOCK);
    await settle();

    for (let seq = 11; seq <= 60; seq += 1) pubsub.publish(stockChannel(DROP), stockMessage(seq, 100 - seq));
    // Older than what is held: ignored.
    pubsub.publish(stockChannel(DROP), stockMessage(12, 88));
    await vi.advanceTimersByTimeAsync(100);

    for (const socket of sockets) {
      expect(socket.ofType('delta')).toEqual([
        {
          type: 'delta',
          topic: STOCK,
          gen: 3,
          seq: 60,
          ts: 1_011,
          data: { avail: 40, held: 0, sold: 60, status: 'LIVE' },
        },
      ]);
    }
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets[0]?.ofType('delta')).toHaveLength(1);
  });

  it('drops incomplete stock levels', async () => {
    const { connect, pubsub } = start();
    const socket = connect();
    sub(socket, STOCK);
    await settle();
    pubsub.publish(stockChannel(DROP), '3:11::0:0:LIVE:1011');
    await vi.advanceTimersByTimeAsync(100);
    expect(socket.ofType('delta')).toEqual([]);
  });
});

describe('access (§7, §11)', () => {
  it('refuses dash topics to anonymous and buyer sockets, and subscribes nothing for them', async () => {
    const { connect, pubsub } = start();
    for (const principal of [anonymous, buyer]) {
      const socket = connect(principal);
      sub(socket, DASH, STOCK);
      await settle();
      expect(socket.ofType('error')).toEqual([{ type: 'error', code: 'FORBIDDEN', topics: [DASH] }]);
      expect(socket.ofType('snapshot').map((frame) => frame.topic)).toEqual([STOCK]);
    }
    expect(pubsub.commands.some((command) => command.includes(dashboardChannel(DROP)))).toBe(false);
  });

  it('gives admins the dash topic, versioned by the projection', async () => {
    const { connect, pubsub } = start();
    const socket = connect(admin);
    sub(socket, DASH);
    await settle();
    const totals = (paid: number) => ({
      ...Object.fromEntries(SALES_COUNTERS.map((counter) => [counter, 0])),
      paid,
      lastEventAt: null,
    });
    pubsub.publish(dashboardChannel(DROP), JSON.stringify({ version: 7, totals: totals(3) }));
    pubsub.publish(dashboardChannel(DROP), JSON.stringify({ version: 6, totals: totals(2) }));
    pubsub.publish(dashboardChannel(DROP), JSON.stringify({ version: 8, totals: { paid: 9 } }));
    await vi.advanceTimersByTimeAsync(100);
    expect(socket.ofType('delta')).toMatchObject([{ topic: DASH, gen: 0, seq: 7, data: totals(3) }]);
  });

  it('caps the topics one socket holds', async () => {
    const { connect } = start();
    const socket = connect();
    const topics = Array.from({ length: GATEWAY_LIMITS.maxTopics + 2 }, (_, i) =>
      topicOf('stock', `5eed0004-0000-4000-8000-${String(i).padStart(12, '0')}`),
    );
    sub(socket, ...topics.slice(0, GATEWAY_LIMITS.maxTopics));
    sub(socket, ...topics.slice(GATEWAY_LIMITS.maxTopics));
    await settle();
    expect(socket.ofType('error')).toEqual([
      { type: 'error', code: 'TOO_MANY_TOPICS', topics: topics.slice(GATEWAY_LIMITS.maxTopics) },
    ]);
  });
});

describe('the user topic', () => {
  it("forwards the owner's events at once, to every socket of that user and nobody else", async () => {
    const { connect, pubsub } = start();
    const tabs = [connect(buyer), connect(buyer)];
    const stranger = connect(otherBuyer);
    const anon = connect();
    await settle();
    expect(pubsub.commands.filter((command) => command.endsWith(userChannel(BUYER)))).toHaveLength(1);

    const event = { type: 'order', orderId: ORDER, status: 'PAID', version: 4 };
    pubsub.publish(userChannel(BUYER), JSON.stringify(event));
    pubsub.publish(userChannel(BUYER), JSON.stringify({ ...event, status: 'BOGUS' }));
    // No timer moved: user events are never coalesced.
    for (const tab of tabs) expect(tab.ofType('order')).toEqual([event]);
    expect(stranger.ofType('order')).toEqual([]);
    expect(anon.ofType('order')).toEqual([]);

    tabs[0]?.hangUp();
    await settle();
    expect(pubsub.listeners.has(userChannel(BUYER))).toBe(true);
    tabs[1]?.hangUp();
    await settle();
    expect(pubsub.listeners.has(userChannel(BUYER))).toBe(false);
  });
});

describe('client frames', () => {
  it.each([
    ['binary frame', (socket: FakeSocket) => socket.emit('message', Buffer.from('{}'), true), 1003],
    ['invalid JSON', (socket: FakeSocket) => socket.emit('message', Buffer.from('{sub'), false), 1008],
    ['unknown message', (socket: FakeSocket) => socket.receive({ type: 'sub', topics: ['user'] }), 1008],
  ])('closes the socket on a %s', (_, act, code) => {
    const { connect } = start();
    const socket = connect();
    act(socket);
    expect(socket.closedWith?.code).toBe(code);
  });

  it('closes a socket that sends more than 20 frames in a second', async () => {
    const { connect } = start();
    const socket = connect();
    for (let i = 0; i < 20; i += 1) socket.receive({ type: 'unsub', topics: [STOCK] });
    expect(socket.closedWith).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    for (let i = 0; i < 21; i += 1) socket.receive({ type: 'unsub', topics: [STOCK] });
    expect(socket.closedWith).toEqual({ code: WS_CLOSE.POLICY, reason: 'too many messages' });
  });
});

describe('backpressure (§7)', () => {
  it('skips level frames while the buffer is full and catches up once it drains, with no new publish', async () => {
    const { connect, pubsub } = start();
    const slow = connect();
    const fast = connect();
    sub(slow, STOCK);
    sub(fast, STOCK);
    await settle();

    slow.bufferedAmount = GATEWAY_LIMITS.skipAboveBytes + 1;
    pubsub.publish(stockChannel(DROP), stockMessage(11, 89));
    await vi.advanceTimersByTimeAsync(100);
    pubsub.publish(stockChannel(DROP), stockMessage(12, 88));
    await vi.advanceTimersByTimeAsync(100);
    expect(slow.ofType('delta')).toEqual([]);
    expect(fast.ofType('delta').map((frame) => frame.seq)).toEqual([11, 12]);

    slow.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(100);
    expect(slow.ofType('delta').map((frame) => frame.seq)).toEqual([12]);
    expect(fast.ofType('delta')).toHaveLength(2);
  });

  it('closes a socket whose sends stay skipped for 10 s with 1013', async () => {
    const { connect } = start();
    const socket = connect();
    socket.bufferedAmount = GATEWAY_LIMITS.skipAboveBytes + 1;
    await vi.advanceTimersByTimeAsync(GATEWAY_LIMITS.stallCloseMs);
    expect(socket.closedWith).toBeUndefined();
    await vi.advanceTimersByTimeAsync(GATEWAY_LIMITS.watchdogIntervalMs);
    expect(socket.closedWith).toEqual({ code: WS_CLOSE.TRY_AGAIN_LATER, reason: 'stalled' });
  });

  it('forgives a socket that drains in time, and closes one past the hard cap at once', async () => {
    const { connect } = start();
    const draining = connect();
    const flooded = connect();
    draining.bufferedAmount = GATEWAY_LIMITS.skipAboveBytes + 1;
    await vi.advanceTimersByTimeAsync(GATEWAY_LIMITS.stallCloseMs - 2_000);
    draining.bufferedAmount = 0;
    flooded.bufferedAmount = GATEWAY_LIMITS.closeAboveBytes + 1;
    await vi.advanceTimersByTimeAsync(GATEWAY_LIMITS.watchdogIntervalMs);
    draining.bufferedAmount = GATEWAY_LIMITS.skipAboveBytes + 1;
    await vi.advanceTimersByTimeAsync(GATEWAY_LIMITS.stallCloseMs - 2_000);
    expect(draining.closedWith).toBeUndefined();
    expect(flooded.closedWith).toEqual({ code: WS_CLOSE.TRY_AGAIN_LATER, reason: 'send buffer full' });
  });

  it('applies injected thresholds, as the integration test injects tiny ones', async () => {
    const limits = { skipAboveBytes: 1024, stallCloseMs: 500, watchdogIntervalMs: 50 };
    const { connect, pubsub } = start({ limits });
    const socket = connect();
    sub(socket, STOCK);
    await settle();

    // Far below the production soft limit, above the injected one: skipped.
    socket.bufferedAmount = 2 * 1024;
    pubsub.publish(stockChannel(DROP), stockMessage(11, 89));
    await vi.advanceTimersByTimeAsync(limits.stallCloseMs);
    expect(socket.ofType('delta')).toEqual([]);
    expect(socket.closedWith).toBeUndefined();
    await vi.advanceTimersByTimeAsync(limits.watchdogIntervalMs);
    expect(socket.closedWith).toEqual({ code: WS_CLOSE.TRY_AGAIN_LATER, reason: 'stalled' });
  });
});

describe('keepalive', () => {
  it('pings every 20 s and drops a socket after 2 missed pongs', async () => {
    const { connect } = start();
    const alive = connect();
    const dead = connect();
    for (let round = 1; round <= 3; round += 1) {
      await vi.advanceTimersByTimeAsync(GATEWAY_LIMITS.pingIntervalMs);
      alive.emit('pong');
    }
    expect(alive.pings).toBe(3);
    expect(alive.terminated).toBe(false);
    expect(dead.pings).toBe(2);
    expect(dead.terminated).toBe(true);
  });
});

describe('room topic', () => {
  it('snapshots the pinned drop and the viewers across instances, then pushes changes', async () => {
    const { connect, pubsub, setPinned, viewers } = start({ otherViewers: 3 });
    const socket = connect();
    sub(socket, ROOM_TOPIC);
    await settle();
    const [snapshot] = socket.ofType('snapshot');
    expect(snapshot).toMatchObject({
      topic: ROOM_TOPIC,
      gen: 0,
      data: { pinned: { dropId: DROP, status: 'LIVE' }, viewers: 4 },
    });
    expect(viewers.report).toHaveBeenCalledWith(new Map([[ROOM, 1]]), []);

    // A second viewer here; the next viewer beat pushes the new total.
    sub(connect(), ROOM_TOPIC);
    await vi.advanceTimersByTimeAsync(GATEWAY_LIMITS.viewerIntervalMs);
    await vi.advanceTimersByTimeAsync(100);
    const [viewerDelta] = socket.ofType('delta');
    expect(viewerDelta?.data).toEqual({ pinned: { dropId: DROP, status: 'LIVE' }, viewers: 5 });
    expect(viewerDelta?.seq).toBeGreaterThan(snapshot?.seq ?? Number.POSITIVE_INFINITY);

    // The scheduler's nudge: re-read from Postgres and pushed.
    setPinned({ dropId: DROP, status: 'ENDED' });
    pubsub.publish(roomChannel(ROOM), JSON.stringify({ type: 'drop', dropId: DROP, status: 'ENDED' }));
    await vi.advanceTimersByTimeAsync(100);
    expect(socket.ofType('delta').at(-1)?.data).toEqual({
      pinned: { dropId: DROP, status: 'ENDED' },
      viewers: 5,
    });
  });

  it('re-reads the pinned drop on the viewer beat, so changes without a nudge show too', async () => {
    const { connect, setPinned } = start();
    const socket = connect();
    sub(socket, ROOM_TOPIC);
    await settle();
    setPinned(null);
    await vi.advanceTimersByTimeAsync(GATEWAY_LIMITS.viewerIntervalMs + 100);
    expect(socket.ofType('delta').at(-1)?.data).toEqual({ pinned: null, viewers: 1 });
  });

  it("deletes this instance's viewer field once it has no viewer left in the room", async () => {
    const { connect, viewers } = start();
    const socket = connect();
    sub(socket, ROOM_TOPIC);
    await settle();
    socket.hangUp();
    await vi.advanceTimersByTimeAsync(GATEWAY_LIMITS.viewerIntervalMs);
    expect(viewers.report).toHaveBeenLastCalledWith(new Map(), [ROOM]);
  });
});

describe('resnapshot after a subscriber reconnect (§7 step 3)', () => {
  it('pushes every held topic whose level moved while pub/sub was down', async () => {
    const { gateway, connect, stock } = start();
    const socket = connect();
    sub(socket, STOCK);
    await settle();
    // Mutated while the subscriber was away: no publish reached this instance.
    stock.set(DROP, { status: 'LIVE', gen: 3, seq: 25, avail: 75, held: 0, sold: 25 });
    await gateway.resnapshot();
    await vi.advanceTimersByTimeAsync(100);
    expect(socket.ofType('delta')).toMatchObject([{ topic: STOCK, gen: 3, seq: 25, data: { avail: 75 } }]);
  });
});

describe('close', () => {
  it('closes every socket with 1001 and removes the viewer fields', async () => {
    const { gateway, connect, viewers } = start();
    const socket = connect();
    sub(socket, ROOM_TOPIC);
    await settle();
    const closing = gateway.close();
    expect(socket.closedWith).toEqual({ code: WS_CLOSE.GOING_AWAY, reason: 'server shutting down' });
    socket.hangUp();
    await closing;
    expect(viewers.report).toHaveBeenLastCalledWith(new Map(), [ROOM]);

    const late = connect();
    expect(late.closedWith?.code).toBe(WS_CLOSE.GOING_AWAY);
  });
});

describe('abuse (§11)', () => {
  it('answers NOT_FOUND for a drop or room that does not exist, and spends nothing on it', async () => {
    const { connect, pubsub, reads, roomReads, missing, viewers } = start();
    const ghostDrop = '0198a3c4-0000-7000-8000-00000000dead';
    const ghostRoom = '0198a3c4-0000-7000-8000-00000000beef';
    missing.add(ghostDrop).add(ghostRoom);
    const socket = connect();
    sub(socket, topicOf('stock', ghostDrop), topicOf('room', ghostRoom), STOCK);
    await settle();

    expect(socket.ofType('error')).toEqual([
      {
        type: 'error',
        code: 'NOT_FOUND',
        topics: [topicOf('stock', ghostDrop), topicOf('room', ghostRoom)],
      },
    ]);
    expect(socket.ofType('snapshot').map((frame) => frame.topic)).toEqual([STOCK]);
    expect(pubsub.commands).toEqual([`SUBSCRIBE ${stockChannel(DROP)}`]);
    expect(reads.stock).toBe(1);
    await vi.advanceTimersByTimeAsync(GATEWAY_LIMITS.viewerIntervalMs);
    expect(roomReads).toEqual([]);
    expect(viewers.report).toHaveBeenLastCalledWith(new Map(), []);
  });

  /** `n` distinct stock topics from `from` on. */
  const stockTopics = (from: number, n: number) =>
    Array.from({ length: n }, (_, i) =>
      topicOf('stock', `5eed0004-0000-4000-8000-${String(from + i).padStart(12, '0')}`),
    );
  /** Joins and leaves `n` topics, `WS_MAX_TOPICS_PER_SOCKET` per frame: the socket never holds many. */
  async function churn(socket: FakeSocket, from: number, n: number): Promise<void> {
    for (let at = 0; at < n; at += GATEWAY_LIMITS.maxTopics) {
      const topics = stockTopics(from + at, Math.min(GATEWAY_LIMITS.maxTopics, n - at));
      sub(socket, ...topics);
      await settle();
      socket.receive({ type: 'unsub', topics });
    }
  }

  it('closes a socket that churns through more joins than its budget', async () => {
    const { connect } = start();
    const socket = connect();
    await churn(socket, 0, GATEWAY_LIMITS.maxJoinsPerWindow);
    expect(socket.closedWith).toBeUndefined();
    sub(socket, ...stockTopics(1_000, 1));
    expect(socket.closedWith).toEqual({ code: WS_CLOSE.POLICY, reason: 'too many subscriptions' });
  });

  it('gives a fresh budget once the window has passed', async () => {
    const { connect } = start();
    const socket = connect();
    await churn(socket, 0, GATEWAY_LIMITS.maxJoinsPerWindow);
    await vi.advanceTimersByTimeAsync(GATEWAY_LIMITS.joinWindowMs);
    await churn(socket, 1_000, GATEWAY_LIMITS.maxTopics);
    expect(socket.closedWith).toBeUndefined();
  });

  it('counts open sockets per client address', () => {
    const { connect, gateway } = start();
    const first = connect(undefined, { address: '198.51.100.1' });
    connect(undefined, { address: '198.51.100.1' });
    connect(undefined, { address: '198.51.100.2' });
    expect(gateway.socketsFrom('198.51.100.1')).toBe(2);
    first.hangUp();
    expect(gateway.socketsFrom('198.51.100.1')).toBe(1);
    expect(gateway.socketsFrom('192.0.2.9')).toBe(0);
  });

  it('counts a signed-in viewer once however many tabs they open, an anonymous socket each', async () => {
    const { connect, viewers } = start();
    for (const principal of [buyer, buyer, buyer, undefined, undefined]) sub(connect(principal), ROOM_TOPIC);
    await settle();
    await vi.advanceTimersByTimeAsync(GATEWAY_LIMITS.viewerIntervalMs);
    expect(viewers.report).toHaveBeenLastCalledWith(new Map([[ROOM, 3]]), []);
  });
});

describe('shared reads', () => {
  it('reads a topic once for every socket that joins while its snapshot is out', async () => {
    const { connect, reads, holdStockReads } = start();
    const open = holdStockReads();
    const sockets = Array.from({ length: 5 }, () => connect());
    for (const socket of sockets) sub(socket, STOCK);
    await settle();
    open();
    await settle();
    expect(reads.stock).toBe(1);
    for (const socket of sockets) expect(socket.ofType('snapshot')).toHaveLength(1);
  });

  it('re-reads every room of the instance in one statement per viewer beat', async () => {
    const { connect, roomReads } = start();
    const rooms = [ROOM, '5eed0002-0000-4000-8000-000000000002', '5eed0002-0000-4000-8000-000000000003'];
    for (const room of rooms) sub(connect(), topicOf('room', room));
    await settle();
    roomReads.length = 0;
    await vi.advanceTimersByTimeAsync(GATEWAY_LIMITS.viewerIntervalMs);
    expect(roomReads).toEqual([rooms]);
  });

  it('never lets an older room read that finishes late undo a newer one', async () => {
    const { connect, pubsub, setPinned, holdNextRoomRead, roomReads } = start();
    const socket = connect();
    sub(socket, ROOM_TOPIC);
    await settle();
    // The beat's read sees the drop LIVE and stalls; meanwhile a nudge reads it ENDED and lands first.
    setPinned({ dropId: DROP, status: 'PAUSED' });
    const open = holdNextRoomRead();
    await vi.advanceTimersByTimeAsync(GATEWAY_LIMITS.viewerIntervalMs);
    setPinned({ dropId: DROP, status: 'ENDED' });
    pubsub.publish(roomChannel(ROOM), JSON.stringify({ type: 'drop', dropId: DROP, status: 'ENDED' }));
    await vi.advanceTimersByTimeAsync(100);
    expect(socket.ofType('delta').at(-1)?.data).toMatchObject({ pinned: { status: 'ENDED' } });
    open();
    await vi.advanceTimersByTimeAsync(100);
    expect(roomReads.length).toBeGreaterThanOrEqual(3);
    expect(socket.ofType('delta').map((frame) => frame.data)).not.toContainEqual(
      expect.objectContaining({ pinned: { dropId: DROP, status: 'PAUSED' } }),
    );
  });
});

describe('failure (§7): a topic that cannot be set up closes the socket with 1013', () => {
  it('when the SUBSCRIBE fails, as node-redis fails one in flight when its connection drops', async () => {
    const { connect, pubsub } = start();
    pubsub.failSubscribes = 1;
    const socket = connect();
    sub(socket, STOCK);
    await settle();
    expect(socket.closedWith).toEqual({ code: WS_CLOSE.TRY_AGAIN_LATER, reason: 'topic unavailable' });

    // The reconnect subscribes afresh and gets its snapshot.
    const again = connect();
    sub(again, STOCK);
    await settle();
    expect(again.ofType('snapshot')).toHaveLength(1);
  });

  it("when the user channel's SUBSCRIBE fails, so no order event goes missing silently", async () => {
    const { connect, pubsub } = start();
    pubsub.failSubscribes = 1;
    const socket = connect(buyer);
    await settle();
    expect(socket.closedWith).toEqual({
      code: WS_CLOSE.TRY_AGAIN_LATER,
      reason: 'user events unavailable',
    });
  });

  it('when the snapshot cannot be read', async () => {
    const { connect, failStockReads } = start();
    failStockReads(1);
    const socket = connect();
    sub(socket, STOCK);
    await settle();
    expect(socket.closedWith?.code).toBe(WS_CLOSE.TRY_AGAIN_LATER);
  });

  it("when a room's first load fails: its waiting sockets reconnect, and the next load serves them", async () => {
    const { connect, failRoomReads, holdRoomReads } = start();
    failRoomReads(1);
    const open = holdRoomReads();
    const waiting = [connect(), connect()];
    for (const socket of waiting) sub(socket, ROOM_TOPIC);
    await settle();
    open();
    await settle();
    for (const socket of waiting) expect(socket.closedWith?.code).toBe(WS_CLOSE.TRY_AGAIN_LATER);

    const again = connect();
    sub(again, ROOM_TOPIC);
    await settle();
    expect(again.ofType('snapshot')[0]?.data).toEqual({
      pinned: { dropId: DROP, status: 'LIVE' },
      viewers: 1,
    });
  });

  it('retries a failed re-snapshot at the next viewer beat', async () => {
    const { gateway, connect, stock, failStockReads } = start();
    const socket = connect();
    sub(socket, STOCK);
    await settle();
    stock.set(DROP, { status: 'LIVE', gen: 3, seq: 25, avail: 75, held: 0, sold: 25 });
    failStockReads(1);
    await gateway.resnapshot();
    await vi.advanceTimersByTimeAsync(100);
    expect(socket.ofType('delta')).toEqual([]);
    expect(socket.closedWith).toBeUndefined();

    await vi.advanceTimersByTimeAsync(GATEWAY_LIMITS.viewerIntervalMs + 100);
    expect(socket.ofType('delta')).toMatchObject([{ topic: STOCK, seq: 25 }]);
  });
});

describe('sessions (§11)', () => {
  it('closes a signed-in socket once its session expires, at the next ping round', async () => {
    const { connect } = start();
    const expiresAt = Date.now() + GATEWAY_LIMITS.pingIntervalMs + 1_000;
    const expiring = connect({ kind: 'user', userId: ADMIN, role: 'admin', expiresAt });
    const anon = connect();
    await vi.advanceTimersByTimeAsync(GATEWAY_LIMITS.pingIntervalMs);
    expiring.emit('pong');
    anon.emit('pong');
    expect(expiring.closedWith).toBeUndefined();
    await vi.advanceTimersByTimeAsync(GATEWAY_LIMITS.pingIntervalMs);
    expect(expiring.closedWith).toEqual({ code: WS_CLOSE.SESSION_EXPIRED, reason: 'session expired' });
    expect(anon.closedWith).toBeUndefined();
  });
});

describe('heartbeat (WS_HEARTBEAT)', () => {
  it('sends a beat to an opted-in socket that has heard nothing for 10 s, and only to it', async () => {
    const { connect, pubsub } = start();
    const opted = connect(undefined, { beats: true });
    const plain = connect();
    sub(opted, STOCK);
    sub(plain, STOCK);
    await settle();
    // A delta resets the silence.
    await vi.advanceTimersByTimeAsync(GATEWAY_LIMITS.beatIntervalMs - 2_000);
    pubsub.publish(stockChannel(DROP), stockMessage(11, 89));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(opted.ofType('beat')).toEqual([]);

    await vi.advanceTimersByTimeAsync(GATEWAY_LIMITS.beatIntervalMs);
    expect(opted.ofType('beat')).toEqual([{ type: 'beat', serverTime: expect.any(Number) }]);
    expect(plain.ofType('beat')).toEqual([]);
  });
});

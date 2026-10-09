import {
  type BeatMessage,
  DashboardTotalsMessage,
  type HelloMessage,
  RoomChangedMessage,
  type SnapshotMessage,
  splitTopic,
  type Topic,
  type TopicErrorMessage,
  type TopicKind,
  topicOf,
  UserEventMessage,
  WS_CLOSE,
  WS_HEARTBEAT,
  WS_JOIN_WINDOW_MS,
  WS_MAX_CLIENT_MESSAGES_PER_SECOND,
  WS_MAX_JOINS_PER_WINDOW,
  WS_MAX_TOPICS_PER_SOCKET,
} from '@flashdrop/contracts';
import { BugError } from '@flashdrop/domain';
import {
  dashboardChannel,
  parseStockMessage,
  type RedisStock,
  roomChannel,
  type StockVersion,
  stockChannel,
  userChannel,
} from '@flashdrop/inventory';
import type { FastifyBaseLogger } from 'fastify';
import { type RawData, WebSocket } from 'ws';
import { countWsFrame, wsSocketClosed, wsSocketOpened } from '../metrics';
import type { RoomReader } from '../services/rooms';
import { canSubscribe, type Principal, principalLabel, viewerKey } from './access';
import { createChannelRegistry, type PubSub } from './channels';
import { createCoalescer, type Frame, isNewer, type Level } from './coalescer';
import type { TopicDirectory } from './directory';
import { parseClientMessage, parseJson, textOf } from './protocol';
import { createRoomTracker } from './rooms-state';
import type { ViewerStore } from './viewers';
import { type FixedWindow, fixedWindow } from './window';

/*
 * The WebSocket gateway's core (design §7), independent of Fastify: sockets, topics, the Redis fan-out and
 * the timers. `plugin.ts` mounts it at `/ws`; `rooms-state.ts` keeps the room levels.
 *
 * Ordering. Every snapshot and delta carries a full level and its version, and each socket remembers the
 * version it was last sent per topic; nothing older or equal is ever written to it. So subscribe-then-
 * snapshot (§7 step 1) needs no lock: the socket joins its topic, the channel is subscribed (Redis confirms
 * before `acquire` resolves), then the snapshot is read. A delta flushed meanwhile may reach the socket first;
 * the snapshot is then sent only if it is still newer. Anything published after the read arrives as a delta.
 * Sockets joining a topic while its snapshot is being read share that read: it started after the channel was
 * confirmed, so it is as good for them.
 *
 * Abuse (§11). A topic must name a drop or room that exists (`directory.ts`), so no state, Postgres read or
 * Redis write is spent on invented ids; each socket gets a join budget, and `plugin.ts` caps upgrades and
 * sockets per client address.
 *
 * Failure. A topic whose channel could not be subscribed, or whose snapshot could not be read, would sit
 * silent while the socket looks live, and the client polls only while it has no open socket. So such a
 * socket is closed with 1013: the client reconnects with backoff, resubscribes everything and gets fresh
 * snapshots, and while that keeps failing it says "Live updates paused" and polls.
 */

export interface GatewayLimits {
  /** The coalescer's tick: at most one frame per topic per socket per tick (§7: 100 ms). */
  readonly flushIntervalMs: number;
  readonly pingIntervalMs: number;
  /** Pings in a row without a pong after which the socket is dropped. */
  readonly maxMissedPongs: number;
  readonly viewerIntervalMs: number;
  /** How often send buffers are checked for stalls, and opted-in sockets for a due `beat`. */
  readonly watchdogIntervalMs: number;
  /** Level frames are skipped while the socket's send buffer holds more than this. */
  readonly skipAboveBytes: number;
  /** A socket buffering more than this is closed at once (1013). */
  readonly closeAboveBytes: number;
  /** A socket whose sends stay skipped this long is closed (1013). */
  readonly stallCloseMs: number;
  readonly messagesPerSecond: number;
  readonly maxTopics: number;
  /** Topic joins per socket per `joinWindowMs`; one more closes the socket with 1008. */
  readonly maxJoinsPerWindow: number;
  readonly joinWindowMs: number;
  /** An opted-in socket that has been sent nothing for this long gets a `beat`. */
  readonly beatIntervalMs: number;
  /** How long `close()` waits for clients to answer the close frame before cutting them off. */
  readonly closeGraceMs: number;
}

/**
 * Design §7, with one correction: sends stop at 256 KB, so a buffer only passes 1 MB through the frames
 * that are never skipped (snapshots, user events, pings), and "above 1 MB for 10 s" would almost never
 * fire; a stalled client would sit at 256 KB, getting nothing, until pings time it out. So a socket whose
 * sends have been skipped for 10 s is closed with 1013 (it reconnects and gets fresh snapshots), and 1 MB is
 * a hard cap.
 */
export const GATEWAY_LIMITS: GatewayLimits = {
  flushIntervalMs: 100,
  pingIntervalMs: 20_000,
  maxMissedPongs: 2,
  viewerIntervalMs: 5_000,
  watchdogIntervalMs: 1_000,
  skipAboveBytes: 256 * 1024,
  closeAboveBytes: 1024 * 1024,
  stallCloseMs: 10_000,
  messagesPerSecond: WS_MAX_CLIENT_MESSAGES_PER_SECOND,
  maxTopics: WS_MAX_TOPICS_PER_SOCKET,
  maxJoinsPerWindow: WS_MAX_JOINS_PER_WINDOW,
  joinWindowMs: WS_JOIN_WINDOW_MS,
  beatIntervalMs: WS_HEARTBEAT.intervalMs,
  closeGraceMs: 1_000,
};

/** The part of a `ws` WebSocket the gateway uses; tests drive it with fakes. */
export interface GatewaySocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  ping(): void;
  close(code: number, reason: string): void;
  terminate(): void;
  on(event: 'message', listener: (data: RawData, isBinary: boolean) => void): unknown;
  on(event: 'pong', listener: () => void): unknown;
  on(event: 'close', listener: () => void): unknown;
}

/** The dashboard projection's current totals (§9): `drop_sales_totals`. */
export interface DashboardReader {
  totals(dropId: string): Promise<DashboardTotalsMessage | null>;
}

export interface GatewaySources {
  /** One HMGET of the drop's `inv` hash (`readStock`); null if Redis has no such drop. */
  stock(dropId: string): Promise<RedisStock | null>;
  readonly rooms: RoomReader;
  /** Without it, a `dash:` snapshot comes from the gateway's latest frame, if it has one. */
  readonly dashboard?: DashboardReader;
}

export interface GatewayDeps {
  /** In `hello`, and this instance's field in `fd:viewers:<roomId>`. */
  readonly instanceId: string;
  /** The instance's one subscriber connection. */
  readonly pubsub: PubSub;
  readonly sources: GatewaySources;
  /** Which topics exist; a `sub` of any other is answered NOT_FOUND. */
  readonly directory: TopicDirectory;
  readonly viewers: ViewerStore;
  readonly logger: FastifyBaseLogger;
  readonly limits?: Partial<GatewayLimits>;
}

/** What the upgrade request says about the client. */
export interface ClientInfo {
  /** The client's address (`request.ip`, Caddy's forwarded one): sockets are counted per address. */
  readonly address: string;
  /** Opted in to `beat` frames (`WS_HEARTBEAT`). */
  readonly beats: boolean;
}

export interface Gateway {
  attach(socket: GatewaySocket, principal: Principal, client: ClientInfo): void;
  /** Open sockets from one client address on this instance. */
  socketsFrom(address: string): number;
  /**
   * Re-snapshots every topic this instance holds and pushes what changed. Pub/sub is at-most-once, so the
   * plugin calls it on every subscriber `'ready'` after the first; node-redis has resubscribed by then, so
   * nothing published after the read is missed (spike §1.5). A topic whose read fails is read again at the
   * next viewer beat.
   */
  resnapshot(): Promise<void>;
  /** Stops the timers, closes every socket with 1001 and removes this instance's viewer fields. */
  close(): Promise<void>;
}

/** One socket's membership of one topic; a later re-join is a different one. */
type Membership = object;

interface Conn {
  readonly socket: GatewaySocket;
  readonly principal: Principal;
  readonly client: ClientInfo;
  readonly log: FastifyBaseLogger;
  readonly topics: Map<Topic, Membership>;
  /** Topics asked for whose existence is being checked; they count against `maxTopics` already. */
  readonly checking: Map<Topic, Membership>;
  /** The version of the last frame written per topic: nothing older or equal is ever written after it. */
  readonly sent: Map<Topic, StockVersion>;
  closed: boolean;
  missedPongs: number;
  stalledSince: number | undefined;
  /** Client frames per second. */
  readonly frames: FixedWindow;
  /** Topic joins per `joinWindowMs`. */
  readonly joins: FixedWindow;
  /** When a frame was last written to it: a `beat` goes out after `beatIntervalMs` of silence. */
  lastSentAt: number;
}

interface TopicState {
  readonly topic: Topic;
  readonly kind: TopicKind;
  readonly id: string;
  readonly channel: string;
  readonly conns: Set<Conn>;
  /** The join snapshot read in flight (stock, dash), shared by every socket joining meanwhile. */
  reading: Promise<Level | null> | undefined;
}

function channelOf(kind: TopicKind, id: string): string {
  switch (kind) {
    case 'stock':
      return stockChannel(id);
    case 'room':
      return roomChannel(id);
    case 'dash':
      return dashboardChannel(id);
  }
}

export function createGateway(deps: GatewayDeps): Gateway {
  const limits: GatewayLimits = { ...GATEWAY_LIMITS, ...deps.limits };
  const now = () => Date.now();
  const log = deps.logger;
  const conns = new Set<Conn>();
  const topics = new Map<Topic, TopicState>();
  const users = new Map<string, Set<Conn>>();
  /** Open sockets per client address. */
  const addresses = new Map<string, number>();
  /** Channel -> handler of its messages, for the channels this instance holds. */
  const routes = new Map<string, (message: string) => void>();
  /** Topics whose re-snapshot failed: read again at the next viewer beat. */
  const stale = new Set<TopicState>();
  let closing = false;
  let drained: (() => void) | undefined;

  const registry = createChannelRegistry({
    pubsub: deps.pubsub,
    onMessage(message, channel) {
      // node-redis calls this from its socket's data handler: nothing may throw into it.
      try {
        routes.get(channel)?.(message);
      } catch (err) {
        log.error({ err, channel }, 'realtime message handling failed');
      }
    },
    onError: (err, channel) => log.warn({ err, channel }, 'redis unsubscribe failed'),
  });
  const coalescer = createCoalescer({ intervalMs: limits.flushIntervalMs, deliver });
  const rooms = createRoomTracker({
    reader: deps.sources.rooms,
    viewers: deps.viewers,
    localViewers,
    offer: (roomId, level) => coalescer.offer(topicOf('room', roomId), level),
    log,
    now,
  });

  /**
   * Writes `json` unless the socket is gone. A level frame (`skippable`) is skipped while the send buffer is
   * over the limit: the next flush carries a newer level anyway. Events and snapshots are never skipped;
   * the watchdog bounds what they can add.
   */
  function send(conn: Conn, json: string, skippable: boolean): boolean {
    if (conn.closed || conn.socket.readyState !== WebSocket.OPEN) return true;
    if (skippable && conn.socket.bufferedAmount > limits.skipAboveBytes) return false;
    conn.socket.send(json);
    countWsFrame();
    conn.lastSentAt = now();
    return true;
  }

  function deliver({ topic, level, json }: Frame): boolean {
    const state = topics.get(topic);
    if (state === undefined) return true;
    let complete = true;
    for (const conn of state.conns) {
      if (!isNewer(level, conn.sent.get(topic))) continue;
      if (!send(conn, json, true)) {
        complete = false;
        continue;
      }
      conn.sent.set(topic, level);
    }
    return complete;
  }

  function closeConn(conn: Conn, code: number, reason: string): void {
    conn.log.info({ code, reason }, 'closing websocket');
    conn.socket.close(code, reason);
  }

  /** This instance's viewers of a room: distinct principals among its sockets there (`viewerKey`). */
  function localViewers(roomId: string): number {
    const state = topics.get(topicOf('room', roomId));
    if (state === undefined) return 0;
    return new Set([...state.conns].map((conn) => viewerKey(conn.principal))).size;
  }

  async function viewerTick(): Promise<void> {
    await rooms.tick();
    for (const state of [...stale]) {
      if (topics.get(state.topic) === state) void refreshTopic(state);
      else stale.delete(state);
    }
  }

  // --- topics ----------------------------------------------------------------------------------------------

  function onTopicMessage(state: TopicState, message: string): void {
    switch (state.kind) {
      case 'stock': {
        // Null for a level `publish()` could not complete (a field missing mid-rebuild): wait for the next.
        const level = parseStockMessage(message);
        if (level === null) return;
        const { gen, seq, ts, ...data } = level;
        coalescer.offer(state.topic, { gen, seq, ts, data });
        return;
      }
      case 'room': {
        if (parseJson(RoomChangedMessage, message) === null) {
          log.warn({ channel: state.channel, message }, 'malformed room message');
          return;
        }
        rooms.nudge(state.id);
        return;
      }
      case 'dash': {
        const totals = parseJson(DashboardTotalsMessage, message);
        if (totals === null) {
          log.warn({ channel: state.channel }, 'malformed dashboard message');
          return;
        }
        coalescer.offer(state.topic, { gen: 0, seq: totals.version, ts: now(), data: totals.totals });
        return;
      }
    }
  }

  function ensureTopic(topic: Topic): TopicState {
    const existing = topics.get(topic);
    if (existing !== undefined) return existing;
    const { kind, id } = splitTopic(topic);
    const state: TopicState = {
      topic,
      kind,
      id,
      channel: channelOf(kind, id),
      conns: new Set(),
      reading: undefined,
    };
    topics.set(topic, state);
    routes.set(state.channel, (message) => onTopicMessage(state, message));
    if (kind === 'room') rooms.open(id);
    return state;
  }

  function dropTopic(state: TopicState): void {
    topics.delete(state.topic);
    routes.delete(state.channel);
    coalescer.forget(state.topic);
    stale.delete(state);
    if (state.kind === 'room') rooms.close(state.id);
  }

  /** The topic's level now, read fresh; null when there is none to send (a drop Redis does not hold). */
  async function readLevel(state: TopicState): Promise<Level | null> {
    switch (state.kind) {
      case 'stock': {
        const stock = await deps.sources.stock(state.id);
        if (stock === null) return null;
        const { gen, seq, ...data } = stock;
        return { gen, seq, ts: now(), data };
      }
      case 'room':
        return rooms.snapshot(state.id);
      case 'dash': {
        const reader = deps.sources.dashboard;
        const totals = reader === undefined ? null : await reader.totals(state.id);
        if (totals === null) return coalescer.latest(state.topic) ?? null;
        return { gen: 0, seq: totals.version, ts: now(), data: totals.totals };
      }
    }
  }

  /** The snapshot for a joining socket: one read per topic at a time, shared (the room tracker's too). */
  function snapshotOf(state: TopicState): Promise<Level | null> {
    if (state.kind === 'room') return rooms.snapshot(state.id);
    state.reading ??= readLevel(state).finally(() => {
      state.reading = undefined;
    });
    return state.reading;
  }

  /** A fresh read for a topic every socket already holds; never one that started before a reconnect. */
  async function refreshTopic(state: TopicState): Promise<void> {
    try {
      const level = await readLevel(state);
      stale.delete(state);
      if (level !== null && topics.get(state.topic) === state) coalescer.offer(state.topic, level);
    } catch (err) {
      if (topics.get(state.topic) === state) stale.add(state);
      log.warn({ err, topic: state.topic }, 're-snapshot failed; read again at the next viewer beat');
    }
  }

  function holds(conn: Conn, topic: Topic, membership: Membership): boolean {
    return !conn.closed && conn.topics.get(topic) === membership;
  }

  async function join(conn: Conn, topic: Topic): Promise<void> {
    const membership: Membership = {};
    const state = ensureTopic(topic);
    state.conns.add(conn);
    conn.topics.set(topic, membership);
    let level: Level | null;
    try {
      await registry.acquire(state.channel);
      if (!holds(conn, topic, membership)) return;
      level = await snapshotOf(state);
    } catch (err) {
      // A SUBSCRIBE that failed (node-redis rejects one in flight when its connection drops, and leaves it
      // out of its resubscribe) or a snapshot that could not be read: see "Failure" above.
      if (holds(conn, topic, membership)) {
        conn.log.warn({ err, topic }, 'topic could not be set up; asking the client to reconnect');
        closeConn(conn, WS_CLOSE.TRY_AGAIN_LATER, 'topic unavailable');
      }
      return;
    }
    if (level === null || !holds(conn, topic, membership) || !isNewer(level, conn.sent.get(topic))) return;
    const { gen, seq, data } = level;
    const message: SnapshotMessage = { type: 'snapshot', topic, gen, seq, data };
    send(conn, JSON.stringify(message), false);
    conn.sent.set(topic, level);
  }

  function leave(conn: Conn, topic: Topic): void {
    if (conn.checking.delete(topic)) return;
    if (!conn.topics.delete(topic)) return;
    conn.sent.delete(topic);
    const state = topics.get(topic);
    if (state === undefined) throw new BugError(`socket left ${topic}, which has no state`);
    state.conns.delete(conn);
    registry.release(state.channel);
    if (state.conns.size === 0) dropTopic(state);
  }

  /** Tells the socket which topics of its `sub` were not subscribed, and why. */
  function refuse(conn: Conn, code: TopicErrorMessage['code'], list: readonly Topic[]): void {
    if (list.length === 0) return;
    const message: TopicErrorMessage = { type: 'error', code, topics: [...list] };
    send(conn, JSON.stringify(message), false);
  }

  /** Joins the topic once the directory confirms it exists; resolves to the topic if it does not. */
  async function checkThenJoin(conn: Conn, topic: Topic, membership: Membership): Promise<Topic | null> {
    const { kind, id } = splitTopic(topic);
    const found = await deps.directory.exists(kind, id);
    // Unsubscribed, or the socket closed, while the check ran.
    if (conn.checking.get(topic) !== membership) return null;
    conn.checking.delete(topic);
    if (conn.closed) return null;
    if (!found) return topic;
    join(conn, topic).catch((err: unknown) => conn.log.error({ err, topic }, 'websocket subscribe failed'));
    return null;
  }

  function subscribe(conn: Conn, requested: readonly Topic[]): void {
    const forbidden: Topic[] = [];
    const overflow: Topic[] = [];
    const checks: Promise<Topic | null>[] = [];
    for (const topic of new Set(requested)) {
      if (conn.topics.has(topic) || conn.checking.has(topic)) continue;
      if (!canSubscribe(conn.principal, splitTopic(topic).kind)) {
        forbidden.push(topic);
      } else if (conn.topics.size + conn.checking.size >= limits.maxTopics) {
        overflow.push(topic);
      } else if (!conn.joins.take(now())) {
        closeConn(conn, WS_CLOSE.POLICY, 'too many subscriptions');
        return;
      } else {
        // Taken synchronously, so the size check above sees it.
        const membership: Membership = {};
        conn.checking.set(topic, membership);
        checks.push(checkThenJoin(conn, topic, membership));
      }
    }
    refuse(conn, 'FORBIDDEN', forbidden);
    refuse(conn, 'TOO_MANY_TOPICS', overflow);
    if (checks.length === 0) return;
    Promise.all(checks).then(
      (results) =>
        refuse(
          conn,
          'NOT_FOUND',
          results.filter((topic): topic is Topic => topic !== null),
        ),
      (err: unknown) => conn.log.error({ err }, 'websocket subscribe failed'),
    );
  }

  // --- the user channel ------------------------------------------------------------------------------------

  function onUserMessage(userId: string, message: string): void {
    const event = parseJson(UserEventMessage, message);
    if (event === null) {
      log.warn({ userId }, 'malformed user event');
      return;
    }
    // Never coalesced: each event goes out as it came, serialized once for all of the user's sockets.
    const json = JSON.stringify(event);
    for (const conn of users.get(userId) ?? []) send(conn, json, false);
  }

  function addUser(conn: Conn, userId: string): void {
    const channel = userChannel(userId);
    let sockets = users.get(userId);
    if (sockets === undefined) {
      sockets = new Set();
      users.set(userId, sockets);
      routes.set(channel, (message) => onUserMessage(userId, message));
    }
    sockets.add(conn);
    registry.acquire(channel).catch((err: unknown) => {
      // Without its channel the socket would never hear of its orders: see "Failure" above.
      if (conn.closed) return;
      conn.log.warn({ err, channel }, 'user channel could not be subscribed; asking the client to reconnect');
      closeConn(conn, WS_CLOSE.TRY_AGAIN_LATER, 'user events unavailable');
    });
  }

  function removeUser(conn: Conn, userId: string): void {
    const sockets = users.get(userId);
    if (sockets === undefined || !sockets.delete(conn)) return;
    const channel = userChannel(userId);
    registry.release(channel);
    if (sockets.size === 0) {
      users.delete(userId);
      routes.delete(channel);
    }
  }

  // --- sockets ---------------------------------------------------------------------------------------------

  function onClientMessage(conn: Conn, data: RawData, isBinary: boolean): void {
    if (conn.closed) return;
    if (!conn.frames.take(now())) {
      closeConn(conn, WS_CLOSE.POLICY, 'too many messages');
      return;
    }
    if (isBinary) {
      closeConn(conn, WS_CLOSE.UNSUPPORTED_DATA, 'text frames only');
      return;
    }
    const message = parseClientMessage(textOf(data));
    if (message === null) {
      closeConn(conn, WS_CLOSE.POLICY, 'invalid message');
      return;
    }
    if (message.type === 'sub') subscribe(conn, message.topics);
    else for (const topic of message.topics) leave(conn, topic);
  }

  function detach(conn: Conn): void {
    if (conn.closed) return;
    conn.closed = true;
    conns.delete(conn);
    wsSocketClosed();
    const open = (addresses.get(conn.client.address) ?? 1) - 1;
    if (open > 0) addresses.set(conn.client.address, open);
    else addresses.delete(conn.client.address);
    conn.checking.clear();
    for (const topic of [...conn.topics.keys()]) leave(conn, topic);
    if (conn.principal.kind === 'user') removeUser(conn, conn.principal.userId);
    if (conns.size === 0) drained?.();
  }

  function attach(socket: GatewaySocket, principal: Principal, client: ClientInfo): void {
    if (closing) {
      socket.close(WS_CLOSE.GOING_AWAY, 'server shutting down');
      return;
    }
    const t = now();
    const conn: Conn = {
      socket,
      principal,
      client,
      log: log.child({ principal: principalLabel(principal) }),
      topics: new Map(),
      checking: new Map(),
      sent: new Map(),
      closed: false,
      missedPongs: 0,
      stalledSince: undefined,
      frames: fixedWindow(limits.messagesPerSecond, 1_000, t),
      joins: fixedWindow(limits.maxJoinsPerWindow, limits.joinWindowMs, t),
      lastSentAt: t,
    };
    conns.add(conn);
    // Paired with `detach`, which runs once per socket (`conn.closed`), so the gauge cannot drift.
    wsSocketOpened();
    addresses.set(client.address, (addresses.get(client.address) ?? 0) + 1);
    socket.on('message', (data, isBinary) => onClientMessage(conn, data, isBinary));
    socket.on('pong', () => {
      conn.missedPongs = 0;
    });
    socket.on('close', () => detach(conn));
    if (principal.kind === 'user') addUser(conn, principal.userId);
    const hello: HelloMessage = { type: 'hello', instanceId: deps.instanceId, serverTime: t };
    send(conn, JSON.stringify(hello), false);
  }

  // --- timers ----------------------------------------------------------------------------------------------

  function pingRound(): void {
    const t = now();
    for (const conn of conns) {
      // The principal was fixed at upgrade: a session that has expired since must not keep hearing its
      // user's events, or an admin's dashboard (§11). The client reconnects with its current cookie.
      if (conn.principal.kind === 'user' && conn.principal.expiresAt <= t) {
        if (conn.socket.readyState === WebSocket.OPEN) {
          closeConn(conn, WS_CLOSE.SESSION_EXPIRED, 'session expired');
        }
        continue;
      }
      if (conn.missedPongs >= limits.maxMissedPongs) {
        conn.log.info({ missedPongs: conn.missedPongs }, 'websocket missed its pongs; dropping it');
        conn.socket.terminate();
        continue;
      }
      conn.missedPongs += 1;
      if (conn.socket.readyState === WebSocket.OPEN) conn.socket.ping();
    }
  }

  function watchdog(): void {
    const t = now();
    for (const conn of conns) {
      if (conn.socket.readyState !== WebSocket.OPEN) continue;
      const buffered = conn.socket.bufferedAmount;
      if (buffered > limits.closeAboveBytes) {
        closeConn(conn, WS_CLOSE.TRY_AGAIN_LATER, 'send buffer full');
        continue;
      }
      if (buffered <= limits.skipAboveBytes) {
        conn.stalledSince = undefined;
      } else {
        conn.stalledSince ??= t;
        if (t - conn.stalledSince >= limits.stallCloseMs) {
          closeConn(conn, WS_CLOSE.TRY_AGAIN_LATER, 'stalled');
          continue;
        }
      }
      if (conn.client.beats && t - conn.lastSentAt >= limits.beatIntervalMs) {
        const beat: BeatMessage = { type: 'beat', serverTime: t };
        send(conn, JSON.stringify(beat), true);
      }
    }
  }

  const timers = [
    setInterval(pingRound, limits.pingIntervalMs),
    setInterval(watchdog, limits.watchdogIntervalMs),
    setInterval(() => void viewerTick(), limits.viewerIntervalMs),
  ];
  for (const timer of timers) timer.unref();
  coalescer.start();

  return {
    attach,

    socketsFrom: (address) => addresses.get(address) ?? 0,

    async resnapshot() {
      log.info({ topics: topics.size }, 'redis subscriber reconnected; re-snapshotting');
      await Promise.all([
        rooms.refresh().catch((err: unknown) => log.warn({ err }, 'room re-snapshot failed')),
        ...[...topics.values()].filter((state) => state.kind !== 'room').map(refreshTopic),
      ]);
    },

    async close() {
      if (closing) return;
      closing = true;
      log.info({ sockets: conns.size, topics: topics.size }, 'closing websocket gateway');
      for (const timer of timers) clearInterval(timer);
      coalescer.stop();
      const done = new Promise<void>((resolve) => {
        drained = resolve;
      });
      for (const conn of conns) conn.socket.close(WS_CLOSE.GOING_AWAY, 'server shutting down');
      if (conns.size === 0) drained?.();
      await Promise.all([
        rooms.forget().catch((err: unknown) => log.warn({ err }, 'viewer fields not removed')),
        Promise.race([done, new Promise((resolve) => setTimeout(resolve, limits.closeGraceMs))]),
      ]);
      // Clients that did not answer the close frame in time.
      for (const conn of conns) conn.socket.terminate();
    },
  };
}

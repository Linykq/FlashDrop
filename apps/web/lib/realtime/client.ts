import type { Topic, UserEventMessage } from '@flashdrop/contracts';
import { encodeClientMessage, isNewer, parseServerMessage, type Version } from './protocol';

/*
 * The tab's one WebSocket to the gateway (SD §7, §8.2): many topics over one socket, whichever pages and
 * islands ask for them. Components never hold the socket; they subscribe to topics here and read levels
 * through `useSyncExternalStore` (`hooks.ts`).
 *
 * - Topics. A topic is subscribed on the socket while anything listens to it, plus a short linger, so a page
 *   that unmounts and mounts the same island (a client navigation, a re-keyed list) doesn't unsubscribe and
 *   resubscribe. Changes are sent in batches, at most one `sub` and one `unsub` every 250 ms, far inside
 *   the gateway's 20 frames per second.
 * - Levels. Every snapshot and delta carries a full level and its version `(gen, seq)`. The newest one per
 *   topic is kept, so an island that subscribes later starts from it. Listeners still see every frame:
 *   they gate on the version themselves, against their own seed (the SSR snapshot), which may be newer.
 * - Reconnects. A socket that closes is reopened with full-jitter exponential backoff, 0.5 s doubling to
 *   10 s, and every topic is subscribed again, so each gets a fresh snapshot: stock is a level, not a log,
 *   so a snapshot is all a client ever needs to catch up (§7 step 4). The backoff starts over only after a
 *   socket stayed open for 5 s, so a gateway that accepts and drops at once is not hammered.
 * - Offline. When the browser says it went offline, the socket is closed and counted as lost at once: a
 *   browser keeps a WebSocket "open" through a lost network until TCP gives up, minutes later, and in the
 *   meantime the page would show its last level as live. Back online, the reconnect goes without waiting
 *   out its backoff.
 * - Paused. After 5 s without an open socket while something listens, the status says `paused`, and pages
 *   say "Live updates paused" and poll instead (§7 step 5).
 * - Session changes. The gateway fixes a socket's principal at the upgrade (§7), so after a sign-in, sign-out
 *   or account switch `reconnect()` replaces the socket at once with one carrying the new cookie, and every
 *   topic is subscribed again on it, refused ones included.
 * - Server time. `hello.serverTime` measures the tab's offset to the server's clock, which every countdown
 *   uses (`clock.ts`).
 * - Idle. With nothing listening for 10 s, the socket closes; the next subscription opens a new one.
 */

/** A snapshot or delta, as received; `data` is checked by whoever reads the topic. */
export type LevelFrame = Version & {
  kind: 'snapshot' | 'delta';
  topic: Topic;
  /** For a delta, when its newest change happened (stock: the Redis mutation time), in ms. */
  ts: number | null;
  data: unknown;
};

export type RealtimeStatus = {
  /** A socket is open: levels arrive as they change. */
  readonly connected: boolean;
  /** No socket for more than 5 s while something listens: live levels may be stale. */
  readonly paused: boolean;
  /** The gateway instance of the open socket, from its `hello`. */
  readonly instanceId: string | null;
};

export interface SocketHandlers {
  onOpen(): void;
  onMessage(text: string): void;
  onClose(code: number): void;
}

/** The part of a WebSocket the client uses; `browserSocket` adapts the real one, tests use fakes. */
export interface SocketLike {
  send(data: string): void;
  close(code: number, reason: string): void;
}

export type SocketFactory = (url: string, handlers: SocketHandlers) => SocketLike;

export interface RealtimeDeps {
  /** The gateway's URL, asked once per connection attempt. */
  url(): string;
  createSocket: SocketFactory;
  /** A reading of the server's clock taken during a connect that started at `sentAt` (`noteServerTime`). */
  onServerTime(serverTime: number, sentAt: number, receivedAt: number): void;
  /** Subscribes to the browser going offline (`false`) and coming back online (`true`); returns the unsubscribe. */
  onNetwork(listener: (online: boolean) => void): () => void;
  /** Reports a bug (a malformed frame, a refused topic) without breaking the page: `reportError`. */
  report(error: Error): void;
  random(): number;
  now(): number;
}

export const REALTIME_TIMING = {
  backoffBaseMs: 500,
  backoffMaxMs: 10_000,
  /** A socket open this long counts as stable: the next reconnect starts the backoff over. */
  stableMs: 5_000,
  pausedAfterMs: 5_000,
  syncIntervalMs: 250,
  lingerMs: 2_000,
  idleCloseMs: 10_000,
} as const;

/** The most topics one `sub` or `unsub` may name (`WS_MAX_TOPICS_PER_SOCKET`). */
const MAX_TOPICS_PER_MESSAGE = 64;
/** A normal close: the client is done with the socket. */
const CLOSE_NORMAL = 1000;

type TopicEntry = {
  readonly listeners: Set<(frame: LevelFrame) => void>;
  latest: LevelFrame | null;
  linger: ReturnType<typeof setTimeout> | undefined;
};

type Phase = 'idle' | 'connecting' | 'open' | 'waiting';

const INITIAL_STATUS: RealtimeStatus = { connected: false, paused: false, instanceId: null };

export class RealtimeClient {
  readonly #deps: RealtimeDeps;
  readonly #topics = new Map<Topic, TopicEntry>();
  readonly #userListeners = new Set<(event: UserEventMessage) => void>();
  readonly #statusListeners = new Set<() => void>();
  /** Topics the current socket holds, as far as the client has asked. */
  readonly #subscribed = new Set<Topic>();
  #status: RealtimeStatus = INITIAL_STATUS;
  #phase: Phase = 'idle';
  #socket: SocketLike | null = null;
  #attempt = 0;
  #connectStartedAt = 0;
  #openedAt = 0;
  #lastSyncAt = Number.NEGATIVE_INFINITY;
  #syncTimer: ReturnType<typeof setTimeout> | undefined;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #pausedTimer: ReturnType<typeof setTimeout> | undefined;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #stopNetwork: (() => void) | undefined;

  constructor(deps: RealtimeDeps) {
    this.#deps = deps;
  }

  /**
   * Listens to a topic's snapshots and deltas. The newest level already received, if any, is delivered on
   * the next microtask, so a late subscriber catches up without waiting for a change.
   */
  subscribe(topic: Topic, listener: (frame: LevelFrame) => void): () => void {
    let entry = this.#topics.get(topic);
    if (entry === undefined) {
      entry = { listeners: new Set(), latest: null, linger: undefined };
      this.#topics.set(topic, entry);
    }
    const joined = entry;
    clearTimeout(joined.linger);
    joined.linger = undefined;
    joined.listeners.add(listener);
    if (joined.latest !== null) {
      queueMicrotask(() => {
        if (joined.listeners.has(listener) && joined.latest !== null) this.#deliver(listener, joined.latest);
      });
    }
    this.#demandChanged();
    return () => {
      if (!joined.listeners.delete(listener) || joined.listeners.size > 0) return;
      joined.linger = setTimeout(() => {
        if (this.#topics.get(topic) !== joined || joined.listeners.size > 0) return;
        this.#topics.delete(topic);
        this.#demandChanged();
      }, REALTIME_TIMING.lingerMs);
    };
  }

  /** The newest level received on a topic this client holds, or `null`. */
  latest(topic: Topic): LevelFrame | null {
    return this.#topics.get(topic)?.latest ?? null;
  }

  /** Listens to the signed-in owner's `order` and `listing` events; they are never coalesced (§7). */
  onUserEvent(listener: (event: UserEventMessage) => void): () => void {
    this.#userListeners.add(listener);
    this.#demandChanged();
    return () => {
      if (this.#userListeners.delete(listener)) this.#demandChanged();
    };
  }

  /** Status changes; read the status with `status()`. Listening alone does not open a socket. */
  onStatus(listener: () => void): () => void {
    this.#statusListeners.add(listener);
    return () => {
      this.#statusListeners.delete(listener);
    };
  }

  status(): RealtimeStatus {
    return this.#status;
  }

  /**
   * The session changed: the socket's `user` channel and rights belong to the account it was opened with, so
   * it is closed and replaced at once, with the backoff started over. Levels already received stay; the new
   * socket's snapshots supersede them, and a topic the new account may not read is refused again (admin
   * pages themselves are gated on the server). Without a socket there is nothing to do: the next one
   * carries the new cookie.
   */
  reconnect(): void {
    if (this.#phase === 'idle') return;
    if (!this.#hasDemand()) {
      this.#stop();
      return;
    }
    const socket = this.#socket;
    // Cleared first, so the close event this causes is ignored as a replaced socket's.
    this.#socket = null;
    this.#attempt = 0;
    this.#subscribed.clear();
    for (const timer of [this.#reconnectTimer, this.#syncTimer]) clearTimeout(timer);
    this.#reconnectTimer = undefined;
    this.#syncTimer = undefined;
    socket?.close(CLOSE_NORMAL, 'session changed');
    this.#setStatus({ connected: false, instanceId: null });
    this.#connect();
  }

  // --- demand ---------------------------------------------------------------------------------------------

  #hasDemand(): boolean {
    return this.#topics.size > 0 || this.#userListeners.size > 0;
  }

  #demandChanged(): void {
    if (this.#hasDemand()) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = undefined;
      this.#stopNetwork ??= this.#deps.onNetwork((online) =>
        online ? this.#reconnectNow() : this.#dropSocket(),
      );
      if (this.#phase === 'idle') this.#connect();
      else this.#scheduleSync();
      return;
    }
    switch (this.#phase) {
      case 'open':
        this.#scheduleSync();
        this.#idleTimer ??= setTimeout(() => {
          this.#idleTimer = undefined;
          if (!this.#hasDemand()) this.#stop();
        }, REALTIME_TIMING.idleCloseMs);
        return;
      case 'connecting':
      case 'waiting':
        this.#stop();
        return;
      case 'idle':
        return;
    }
  }

  /** Nothing listens: no socket, no reconnects, nothing reported as paused. */
  #stop(): void {
    const socket = this.#socket;
    this.#socket = null;
    this.#phase = 'idle';
    this.#attempt = 0;
    this.#subscribed.clear();
    for (const timer of [this.#reconnectTimer, this.#pausedTimer, this.#syncTimer]) clearTimeout(timer);
    this.#reconnectTimer = undefined;
    this.#pausedTimer = undefined;
    this.#syncTimer = undefined;
    this.#stopNetwork?.();
    this.#stopNetwork = undefined;
    socket?.close(CLOSE_NORMAL, 'idle');
    this.#setStatus(INITIAL_STATUS);
  }

  // --- the socket -----------------------------------------------------------------------------------------

  #connect(): void {
    this.#phase = 'connecting';
    this.#connectStartedAt = this.#deps.now();
    this.#startPausedTimer();
    let socket: SocketLike | null = null;
    // Each handler checks that its socket is still the current one: a late event from a socket that was
    // replaced or stopped must not touch the state of the next.
    const current = () => socket !== null && socket === this.#socket;
    socket = this.#deps.createSocket(this.#deps.url(), {
      onOpen: () => {
        if (current()) this.#onOpen();
      },
      onMessage: (text) => {
        if (current()) this.#onMessage(text);
      },
      onClose: () => {
        if (current()) this.#onClose();
      },
    });
    this.#socket = socket;
  }

  #onOpen(): void {
    this.#phase = 'open';
    this.#openedAt = this.#deps.now();
    clearTimeout(this.#pausedTimer);
    this.#pausedTimer = undefined;
    this.#subscribed.clear();
    this.#sync();
    this.#setStatus({ connected: true, paused: false });
  }

  #onClose(): void {
    const stable = this.#phase === 'open' && this.#deps.now() - this.#openedAt >= REALTIME_TIMING.stableMs;
    if (stable) this.#attempt = 0;
    this.#socket = null;
    this.#subscribed.clear();
    clearTimeout(this.#syncTimer);
    this.#syncTimer = undefined;
    this.#setStatus({ connected: false, instanceId: null });
    if (!this.#hasDemand()) {
      this.#stop();
      return;
    }
    this.#phase = 'waiting';
    this.#startPausedTimer();
    const ceiling = Math.min(
      REALTIME_TIMING.backoffMaxMs,
      REALTIME_TIMING.backoffBaseMs * 2 ** this.#attempt,
    );
    this.#attempt += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#connect();
    }, this.#deps.random() * ceiling);
  }

  /** The browser went offline: the socket, open or still connecting, is lost as far as the page goes. */
  #dropSocket(): void {
    const socket = this.#socket;
    if (socket === null) return;
    // Cleared first by #onClose, so the close event this causes is ignored as a replaced socket's.
    this.#onClose();
    socket.close(CLOSE_NORMAL, 'offline');
  }

  /** The browser is back online: a reconnect waiting out its backoff goes now. */
  #reconnectNow(): void {
    if (this.#phase !== 'waiting') return;
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    this.#connect();
  }

  #startPausedTimer(): void {
    if (this.#pausedTimer !== undefined || this.#status.paused) return;
    this.#pausedTimer = setTimeout(() => {
      this.#pausedTimer = undefined;
      if (!this.#status.connected && this.#hasDemand()) this.#setStatus({ paused: true });
    }, REALTIME_TIMING.pausedAfterMs);
  }

  #onMessage(text: string): void {
    const message = parseServerMessage(text);
    if (message === null) {
      this.#deps.report(new Error(`malformed realtime frame: ${text.slice(0, 200)}`));
      return;
    }
    switch (message.type) {
      case 'hello':
        this.#deps.onServerTime(message.serverTime, this.#connectStartedAt, this.#deps.now());
        this.#setStatus({ instanceId: message.instanceId });
        return;
      case 'snapshot':
      case 'delta': {
        const entry = this.#topics.get(message.topic);
        if (entry === undefined) return;
        const frame: LevelFrame = {
          kind: message.type,
          topic: message.topic,
          gen: message.gen,
          seq: message.seq,
          ts: message.type === 'delta' ? message.ts : null,
          data: message.data,
        };
        if (entry.latest === null || isNewer(frame, entry.latest)) entry.latest = frame;
        for (const listener of [...entry.listeners]) this.#deliver(listener, frame);
        return;
      }
      case 'order':
      case 'listing':
        for (const listener of [...this.#userListeners]) {
          try {
            listener(message);
          } catch (error) {
            this.#deps.report(asError(error));
          }
        }
        return;
      case 'error':
        // The topics stay counted as subscribed, so they are not asked for again on this socket: a refusal
        // is the gateway's answer for the socket's lifetime (an admin topic without an admin session).
        this.#deps.report(
          new Error(`realtime topics refused (${message.code}): ${message.topics.join(', ')}`),
        );
        return;
    }
  }

  #deliver(listener: (frame: LevelFrame) => void, frame: LevelFrame): void {
    try {
      listener(frame);
    } catch (error) {
      this.#deps.report(asError(error));
    }
  }

  // --- subscriptions --------------------------------------------------------------------------------------

  #scheduleSync(): void {
    if (this.#phase !== 'open' || this.#syncTimer !== undefined) return;
    const wait = Math.max(0, this.#lastSyncAt + REALTIME_TIMING.syncIntervalMs - this.#deps.now());
    this.#syncTimer = setTimeout(() => {
      this.#syncTimer = undefined;
      this.#sync();
    }, wait);
  }

  /** Sends what changed since the last sync: one `sub` and one `unsub` at most (per 64 topics). */
  #sync(): void {
    const socket = this.#socket;
    if (this.#phase !== 'open' || socket === null) return;
    this.#lastSyncAt = this.#deps.now();
    const add = [...this.#topics.keys()].filter((topic) => !this.#subscribed.has(topic));
    const remove = [...this.#subscribed].filter((topic) => !this.#topics.has(topic));
    for (const topics of chunks(add)) {
      socket.send(encodeClientMessage({ type: 'sub', topics }));
      for (const topic of topics) this.#subscribed.add(topic);
    }
    for (const topics of chunks(remove)) {
      socket.send(encodeClientMessage({ type: 'unsub', topics }));
      for (const topic of topics) this.#subscribed.delete(topic);
    }
  }

  #setStatus(patch: Partial<RealtimeStatus>): void {
    const next = { ...this.#status, ...patch };
    const current = this.#status;
    if (
      next.connected === current.connected &&
      next.paused === current.paused &&
      next.instanceId === current.instanceId
    ) {
      return;
    }
    this.#status = next;
    for (const listener of [...this.#statusListeners]) listener();
  }
}

function chunks(topics: readonly Topic[]): Topic[][] {
  const out: Topic[][] = [];
  for (let at = 0; at < topics.length; at += MAX_TOPICS_PER_MESSAGE) {
    out.push(topics.slice(at, at + MAX_TOPICS_PER_MESSAGE));
  }
  return out;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

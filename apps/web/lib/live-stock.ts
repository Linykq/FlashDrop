import type { StockSnapshot, StockStatus } from '@flashdrop/contracts';
import { useCallback, useState, useSyncExternalStore } from 'react';
import { formatCount } from './format';
import { realtime } from './realtime/browser';
import type { LevelFrame } from './realtime/client';
import { isNewer, parseStockData, topicOf, type Version } from './realtime/protocol';
import type { StockState } from './stock';

/*
 * Live stock for the storefront (SD §7, §8.2): one store per drop and tab, read through useSyncExternalStore,
 * so every island showing a drop (the status line, the purchase panel, a drop card) renders the same state.
 * Levels arrive on the drop's `stock:<dropId>` topic over the tab's one socket (`realtime/`); while the socket
 * has been down for over 5 s, the store polls `GET /api/v1/drops/:dropId/stock` (one atomic `HMGET`) every
 * 3 s instead, and the page says "Live updates paused".
 *
 * Every level carries its `(gen, seq)` version and the store applies only strictly newer ones, so the SSR
 * snapshot, a frame, a poll and a later rebuild can arrive in any order and the display never goes backwards:
 * a rebuild bumps `gen` and restarts `seq` at 0 (SD §4.1, §4.7). Levels taken while the drop is RECONCILING
 * are ignored: the hash is mid-rebuild and the last good state stays on screen.
 *
 * Polled snapshots are checked with a type guard rather than the Zod contract, to keep Zod out of the
 * product page's first load (design-system §14); the shape is `StockSnapshot` from the contracts.
 */

export type StockVersion = Version;

/** A drop's stock as the storefront shows it, with its version. */
export type LiveLevel = StockState & StockVersion;

export type LiveStock = {
  level: LiveLevel;
  /** The socket has been down for over 5 s: the numbers may be stale, and LiveStock says so (§9.9). */
  paused: boolean;
  /**
   * The level came in while the buyer's own press was in flight, or from the refresh after it. The Buy button
   * or the note under it speaks for that press, so no stock announcement does (§9.9, §9.13).
   */
  quiet: boolean;
};

/** SD §7 step 5: while paused, a poll every 3 s. */
const POLL_MS = 3_000;
const POLL_JITTER_MS = 500;
const POLL_TIMEOUT_MS = 4_000;
/** A socket that sends no frame for a drop this long after subscribing it gets one poll (no snapshot). */
const FIRST_FRAME_WAIT_MS = 5_000;
/** The longest a press waits for its refresh before its note shows anyway. */
const REFRESH_WAIT_MS = 1_000;

type Snapshot = Omit<LiveLevel, 'status'> & { status: StockStatus };

const STATUSES: readonly string[] = [
  'SCHEDULED',
  'LIVE',
  'PAUSED',
  'ENDED',
  'RECONCILING',
] satisfies readonly StockStatus[];

const isStatus = (value: unknown): value is StockStatus =>
  typeof value === 'string' && STATUSES.includes(value);
const isUnits = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 0;
/** `gen` is -1 only in the fail-closed hash of a drop that was never rebuilt. */
const isGen = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= -1;

/** A `StockSnapshot` body, or `null` for anything else. */
export function parseSnapshot(body: unknown): Snapshot | null {
  if (typeof body !== 'object' || body === null) return null;
  if (!('status' in body && 'avail' in body && 'held' in body && 'sold' in body)) return null;
  if (!('gen' in body && 'seq' in body)) return null;
  const { status, avail, held, sold, gen, seq } = body satisfies Partial<
    Record<keyof StockSnapshot, unknown>
  >;
  if (!isStatus(status) || !isUnits(avail) || !isUnits(held) || !isUnits(sold)) return null;
  if (!isGen(gen) || !isUnits(seq)) return null;
  return { status, avail, held, sold, gen, seq };
}

/** A `stock:` frame as a snapshot, or `null` when its data is malformed (reported). */
function frameSnapshot(frame: LevelFrame): Snapshot | null {
  const data = parseStockData(frame.data);
  if (data === null) {
    reportError(new Error(`malformed stock data on ${frame.topic}`));
    return null;
  }
  return { ...data, gen: frame.gen, seq: frame.seq };
}

type Entry = {
  readonly dropId: string;
  snapshot: LiveStock;
  readonly listeners: Set<() => void>;
  stop: (() => void) | undefined;
  pollTimer: ReturnType<typeof setTimeout> | undefined;
  frameTimer: ReturnType<typeof setTimeout> | undefined;
  inflight: AbortController | undefined;
  /** The buyer's own presses in flight: levels that arrive meanwhile are theirs to speak for. */
  presses: number;
  /** A frame arrived since the socket last opened (or since the drop was subscribed on it). */
  framed: boolean;
  readonly onVisibilityChange: () => void;
};

const entries = new Map<string, Entry>();

function update(entry: Entry, next: Partial<LiveStock>): void {
  entry.snapshot = { ...entry.snapshot, ...next };
  for (const listener of entry.listeners) listener();
}

/** Applies a level if it is newer; a rebuild in progress (RECONCILING) leaves the last good state on screen. */
function apply(entry: Entry, snapshot: Snapshot, quiet: boolean): void {
  const { status } = snapshot;
  if (status === 'RECONCILING' || !isNewer(snapshot, entry.snapshot.level)) return;
  update(entry, { level: { ...snapshot, status }, quiet: quiet || entry.presses > 0 });
}

function polling(entry: Entry): boolean {
  // An ended drop no longer changes in a way the page shows.
  return (
    entry.listeners.size > 0 &&
    !document.hidden &&
    realtime().status().paused &&
    entry.snapshot.level.status !== 'ENDED'
  );
}

function schedulePoll(entry: Entry, delay: number): void {
  clearTimeout(entry.pollTimer);
  entry.pollTimer = polling(entry) ? setTimeout(() => void poll(entry), delay) : undefined;
}

async function poll(entry: Entry, quiet = false): Promise<void> {
  entry.inflight?.abort();
  const controller = new AbortController();
  entry.inflight = controller;
  let snapshot: Snapshot | null = null;
  try {
    const response = await fetch(`/api/v1/drops/${encodeURIComponent(entry.dropId)}/stock`, {
      cache: 'no-store',
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(POLL_TIMEOUT_MS)]),
    });
    if (response.ok) snapshot = parseSnapshot(await response.json());
  } catch {
    // Replaced by a newer poll or stopped: that one owns the schedule. Otherwise a timeout or no network:
    // the socket is down too, and the page already says live updates are paused.
    if (controller.signal.aborted) return;
  } finally {
    if (entry.inflight === controller) entry.inflight = undefined;
  }
  if (snapshot) apply(entry, snapshot, quiet);
  schedulePoll(entry, POLL_MS + Math.random() * POLL_JITTER_MS);
}

/** The socket opened, or the drop was subscribed on an open one: its snapshot is due. */
function awaitFirstFrame(entry: Entry): void {
  entry.framed = false;
  clearTimeout(entry.frameTimer);
  entry.frameTimer = setTimeout(() => {
    // The gateway could not read the drop (§7: no snapshot then); one poll fills in.
    if (!entry.framed && entry.listeners.size > 0) void poll(entry);
  }, FIRST_FRAME_WAIT_MS);
}

function onStatus(entry: Entry): void {
  const { connected, paused } = realtime().status();
  if (paused !== entry.snapshot.paused) update(entry, { paused });
  if (connected) {
    clearTimeout(entry.pollTimer);
    entry.pollTimer = undefined;
    awaitFirstFrame(entry);
  } else {
    clearTimeout(entry.frameTimer);
    // Paused this moment: poll at once, then every 3 s.
    if (paused && entry.pollTimer === undefined) schedulePoll(entry, 0);
  }
}

function entryFor(dropId: string, seed: LiveLevel): Entry {
  const existing = entries.get(dropId);
  if (existing) {
    // A fresher server render, after a client-side navigation back to the page.
    if (isNewer(seed, existing.snapshot.level)) {
      existing.snapshot = { ...existing.snapshot, level: seed, quiet: false };
    }
    return existing;
  }
  const entry: Entry = {
    dropId,
    snapshot: { level: seed, paused: false, quiet: false },
    listeners: new Set(),
    stop: undefined,
    pollTimer: undefined,
    frameTimer: undefined,
    inflight: undefined,
    presses: 0,
    framed: false,
    // Timers are throttled in background tabs: polling stops there and resumes with a poll on return.
    onVisibilityChange: () => {
      if (document.hidden) {
        clearTimeout(entry.pollTimer);
        entry.pollTimer = undefined;
      } else {
        schedulePoll(entry, 0);
      }
    },
  };
  entries.set(dropId, entry);
  return entry;
}

function start(entry: Entry): void {
  const client = realtime();
  const stopTopic = client.subscribe(topicOf('stock', entry.dropId), (frame) => {
    entry.framed = true;
    const snapshot = frameSnapshot(frame);
    if (snapshot) apply(entry, snapshot, false);
  });
  const stopStatus = client.onStatus(() => onStatus(entry));
  document.addEventListener('visibilitychange', entry.onVisibilityChange);
  entry.stop = () => {
    stopTopic();
    stopStatus();
    document.removeEventListener('visibilitychange', entry.onVisibilityChange);
    clearTimeout(entry.pollTimer);
    clearTimeout(entry.frameTimer);
    entry.pollTimer = undefined;
    entry.inflight?.abort();
  };
  onStatus(entry);
}

/**
 * Listens to a drop's live stock, seeding its store with `seed` (or anything newer it already has); the first
 * listener subscribes the drop's topic, the last one leaving releases it. `useLiveStock` is the React view.
 */
export function subscribeLiveStock(dropId: string, seed: LiveLevel, listener: () => void): () => void {
  const entry = entryFor(dropId, seed);
  entry.listeners.add(listener);
  if (entry.listeners.size === 1) start(entry);
  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size > 0) return;
    entry.stop?.();
    entry.stop = undefined;
  };
}

/**
 * Polls the drop now, after the buyer's own press reserved or was refused, rather than waiting for the
 * socket. The level it brings is `quiet`. Resolves once that poll has answered, or after 1 s, whichever
 * comes first, so a refusal's note can wait for the stock it is worded from (§9.13); it never rejects.
 */
export function refreshLiveStock(dropId: string): Promise<void> {
  const entry = entries.get(dropId);
  if (entry === undefined || entry.listeners.size === 0) return Promise.resolve();
  clearTimeout(entry.pollTimer);
  entry.pollTimer = undefined;
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, REFRESH_WAIT_MS);
    void poll(entry, true).finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Marks the buyer's own press on the drop as in flight until the returned function is called: the frame
 * that carries its own hold arrives meanwhile, and the press speaks for it, not a stock announcement.
 */
export function holdStockAnnouncements(dropId: string): () => void {
  const entry = entries.get(dropId);
  if (entry === undefined) return () => {};
  entry.presses += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.presses -= 1;
  };
}

/**
 * The drop's live stock, starting from the server's snapshot `seed`. Server render and hydration use the
 * seed itself, so the markup matches; afterwards the store's state, which is the seed or anything newer. A
 * new `dropId` (a live room pinning another drop) starts again from that drop's seed.
 */
export function useLiveStock(dropId: string, seed: LiveLevel): LiveStock {
  const [initial, setInitial] = useState(() => ({ dropId, stock: fresh(seed) }));
  if (initial.dropId !== dropId) setInitial({ dropId, stock: fresh(seed) });
  const current = initial.dropId === dropId ? initial.stock : fresh(seed);
  const subscribeToDrop = useCallback(
    (listener: () => void) => subscribeLiveStock(dropId, current.level, listener),
    [dropId, current],
  );
  const getSnapshot = useCallback(() => liveStockOf(dropId) ?? current, [dropId, current]);
  return useSyncExternalStore(subscribeToDrop, getSnapshot, () => current);
}

/** The drop's live stock while anything listens to it (or since it last did), else `undefined`. */
export function liveStockOf(dropId: string): LiveStock | undefined {
  return entries.get(dropId)?.snapshot;
}

function fresh(level: LiveLevel): LiveStock {
  return { level, paused: false, quiet: false };
}

/**
 * What a screen reader hears when live stock changes (design-system §9.9): only threshold crossings (10, 5
 * and 1 left), becoming all reserved or sold out, and coming back from 0. `null` for every other change.
 */
export function stockAnnouncement(previous: StockState, next: StockState): string | null {
  if (previous.status !== 'LIVE' || next.status !== 'LIVE') return null;
  const before = previous.avail;
  const after = next.avail;
  if (after === 0) {
    if (next.held > 0) return before > 0 ? 'All reserved. Some may free up.' : null;
    return before > 0 || previous.held > 0 ? 'Sold out.' : null;
  }
  if (before === 0) return `Available again. ${formatCount(after)} left.`;
  if (after < before && [1, 5, 10].some((threshold) => after <= threshold && before > threshold)) {
    return `${formatCount(after)} left.`;
  }
  return null;
}

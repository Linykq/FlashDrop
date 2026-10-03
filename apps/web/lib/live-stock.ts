import type { StockStatus } from '@flashdrop/contracts';
import { useCallback, useState, useSyncExternalStore } from 'react';
import { formatCount } from './format';
import type { StockState } from './stock';

/*
 * Live stock for the storefront (SD §8.2): one store per drop and tab, read through useSyncExternalStore, so
 * every island showing a drop (the status line, the purchase panel) renders the same state. Until the
 * WebSocket client arrives (M5), the store polls `GET /api/v1/drops/:dropId/stock`, the atomic `HMGET` of the
 * drop's Redis hash; M5 swaps the transport and keeps this interface.
 *
 * Every level carries its `(gen, seq)` version and the store applies only strictly newer ones, so the SSR
 * snapshot, a slow poll and a later rebuild can arrive in any order and the display never goes backwards: a
 * rebuild bumps `gen` and restarts `seq` at 0 (SD §4.1, §4.7). Snapshots taken while the drop is RECONCILING
 * are ignored: the hash is mid-rebuild and the last good state stays on screen.
 *
 * Snapshots are checked with a type guard rather than the Zod contract, to keep Zod out of the product page's
 * first load (design-system §14); the shape is `StockSnapshot` from the contracts.
 */

export type StockVersion = { gen: number; seq: number };

/** A drop's stock as the storefront shows it, with its version. */
export type LiveLevel = StockState & StockVersion;

export type LiveStock = {
  level: LiveLevel;
  /** No snapshot arrived for over 5 s: the numbers may be stale, and LiveStock says so (§9.9). */
  paused: boolean;
  /**
   * The level came from the refresh after the buyer's own press (`refreshLiveStock`). The Buy button or the
   * note under it speaks for that press, so no stock announcement does (§9.9, §9.13).
   */
  quiet: boolean;
};

/** Whether `next` is strictly newer than `current`, comparing `(gen, seq)` lexicographically. */
export function isNewer(next: StockVersion, current: StockVersion): boolean {
  return next.gen > current.gen || (next.gen === current.gen && next.seq > current.seq);
}

const POLL_MS = 2_500;
const POLL_JITTER_MS = 500;
const POLL_TIMEOUT_MS = 4_000;
/** SD §7: after 5 s without updates the UI says "Live updates paused". */
const PAUSED_AFTER_MS = 5_000;
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
  const { status, avail, held, sold, gen, seq } = body;
  if (!isStatus(status) || !isUnits(avail) || !isUnits(held) || !isUnits(sold)) return null;
  if (!isGen(gen) || !isUnits(seq)) return null;
  return { status, avail, held, sold, gen, seq };
}

type Entry = {
  dropId: string;
  snapshot: LiveStock;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setTimeout> | undefined;
  inflight: AbortController | undefined;
  lastSuccess: number;
  onVisibilityChange: () => void;
};

const entries = new Map<string, Entry>();

function update(entry: Entry, next: Partial<LiveStock>): void {
  entry.snapshot = { ...entry.snapshot, ...next };
  for (const listener of entry.listeners) listener();
}

function schedule(entry: Entry, delay: number): void {
  clearTimeout(entry.timer);
  // An ended drop no longer changes in a way the page shows.
  if (entry.listeners.size === 0 || document.hidden || entry.snapshot.level.status === 'ENDED') return;
  entry.timer = setTimeout(() => void poll(entry), delay);
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
    // Replaced by a newer poll or stopped: that one owns the schedule. Otherwise a timeout or no network,
    // which matters only once polls keep failing, and the paused state below reports exactly that.
    if (controller.signal.aborted) return;
  } finally {
    if (entry.inflight === controller) entry.inflight = undefined;
  }

  if (snapshot) {
    entry.lastSuccess = Date.now();
    const { status } = snapshot;
    const { level, paused } = entry.snapshot;
    // A rebuild in progress (RECONCILING) leaves the last good state on screen.
    const fresh = status !== 'RECONCILING' && isNewer(snapshot, level) ? { ...snapshot, status } : null;
    if (fresh) update(entry, { paused: false, level: fresh, quiet });
    else if (paused) update(entry, { paused: false });
  } else if (!entry.snapshot.paused && Date.now() - entry.lastSuccess > PAUSED_AFTER_MS) {
    update(entry, { paused: true });
  }
  schedule(entry, POLL_MS + Math.random() * POLL_JITTER_MS);
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
    timer: undefined,
    inflight: undefined,
    lastSuccess: Date.now(),
    // Timers are throttled in background tabs: polling stops there and resumes with a poll on return,
    // with a fresh grace period before the paused state.
    onVisibilityChange: () => {
      if (document.hidden) {
        clearTimeout(entry.timer);
        return;
      }
      entry.lastSuccess = Date.now();
      schedule(entry, 0);
    },
  };
  entries.set(dropId, entry);
  return entry;
}

function subscribe(dropId: string, seed: LiveLevel, listener: () => void): () => void {
  // A store that outlived its listeners belongs to a page shown again (Next keeps visited pages in a hidden
  // <Activity>) or opened again: its level is as old as the time away, so it polls at once. A new store
  // starts from the server's fresh snapshot.
  const returning = entries.has(dropId);
  const entry = entryFor(dropId, seed);
  entry.listeners.add(listener);
  if (entry.listeners.size === 1) {
    document.addEventListener('visibilitychange', entry.onVisibilityChange);
    entry.lastSuccess = Date.now();
    schedule(entry, returning ? 0 : POLL_MS);
  }
  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size > 0) return;
    document.removeEventListener('visibilitychange', entry.onVisibilityChange);
    clearTimeout(entry.timer);
    entry.inflight?.abort();
  };
}

/**
 * Polls the drop now, after the buyer's own press reserved or was refused, rather than at the next tick. The
 * level it brings is `quiet`. Resolves once that poll has answered, or after 1 s, whichever comes first, so a
 * refusal's note can wait for the stock it is worded from (§9.13); it never rejects.
 */
export function refreshLiveStock(dropId: string): Promise<void> {
  const entry = entries.get(dropId);
  if (entry === undefined || entry.listeners.size === 0) return Promise.resolve();
  clearTimeout(entry.timer);
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, REFRESH_WAIT_MS);
    void poll(entry, true).finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * The drop's live stock, starting from the server's snapshot `seed`. Server render and hydration use the
 * seed itself, so the markup matches; afterwards the store's state, which is the seed or anything newer.
 */
export function useLiveStock(dropId: string, seed: LiveLevel): LiveStock {
  const [initial] = useState<LiveStock>(() => ({ level: seed, paused: false, quiet: false }));
  const subscribeToDrop = useCallback(
    (listener: () => void) => subscribe(dropId, initial.level, listener),
    [dropId, initial],
  );
  const getSnapshot = useCallback(() => entries.get(dropId)?.snapshot ?? initial, [dropId, initial]);
  return useSyncExternalStore(subscribeToDrop, getSnapshot, () => initial);
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

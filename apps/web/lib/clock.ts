import { useState, useSyncExternalStore } from 'react';

/*
 * One shared 1 s clock for every countdown on the page (design-system §8.7): a single setTimeout chain
 * aligned to second boundaries, running only while something subscribes and paused while the tab is hidden,
 * so a page with nine tiles still wakes the CPU once a second, and a background tab not at all.
 *
 * Countdowns run on the server's clock, not the device's: each reads `Date.now()` plus an offset (server minus
 * device). A page's render carries the server's clock (`serverNow`), which gives a first estimate; a request
 * whose answer carries `serverNow` measures it properly, and the most precise measurement serves every
 * countdown in the tab from then on.
 */

type Listener = () => void;

const listeners = new Set<Listener>();
let timer: ReturnType<typeof setTimeout> | undefined;
let now = 0;

/** The tab's best measurement of the server's clock, with how far off it can be (half its round trip). */
let measured: { offset: number; error: number } | null = null;

function notify(): void {
  now = Date.now();
  for (const listener of listeners) listener();
}

function tick(): void {
  notify();
  schedule();
}

function schedule(): void {
  clearTimeout(timer);
  if (listeners.size === 0 || document.hidden) return;
  // Wake just after the next whole second, so every countdown flips its digits together.
  timer = setTimeout(tick, 1000 - (Date.now() % 1000));
}

// Timers are throttled in hidden tabs, so the clock stops there and resyncs at once when the tab returns.
function onVisibilityChange(): void {
  if (document.hidden) clearTimeout(timer);
  else tick();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    document.addEventListener('visibilitychange', onVisibilityChange);
    // A fresh reading for the first subscriber: React compares snapshots after subscribing and re-renders
    // if the time it rendered with is stale.
    now = Date.now();
    schedule();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
  };
}

/**
 * The offset a request measures: the server read its clock somewhere between `sentAt` and `receivedAt`
 * (device time), so at `receivedAt` it reads `serverNow` plus up to the whole round trip. The midpoint is off
 * by at most half of it either way.
 */
export function offsetFromRoundTrip(
  serverNow: number,
  sentAt: number,
  receivedAt: number,
): { offset: number; error: number } {
  const error = Math.max(0, receivedAt - sentAt) / 2;
  return { offset: serverNow + error - receivedAt, error };
}

/**
 * Records a reading of the server's clock taken by a request (SD §8.3: the offset never relies on the device's
 * clock). It replaces the tab's measurement only if it is more precise, and every countdown re-renders on it.
 */
export function noteServerTime(serverNow: number, sentAt: number, receivedAt: number): void {
  const reading = offsetFromRoundTrip(serverNow, sentAt, receivedAt);
  if (measured !== null && measured.error <= reading.error) return;
  measured = reading;
  if (listeners.size > 0) notify();
}

/**
 * When the first byte of a response arrived, in device time: `responseStart` is on the monotonic clock
 * (`performance.now()`), so it is measured back from now on that clock, and a device clock adjusted since
 * doesn't skew it. `null` without navigation timing.
 */
export function responseArrivedAt(
  responseStart: number | undefined,
  monotonicNow: number,
  wallNow: number,
): number | null {
  if (responseStart === undefined || responseStart <= 0) return null;
  return wallNow - (monotonicNow - responseStart);
}

function documentResponseAt(): number | null {
  const [entry] = performance.getEntriesByType('navigation');
  const responseStart =
    entry && 'responseStart' in entry && typeof entry.responseStart === 'number'
      ? entry.responseStart
      : undefined;
  return responseArrivedAt(responseStart, performance.now(), Date.now());
}

const subscribeNever = () => () => {};

/**
 * The current time in server terms, ticking once a second. `serverNow` is the server's clock when it rendered
 * the page (SSR passes it down): it is both the value used for the server render and hydration, so the markup
 * matches, and the page's first estimate of the offset, until a request measures it (`noteServerTime`).
 * Checkout's hold ends 2 s early for what remains of the error (SD §8.3), and live pages refine it with the
 * socket's `hello.serverTime` (M5).
 */
export function useServerTime(serverNow: number): number {
  // `true` only while this component hydrates the server's markup (React renders the server snapshot then).
  const hydrating = useSyncExternalStore(
    subscribeNever,
    () => false,
    () => true,
  );
  // The page's own estimate, taken once. Hydrating, the reading is anchored at the document's first byte: off
  // by the network's one-way delay when the server read its clock before sending it, and ahead when the
  // reading streamed in after it (the countdown ends early, the safe side). Hydration itself can come seconds
  // later on a slow device, and anchoring there would make every countdown run that much late. Rendered after
  // a client navigation, the payload arrived just before the mount. The server never reads its clock here: it
  // renders `serverNow`, and a clock read while prerendering would fail the build under Cache Components.
  const [estimate] = useState(() =>
    typeof window === 'undefined' ? 0 : serverNow - ((hydrating ? documentResponseAt() : null) ?? Date.now()),
  );
  return useSyncExternalStore(
    subscribe,
    // Until this component has subscribed, a stopped clock may hold a reading from an earlier page, so it
    // renders `serverNow`; the subscription then takes a fresh reading.
    () => (listeners.size === 0 ? serverNow : now + (measured?.offset ?? estimate)),
    () => serverNow,
  );
}

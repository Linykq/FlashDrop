import { useState, useSyncExternalStore } from 'react';

/*
 * One shared 1 s clock for every countdown on the page (design-system §8.7): a single setTimeout chain
 * aligned to second boundaries, running only while something subscribes and paused while the tab is hidden,
 * so a page with nine tiles still wakes the CPU once a second, and a background tab not at all.
 */

type Listener = () => void;

const listeners = new Set<Listener>();
let timer: ReturnType<typeof setTimeout> | undefined;
let now = 0;

function tick(): void {
  now = Date.now();
  for (const listener of listeners) listener();
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
 * The current time in server terms, ticking once a second. `serverNow` is the server's clock when it rendered
 * the page (SSR passes it down): it is both the value used for the server render and hydration, so the markup
 * matches, and the reference for the client's offset, so a skewed device clock never shifts a deadline.
 * The offset also absorbs the delivery delay of the page; checkout's hold ends 2 s early for that (SD §8.3),
 * and live pages refine it with the socket's `hello.serverTime` (M5).
 */
export function useServerTime(serverNow: number): number {
  // Measured once, at hydration or mount. The server never reads its clock here: it renders `serverNow`, and a
  // clock read while prerendering would fail the build under Cache Components.
  const [offset] = useState(() => (typeof window === 'undefined' ? 0 : serverNow - Date.now()));
  return useSyncExternalStore(
    subscribe,
    // Until this component has subscribed, a stopped clock may hold a reading from an earlier page, so it
    // renders `serverNow`; the subscription then takes a fresh reading.
    () => (listeners.size === 0 ? serverNow : now + offset),
    () => serverNow,
  );
}

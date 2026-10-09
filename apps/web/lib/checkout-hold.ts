import { useCallback, useMemo, useSyncExternalStore } from 'react';

/*
 * The hold of one order as checkout's two islands see it: the page (countdown, extension, form) and the reduced
 * bar's "Leave checkout" (design-system §9.18), which lives in the layout and must leave the bar at the very
 * moment the page's hold ends, whether its clock ran out, it was extended (a later deadline), or it ended for a
 * reason no clock shows (submitted, left, or api answered 410). One store per tab, read through
 * useSyncExternalStore, keyed by order id.
 *
 * Each reading carries the server time it was taken at, and the newest wins: a page rendered again by the
 * server after an extension (a reload, a refresh) supersedes an older reading kept here, and vice versa.
 *
 * Beside the hold, whether the page has a submit in flight: a fact of this tab, not a server reading, so it is
 * kept apart and never superseded by a render.
 */

/** Why the hold ended on screen before its clock did. */
export type HoldEnd = 'placed' | 'left' | 'expired';

export type CheckoutHold = {
  createdAt: string;
  expiresAt: string;
  /** How many of the one allowed extensions were used. */
  extensions: number;
  /** The server's clock, in epoch ms, when this reading was taken. */
  serverNow: number;
  ended: HoldEnd | null;
};

const holds = new Map<string, CheckoutHold>();
const submitting = new Set<string>();
const listeners = new Map<string, Set<() => void>>();

function notify(orderId: string): void {
  for (const listener of listeners.get(orderId) ?? []) listener();
}

function subscribe(orderId: string, listener: () => void): () => void {
  let set = listeners.get(orderId);
  if (!set) {
    set = new Set();
    listeners.set(orderId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(orderId);
  };
}

function latest(orderId: string, rendered: CheckoutHold): CheckoutHold {
  const stored = holds.get(orderId);
  return stored !== undefined && stored.serverNow >= rendered.serverNow ? stored : rendered;
}

/**
 * The order's hold: the newest of the server's render (`createdAt` … `serverNow`) and what this tab learned
 * since. `update` merges a change into it and tells every island showing the order.
 */
export function useCheckoutHold(
  orderId: string,
  { createdAt, expiresAt, extensions, serverNow }: Omit<CheckoutHold, 'ended'>,
): [hold: CheckoutHold, update: (change: Partial<CheckoutHold>) => void] {
  // One object per server reading, so the snapshot stays referentially stable between renders.
  const rendered = useMemo<CheckoutHold>(
    () => ({ createdAt, expiresAt, extensions, serverNow, ended: null }),
    [createdAt, expiresAt, extensions, serverNow],
  );
  const hold = useSyncExternalStore(
    useCallback((listener) => subscribe(orderId, listener), [orderId]),
    () => latest(orderId, rendered),
    () => rendered,
  );
  const update = useCallback(
    (change: Partial<CheckoutHold>) => {
      holds.set(orderId, { ...latest(orderId, rendered), ...change });
      notify(orderId);
    },
    [orderId, rendered],
  );
  return [hold, update];
}

/**
 * Whether the page has a checkout submit in flight for the order, from Pay until its answer (and, once
 * placed, until the order page shows). The bar's "Leave checkout" waits meanwhile (design-system §9.18): the
 * submit's answer decides the order, and a Leave confirmed in between would race it.
 */
export function useCheckoutSubmitting(orderId: string): boolean {
  return useSyncExternalStore(
    useCallback((listener) => subscribe(orderId, listener), [orderId]),
    () => submitting.has(orderId),
    () => false,
  );
}

/** Set by the page that owns the submit (`checkout-view.tsx`). */
export function setCheckoutSubmitting(orderId: string, inFlight: boolean): void {
  if (submitting.has(orderId) === inFlight) return;
  if (inFlight) submitting.add(orderId);
  else submitting.delete(orderId);
  notify(orderId);
}

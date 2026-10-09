import { useEffect, useEffectEvent } from 'react';

/*
 * Checkout's tabs tell each other what happened to an order's hold (BroadcastChannel, same origin), so a
 * second tab on the same checkout never keeps counting down a hold that ended or moved: submitted or left
 * in one tab closes it in the others at once, and an extension moves the deadline everywhere. A browser
 * without BroadcastChannel misses only the speed-up: each tab still asks the server when it is shown again
 * and when its clock runs out (`checkout-view.tsx`).
 *
 * A tab never receives its own messages: everything here goes through one channel object per tab.
 */

const CHANNEL_NAME = 'fd-checkout';

export type CheckoutMessage =
  /** The order left checkout in another tab: submitted, or left (cancelled). */
  | { orderId: string; kind: 'ended'; end: 'placed' | 'left' }
  /** Another tab extended the hold; the server's reading of it. */
  | { orderId: string; kind: 'hold'; expiresAt: string; extensions: number; serverNow: number };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * A message from another tab, checked: that tab may run an older or newer build of this page, so anything
 * this build doesn't understand is ignored.
 */
export function parseCheckoutMessage(data: unknown): CheckoutMessage | null {
  if (!isRecord(data) || typeof data.orderId !== 'string') return null;
  const { orderId } = data;
  if (data.kind === 'ended' && (data.end === 'placed' || data.end === 'left')) {
    return { orderId, kind: 'ended', end: data.end };
  }
  if (
    data.kind === 'hold' &&
    typeof data.expiresAt === 'string' &&
    !Number.isNaN(Date.parse(data.expiresAt)) &&
    Number.isInteger(data.extensions) &&
    Number(data.extensions) >= 0 &&
    typeof data.serverNow === 'number' &&
    Number.isFinite(data.serverNow)
  ) {
    return {
      orderId,
      kind: 'hold',
      expiresAt: data.expiresAt,
      extensions: Number(data.extensions),
      serverNow: data.serverNow,
    };
  }
  return null;
}

let channel: BroadcastChannel | null | undefined;

function tabChannel(): BroadcastChannel | null {
  if (channel === undefined) {
    channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL_NAME) : null;
  }
  return channel;
}

/** Tells this order's other checkout tabs. */
export function postCheckoutMessage(message: CheckoutMessage): void {
  tabChannel()?.postMessage(message);
}

/** Calls `onMessage` for what other tabs say about `orderId`, while mounted. */
export function useCheckoutMessages(orderId: string, onMessage: (message: CheckoutMessage) => void): void {
  const handle = useEffectEvent(onMessage);
  useEffect(() => {
    const tab = tabChannel();
    if (!tab) return;
    const listener = (event: MessageEvent) => {
      const message = parseCheckoutMessage(event.data);
      if (message?.orderId === orderId) handle(message);
    };
    tab.addEventListener('message', listener);
    return () => tab.removeEventListener('message', listener);
  }, [orderId]);
}

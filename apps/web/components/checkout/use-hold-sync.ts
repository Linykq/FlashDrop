'use client';

import { useEffect, useEffectEvent, useRef } from 'react';
import { useCheckoutMessages } from '../../lib/checkout-channel';
import type { CheckoutHold } from '../../lib/checkout-hold';
import { judgeReading } from '../../lib/hold';
import type { OrderState } from '../../lib/order-requests';
import { orderRequests } from '../../lib/use-order-requests';

type HoldSyncOptions = {
  orderId: string;
  hold: CheckoutHold;
  update: (change: Partial<CheckoutHold>) => void;
  /** The hold's clock ran out, and no submit is in flight whose answer would decide it. */
  clockEnded: boolean;
  /** The order left checkout elsewhere: submitted (and perhaps paid since), or left. */
  onLeft: (end: 'placed' | 'left') => void;
  /** Whether to keep in step at all: not once the page shows the hold's end. */
  enabled: boolean;
};

/** After hydration, when the first check runs: with the order requests' chunk, off the first load. */
const FIRST_CHECK_MS = 1_000;

/**
 * Keeps a checkout tab's hold in step with the server, because a hold can end, or move, where this tab's clock
 * can't see it: submitted, extended or left in another tab or browser, or still being placed by a submit that
 * timed out here. The tab asks the server (`GET /orders/:id`, which also measures the clock offset):
 *
 * - once a second after it mounts, whether by a full load or a client navigation;
 * - whenever it is shown again (tab switch, window focus);
 * - when its clock runs out, before it says "expired": only RESERVED (with the deadline that ran out) or
 *   EXPIRED is an expiry; anything else left checkout and goes to the order page. A clock that ran out with no
 *   answer from the server (offline) is taken at its word.
 *
 * The buyer's other tabs on the same browser say so at once (`checkout-channel.ts`), without a request.
 */
export function useHoldSync({ orderId, hold, update, clockEnded, onLeft, enabled }: HoldSyncOptions): void {
  const running = useRef<AbortController | null>(null);

  // Judged when the answer arrives, against the hold and the clock as they are then: a check that was asked for
  // before the clock ran out still decides correctly after it.
  const settle = useEffectEvent((order: OrderState | null) => {
    if (!enabled) return;
    if (order === null) {
      if (clockEnded) update({ ended: 'expired' });
      return;
    }
    const verdict = judgeReading(hold, order, { clockEnded });
    if (verdict.kind === 'moved') update(verdict.change);
    else if (verdict.kind === 'expired') update({ ended: 'expired' });
    else if (verdict.kind === 'closed') onLeft(verdict.end);
  });

  /** One check at a time; one asked for meanwhile is answered by the one in flight (see `settle`). */
  const check = useEffectEvent(() => {
    if (!enabled || running.current) return;
    const controller = new AbortController();
    running.current = controller;
    void (async () => {
      try {
        const requests = await orderRequests();
        const read = requests ? await requests.readOrder(orderId, controller.signal) : null;
        settle(read?.kind === 'ok' ? read.order : null);
      } catch (error) {
        // Aborted: the page was hidden or left. Nothing else rejects.
        if (!controller.signal.aborted) throw error;
      } finally {
        if (running.current === controller) running.current = null;
      }
    })();
  });

  useEffect(() => {
    const first = setTimeout(check, FIRST_CHECK_MS);
    const onShown = () => {
      if (!document.hidden) check();
    };
    document.addEventListener('visibilitychange', onShown);
    window.addEventListener('focus', onShown);
    return () => {
      clearTimeout(first);
      document.removeEventListener('visibilitychange', onShown);
      window.removeEventListener('focus', onShown);
      running.current?.abort();
      running.current = null;
    };
  }, []);

  useEffect(() => {
    if (clockEnded) check();
  }, [clockEnded]);

  useCheckoutMessages(orderId, (message) => {
    if (!enabled) return;
    if (message.kind === 'ended') onLeft(message.end);
    else if (Date.parse(message.expiresAt) > Date.parse(hold.expiresAt)) {
      const { expiresAt, extensions, serverNow } = message;
      update({ expiresAt, extensions, serverNow });
    }
  });
}

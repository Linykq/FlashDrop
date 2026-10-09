'use client';

import { useRouter } from 'next/navigation';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { postCheckoutMessage } from '../../lib/checkout-channel';
import type { CheckoutHold } from '../../lib/checkout-hold';
import { formatTime } from '../../lib/format';
import { type HoldVerdict, judgeReading } from '../../lib/hold';
import { checkoutHref, loginHref } from '../../lib/routes';
import { orderRequests } from '../../lib/use-order-requests';
import { announce } from '../ui/announcer';

/** The extension row's state (design-system §10.4): offered, in flight, or how the buyer's press ended. */
export type Extension =
  | { kind: 'offered' }
  | { kind: 'adding' }
  | { kind: 'added' }
  /** Refused because another tab of the buyer's added the minute first: the hold did get it. */
  | { kind: 'added-elsewhere'; expiresAt: string }
  /** Refused: the hold stands as it was, until `expiresAt`. */
  | { kind: 'refused'; expiresAt: string }
  | { kind: 'failed' };

/** Where a press came from: the row whose button had focus takes it on its result (`result`). */
export type ExtendOrigin = { hadFocus: boolean; result: RefObject<HTMLElement | null> };

type HoldExtensionOptions = {
  orderId: string;
  hold: CheckoutHold;
  onHoldChange: (change: Partial<CheckoutHold>) => void;
  /** The order is no longer a hold (expired, submitted or left); the server's verdict says how. */
  onClosed: (verdict: Extract<HoldVerdict, { kind: 'expired' | 'closed' }>) => void;
};

/**
 * The one-time +60 s extension (SD §5.1, WCAG 2.2.1), shared by the hold card's row and the row checkout shows
 * above Pay while the card is out of view, so both say the same and the offer stays once-only. "Add 1 minute"
 * posts `extend`, a compare-and-set in api, so a double press, the other row or a second tab can't extend twice.
 * On success the deadline moves (and the buyer's other checkout tabs hear of it); on a refusal the order is read
 * again to say what really holds: added after all (another tab got there first), the same deadline, or a hold
 * that ended.
 */
export function useHoldExtension({ orderId, hold, onHoldChange, onClosed }: HoldExtensionOptions): {
  extension: Extension;
  extend: (origin: ExtendOrigin) => void;
} {
  const router = useRouter();
  const [extension, setExtension] = useState<Extension>({ kind: 'offered' });
  const running = useRef<AbortController | null>(null);
  useEffect(() => () => running.current?.abort(), []);

  /**
   * Reports the outcome where the buyer is: a button that had focus is gone, so focus moves to the sentence
   * that replaced it, which reads it; otherwise the Announcer says it politely (§13.3).
   */
  const report = (text: string, { hadFocus, result }: ExtendOrigin) => {
    if (hadFocus) requestAnimationFrame(() => result.current?.focus());
    else announce(text);
  };

  async function extend(origin: ExtendOrigin): Promise<void> {
    if (running.current) return;
    const controller = new AbortController();
    running.current = controller;
    // The hold as this tab knew it when the buyer pressed: what a refusal is judged against.
    const pressedOn = hold;
    setExtension({ kind: 'adding' });
    try {
      const requests = await orderRequests();
      const outcome = requests ? await requests.extendHold(orderId, controller.signal) : null;
      if (outcome?.kind === 'done') {
        const { expiresAt, extensions, serverNow } = outcome.order;
        const change = { expiresAt, extensions, serverNow: Date.parse(serverNow) };
        onHoldChange(change);
        postCheckoutMessage({ orderId, kind: 'hold', ...change });
        setExtension({ kind: 'added' });
        report('1 minute added.', origin);
        return;
      }
      if (outcome?.kind === 'signed-out') {
        router.push(loginHref(checkoutHref(orderId)));
        return;
      }
      if (outcome?.kind === 'refused' && requests) {
        const read = await requests.readOrder(orderId, controller.signal);
        const verdict = read.kind === 'ok' ? judgeReading(pressedOn, read.order) : null;
        if (verdict?.kind === 'expired' || verdict?.kind === 'closed') {
          onClosed(verdict);
          return;
        }
        if (verdict?.kind === 'moved') {
          onHoldChange(verdict.change);
          setExtension({ kind: 'added-elsewhere', expiresAt: verdict.change.expiresAt });
          report(`1 minute was added. Your hold ends at ${formatTime(verdict.change.expiresAt)}.`, origin);
          return;
        }
        setExtension({ kind: 'refused', expiresAt: pressedOn.expiresAt });
        report(`Couldn't add time. Your hold ends at ${formatTime(pressedOn.expiresAt)}.`, origin);
        return;
      }
      setExtension({ kind: 'failed' });
      announce("Couldn't add time. Try again.");
    } catch (error) {
      // Aborted: checkout went away. Nothing else rejects.
      if (!controller.signal.aborted) throw error;
    } finally {
      if (running.current === controller) running.current = null;
    }
  }

  return { extension, extend: (origin) => void extend(origin) };
}

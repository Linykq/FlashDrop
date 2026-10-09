'use client';

import { Timer } from 'lucide-react';
import type { MouseEvent } from 'react';
import { type CheckoutHold, useCheckoutHold } from '../../lib/checkout-hold';
import { useServerTime } from '../../lib/clock';
import { cx } from '../../lib/cx';
import { formatCountdown } from '../../lib/format';
import { holdClock, holdState } from '../../lib/hold';
import { HOLD_CARD_ID, useHoldCountdownHidden } from '../../lib/hold-visibility';
import { LocalTime } from '../commerce/local-time';

type HoldTimerLinkProps = {
  orderId: string;
  /** The hold as the server rendered it; the page's island shares what it learns since (`checkout-hold.ts`). */
  hold: Omit<CheckoutHold, 'ended'>;
};

/**
 * The compact countdown in checkout's bar (design-system §9.18, §9.19), while the hold card's countdown is
 * scrolled out of view, so the time limit stays visible as the buyer fills in the form (WCAG 2.2.1). After the
 * wordmark from 735 px; on phones in its place, beside "Leave checkout" (`checkout-bar.tsx`). Like the card, it
 * takes the warning colour for the last minute, and its digits are hidden from assistive technology: the link
 * is named by the deadline, a time that doesn't change, and leads back to the card, which takes focus.
 */
export function HoldTimerLink({ orderId, hold: rendered }: HoldTimerLinkProps) {
  const [hold] = useCheckoutHold(orderId, rendered);
  const now = useServerTime(hold.serverNow);
  const countdownHidden = useHoldCountdownHidden();
  const { remainingMs, warning, expired } = holdState(now, holdClock(hold.createdAt, hold.expiresAt));
  if (!countdownHidden || hold.ended !== null || expired) return null;

  return (
    <a
      href={`#${HOLD_CARD_ID}`}
      data-hold-timer
      onClick={focusCard}
      className={cx(
        // 44 px tall, its icon on the wordmark's edge; the ring is inset, so the bar's edges never clip it.
        '-ml-2 inline-flex h-11 animate-fade-in items-center gap-1.5 rounded-md px-2 text-callout font-medium tabular-nums',
        'transition-colors duration-200 ease-standard hover:bg-fill-quaternary focus-visible:-outline-offset-3',
        warning ? 'text-warning' : 'text-label',
      )}
    >
      <Timer size={16} className="shrink-0" />
      <span aria-hidden="true">{formatCountdown(remainingMs)}</span>
      <span className="sr-only">
        Reserved until <LocalTime iso={hold.expiresAt} format="time" />
      </span>
    </a>
  );
}

/**
 * Following the link alone would scroll to the card without moving focus there in every browser; focusing it
 * does both, and the root's scroll padding keeps it clear of the bar.
 */
function focusCard(event: MouseEvent<HTMLAnchorElement>): void {
  const card = document.getElementById(HOLD_CARD_ID);
  if (!card) return;
  event.preventDefault();
  card.focus();
}

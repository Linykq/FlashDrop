'use client';

import { Timer } from 'lucide-react';
import { useEffect, useEffectEvent } from 'react';
import { useServerTime } from '../../lib/clock';
import { cx } from '../../lib/cx';
import { formatCount, formatCountdown } from '../../lib/format';
import { type HeldOrder, holdClock, holdState } from '../../lib/hold';
import { checkoutHref } from '../../lib/routes';
import { ButtonLink } from '../ui/button';
import { LocalTime } from './local-time';

type HeldOrderNoticeProps = {
  order: HeldOrder;
  /** The server's clock when it rendered the page, which corrects the device clock (as in checkout). */
  serverNow: number;
  /** Shows "Go to checkout" here; left out where the filled action already is that link. */
  link: boolean;
  /** Called once, when the hold ends (2 s before api ends it, like checkout's countdown). */
  onEnd: () => void;
  className?: string;
};

/**
 * The buyer's live hold on this drop, above the Buy row (design-system §9.13): what is held, the time left on
 * the shared clock, and the way back to its checkout. Leaving checkout keeps the hold until it expires, so
 * without this a buyer back on the product page would hold units they can't see, and with a limit of 1 meet
 * only a refusal. The digits change every second, so they are hidden from assistive technology, which reads
 * the deadline as a time instead. Calm, like the hold card: no motion, no warning colour.
 */
export function HeldOrderNotice({ order, serverNow, link, onEnd, className }: HeldOrderNoticeProps) {
  const now = useServerTime(serverNow);
  const { remainingMs, expired } = holdState(now, holdClock(order.createdAt, order.expiresAt));
  const end = useEffectEvent(onEnd);
  useEffect(() => {
    if (expired) end();
  }, [expired]);

  return (
    // A query container: the link sits beside the text where the panel is wide enough, and below it, full
    // width, in the narrow panel of phones and tablets. In the narrowest (320 px phones) the time left takes a
    // line of its own rather than breaking the sentence before it.
    <div className={cx('@container', className)}>
      <div className="flex flex-wrap items-center gap-3 rounded-lg bg-bg-secondary py-3 pr-3 pl-4">
        <Timer className="shrink-0 text-accent-label" />
        <p className="min-w-0 flex-1 text-callout">
          <span className="font-medium">You have {formatCount(order.qty)} reserved</span>
          <span aria-hidden="true" className="block text-label-secondary tabular-nums @min-[20rem]:inline">
            <span className="hidden @min-[20rem]:inline"> · </span>
            {formatCountdown(remainingMs)} left
          </span>
          <span className="sr-only">
            , held until <LocalTime iso={order.expiresAt} format="time" />
          </span>
        </p>
        {link && (
          <ButtonLink href={checkoutHref(order.id)} variant="tinted" className="w-full @min-[28rem]:w-auto">
            Go to checkout
          </ButtonLink>
        )}
      </div>
    </div>
  );
}

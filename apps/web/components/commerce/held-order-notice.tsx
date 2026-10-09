'use client';

import { Timer } from 'lucide-react';
import { useEffect, useEffectEvent } from 'react';
import { useServerTime } from '../../lib/clock';
import { cx } from '../../lib/cx';
import { formatCount, formatCountdown } from '../../lib/format';
import { type HeldOrder, holdClock, holdState } from '../../lib/hold';
import { LocalTime } from './local-time';

type HeldOrderNoticeProps = {
  order: HeldOrder;
  /** The server's clock when it rendered the page, which corrects the device clock (as in checkout). */
  serverNow: number;
  /** Called once, when the hold ends (2 s before api ends it, like checkout's countdown). */
  onEnd: () => void;
  className?: string;
};

/**
 * The buyer's live hold on this drop, above the purchase row (design-system §9.13): what is held and the time
 * left on the shared clock. The row under it leads to the hold's checkout with the filled action. "Leave
 * checkout" releases a hold, but Back or a closed tab keeps it until it expires, so without this a buyer back
 * on the product page would hold units they can't see. The digits change every second, so they are hidden from
 * assistive technology, which reads the deadline as a time instead. Calm, like the hold card: no motion, no
 * warning colour.
 */
export function HeldOrderNotice({ order, serverNow, onEnd, className }: HeldOrderNoticeProps) {
  const now = useServerTime(serverNow);
  const { remainingMs, expired } = holdState(now, holdClock(order.createdAt, order.expiresAt));
  const end = useEffectEvent(onEnd);
  useEffect(() => {
    if (expired) end();
  }, [expired]);

  return (
    // A query container: in the narrowest panels (320 px phones) the time left takes a line of its own rather
    // than breaking the sentence before it. A translucent fill, not `bg-secondary`: the row sits on `bg` on the
    // product page and on `surface` in the drop card, and in dark mode `bg-secondary` and `surface` are the
    // same colour, which left only the row's padding showing there, like a misalignment. The quaternary fill,
    // the lightest: on white the tertiary one takes `label-secondary` under 4.5:1.
    <div className={cx('@container', className)}>
      <div className="flex items-center gap-3 rounded-lg bg-fill-quaternary px-4 py-3">
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
      </div>
    </div>
  );
}

'use client';

import { Timer } from 'lucide-react';
import { useEffect, useEffectEvent, useId, useRef, useState } from 'react';
import type { CheckoutHold } from '../../lib/checkout-hold';
import { useServerTime } from '../../lib/clock';
import { cx } from '../../lib/cx';
import { formatCountdown } from '../../lib/format';
import { announcedFrom, holdAnnouncement, holdClock, holdState, showsExtensionRow } from '../../lib/hold';
import { HOLD_CARD_ID, useWatchHoldCountdown } from '../../lib/hold-visibility';
import { LocalTime } from '../commerce/local-time';
import { ExtensionRow } from './extension-row';
import type { ExtendOrigin, Extension } from './use-hold-extension';

type HoldCardProps = {
  hold: CheckoutHold;
  /** The one-time extension's state, shared with the row above Pay (`use-hold-extension.ts`). */
  extension: Extension;
  onExtend: (origin: ExtendOrigin) => void;
  /** Called when the hold ends on the clock (2 s before api ends it), once per deadline. */
  onExpire: () => void;
};

/**
 * "Reserved for you" and the time left (design-system §10.4, SD §8.3). The digits and the bar change every
 * second, so both are hidden from assistive technology: a polite region of the card's own speaks at 2:00,
 * 1:00, 0:30 and 0:10 only, and the footnote gives the deadline as a time that doesn't change. Everything
 * stays `label` and `accent` until the last minute, then `warning`. Calm: no motion, no pulse.
 *
 * In the last minute the card offers the one-time extension (WCAG 2.2.1). While its countdown row is scrolled
 * out of view, the checkout bar shows a compact copy that links back here (the card is its focus target), and
 * the form repeats the offer above Pay (`hold-visibility.ts`).
 */
export function HoldCard({ hold, extension, onExtend, onExpire }: HoldCardProps) {
  const now = useServerTime(hold.serverNow);
  const state = holdState(now, holdClock(hold.createdAt, hold.expiresAt));
  const { remainingMs, seconds, fraction, warning, expired } = state;
  const titleId = useId();
  const countdownRow = useRef<HTMLDivElement>(null);
  useWatchHoldCountdown(countdownRow);

  // The card's own polite region (SD §8.3), for the countdown's thresholds only.
  const [announcement, setAnnouncement] = useState('');
  // From just above the whole hold, so the first tick names the band the hold is in: "2 minutes left to check
  // out." for a fresh hold, which the 2 s margin starts at 1:58.
  const shown = useRef(announcedFrom(hold.createdAt, hold.expiresAt));
  const announceTick = useEffectEvent((seconds: number) => {
    const text = holdAnnouncement(shown.current, seconds, { canExtend: hold.extensions === 0 });
    shown.current = seconds;
    if (text) setAnnouncement(text);
  });
  useEffect(() => announceTick(seconds), [seconds]);

  const end = useEffectEvent(onExpire);
  useEffect(() => {
    if (expired) end();
  }, [expired]);

  return (
    <section
      id={HOLD_CARD_ID}
      tabIndex={-1}
      aria-labelledby={titleId}
      className="rounded-lg bg-surface p-5 elevation-1 sm:p-6"
    >
      <div ref={countdownRow} className="flex items-center justify-between gap-4">
        <h2 id={titleId} className="inline-flex items-center gap-2 text-headline">
          <Timer className="shrink-0" />
          Reserved for you
        </h2>
        <p aria-hidden="true" className={cx('text-title-2 tabular-nums', warning && 'text-warning')}>
          {formatCountdown(remainingMs)}
        </p>
      </div>
      {/* The hold bar (§9.27): steps once a second, no transition. */}
      <div aria-hidden="true" className="mt-4 h-1 overflow-clip rounded-full bg-fill-secondary">
        <div
          className={cx('h-full rounded-full', warning ? 'bg-warning' : 'bg-accent')}
          style={{ width: `${fraction * 100}%` }}
        />
      </div>
      <p className="mt-3 text-footnote text-label-secondary">
        We hold it until <LocalTime iso={hold.expiresAt} format="time" />.
      </p>
      {showsExtensionRow(state, hold.extensions, extension.kind !== 'offered') && (
        <ExtensionRow
          extension={extension}
          onExtend={onExtend}
          className="mt-4 border-separator border-t pt-4"
        />
      )}
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </section>
  );
}

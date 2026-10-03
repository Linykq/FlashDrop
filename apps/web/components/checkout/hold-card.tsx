'use client';

import { Timer } from 'lucide-react';
import { useEffect, useEffectEvent, useId, useRef, useState } from 'react';
import { useServerTime } from '../../lib/clock';
import { cx } from '../../lib/cx';
import { formatCountdown } from '../../lib/format';
import { announcedFrom, holdAnnouncement, holdClock, holdState } from '../../lib/hold';
import { LocalTime } from '../commerce/local-time';

type HoldCardProps = {
  createdAt: string;
  expiresAt: string;
  /** The server's clock when it rendered the order; the countdown corrects the device clock with it. */
  serverNow: number;
  /** Called once, when the hold ends (2 s before api ends it). */
  onExpire: () => void;
};

/**
 * "Reserved for you" and the time left (design-system §10.4, SD §8.3). The digits and the bar change every
 * second, so both are hidden from assistive technology: a polite region of the card's own speaks at 2:00,
 * 1:00, 0:30 and 0:10 only, and the footnote gives the deadline as a time that doesn't change. Everything
 * stays `label` and `accent` until the last minute, then `warning`. Calm: no motion, no pulse.
 */
export function HoldCard({ createdAt, expiresAt, serverNow, onExpire }: HoldCardProps) {
  const now = useServerTime(serverNow);
  const { remainingMs, seconds, fraction, warning, expired } = holdState(
    now,
    holdClock(createdAt, expiresAt),
  );
  const titleId = useId();

  const [announcement, setAnnouncement] = useState('');
  // From just above the whole hold, so the first tick names the band the hold is in: "2 minutes left to check
  // out." for a fresh hold, which the 2 s margin starts at 1:58.
  const shown = useRef(announcedFrom(createdAt, expiresAt));
  useEffect(() => {
    const text = holdAnnouncement(shown.current, seconds);
    shown.current = seconds;
    if (text) setAnnouncement(text);
  }, [seconds]);

  const end = useEffectEvent(onExpire);
  useEffect(() => {
    if (expired) end();
  }, [expired]);

  return (
    <section aria-labelledby={titleId} className="rounded-lg bg-surface p-5 elevation-1 sm:p-6">
      <div className="flex items-center justify-between gap-4">
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
        We hold it until <LocalTime iso={expiresAt} format="time" />.
      </p>
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </section>
  );
}

'use client';

import { useEffect, useEffectEvent } from 'react';
import { useServerTime } from '../../lib/clock';
import { cx } from '../../lib/cx';
import { COUNTDOWN_WINDOW_MS, formatCountdown } from '../../lib/format';
import { LocalTime } from './local-time';

type CountdownProps = {
  /** The deadline, ISO 8601. */
  target: string;
  /** The server's clock (epoch ms) when it rendered; see `useServerTime`. */
  serverNow: number;
  /** "Starts" for an opening (on tiles, LiveStock and the hero alike), "Ends" for a closing. */
  verb: 'Starts' | 'Ends';
  /** `inline` inherits its style; `hero` sets the digits in `text-title-2`. */
  variant?: 'inline' | 'hero';
  /** Called once when the deadline passes. */
  onEnd?: () => void;
};

/**
 * A deadline under 24 hours as running digits, further out as an absolute time (§9.10); it switches to digits
 * by itself. The digits change every second, so they are hidden from assistive technology, which reads a
 * stable equivalent instead: "Starts at 7:00 PM" today, "Starts Sat, Oct 3 at 7:00 PM" on another day.
 * Nothing here is announced.
 */
export function Countdown({ target, serverNow, verb, variant = 'inline', onEnd }: CountdownProps) {
  const now = useServerTime(serverNow);
  const deadline = Date.parse(target);
  const remaining = deadline - now;

  const ended = remaining <= 0;
  const end = useEffectEvent(() => onEnd?.());
  useEffect(() => {
    if (ended) end();
  }, [ended]);

  if (remaining >= COUNTDOWN_WINDOW_MS) {
    return (
      <span>
        {verb} <LocalTime iso={target} />
      </span>
    );
  }

  // An opening shows "Starting…" until the stock snapshot reports the drop LIVE.
  if (ended && verb === 'Starts') return <span>Starting…</span>;

  return (
    <span>
      <span aria-hidden="true" className={cx(variant === 'hero' && 'inline-flex items-baseline gap-2')}>
        {verb} in{variant === 'inline' && ' '}
        <span className={cx('tabular-nums', variant === 'hero' && 'text-title-2 text-label')}>
          {formatCountdown(remaining)}
        </span>
      </span>
      <span className="sr-only">
        {verb} <LocalTime iso={target} format="at" />
      </span>
    </span>
  );
}

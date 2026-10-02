'use client';

import type { ReactNode } from 'react';
import { useServerTime } from '../../lib/clock';

type BeforeDeadlineProps = {
  /** ISO 8601. */
  target: string;
  /** The server's clock (epoch ms) when it rendered; see `useServerTime`. */
  serverNow: number;
  /** What replaces `children` once the deadline passed; nothing by default. */
  after?: ReactNode;
  children: ReactNode;
};

/**
 * Server-rendered content that only holds until a deadline on the shared clock, such as the Buy button's
 * "Opens at 7:00 PM": once the start passed it would contradict the countdown's "Starting…", which shows
 * until the stock snapshot reports the drop LIVE (§9.10).
 */
export function BeforeDeadline({ target, serverNow, after = null, children }: BeforeDeadlineProps) {
  const now = useServerTime(serverNow);
  return now < Date.parse(target) ? children : after;
}

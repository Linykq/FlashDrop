'use client';

import { CalendarClock } from 'lucide-react';
import { type LiveLevel, useLiveStock } from '../../lib/live-stock';
import { DropStatusPill } from '../ui/status-pill';
import { Countdown } from './countdown';
import { LiveBadge } from './live-badge';
import { LocalTime } from './local-time';

type LiveDropStatusProps = {
  dropId: string;
  seed: LiveLevel;
  startsAt: string;
  endsAt: string;
  serverNow: number;
};

/**
 * "[LIVE] Ends in 12:04" above the product title (§10.2), on the same live stock as the purchase panel, so
 * both change together when the drop opens, pauses or ends. A scheduled drop shows when it opens, as the home
 * hero does, and leaves the state to LiveStock's countdown and the Buy button: a "Scheduled" pill would only
 * repeat them (§1.4). Paused and ended drops show their status pill.
 */
export function LiveDropStatus({ dropId, seed, startsAt, endsAt, serverNow }: LiveDropStatusProps) {
  const { level } = useLiveStock(dropId, seed);
  return (
    <div className="flex min-h-6 items-center gap-2 text-footnote text-label-secondary">
      {level.status === 'LIVE' ? (
        <>
          <LiveBadge />
          <Countdown target={endsAt} serverNow={serverNow} verb="Ends" />
        </>
      ) : level.status === 'SCHEDULED' ? (
        <span className="inline-flex items-center gap-1.5">
          <CalendarClock size={16} />
          <LocalTime iso={startsAt} />
        </span>
      ) : (
        <DropStatusPill status={level.status} />
      )}
    </div>
  );
}

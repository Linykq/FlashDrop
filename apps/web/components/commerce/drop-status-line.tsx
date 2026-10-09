import { CalendarClock, PackageX } from 'lucide-react';
import type { StockState } from '../../lib/stock';
import { DropStatusPill, StatusPill } from '../ui/status-pill';
import { Countdown } from './countdown';
import { LiveBadge } from './live-badge';
import { LocalTime } from './local-time';

type DropStatusLineProps = {
  stock: StockState;
  startsAt: string;
  endsAt: string;
  serverNow: number;
  /** Only the home hero's badge pulses here (§9.11); the room's own badge sits on the video. */
  pulse?: boolean;
};

/**
 * What a drop is doing, in the footnote line above its title (§9.12, §10.1, §10.2): "[LIVE] Ends in 12:04"
 * while it sells; "Sold out" once every unit is paid for, since a red LIVE and a running clock would promise
 * what can no longer be bought; when it opens, for a scheduled drop, whose countdown LiveStock already runs,
 * so no "Scheduled" pill repeats it (§1.4); otherwise the status pill.
 */
export function DropStatusLine({ stock, startsAt, endsAt, serverNow, pulse = false }: DropStatusLineProps) {
  if (stock.status === 'LIVE' && stock.avail === 0 && stock.held === 0) {
    return (
      <StatusPill tone="neutral" icon={PackageX}>
        Sold out
      </StatusPill>
    );
  }
  if (stock.status === 'LIVE') {
    return (
      <>
        <LiveBadge pulse={pulse} />
        <Countdown target={endsAt} serverNow={serverNow} verb="Ends" />
      </>
    );
  }
  if (stock.status === 'SCHEDULED') {
    return (
      <span className="inline-flex items-center gap-1.5">
        <CalendarClock size={16} />
        <LocalTime iso={startsAt} />
      </span>
    );
  }
  return <DropStatusPill status={stock.status} />;
}

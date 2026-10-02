import type { DropStatus, ListingJobStatus, OrderStatus } from '@flashdrop/domain';
import {
  Ban,
  CalendarClock,
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CirclePause,
  CircleStop,
  CircleX,
  Clock,
  Hourglass,
  type LucideIcon,
  Pencil,
  RotateCw,
  Timer,
  TriangleAlert,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { LiveBadge } from '../commerce/live-badge';

export type PillTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

const toneClass: Record<PillTone, string> = {
  neutral: 'bg-fill-tertiary text-label',
  info: 'bg-accent-tint text-accent-label',
  success: 'bg-success-tint text-success',
  warning: 'bg-warning-tint text-warning',
  danger: 'bg-danger-tint text-danger',
};

type StatusPillProps = { tone: PillTone; icon: LucideIcon; children: ReactNode };

/**
 * A status as text with an icon, so colour is never the only signal (§9.24). Pills are text, not controls.
 */
export function StatusPill({ tone, icon: Icon, children }: StatusPillProps) {
  return (
    <span
      className={cx(
        'inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-full pr-2.5 pl-2 text-caption font-medium',
        toneClass[tone],
      )}
    >
      <Icon size={14} strokeWidth={1.5} />
      {children}
    </span>
  );
}

type PillSpec = { tone: PillTone; icon: LucideIcon; label: string };

const orderPills: Record<OrderStatus, PillSpec> = {
  RESERVED: { tone: 'info', icon: Timer, label: 'Reserved' },
  PENDING_PAYMENT: { tone: 'info', icon: CircleDashed, label: 'Processing' },
  PAID: { tone: 'success', icon: CircleCheck, label: 'Paid' },
  PAYMENT_FAILED: { tone: 'danger', icon: CircleX, label: 'Declined' },
  EXPIRED: { tone: 'neutral', icon: Hourglass, label: 'Expired' },
  CANCELLED: { tone: 'neutral', icon: Ban, label: 'Cancelled' },
  REJECTED: { tone: 'neutral', icon: CircleMinus, label: 'Not reserved' },
};

/**
 * Buyers see a payment that failed because its window closed (`reference_closed`) as Expired: no card was
 * declined (§9.24, §10.5).
 */
export function OrderStatusPill({
  status,
  declineCode,
}: {
  status: OrderStatus;
  declineCode?: string | null;
}) {
  const spec =
    status === 'PAYMENT_FAILED' && declineCode === 'reference_closed'
      ? orderPills.EXPIRED
      : orderPills[status];
  return (
    <StatusPill tone={spec.tone} icon={spec.icon}>
      {spec.label}
    </StatusPill>
  );
}

/** Every drop status, plus the Redis-side RECONCILING that admin shows while live stock is rebuilt. */
type DropPillStatus = DropStatus | 'RECONCILING';

const dropPills: Record<Exclude<DropPillStatus, 'LIVE'>, PillSpec> = {
  DRAFT: { tone: 'neutral', icon: Pencil, label: 'Draft' },
  // Neutral, not info: waiting isn't progress, and an accent pill beside the title would read as a control (§2.7).
  SCHEDULED: { tone: 'neutral', icon: CalendarClock, label: 'Scheduled' },
  PAUSED: { tone: 'warning', icon: CirclePause, label: 'Paused' },
  ENDED: { tone: 'neutral', icon: CircleStop, label: 'Ended' },
  // A Redis-side state while live stock is rebuilt from Postgres (SD §4.7); admin only.
  RECONCILING: { tone: 'warning', icon: RotateCw, label: 'Rebuilding' },
};

/** A drop's state; LIVE is the LIVE badge itself, never pulsing in a list. */
export function DropStatusPill({ status }: { status: DropPillStatus }) {
  if (status === 'LIVE') return <LiveBadge size="sm" />;
  const spec = dropPills[status];
  return (
    <StatusPill tone={spec.tone} icon={spec.icon}>
      {spec.label}
    </StatusPill>
  );
}

const listingJobPills: Record<ListingJobStatus, PillSpec> = {
  PENDING: { tone: 'neutral', icon: Clock, label: 'Queued' },
  RUNNING: { tone: 'info', icon: CircleDashed, label: 'Generating' },
  READY: { tone: 'success', icon: CircleCheck, label: 'Ready for review' },
  NEEDS_REVIEW: { tone: 'warning', icon: TriangleAlert, label: 'Needs review' },
  FAILED: { tone: 'danger', icon: CircleX, label: 'Failed' },
  APPROVED: { tone: 'success', icon: CircleCheck, label: 'Published' },
};

export function ListingJobStatusPill({ status }: { status: ListingJobStatus }) {
  const spec = listingJobPills[status];
  return (
    <StatusPill tone={spec.tone} icon={spec.icon}>
      {spec.label}
    </StatusPill>
  );
}

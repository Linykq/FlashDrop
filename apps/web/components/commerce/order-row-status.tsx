'use client';

import type { OrderStatus } from '@flashdrop/contracts';
import { useServerTime } from '../../lib/clock';
import { formatCountdown } from '../../lib/format';
import { holdClock, holdState } from '../../lib/hold';
import { OrderStatusPill } from '../ui/status-pill';
import { LocalTime } from './local-time';

type OrderRowStatusProps = {
  status: OrderStatus;
  createdAt: string;
  expiresAt: string;
  /** The server's clock when it built the order view, which corrects the device clock. */
  serverNow: string;
  /** What the order came to, formatted; the meta line shows it from 735 px. */
  total: string;
};

/*
 * The order row's status pill and meta line (design-system §10.6), as two cells of the row's grid: on phones
 * the pill sits on the meta line under the title, so the title has the row's full width; from 735 px it sits
 * at the end of the row, beside both lines.
 */
const pillCell = 'col-start-1 row-start-2 justify-self-start sm:col-start-2 sm:row-span-2 sm:row-start-1';
const metaCell =
  'col-start-2 row-start-2 min-w-0 text-footnote text-label-secondary tabular-nums sm:col-start-1';

/**
 * A live hold shows the time it has left, on the shared clock, and turns Expired at its deadline (the UI's,
 * 2 s before api's, as in checkout), because the list itself is a server render that never updates. Every
 * other order shows when it was placed.
 */
export function OrderRowStatus(props: OrderRowStatusProps) {
  return props.status === 'RESERVED' ? <HoldRowStatus {...props} /> : <RowStatus {...props} />;
}

function HoldRowStatus({ createdAt, expiresAt, serverNow, total }: OrderRowStatusProps) {
  const now = useServerTime(Date.parse(serverNow));
  const { remainingMs, expired } = holdState(now, holdClock(createdAt, expiresAt));
  if (expired) return <RowStatus status="EXPIRED" createdAt={createdAt} total={total} />;
  return (
    <>
      <span className={pillCell}>
        <OrderStatusPill status="RESERVED" />
      </span>
      <p className={metaCell}>
        {/* The digits change every second, so assistive technology reads the deadline instead. */}
        <span aria-hidden="true">{formatCountdown(remainingMs)} left</span>
        <span className="sr-only">
          Held until <LocalTime iso={expiresAt} format="time" />
        </span>
        <span className="max-sm:hidden"> · {total}</span>
      </p>
    </>
  );
}

function RowStatus({
  status,
  createdAt,
  total,
}: Pick<OrderRowStatusProps, 'status' | 'createdAt' | 'total'>) {
  return (
    <>
      <span className={pillCell}>
        <OrderStatusPill status={status} />
      </span>
      <p className={metaCell}>
        <LocalTime iso={createdAt} />
        {/* On phones the line keeps the date alone, beside the pill. */}
        <span className="max-sm:hidden"> · {total}</span>
      </p>
    </>
  );
}

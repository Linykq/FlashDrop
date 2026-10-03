'use client';

import { Check } from 'lucide-react';
import type { Ref } from 'react';
import type { BuyAction } from '../../lib/purchase';
import { loginHref } from '../../lib/routes';
import type { ReserveState } from '../../lib/use-reserve';
import { Button, ButtonLink } from '../ui/button';
import { BeforeDeadline } from './before-deadline';
import { LocalTime } from './local-time';

type BuyButtonProps = {
  action: Exclude<BuyAction, { kind: 'hidden' }>;
  /** The reserve flow's state; while a request runs or has reserved, it decides the label. */
  reserve: ReserveState;
  /** The quantity a press reserves, named in the label from 2 up ("Buy 2"). */
  quantity: number;
  /** The most the stepper offers, so the label slot fits "Buy {max}". */
  maxQuantity: number;
  onBuy: () => void;
  /** For "Opens at 7:00 PM" before the drop opens. */
  startsAt: string;
  /** The server's clock when it rendered, so "Opens at…" turns into "Starting…" on time. */
  serverNow: number;
  /** The page to come back to after signing in. */
  returnTo: string;
  /** lg inline in the purchase panel, md in the sticky buy bar. */
  size?: 'lg' | 'md';
  /** The note under the button, while one explains the last press (§9.13). */
  describedBy?: string;
  /** The `<button>` in every state but "Sign in to buy", which is a link. */
  buttonRef?: Ref<HTMLButtonElement>;
  className?: string;
};

const closedLabel = {
  paused: 'Paused',
  'all-reserved': 'All reserved',
  'sold-out': 'Sold out',
} as const;

/** The check of "Reserved", popping in on the `celebrate` spring (§6.3); still under reduced motion. */
function ReservedCheck({ size }: { size: number }) {
  return <Check size={size} className="shrink-0 motion-safe:animate-celebrate" />;
}

/**
 * The one filled action of the purchase panel (§9.13). "Buy" reserves; while the request runs it shows the
 * spinner and "Reserving…", then "Still trying…" after 2 s of retries, and "Reserved" with a check once the
 * hold exists. When nothing can be reserved it keeps its place with the disabled look and LiveStock's word for
 * why, and stays focusable (`aria-disabled`), so the layout never jumps when the state changes.
 */
export function BuyButton({
  action,
  reserve,
  quantity,
  maxQuantity,
  onBuy,
  startsAt,
  serverNow,
  returnTo,
  size = 'lg',
  describedBy,
  buttonRef,
  className,
}: BuyButtonProps) {
  const labels = ['Buy', `Buy ${maxQuantity}`, 'Reserving…', 'Still trying…', 'Reserved'];
  const shared = { size, className, 'aria-describedby': describedBy };

  // A request in flight or done outranks the live state: the last unit may sell to this very press.
  if (reserve.phase === 'reserving') {
    return (
      <Button {...shared} ref={buttonRef} loading reserve={labels}>
        {reserve.slow ? 'Still trying…' : 'Reserving…'}
      </Button>
    );
  }
  if (reserve.phase === 'reserved') {
    return (
      <Button {...shared} ref={buttonRef} icon={ReservedCheck} reserve={labels}>
        Reserved
      </Button>
    );
  }

  switch (action.kind) {
    case 'sign-in':
      return (
        <ButtonLink {...shared} href={loginHref(returnTo)}>
          Sign in to buy
        </ButtonLink>
      );
    case 'closed':
      return (
        <Button {...shared} ref={buttonRef} disabled>
          {action.reason === 'opens' ? (
            <BeforeDeadline target={startsAt} serverNow={serverNow} after="Starting…">
              <span>
                Opens <LocalTime iso={startsAt} format="opening" />
              </span>
            </BeforeDeadline>
          ) : (
            closedLabel[action.reason]
          )}
        </Button>
      );
    case 'buy':
      return (
        <Button {...shared} ref={buttonRef} reserve={labels} onClick={onBuy}>
          {quantity > 1 ? `Buy ${quantity}` : 'Buy'}
        </Button>
      );
  }
}

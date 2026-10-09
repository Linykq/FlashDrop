'use client';

import { Check } from 'lucide-react';
import type { Ref } from 'react';
import type { BuyAction } from '../../lib/purchase';
import { loginHref } from '../../lib/routes';
import type { ReserveState } from '../../lib/use-reserve';
import { Button, ButtonLink } from '../ui/button';

type BuyButtonProps = {
  /**
   * A drop that hasn't opened shows no button (its status line and countdown say when), so `opens` reaches
   * here only through a press already in flight, which outranks it.
   */
  action: Exclude<BuyAction, { kind: 'hidden' }>;
  /** The reserve flow's state; while a request runs or has reserved, it decides the label. */
  reserve: ReserveState;
  /** The quantity a press reserves, named in the label from 2 up ("Buy 2"). */
  quantity: number;
  /** The most the stepper offers, so the label slot fits "Buy {max}". */
  maxQuantity: number;
  onBuy: () => void;
  /** The page to come back to after signing in. */
  returnTo: string;
  /** lg inline in the purchase panel, md in the sticky buy bar and beside a live hold. */
  size?: 'lg' | 'md';
  /**
   * `gray` beside a live hold, where "Go to checkout" is the filled action (§9.13) and this one reserves
   * `more`: "Buy 1 more".
   */
  variant?: 'filled' | 'gray';
  more?: boolean;
  /** The note under the button, while one explains the last press (§9.13). */
  describedBy?: string;
  /** The `<button>` in every state but "Sign in to buy", which is a link. */
  buttonRef?: Ref<HTMLButtonElement>;
  className?: string;
};

const closedLabel = {
  opens: 'Not open yet',
  paused: 'Paused',
  'all-reserved': 'All reserved',
  'sold-out': 'Sold out',
} as const;

/** The check of "Reserved", popping in on the `celebrate` spring (§6.3); still under reduced motion. */
function ReservedCheck({ size }: { size: number }) {
  return <Check size={size} className="shrink-0 motion-safe:animate-celebrate" />;
}

/**
 * The purchase panel's reserve action (§9.13), filled unless a live hold leads. "Buy" reserves; while the request runs it shows the
 * spinner and "Reserving…", then "Still trying…" after 2 s of retries, and "Reserved" with a check once the
 * hold exists. When nothing can be reserved it keeps its place with the disabled look and LiveStock's word for
 * why (paused, all reserved), and stays focusable (`aria-disabled`), so the layout never jumps when the state
 * changes.
 */
export function BuyButton({
  action,
  reserve,
  quantity,
  maxQuantity,
  onBuy,
  returnTo,
  size = 'lg',
  variant = 'filled',
  more = false,
  describedBy,
  buttonRef,
  className,
}: BuyButtonProps) {
  const buyLabel = (qty: number) => (more ? `Buy ${qty} more` : qty > 1 ? `Buy ${qty}` : 'Buy');
  const labels = [buyLabel(1), buyLabel(maxQuantity), 'Reserving…', 'Still trying…', 'Reserved'];
  const shared = { size, className, 'aria-describedby': describedBy };
  // The filled default: a variant prop only where it is the gray one, as `Button`'s appearance types want.
  const look = variant === 'gray' ? ({ variant: 'gray' } as const) : {};

  // A request in flight or done outranks the live state: the last unit may sell to this very press.
  if (reserve.phase === 'reserving') {
    return (
      <Button {...shared} {...look} ref={buttonRef} loading reserve={labels}>
        {reserve.slow ? 'Still trying…' : 'Reserving…'}
      </Button>
    );
  }
  if (reserve.phase === 'reserved') {
    return (
      <Button {...shared} {...look} ref={buttonRef} icon={ReservedCheck} reserve={labels}>
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
        <Button {...shared} {...look} ref={buttonRef} disabled>
          {closedLabel[action.reason]}
        </Button>
      );
    case 'buy':
      return (
        <Button {...shared} {...look} ref={buttonRef} reserve={labels} onClick={onBuy}>
          {buyLabel(quantity)}
        </Button>
      );
  }
}

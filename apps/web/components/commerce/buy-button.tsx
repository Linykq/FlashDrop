'use client';

import type { BuyAction } from '../../lib/purchase';
import { loginHref } from '../../lib/routes';
import { Button, ButtonLink } from '../ui/button';
import { BeforeDeadline } from './before-deadline';
import { LocalTime } from './local-time';

type BuyButtonProps = {
  action: Exclude<BuyAction, { kind: 'hidden' }>;
  /** For "Opens at 7:00 PM" before the drop opens. */
  startsAt: string;
  /** The server's clock when it rendered, so "Opens at…" turns into "Starting…" on time. */
  serverNow: number;
  /** The page to come back to after signing in. */
  returnTo: string;
  /** lg inline in the purchase panel, md in the sticky buy bar. */
  size?: 'lg' | 'md';
  className?: string;
};

const closedLabel = {
  paused: 'Paused',
  'all-reserved': 'All reserved',
  'sold-out': 'Sold out',
} as const;

/**
 * The one filled action of the purchase panel (§9.13). When nothing can be reserved it keeps its place with
 * the disabled look and LiveStock's word for why, and stays focusable (`aria-disabled`), so the layout never
 * jumps when the state changes.
 */
export function BuyButton({ action, startsAt, serverNow, returnTo, size = 'lg', className }: BuyButtonProps) {
  switch (action.kind) {
    case 'sign-in':
      return (
        <ButtonLink href={loginHref(returnTo)} size={size} className={className}>
          Sign in to buy
        </ButtonLink>
      );
    case 'closed':
      return (
        <Button size={size} disabled className={className}>
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
      // TODO(M2): reserve with POST /drops/:dropId/reservations and a per-drop Idempotency-Key (SD §8.2),
      // running "Buy" / "Buy 2", "Reserving…", "Still trying…" and "Reserved" (§9.13). Until the reserve
      // endpoint exists the button keeps its label with the disabled look, and the panel says why.
      return (
        <Button size={size} disabled className={className}>
          Buy
        </Button>
      );
  }
}

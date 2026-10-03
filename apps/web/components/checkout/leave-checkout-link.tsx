'use client';

import { useServerTime } from '../../lib/clock';
import { holdClock, holdState } from '../../lib/hold';
import { ButtonLink } from '../ui/button';

type LeaveCheckoutLinkProps = {
  /** The product page. */
  href: string;
  createdAt: string;
  expiresAt: string;
  /** The server's clock when it rendered the order, as for the hold card's countdown. */
  serverNow: number;
};

/**
 * "Leave checkout" in the reduced bar (design-system §9.18), only while the hold lasts: it goes at the moment
 * the hold card turns into the expired card, on the same clock, since there is nothing left to leave.
 */
// TODO(M3): open the leave dialog and release the hold with POST /orders/:orderId/cancel (§10.4); until
// cancel exists, leaving keeps the hold, which the product page offers back, and the sweeper returns it when
// it expires.
export function LeaveCheckoutLink({ href, createdAt, expiresAt, serverNow }: LeaveCheckoutLinkProps) {
  const now = useServerTime(serverNow);
  if (holdState(now, holdClock(createdAt, expiresAt)).expired) return null;
  return (
    // The plain button's own padding would inset its label from the page edge; the margin takes it back.
    <ButtonLink href={href} variant="plain" tone="neutral" className="-mr-5">
      Leave checkout
    </ButtonLink>
  );
}

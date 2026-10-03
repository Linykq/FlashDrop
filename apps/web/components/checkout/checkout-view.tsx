'use client';

import { CircleMinus, Hourglass } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { HoldCard } from './hold-card';
import { OutcomeCard } from './outcome-card';

export type CheckoutState =
  | { kind: 'held'; createdAt: string; expiresAt: string; serverNow: number }
  | { kind: 'expired' }
  | { kind: 'rejected'; reason: string };

type CheckoutViewProps = {
  state: CheckoutState;
  /** The product page, where "Try again" and "Back to the drop" lead. */
  productHref: string;
  /** The order summary card, rendered on the server. */
  summary: ReactNode;
};

/**
 * Checkout, one column (design-system §10.4): the heading, the hold, the summary, and below them the
 * shipping and payment form, which arrives with checkout submit (M3). Focus starts on the heading (SD §8.3).
 * When the hold runs out on screen, the expired card replaces it and its heading takes focus, which reads the
 * heading with its description; the summary stays, so the buyer still sees what was held.
 */
export function CheckoutView({ state, productHref, summary }: CheckoutViewProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  const expiredHeading = useRef<HTMLHeadingElement>(null);
  const [expiredOnScreen, setExpiredOnScreen] = useState(false);

  useEffect(() => {
    heading.current?.focus();
  }, []);
  useEffect(() => {
    if (expiredOnScreen) expiredHeading.current?.focus();
  }, [expiredOnScreen]);

  const expired = state.kind === 'expired' || expiredOnScreen;

  return (
    <>
      <h1 ref={heading} tabIndex={-1} className="text-title-1 outline-none">
        Checkout
      </h1>
      <div className="mt-8">
        {state.kind === 'rejected' ? (
          <OutcomeCard
            icon={CircleMinus}
            title="Not reserved"
            description={state.reason}
            action={{ href: productHref, label: 'Back to the drop' }}
          />
        ) : expired ? (
          <OutcomeCard
            icon={Hourglass}
            title="Reservation expired"
            description="Your item went back on sale."
            action={{ href: productHref, label: 'Try again' }}
            headingRef={expiredOnScreen ? expiredHeading : undefined}
          />
        ) : (
          <HoldCard
            createdAt={state.createdAt}
            expiresAt={state.expiresAt}
            serverNow={state.serverNow}
            onExpire={() => setExpiredOnScreen(true)}
          />
        )}
      </div>
      <div className="mt-8">{summary}</div>
    </>
  );
}

'use client';

import { Hourglass } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { postCheckoutMessage } from '../../lib/checkout-channel';
import { type CheckoutHold, setCheckoutSubmitting, useCheckoutHold } from '../../lib/checkout-hold';
import { focusOnLoad } from '../../lib/focus';
import { usePrefetchOrderRequests } from '../../lib/use-order-requests';
import { useRefreshOnReturn } from '../../lib/use-refresh-on-return';
import { CheckoutForm, type SubmitEnd } from './checkout-form';
import { ExtensionOffer } from './extension-offer';
import { HoldCard } from './hold-card';
import { OutcomeCard } from './outcome-card';
import { useHoldExtension } from './use-hold-extension';
import { useHoldSync } from './use-hold-sync';

type CheckoutViewProps = {
  orderId: string;
  /** The hold as the server rendered it. */
  hold: Omit<CheckoutHold, 'ended'>;
  /** The server rendered a RESERVED order already past the UI's deadline (Postgres expires it in a moment). */
  expiredAtLoad: boolean;
  /** The product page, where "Try again" leads. */
  productHref: string;
  /** The order status page, where a submitted order goes (§10.4). */
  orderPageHref: string;
  /** "Pay $258.00". */
  payLabel: string;
  /** The order summary card, rendered on the server. */
  summary: ReactNode;
};

/**
 * Checkout, one column (design-system §10.4): the heading, the hold, the summary and the shipping and payment
 * form. Focus starts on the heading (SD §8.3), unless the buyer already put it in a field.
 *
 * The hold ends on screen only when the server agrees (`use-hold-sync.ts`): when its clock runs out (2 s before
 * api's), and no submit is in flight whose answer decides it, the page reads the order. Still held until that
 * deadline, or expired: the expired card replaces the hold and the form, and its heading takes focus, which
 * reads it with its description; the summary stays, so the buyer still sees what was held. Submitted or left
 * elsewhere (another tab, another device, or a submit here that timed out but landed): the order page shows it.
 */
export function CheckoutView({
  orderId,
  hold: rendered,
  expiredAtLoad,
  productHref,
  orderPageHref,
  payLabel,
  summary,
}: CheckoutViewProps) {
  const router = useRouter();
  const heading = useRef<HTMLHeadingElement>(null);
  const expiredHeading = useRef<HTMLHeadingElement>(null);
  const [hold, updateHold] = useCheckoutHold(orderId, rendered);
  const [busy, setBusy] = useState(false);
  // The deadline whose clock ran out: a later deadline (an extension, here or elsewhere) is running again.
  const [ranOut, setRanOut] = useState<string | null>(null);
  const expired = expiredAtLoad || hold.ended === 'expired';

  usePrefetchOrderRequests();
  // A hold is live server data: shown again after Back, the page asks whether it still is one.
  useRefreshOnReturn();

  useEffect(() => focusOnLoad(heading.current), []);

  // The bar's "Leave checkout" waits for the submit's answer (§9.18). Hidden or gone, the page has none.
  useEffect(() => {
    setCheckoutSubmitting(orderId, busy);
    return () => setCheckoutSubmitting(orderId, false);
  }, [orderId, busy]);

  /** The order left checkout other than by this tab's submit: its status page says how. */
  function leftElsewhere(end: 'placed' | 'left'): void {
    updateHold({ ended: end });
    router.replace(orderPageHref);
  }

  useHoldSync({
    orderId,
    hold,
    update: updateHold,
    clockEnded: ranOut === hold.expiresAt && !busy,
    onLeft: leftElsewhere,
    enabled: hold.ended === null && !expiredAtLoad,
  });

  const { extension, extend } = useHoldExtension({
    orderId,
    hold,
    onHoldChange: updateHold,
    onClosed: (verdict) => {
      if (verdict.kind === 'expired') updateHold({ ended: 'expired' });
      else leftElsewhere(verdict.end);
    },
  });

  useEffect(() => {
    // Ended while the buyer watched: the heading of what replaced the form takes focus (SD §8.3). The bar's
    // "Leave checkout" goes with the hold at the same moment (§9.18).
    if (hold.ended === 'expired') expiredHeading.current?.focus();
  }, [hold.ended]);

  function onSubmitEnd(end: SubmitEnd): void {
    updateHold({ ended: end });
    if (end === 'placed') postCheckoutMessage({ orderId, kind: 'ended', end });
  }

  return (
    <>
      <h1 ref={heading} tabIndex={-1} className="text-title-1 outline-none">
        Checkout
      </h1>
      {expired ? (
        <>
          <div className="mt-8">
            <OutcomeCard
              icon={Hourglass}
              title="Reservation expired"
              description="Your item went back on sale."
              action={{ href: productHref, label: 'Try again' }}
              headingRef={expiredAtLoad ? undefined : expiredHeading}
            />
          </div>
          <div className="mt-8">{summary}</div>
        </>
      ) : (
        <>
          <div className="mt-8">
            <HoldCard
              hold={hold}
              extension={extension}
              onExtend={extend}
              onExpire={() => setRanOut(hold.expiresAt)}
            />
          </div>
          <div className="mt-8">{summary}</div>
          <div className="mt-8">
            <CheckoutForm
              orderId={orderId}
              payLabel={payLabel}
              orderPageHref={orderPageHref}
              busy={busy}
              onBusyChange={setBusy}
              onEnd={onSubmitEnd}
              beforePay={<ExtensionOffer hold={hold} extension={extension} onExtend={extend} />}
            />
          </div>
        </>
      )}
    </>
  );
}

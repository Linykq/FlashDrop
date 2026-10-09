'use client';

import { CircleAlert } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { postCheckoutMessage } from '../../lib/checkout-channel';
import { type CheckoutHold, useCheckoutHold, useCheckoutSubmitting } from '../../lib/checkout-hold';
import { forgetCheckoutKey } from '../../lib/checkout-key';
import { useServerTime } from '../../lib/clock';
import { holdClock, holdState } from '../../lib/hold';
import { checkoutHref, loginHref } from '../../lib/routes';
import { orderRequests } from '../../lib/use-order-requests';
import { AlertDialog } from '../ui/alert-dialog';
import { Button } from '../ui/button';

type LeaveCheckoutProps = {
  orderId: string;
  /** The hold as the server rendered it; the page's island shares what it learns since (`checkout-hold.ts`). */
  hold: Omit<CheckoutHold, 'ended'>;
  /** The product page, where leaving goes. */
  productHref: string;
  /** The order status page, where an order that was placed or ended meanwhile goes. */
  orderPageHref: string;
};

/**
 * "Leave checkout" in the reduced bar (design-system §9.14, §9.18, §10.4), only while there is a hold to leave:
 * it goes at the moment the page's hold ends, by the same clock and the same store. It opens a native alert
 * dialog, "Leave checkout? Your reservation will be released.", where Stay is the safe, filled action with
 * initial focus, and Esc chooses it. Leave posts `cancel?from=RESERVED`, a compare-and-set in api that
 * returns the units at once rather than when the hold would have expired, then opens the product page. Focus
 * returns to this button when the dialog closes (native behaviour).
 *
 * It never cancels an order being paid. While the page's submit is in flight the button is disabled
 * (`aria-disabled`, still focusable): that answer decides the order. And the cancel carries its precondition,
 * so if the order was placed meanwhile all the same (a submit whose answer was lost, another tab or device),
 * or expired, api refuses (409) and the order page shows what happened.
 */
export function LeaveCheckout({ orderId, hold: rendered, productHref, orderPageHref }: LeaveCheckoutProps) {
  const router = useRouter();
  const [hold, updateHold] = useCheckoutHold(orderId, rendered);
  const submitting = useCheckoutSubmitting(orderId);
  const now = useServerTime(hold.serverNow);
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const running = useRef<AbortController | null>(null);

  // Hidden with its page (React <Activity>): an abandoned cancel is safe to send again, a compare-and-set.
  useEffect(() => {
    setLeaving(false);
    return () => {
      running.current?.abort();
      running.current = null;
    };
  }, []);

  if (hold.ended !== null || holdState(now, holdClock(hold.createdAt, hold.expiresAt)).expired) return null;

  async function leave(): Promise<void> {
    if (running.current) return;
    const controller = new AbortController();
    running.current = controller;
    setLeaving(true);
    setFailed(false);
    try {
      const requests = await orderRequests();
      const outcome = requests ? await requests.cancelOrder(orderId, controller.signal) : null;
      switch (outcome?.kind) {
        case 'done':
        case 'refused':
          // Cancelled, or no longer a hold (placed, or expired): either way checkout is over.
          forgetCheckoutKey(orderId);
          updateHold({ ended: 'left' });
          postCheckoutMessage({ orderId, kind: 'ended', end: 'left' });
          router.push(outcome.kind === 'done' ? productHref : orderPageHref);
          return;
        case 'signed-out':
          router.push(loginHref(checkoutHref(orderId)));
          return;
        default:
          setFailed(true);
          setLeaving(false);
      }
    } catch (error) {
      // Aborted: the bar went away. Nothing else rejects.
      if (!controller.signal.aborted) throw error;
    } finally {
      if (running.current === controller) running.current = null;
    }
  }

  function stay(): void {
    if (leaving) return;
    setOpen(false);
    setFailed(false);
  }

  return (
    <>
      {/* The plain button's own padding would inset its label from the page edge; the margin takes it back.
          That puts the button on the viewport's edge on phones, and 2 px under its top: the ring is inset. */}
      <Button
        variant="plain"
        tone="neutral"
        disabled={submitting}
        className="-mr-5 focus-visible:-outline-offset-3"
        onClick={() => setOpen(true)}
      >
        Leave checkout
      </Button>
      <AlertDialog
        open={open}
        onCancel={stay}
        title="Leave checkout?"
        description={
          <>
            <p>Your reservation will be released.</p>
            {/* Always in the dialog and polite (§13.3 rule 1): a region inserted with its text is skipped by
                some screen readers, and the Announcer's regions sit outside the modal, where it hides them. */}
            <p role="status" className={failed ? 'mt-3 text-callout text-danger' : undefined}>
              {failed && (
                <span className="flex items-start gap-1.5">
                  <CircleAlert size={16} className="mt-0.5 shrink-0" />
                  Couldn't leave checkout. Check your connection and try again.
                </span>
              )}
            </p>
          </>
        }
      >
        <Button size="md" shape="rounded" data-autofocus onClick={stay}>
          Stay
        </Button>
        <Button
          variant="plain"
          tone="destructive"
          shape="rounded"
          loading={leaving}
          reserve={['Leave', 'Leaving…']}
          onClick={() => void leave()}
        >
          {leaving ? 'Leaving…' : 'Leave'}
        </Button>
      </AlertDialog>
    </>
  );
}

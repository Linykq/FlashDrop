import type { OrderView } from '@flashdrop/contracts';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { Suspense } from 'react';
import { type CheckoutState, CheckoutView } from '../../../components/checkout/checkout-view';
import { OrderSummary } from '../../../components/checkout/order-summary';
import { Skeleton, SkeletonText } from '../../../components/ui/skeleton';
import { holdClock, holdState, rejectionText } from '../../../lib/hold';
import { checkoutHref, loginHref, orderPageHref, productHref } from '../../../lib/routes';
import { readOrder } from '../../../lib/server/orders';

export const metadata: Metadata = { title: 'Checkout', robots: { index: false } };

/*
 * Checkout (SD §8.1, design-system §10.4): dynamic and never indexed. The order is read with the buyer's
 * session on every request, because its hold changes by the second. Signed out, proxy.ts already sent the
 * buyer to sign in; an expired session is caught here. Another buyer's order is a 404 (SD §11).
 */
export default function CheckoutPage({ params }: PageProps<'/checkout/[orderId]'>) {
  return (
    <div className="page-form pt-8 pb-(--section-space) sm:pt-12">
      <Suspense fallback={<CheckoutSkeleton />}>
        <Checkout params={params} />
      </Suspense>
    </div>
  );
}

async function Checkout({ params }: Pick<PageProps<'/checkout/[orderId]'>, 'params'>) {
  const { orderId } = await params;
  const read = await readOrder(orderId);
  if (read.kind === 'signed-out') redirect(loginHref(checkoutHref(orderId)));
  if (read.kind === 'not-found') notFound();
  const order = read.value;
  const state = checkoutState(order);
  // Submitted or finished: what happened next is the order page's to show (§10.4).
  if (state === null) redirect(orderPageHref(order.id));
  return (
    <CheckoutView
      state={state}
      productHref={productHref(order.product.slug)}
      summary={<OrderSummary order={order} />}
    />
  );
}

/** What checkout shows for the order, or `null` when it belongs on the order page. */
function checkoutState(order: OrderView): CheckoutState | null {
  switch (order.status) {
    case 'RESERVED': {
      const serverNow = Date.parse(order.serverNow);
      // The UI ends a hold 2 s early; Postgres expires it a moment after its deadline (SD §4.6).
      if (holdState(serverNow, holdClock(order.createdAt, order.expiresAt)).expired)
        return { kind: 'expired' };
      return { kind: 'held', createdAt: order.createdAt, expiresAt: order.expiresAt, serverNow };
    }
    case 'EXPIRED':
      return { kind: 'expired' };
    case 'REJECTED':
      return { kind: 'rejected', reason: rejectionText(order.closeReason) };
    default:
      return null;
  }
}

/** The page's exact box while the order loads: the heading, the hold card and the summary card (§9.16). */
function CheckoutSkeleton() {
  return (
    <div aria-busy="true">
      <div aria-hidden="true">
        <SkeletonText style="title-1" className="w-40" />
        <Skeleton className="mt-8 h-29.5 rounded-lg sm:h-31.5 md:h-32.5" />
        <Skeleton className="mt-8 h-39.75 rounded-lg sm:h-43.75" />
      </div>
    </div>
  );
}

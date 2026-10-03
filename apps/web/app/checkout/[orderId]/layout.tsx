import { unstable_rethrow } from 'next/navigation';
import { Suspense } from 'react';
import { LeaveCheckoutLink } from '../../../components/checkout/leave-checkout-link';
import { CheckoutBar } from '../../../components/layout/checkout-bar';
import { NavSentinel } from '../../../components/layout/nav-bar';
import { SkipLink } from '../../../components/layout/skip-link';
import { isLiveHold } from '../../../lib/hold';
import { productHref } from '../../../lib/routes';
import { readOrder } from '../../../lib/server/orders';

/**
 * Checkout's chrome (design-system §8.1, §10.4): the reduced navigation bar, no footer, the grouped canvas.
 * The skip link names where it leads, "Skip to checkout" (SD §8.3).
 */
export default function CheckoutLayout({ children, params }: LayoutProps<'/checkout/[orderId]'>) {
  return (
    <div data-page="grouped" className="flex min-h-dvh flex-col">
      <SkipLink label="Skip to checkout" />
      <CheckoutBar
        action={
          <Suspense fallback={null}>
            <LeaveCheckout params={params} />
          </Suspense>
        }
      />
      <main id="main" className="flex-1">
        <NavSentinel />
        {children}
      </main>
    </div>
  );
}

/**
 * The way out, back to the product, while there is a hold to leave. An expired or refused order has nothing
 * to leave: its card already offers the way back, and the bar keeps only the wordmark. The order read is
 * shared with the page (memoised per request).
 */
async function LeaveCheckout({ params }: Pick<LayoutProps<'/checkout/[orderId]'>, 'params'>) {
  const { orderId } = await params;
  try {
    const read = await readOrder(orderId);
    if (read.kind !== 'ok') return null;
    const order = read.value;
    const serverNow = Date.parse(order.serverNow);
    if (!isLiveHold(order, serverNow)) return null;
    return (
      <LeaveCheckoutLink
        href={productHref(order.product.slug)}
        createdAt={order.createdAt}
        expiresAt={order.expiresAt}
        serverNow={serverNow}
      />
    );
  } catch (error) {
    unstable_rethrow(error);
    // The page reads the same order and fails with the same error, which its error state shows and Next
    // logs; the bar only goes without its link.
    return null;
  }
}

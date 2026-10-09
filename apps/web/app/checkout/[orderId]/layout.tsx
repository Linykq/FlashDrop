import { unstable_rethrow } from 'next/navigation';
import { Suspense } from 'react';
import { HoldTimerLink } from '../../../components/checkout/hold-timer-link';
import { LeaveCheckout } from '../../../components/checkout/leave-checkout';
import { CheckoutBar } from '../../../components/layout/checkout-bar';
import { NavSentinel } from '../../../components/layout/nav-bar';
import { SkipLink } from '../../../components/layout/skip-link';
import type { CheckoutHold } from '../../../lib/checkout-hold';
import { isLiveHold } from '../../../lib/hold';
import { orderPageHref, productHref } from '../../../lib/routes';
import { readOrder } from '../../../lib/server/orders';

type Params = Pick<LayoutProps<'/checkout/[orderId]'>, 'params'>;

/**
 * Checkout's chrome (design-system §8.1, §10.4): the reduced navigation bar, no footer, the grouped canvas.
 * The skip link names where it leads, "Skip to checkout" (SD §8.3).
 */
export default function CheckoutLayout({ children, params }: LayoutProps<'/checkout/[orderId]'>) {
  return (
    <div data-page="grouped" className="flex min-h-dvh flex-col">
      <SkipLink label="Skip to checkout" />
      <CheckoutBar
        status={
          <Suspense fallback={null}>
            <HoldTimerAction params={params} />
          </Suspense>
        }
        action={
          <Suspense fallback={null}>
            <LeaveCheckoutAction params={params} />
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

type LiveHold = {
  orderId: string;
  hold: Omit<CheckoutHold, 'ended'>;
  productHref: string;
  orderPageHref: string;
};

/**
 * The order's hold, while there is one: the bar's islands go with it. An expired order has nothing to leave
 * or count down: its card already offers the way back, and the bar keeps only the wordmark. The order read is
 * shared with the page (memoised per request).
 */
async function liveHoldOf({ params }: Params): Promise<LiveHold | null> {
  const { orderId } = await params;
  try {
    const read = await readOrder(orderId);
    if (read.kind !== 'ok') return null;
    const order = read.value;
    const serverNow = Date.parse(order.serverNow);
    if (!isLiveHold(order, serverNow)) return null;
    return {
      orderId: order.id,
      hold: {
        createdAt: order.createdAt,
        expiresAt: order.expiresAt,
        extensions: order.extensions,
        serverNow,
      },
      productHref: productHref(order.product.slug),
      orderPageHref: orderPageHref(order.id),
    };
  } catch (error) {
    unstable_rethrow(error);
    // The page reads the same order and fails with the same error, which its error state shows and Next
    // logs; the bar only goes without its islands.
    return null;
  }
}

/** The way out, while there is a hold to leave. */
async function LeaveCheckoutAction({ params }: Params) {
  const live = await liveHoldOf({ params });
  return live && <LeaveCheckout {...live} />;
}

/** The compact countdown, while there is a hold to count down. */
async function HoldTimerAction({ params }: Params) {
  const live = await liveHoldOf({ params });
  return live && <HoldTimerLink orderId={live.orderId} hold={live.hold} />;
}

import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { Suspense } from 'react';
import { OrderStatusView } from '../../../../components/orders/order-status-view';
import { Skeleton, SkeletonText } from '../../../../components/ui/skeleton';
import { checkoutHref, loginHref, orderPageHref, productHref } from '../../../../lib/routes';
import { readOrder } from '../../../../lib/server/orders';

export const metadata: Metadata = { title: 'Your order', robots: { index: false } };

/*
 * The order status page (SD §8.1, design-system §10.5): where checkout sends a submitted order, and where an
 * order opens from the lists once it is no longer held. Dynamic: the order is read with the buyer's session on
 * every request, and the page keeps reading it while the payment runs. Signed out, proxy.ts already sent the
 * visitor to sign in; an expired session is caught here. Another buyer's order is a 404 (SD §11).
 */
export default function OrderPage({ params }: PageProps<'/orders/[orderId]'>) {
  return (
    <div data-page="grouped" className="page-form py-(--section-space)">
      <Suspense fallback={<OrderSkeleton />}>
        <Order params={params} />
      </Suspense>
    </div>
  );
}

async function Order({ params }: Pick<PageProps<'/orders/[orderId]'>, 'params'>) {
  const { orderId } = await params;
  const read = await readOrder(orderId);
  if (read.kind === 'signed-out') redirect(loginHref(orderPageHref(orderId)));
  if (read.kind === 'not-found') notFound();
  const order = read.value;
  // A hold belongs to checkout, which sends anything else back here, so the two never loop.
  if (order.status === 'RESERVED') redirect(checkoutHref(order.id));
  return <OrderStatusView order={order} productHref={productHref(order.product.slug)} />;
}

/** The page's box while the order loads: the glyph, the heading, the sentence and the details card (§9.16). */
function OrderSkeleton() {
  return (
    <div aria-busy="true">
      <div aria-hidden="true" className="flex flex-col items-center">
        <Skeleton className="size-18 rounded-full" />
        <SkeletonText style="display-2" className="mt-5 w-3/4" />
        <SkeletonText style="body" className="mt-3 w-1/2" />
      </div>
      <Skeleton className="mt-8 h-80 rounded-lg" />
    </div>
  );
}

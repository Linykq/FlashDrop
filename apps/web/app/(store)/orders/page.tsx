import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { OrderList, OrderListSkeleton } from '../../../components/commerce/order-list';
import { ButtonLink } from '../../../components/ui/button';
import { EmptyState } from '../../../components/ui/empty-state';
import { loginHref, ORDERS_HREF } from '../../../lib/routes';
import { readMyOrders } from '../../../lib/server/orders';

export const metadata: Metadata = { title: 'Your orders', robots: { index: false } };

/*
 * Every order of the signed-in buyer, newest first, from `GET /api/v1/me/orders` (SD §5.1), in the grouped
 * list of the account page (design-system §10.6). Dynamic: it depends on the session. Signed out, proxy.ts
 * already sent the visitor to sign in; an expired session is caught here.
 */
export default function OrdersPage() {
  return (
    <div data-page="grouped" className="page-form py-(--section-space)">
      <h1 className="text-title-1">Your orders</h1>
      <div className="mt-6 rounded-lg bg-surface elevation-1 sm:mt-8">
        <Suspense
          fallback={
            <div aria-busy="true">
              <OrderListSkeleton />
            </div>
          }
        >
          <Orders />
        </Suspense>
      </div>
    </div>
  );
}

/** The most `GET /me/orders` lists at once. */
const MAX_ORDERS = 100;

async function Orders() {
  const read = await readMyOrders(MAX_ORDERS);
  if (read.kind !== 'ok') redirect(loginHref(ORDERS_HREF));
  if (read.value.length === 0) {
    return (
      <EmptyState
        title="No orders yet"
        description="Orders you place show up here."
        action={
          <ButtonLink href="/" variant="tinted">
            Go to drops
          </ButtonLink>
        }
      />
    );
  }
  return <OrderList orders={read.value} />;
}

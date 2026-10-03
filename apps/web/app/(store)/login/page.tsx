import type { OrderView } from '@flashdrop/contracts';
import { ChevronRight } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { unstable_rethrow } from 'next/navigation';
import { Suspense } from 'react';
import { LoginForm } from '../../../components/account/login-form';
import { SignOutButton } from '../../../components/account/sign-out-button';
import { OrderList } from '../../../components/commerce/order-list';
import { Skeleton, SkeletonText } from '../../../components/ui/skeleton';
import { adminHref, ORDERS_HREF, safeReturnTo } from '../../../lib/routes';
import { getDevUsers } from '../../../lib/server/catalog';
import { log } from '../../../lib/server/log';
import { readMyOrders } from '../../../lib/server/orders';
import { getViewer } from '../../../lib/server/session';

/*
 * Dev sign-in, and the account page once signed in (design-system §10.6). Dynamic: it reads the session
 * cookie and `?returnTo=`. The seeded accounts come from a cached read, so the picker costs no api round
 * trip after the first visit.
 */

export async function generateMetadata(): Promise<Metadata> {
  const viewer = await getViewer();
  return { title: viewer ? 'Account' : 'Sign in', robots: { index: false } };
}

export default function LoginPage({ searchParams }: PageProps<'/login'>) {
  return (
    <div data-page="grouped" className="page-form py-(--section-space)">
      <Suspense fallback={<LoginSkeleton />}>
        <Login searchParams={searchParams} />
      </Suspense>
      {/* Its own hole: the account card never waits for the orders. */}
      <Suspense fallback={null}>
        <YourOrders />
      </Suspense>
    </div>
  );
}

// A card on the grouped canvas from 735 px. On phones the content sits on the canvas itself, so the account
// list is the one surface, as in a grouped list on iOS, and keeps the full width of the screen.
const cardClass = 'sm:rounded-xl sm:bg-surface sm:p-8 sm:elevation-1';

async function Login({ searchParams }: Pick<PageProps<'/login'>, 'searchParams'>) {
  // The request's own inputs first: the cached read must never start while `next build` prerenders.
  const [{ returnTo }, viewer] = await Promise.all([searchParams, getViewer()]);
  const users = await getDevUsers();
  const admin = viewer ? adminHref(viewer.role) : null;

  return (
    <div className={cardClass}>
      {/* Signed in, Sign out sits on the title's row, where it never has to wrap under a long name. */}
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-title-1">{viewer ? 'Account' : 'Sign in'}</h1>
        {viewer && <SignOutButton />}
      </div>
      {viewer ? (
        <>
          <p className="mt-2 text-body text-label-secondary">
            Signed in as <span className="font-medium text-label">{viewer.name}</span>
          </p>
          {admin && (
            <Link
              href={admin}
              className="mt-1 inline-flex min-h-11 items-center gap-1 text-callout text-accent-label"
            >
              Open admin
              <ChevronRight size={14} />
            </Link>
          )}
        </>
      ) : (
        <p className="mt-2 text-body text-label-secondary">
          Development sign-in. Pick a seeded account; there's no password.
        </p>
      )}
      <LoginForm
        className="mt-6"
        users={users}
        currentUserId={viewer?.id ?? null}
        returnTo={safeReturnTo(returnTo)}
      />
      <p className="mt-4 text-footnote text-label-secondary">Sessions last 12 hours.</p>
    </div>
  );
}

/** The account page shows this many of the latest orders; "See all" opens the rest (§10.6). */
const LATEST_ORDERS = 10;

/**
 * "Your orders" (§10.6), 24 px below the account card and in the same card style: the way back to an order
 * once its page is closed. Signed out there is nothing to show. If api can't list the orders, the card says
 * so and the account card above keeps working.
 */
async function YourOrders() {
  if (!(await getViewer())) return null;
  const orders = await listOrders();
  return (
    <section aria-labelledby="your-orders" className={`mt-6 ${cardClass}`}>
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="your-orders" className="text-title-3">
          Your orders
        </h2>
        {orders && orders.length > LATEST_ORDERS && (
          <Link
            href={ORDERS_HREF}
            className="-my-3 inline-flex min-h-11 items-center gap-1 text-callout text-accent-label"
          >
            See all
            <ChevronRight size={14} />
          </Link>
        )}
      </div>
      {orders === null ? (
        <p className="mt-2 text-callout text-label-secondary">
          Couldn't load your orders. Refresh the page in a moment to try again.
        </p>
      ) : orders.length === 0 ? (
        <>
          <p className="mt-2 text-headline">No orders yet</p>
          <p className="mt-1 text-callout text-label-secondary">Orders you place show up here.</p>
        </>
      ) : (
        <div className="mt-4 rounded-lg border border-separator bg-surface">
          <OrderList orders={orders.slice(0, LATEST_ORDERS)} />
        </div>
      )}
    </section>
  );
}

/** The buyer's orders, or `null` when api can't list them right now (logged). */
async function listOrders(): Promise<OrderView[] | null> {
  try {
    // One more than shown, to know whether "See all" has more to show.
    const read = await readMyOrders(LATEST_ORDERS + 1);
    if (read.kind === 'ok') return read.value;
    // The session cookie verified here but api refused it (a rotated secret, a deleted user).
    log().warn({ read: read.kind }, 'api refused the session while listing orders for the account page');
    return null;
  } catch (error) {
    unstable_rethrow(error);
    log().warn({ err: error }, 'cannot list orders for the account page');
    return null;
  }
}

function LoginSkeleton() {
  return (
    <div aria-busy="true" className={cardClass}>
      <div aria-hidden="true">
        <SkeletonText style="title-1" className="w-32" />
        <SkeletonText style="body" className="mt-2 w-full" />
        <Skeleton className="mt-6 h-64 rounded-lg" />
        <Skeleton className="mt-6 h-14 rounded-md" />
        <SkeletonText style="footnote" className="mt-4 w-40" />
      </div>
    </div>
  );
}

import { ChevronRight } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { LoginForm } from '../../../components/account/login-form';
import { SignOutButton } from '../../../components/account/sign-out-button';
import { Skeleton, SkeletonText } from '../../../components/ui/skeleton';
import { adminHref, safeReturnTo } from '../../../lib/routes';
import { getDevUsers } from '../../../lib/server/catalog';
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
      {/* TODO(M3): the "Your orders" card from GET /me/orders, 24 px below (§10.6). */}
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
